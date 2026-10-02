/**
 * Full reviewed ingest: optional Kaggle download + archive validation + publish.
 * One coordinator job; download completion is not readiness.
 * Requires an analyst-approved workspace pin (no in-code Core default).
 */
import { mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { UnsupportedSourceError, type ReviewedSourcePin } from 'dsh-data-core/recipes/registry'
import type { WorkspacePaths } from 'dsh-data-core/workspace-paths'
import { runKaggleDownload } from 'dsh-data-kaggle/download-adapter'
import { downloadDestinationForSlug } from 'dsh-data-kaggle/download-job'
import { IngestCancelledError, runIngestFromArchive } from './ingest-pipeline.js'

export { IngestCancelledError }

export interface RunReviewedIngestRequest {
  slug: string
  workspace: WorkspacePaths
  kaggleExecutable: string
  signal?: AbortSignal
  /** Operator/test local zip; never accepted from model tool arguments. */
  localArchivePath?: string
  /**
   * Required analyst-approved workspace pin from `resolveSourcePin`.
   * Omitting it fails closed — there is no Core-recipe default.
   */
  pin: ReviewedSourcePin
}

export interface ReviewedIngestResult {
  jobId: string
  status: 'ready' | 'needs-input'
  datasetId: string
  datasetVersionId: string
  sourceSlug: string
  sourceVersion: string
  license: string | null
  tables: Array<{
    id: string
    rows: number
    rejectedRows: number
    /** Physical source data rows (adapter-defined); set for adaptive ingest. */
    sourceRowCount?: number
    /** Lossless raw_* table row count. */
    rawRowCount?: number
    /** Typed projection row count (must equal raw when adaptive). */
    projectionRowCount?: number
    /** Per-column TRY_CAST nulls introduced in the projection, keyed by column name. */
    castNullCounts?: Record<string, number>
    /** String columns whose distinct values are 2+ ISO-4217 currency codes — group/filter by them before summing. */
    currencyDimensions?: Array<{ column: string; currencies: string[] }>
    /** Columns the bounded currency scan skipped — mixing inside them is unverified, not ruled out. */
    currencyScanSkipped?: Array<{ column: string; sampledDistinctValues: number }>
    /** Columns republished as raw VARCHAR because no value parsed as the approved type. */
    typeFallbacks?: Array<{ column: string; approvedType: string; unparsedValues: number }>
  }>
  qualityWarnings: string[]
  materialityReasons?: string[]
  /** Named, ranked type re-proposals for columns the typed load had to cast to NULL. */
  typeReproposals?: Array<{
    tableId: string
    column: string
    approvedType?: string
    proposedType: string
    castNullCells: number
    castNullShare: number
    material: boolean
  }>
}

async function findZipInDir(directory: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return undefined
  }
  const zipName = entries.find((name) => name.toLowerCase().endsWith('.zip'))
  return zipName ? join(directory, zipName) : undefined
}

