/**
 * Operator ingest coordinator (P1): validate/extract a local archive, optionally
 * normalize encoding, load staging DuckDB with a reviewed recipe, checkpoint,
 * and atomically publish a dataset version. Download is a separate step the
 * CLI composes in front of this function so offline tests never need network.
 */
import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import type { DatasetManifest } from 'dsh-data-core/contracts'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { effectiveLoadStrategy } from 'dsh-data-core/recipes'
import type { IngestRecipe } from 'dsh-data-core/recipes/types'
import { safeExtractZip } from 'dsh-data-kaggle/archive-safety'
import { normalizeCsvToUtf8 } from './csv-encoding.js'
import { detectCurrencyScan } from './currency-detection.js'
import { evaluateMateriality, type MaterialityDecision } from './materiality.js'
import { PENDING_ADAPTATION_FILENAME, type PendingAdaptationPublish } from './pending-adaptation.js'
import {
  loadCsvIntoStaging,
  loadCsvRawIntoStaging,
  loadTabularIntoStaging,
  loadTabularRawIntoStaging,
  projectTypedFromRaw,
} from './staging-loader.js'

export interface IngestFromArchiveRequest {
  archivePath: string
  workspaceDir: string
  catalogPath: string
  recipe: IngestRecipe
  slug: string
  sourceVersion: string
  idempotencyKey: string
  /** When true, publish even if staging produced rejected rows. */
  acceptRejectedRows?: boolean
  /** Maximum total rejected rows allowed across tables (default 0). */
  maxRejectedRows?: number
  /** Operator cancel; marks the import job `cancelled` and refuses publish. */
  signal?: AbortSignal
}

export class IngestCancelledError extends Error {
  readonly jobId: string

  constructor(jobId: string, reason = 'Ingest cancelled') {
    super(reason)
    this.name = 'IngestCancelledError'
    this.jobId = jobId
  }
}

export interface IngestFromArchiveResult {
  status: 'ready' | 'needs-input'
  datasetId: string
  datasetVersionId: string
  datasetPath: string
  tables: DatasetManifest['tables']
  files: DatasetManifest['files']
  jobId: string
  materiality?: MaterialityDecision
}

export interface PublicationQualityOptions {
  acceptRejectedRows?: boolean
  maxRejectedRows?: number
  /** Recovery guidance appended to the rejection error (already-redacted path). */
  hint?: string
}

function versionIdFor(
  datasetId: string,
  sourceVersion: string,
  recipeHash: string,
  contentDigest: string,
): string {
  const digest = createHash('sha256')
    .update(`${datasetId}\0${sourceVersion}\0${recipeHash}\0${contentDigest}`)
    .digest('hex')
    .slice(0, 12)
  return `${datasetId}-v${sourceVersion}-${digest}`
}