export async function runReviewedIngest(
  request: RunReviewedIngestRequest,
): Promise<ReviewedIngestResult> {
  const pin = request.pin
  if (!pin) {
    throw new UnsupportedSourceError(
      request.slug,
      `No analyst-approved workspace pin for "${request.slug}". Call preview_ingest_source and get analyst approval first.`,
    )
  }
  const destinationDir = downloadDestinationForSlug(
    request.workspace.sourcesDir,
    pin.slug,
    pin.sourceVersion,
  )
  let archivePath = request.localArchivePath
  if (archivePath) {
    archivePath = resolve(archivePath)
  } else {
    archivePath = await findZipInDir(destinationDir)
  }

  if (!archivePath && pin.requiresDownload) {
    await mkdir(destinationDir, { recursive: true })
    const download = await runKaggleDownload(
      {
        slug: pin.slug,
        sourceVersion: pin.sourceVersion,
        destinationDir,
      },
      { kaggleExecutable: request.kaggleExecutable, signal: request.signal },
    )
    if (download.exitCode !== 0) {
      throw new Error(
        download.stderr.slice(0, 2_000) || `Kaggle download failed (${download.exitCode})`,
      )
    }
    archivePath = await findZipInDir(destinationDir)
  }

  if (!archivePath) {
    throw new UnsupportedSourceError(
      pin.slug,
      pin.requiresDownload
        ? `Download finished but no .zip was found for "${pin.slug}"`
        : `Local fixture archive missing for "${pin.slug}". Set DSH_DATA_LOCAL_ARCHIVE or place a zip under sources.`,
    )
  }

  const datasetWorkspace = join(request.workspace.root, 'workspaces', pin.recipe.datasetId)
  const result = await runIngestFromArchive({
    archivePath,
    workspaceDir: datasetWorkspace,
    catalogPath: request.workspace.catalogPath,
    recipe: pin.recipe,
    slug: pin.slug,
    sourceVersion: pin.sourceVersion,
    idempotencyKey: `${pin.recipe.datasetId}:${pin.sourceVersion}:${pin.recipe.recipeHash}`,
    signal: request.signal,
  })

  const qualityWarnings = [
    ...result.tables
      .filter((table) => table.rejectedRows > 0)
      .map((table) => `${table.id}: ${table.rejectedRows} rejected row(s)`),
    ...(result.materiality?.reasons ?? []).map((reason) => `cast-null: ${reason}`),
    ...result.tables.flatMap((table) =>
      (table.currencyDimensions ?? []).map(
        (dimension) =>
          `${table.id}.${dimension.column}: mixes currencies (${dimension.currencies.join(', ')}) — group or filter by it before summing monetary columns in this table`,
      ),
    ),
    ...result.tables.flatMap((table) =>
      (table.typeFallbacks ?? []).map(
        (fallback) =>
          `${table.id}.${fallback.column}: no value matched any ${fallback.approvedType} format (${fallback.unparsedValues} value(s)), so the column keeps its raw text as VARCHAR — ask the analyst for the intended format (for example day-first vs month-first) before any time analysis, then re-ingest with it`,
      ),
    ),
    ...result.tables.flatMap((table) =>
      (table.currencyScanSkipped ?? []).map(
        (skipped) =>
          `${table.id}.${skipped.column}: NOT scanned for mixed currencies — it has more than ${skipped.sampledDistinctValues - 1} distinct values and the sampled ones all look like ISO-4217 codes, so a currency mix cannot be ruled out; group or filter by it before summing monetary columns in this table`,
      ),
    ),
  ]

  return {
    jobId: result.jobId,
    status: result.status,
    datasetId: result.datasetId,
    datasetVersionId: result.datasetVersionId,
    sourceSlug: pin.slug,
    sourceVersion: pin.sourceVersion,
    license: pin.recipe.license,
    tables: result.tables.map((table) => ({
      id: table.id,
      rows: table.rows,
      rejectedRows: table.rejectedRows,
      ...(table.sourceRowCount !== undefined ? { sourceRowCount: table.sourceRowCount } : {}),
      ...(table.rawRowCount !== undefined ? { rawRowCount: table.rawRowCount } : {}),
      ...(table.projectionRowCount !== undefined
        ? { projectionRowCount: table.projectionRowCount }
        : {}),
      ...(table.castNullCounts !== undefined ? { castNullCounts: table.castNullCounts } : {}),
      ...(table.currencyDimensions !== undefined
        ? { currencyDimensions: table.currencyDimensions }
        : {}),
      ...(table.currencyScanSkipped !== undefined
        ? { currencyScanSkipped: table.currencyScanSkipped }
        : {}),
      ...(table.typeFallbacks !== undefined ? { typeFallbacks: table.typeFallbacks } : {}),
    })),
    qualityWarnings,
    ...(result.materiality?.material ? { materialityReasons: result.materiality.reasons } : {}),
    ...(result.materiality?.reproposals && result.materiality.reproposals.length > 0
      ? { typeReproposals: [...result.materiality.reproposals] }
      : {}),
  }
}