function contentDigestFor(files: readonly { name: string; sha256: string }[]): string {
  const material = [...files]
    .map((file) => `${file.name}:${file.sha256}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(material).digest('hex').slice(0, 24)
}

/**
 * Fail closed before promoting staging into an immutable published version.
 * Default maxRejectedRows is 0; acceptRejectedRows bypasses the gate.
 */
export function assertPublicationQuality(
  tables: DatasetManifest['tables'],
  options: PublicationQualityOptions = {},
): void {
  if (options.acceptRejectedRows) return
  const maxRejectedRows = options.maxRejectedRows ?? 0
  const rejectedRows = tables.reduce((sum, table) => sum + table.rejectedRows, 0)
  if (rejectedRows > maxRejectedRows) {
    const hint = options.hint ? ` ${options.hint}` : ''
    throw new Error(
      `Publication rejected: ${rejectedRows} rejected row(s) exceed maxRejectedRows=${maxRejectedRows}.${hint}`,
    )
  }
}

function throwIfIngestAborted(store: MetadataStore, jobId: string, signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const current = store.getImportJob(jobId)
  if (current && current.status !== 'cancelled' && current.status !== 'ready') {
    try {
      store.updateImportJobStatus(jobId, 'cancelled', {
        errorMessage: 'Cancelled by operator signal',
      })
    } catch {
      // Transition may race with another terminal update; still refuse publish.
    }
  }
  throw new IngestCancelledError(jobId)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function publishedResult(
  existing: DatasetManifest,
  datasetsDir: string,
  jobId: string,
): IngestFromArchiveResult {
  const datasetPath = join(datasetsDir, existing.datasetVersionId, 'dataset.duckdb')
  return {
    status: 'ready',
    datasetId: existing.datasetId,
    datasetVersionId: existing.datasetVersionId,
    datasetPath,
    tables: existing.tables,
    files: existing.files,
    jobId,
  }
}

async function promoteStagingAndPublish(input: {
  store: MetadataStore
  jobId: string
  stagingPath: string
  datasetPath: string
  datasetVersionDir: string
  manifest: DatasetManifest
}): Promise<void> {
  await mkdir(input.datasetVersionDir, { recursive: true })
  await copyFile(input.stagingPath, `${input.datasetPath}.tmp`)
  await rename(`${input.datasetPath}.tmp`, input.datasetPath)
  input.store.publishDatasetVersion(input.manifest)
  input.store.updateImportJobStatus(input.jobId, 'ready', {
    datasetVersionId: input.manifest.datasetVersionId,
  })
}

/**
 * Resume a paused adaptive ingest after same-origin analyst confirm.
 * Model tools must not call this — only trusted browser POST handlers.
 */
export async function publishPendingAdaptation(input: {
  catalogPath: string
  workspaceDir: string
  jobId: string
}): Promise<IngestFromArchiveResult> {
  const stagingDir = join(input.workspaceDir, 'staging')
  const pendingPath = join(stagingDir, PENDING_ADAPTATION_FILENAME)
  const raw = await readFile(pendingPath, 'utf8')
  const pending = JSON.parse(raw) as PendingAdaptationPublish
  if (pending.contractVersion !== 1 || pending.jobId !== input.jobId) {
    throw new Error(`Pending adaptation does not match job "${input.jobId}"`)
  }

  const store = new MetadataStore(input.catalogPath)
  try {
    const job = store.getImportJob(input.jobId)
    if (!job || job.status !== 'needs-input') {
      throw new Error(`Import job "${input.jobId}" is not waiting for adaptation confirm`)
    }
    if (!(await pathExists(pending.stagingPath))) {
      throw new Error(`Staging DuckDB missing for job "${input.jobId}"`)
    }

    const manifest: DatasetManifest = {
      contractVersion: 1,
      datasetId: pending.datasetId,
      datasetVersionId: pending.datasetVersionId,
      source: {
        slug: pending.slug,
        version: pending.sourceVersion,
        url: pending.sourceUrl,
        retrievedAt: new Date().toISOString(),
        license: pending.license,
      },
      files: pending.files,
      recipeHash: pending.recipeHash,
      importerVersion: pending.importerVersion,
      tables: pending.tables,
    }

    await promoteStagingAndPublish({
      store,
      jobId: input.jobId,
      stagingPath: pending.stagingPath,
      datasetPath: pending.datasetPath,
      datasetVersionDir: dirname(pending.datasetPath),
      manifest,
    })
    await rm(pendingPath, { force: true })

    return {
      status: 'ready',
      datasetId: manifest.datasetId,
      datasetVersionId: manifest.datasetVersionId,
      datasetPath: pending.datasetPath,
      tables: manifest.tables,
      files: manifest.files,
      jobId: input.jobId,
      materiality: pending.materiality,
    }
  } finally {
    store.close()
  }
}

/**
 * Analyst chose Keep staging — leave files, mark job cancelled (pin stays approved).
 */
export async function deferPendingAdaptation(input: {
  catalogPath: string
  workspaceDir: string
  jobId: string
}): Promise<{ jobId: string; status: 'cancelled' }> {
  const store = new MetadataStore(input.catalogPath)
  try {
    const job = store.getImportJob(input.jobId)
    if (!job || job.status !== 'needs-input') {
      throw new Error(`Import job "${input.jobId}" is not waiting for adaptation confirm`)
    }
    store.updateImportJobStatus(input.jobId, 'cancelled', {
      errorMessage: 'Analyst kept staging without publishing typed projection',
    })
    return { jobId: input.jobId, status: 'cancelled' }
  } finally {
    store.close()
  }
}

export async function runIngestFromArchive(
  request: IngestFromArchiveRequest,
): Promise<IngestFromArchiveResult> {
  const sourcesDir = join(request.workspaceDir, 'sources')
  const stagingDir = join(request.workspaceDir, 'staging')
  const datasetsDir = join(request.workspaceDir, 'datasets')
  await mkdir(sourcesDir, { recursive: true })
  await mkdir(stagingDir, { recursive: true })
  await mkdir(datasetsDir, { recursive: true })

  const store = new MetadataStore(request.catalogPath)
  let job = store.createImportJob({
    idempotencyKey: request.idempotencyKey,
    slug: request.slug,
    sourceVersion: request.sourceVersion,
  })
  // Operator retries after a failed ingest need a fresh job row; terminal
  // failures are immutable under the original idempotency key.
  if (job.status === 'failed' || job.status === 'cancelled') {
    job = store.createImportJob({
      idempotencyKey: `${request.idempotencyKey}:retry:${Date.now()}`,
      slug: request.slug,
      sourceVersion: request.sourceVersion,
    })
  }

  try {
    throwIfIngestAborted(store, job.jobId, request.signal)

    if (job.status === 'ready' && job.datasetVersionId) {
      const existing = store.getDatasetVersion(job.datasetVersionId)
      if (existing) {
        return publishedResult(existing, datasetsDir, job.jobId)
      }
    }

    // Archive-only entry still walks the job state machine; the CLI marks
    // downloading around the real Kaggle call before invoking this helper.
    if (job.status === 'queued') store.updateImportJobStatus(job.jobId, 'downloading')
    throwIfIngestAborted(store, job.jobId, request.signal)
    store.updateImportJobStatus(job.jobId, 'validating')
    throwIfIngestAborted(store, job.jobId, request.signal)
    const extracted = await safeExtractZip(request.archivePath, sourcesDir)
    throwIfIngestAborted(store, job.jobId, request.signal)
    if (request.recipe.tables.length === 0) {
      throw new Error('Ingest recipe must declare at least one table')
    }
    for (const table of request.recipe.tables) {
      if (!extracted.some((file) => file.name === table.sourceFile)) {
        throw new Error(
          `Archive is missing expected source file "${table.sourceFile}" (found: ${extracted.map((f) => f.name).join(', ') || 'none'})`,
        )
      }
    }

    // Version identity includes source file content hashes so updated upstream
    // bytes under the same Kaggle version number cannot collide with a prior publish.
    const contentDigest = contentDigestFor(extracted)
    const datasetVersionId = versionIdFor(
      request.recipe.datasetId,
      request.sourceVersion,
      request.recipe.recipeHash,
      contentDigest,
    )
    const datasetVersionDir = join(datasetsDir, datasetVersionId)
    const datasetPath = join(datasetVersionDir, 'dataset.duckdb')
    const existingVersion = store.getDatasetVersion(datasetVersionId)
    if (existingVersion) {
      throwIfIngestAborted(store, job.jobId, request.signal)
      store.updateImportJobStatus(job.jobId, 'loading')
      store.updateImportJobStatus(job.jobId, 'profiling')
      store.updateImportJobStatus(job.jobId, 'ready', { datasetVersionId })
      return publishedResult(existingVersion, datasetsDir, job.jobId)
    }
    if (await pathExists(datasetPath)) {
      throw new Error(
        `Published dataset file already exists for version "${datasetVersionId}" without a catalog entry; refusing to overwrite`,
      )
    }

    throwIfIngestAborted(store, job.jobId, request.signal)
    store.updateImportJobStatus(job.jobId, 'loading')
    const stagingPath = join(stagingDir, 'staging.duckdb')
    await rm(stagingPath, { force: true })
    await rm(`${stagingPath}.wal`, { force: true })
    const writer = await DuckDBInstance.create(stagingPath)
    const writerConnection = await writer.connect()
    const tableResults: DatasetManifest['tables'] = []
    try {
      for (const table of request.recipe.tables) {
        throwIfIngestAborted(store, job.jobId, request.signal)
        const extractedSourcePath = join(sourcesDir, table.sourceFile)
        const sourceFormat = table.sourceFormat ?? 'csv'
        if (!['csv', 'parquet', 'json', 'excel'].includes(sourceFormat)) {
          throw new Error(`Unsupported controlled source format: ${String(sourceFormat)}`)
        }
        let loadSourcePath = extractedSourcePath
        let tempExcelCsv: string | undefined
        if (sourceFormat === 'excel') {
          if (!table.excelSheet) {
            throw new Error(`Excel table "${table.tableId}" is missing excelSheet`)
          }
          const { excelSheetToTempCsv } = await import('./excel-adapter.js')
          tempExcelCsv = await excelSheetToTempCsv(extractedSourcePath, table.excelSheet)
          loadSourcePath = tempExcelCsv
        }
        if (table.sourceEncoding && table.sourceEncoding !== 'utf-8') {
          if (sourceFormat !== 'csv') {
            throw new Error('sourceEncoding is only supported for CSV tables')
          }
          loadSourcePath = join(stagingDir, `${basename(table.sourceFile)}.utf8.csv`)
          await normalizeCsvToUtf8(extractedSourcePath, loadSourcePath, {
            fromEncoding: table.sourceEncoding,
          })
        }
        try {
          const strategy = effectiveLoadStrategy(request.recipe)
          if (strategy === 'raw_then_typed') {
            const raw =
              sourceFormat === 'csv' || sourceFormat === 'excel'
                ? await loadCsvRawIntoStaging(writerConnection, {
                    csvPath: loadSourcePath,
                    tableId: table.tableId,
                    columns: table.columns,
                  })
                : await loadTabularRawIntoStaging(writerConnection, {
                    sourcePath: loadSourcePath,
                    sourceFormat,
                    tableId: table.tableId,
                    columns: table.columns,
                  })
            const projected = await projectTypedFromRaw(writerConnection, {
              tableId: table.tableId,
              columns: table.columns,
              dateFormat: table.dateFormat,
              timestampFormat: table.timestampFormat,
            })
            const currencyScan = await detectCurrencyScan(
              writerConnection,
              table.tableId,
              table.columns,
            )
            tableResults.push({
              id: table.tableId,
              sourceFile: table.sourceFile,
              rows: projected.projectionRowCount,
              rejectedRows: 0,
              sourceRowCount: raw.sourceRowCount,
              rawRowCount: raw.rawRowCount,
              projectionRowCount: projected.projectionRowCount,
              castNullCounts: projected.castNullCounts,
              ...(projected.typeFallbacks.length > 0
                ? { typeFallbacks: projected.typeFallbacks }
                : {}),
              loadStrategy: 'raw_then_typed',
              ...(currencyScan.dimensions.length > 0
                ? { currencyDimensions: currencyScan.dimensions }
                : {}),
              ...(currencyScan.unscanned.length > 0
                ? { currencyScanSkipped: currencyScan.unscanned }
                : {}),
            })
          } else {
            const loadResult =
              sourceFormat === 'csv' || sourceFormat === 'excel'
                ? await loadCsvIntoStaging(writerConnection, {
                    csvPath: loadSourcePath,
                    tableId: table.tableId,
                    columns: table.columns,
                    dateFormat: table.dateFormat,
                    timestampFormat: table.timestampFormat,
                  })
                : await loadTabularIntoStaging(writerConnection, {
                    sourcePath: loadSourcePath,
                    sourceFormat,
                    tableId: table.tableId,
                    columns: table.columns,
                  })
            const currencyScan = await detectCurrencyScan(
              writerConnection,
              table.tableId,
              table.columns,
            )
            tableResults.push({
              id: table.tableId,
              sourceFile: table.sourceFile,
              rows: loadResult.rowCount,
              rejectedRows: loadResult.rejectedRows.length,
              loadStrategy: 'typed_recipe',
              ...(currencyScan.dimensions.length > 0
                ? { currencyDimensions: currencyScan.dimensions }
                : {}),
              ...(currencyScan.unscanned.length > 0
                ? { currencyScanSkipped: currencyScan.unscanned }
                : {}),
            })
          }
        } finally {
          if (tempExcelCsv) {
            await rm(dirname(tempExcelCsv), { recursive: true, force: true }).catch(() => undefined)
          }
        }
      }
      await writerConnection.run('CHECKPOINT')
    } finally {
      writerConnection.closeSync()
      writer.closeSync()
    }

    throwIfIngestAborted(store, job.jobId, request.signal)
    store.updateImportJobStatus(job.jobId, 'profiling')
    await writeFile(
      join(stagingDir, 'profiling.json'),
      JSON.stringify({ tables: tableResults, contentDigest }, null, 2),
      'utf8',
    )

    const files = extracted.map((file) => ({
      name: file.name,
      sha256: file.sha256,
      bytes: file.bytes,
      format: file.name.toLowerCase().endsWith('.csv')
        ? 'csv'
        : file.name.toLowerCase().endsWith('.parquet')
          ? 'parquet'
          : /\.(?:json|jsonl|ndjson)$/i.test(file.name)
            ? 'json'
            : 'bin',
    }))

    const pinColumns = request.recipe.tables.flatMap((table) =>
      table.columns.map((column) => ({
        tableId: table.tableId,
        name: column.name,
        type: column.type,
      })),
    )
    const materiality = evaluateMateriality(tableResults, pinColumns)
    if (materiality.material && effectiveLoadStrategy(request.recipe) === 'raw_then_typed') {
      const pending: PendingAdaptationPublish = {
        contractVersion: 1,
        jobId: job.jobId,
        datasetId: request.recipe.datasetId,
        datasetVersionId,
        slug: request.slug,
        sourceVersion: request.sourceVersion,
        recipeHash: request.recipe.recipeHash,
        importerVersion: request.recipe.importerVersion,
        sourceUrl: request.recipe.sourceUrl,
        license: request.recipe.license,
        tables: tableResults,
        files,
        materiality,
        stagingPath,
        datasetPath,
        workspaceDir: request.workspaceDir,
        createdAt: new Date().toISOString(),
      }
      await writeFile(
        join(stagingDir, PENDING_ADAPTATION_FILENAME),
        JSON.stringify(pending, null, 2),
        'utf8',
      )
      store.updateImportJobStatus(job.jobId, 'needs-input', {
        warnings: [
          `Adaptation confirm required: ${materiality.reasons.join('; ')}`,
          ...materiality.reasons,
        ],
      })
      return {
        status: 'needs-input',
        datasetId: request.recipe.datasetId,
        datasetVersionId,
        datasetPath,
        tables: tableResults,
        files,
        jobId: job.jobId,
        materiality,
      }
    }

    // Strict reject gate for the legacy typed path only. `raw_then_typed`
    // never rejects rows (cast failures become NULL in the projection and are
    // surfaced by the materiality confirm above), so a `typed_recipe` pin is
    // the only path that can hard-fail here. The hint points the analyst at
    // the adaptive re-proposal recovery (preview-ingest.ts re-proposes legacy
    // typed pins), rather than leaving the failure as a dead end.
    if (effectiveLoadStrategy(request.recipe) === 'typed_recipe') {
      assertPublicationQuality(tableResults, {
        acceptRejectedRows: request.acceptRejectedRows,
        maxRejectedRows: request.maxRejectedRows,
        hint:
          'This pin loads strictly (typed_recipe) and rejects rows that fail type casts. ' +
          'Re-run preview_ingest_source to obtain a lossless raw_then_typed revision for fresh analyst approval.',
      })
    }

    throwIfIngestAborted(store, job.jobId, request.signal)
    const manifest: DatasetManifest = {
      contractVersion: 1,
      datasetId: request.recipe.datasetId,
      datasetVersionId,
      source: {
        slug: request.slug,
        version: request.sourceVersion,
        url: request.recipe.sourceUrl,
        retrievedAt: new Date().toISOString(),
        license: request.recipe.license,
      },
      files,
      recipeHash: request.recipe.recipeHash,
      importerVersion: request.recipe.importerVersion,
      tables: tableResults,
    }

    await promoteStagingAndPublish({
      store,
      jobId: job.jobId,
      stagingPath,
      datasetPath,
      datasetVersionDir,
      manifest,
    })

    return {
      status: 'ready',
      datasetId: manifest.datasetId,
      datasetVersionId,
      datasetPath,
      tables: manifest.tables,
      files: manifest.files,
      jobId: job.jobId,
      ...(materiality.totalCastNullCells > 0 ? { materiality } : {}),
    }
  } catch (error) {
    if (error instanceof IngestCancelledError) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    try {
      const current = store.getImportJob(job.jobId)
      if (
        current &&
        current.status !== 'failed' &&
        current.status !== 'ready' &&
        current.status !== 'cancelled'
      ) {
        store.updateImportJobStatus(job.jobId, 'failed', { errorMessage: message })
      }
    } catch {
      // Preserve the original ingest error if status recovery also fails.
    }
    throw error
  } finally {
    store.close()
  }
}
