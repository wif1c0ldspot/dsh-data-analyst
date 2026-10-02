/**
 * Trusted preview for a tabular Kaggle source that has no analyst-approved
 * workspace pin yet. Downloads with operator credentials (never a
 * model-supplied path), safe-extracts, proposes column types in trusted code
 * (`recipe-proposer.ts` — never a model-authored transform), and stores the
 * proposal as a `candidate` workspace pin attributed to the calling session.
 * Never publishes: `ingest_dataset` only runs after an analyst approves the
 * candidate (see "Data and approval flow" in docs/architecture.md).
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { effectiveLoadStrategy } from 'dsh-data-core/recipes'
import { normalizeSourceSlug, UnsupportedSourceError } from 'dsh-data-core/recipes/registry'
import type { IngestRecipe } from 'dsh-data-core/recipes/types'
import { resolveSourcePin } from 'dsh-data-core/recipes/workspace-registry'
import type { WorkspacePaths } from 'dsh-data-core/workspace-paths'
import { safeExtractZip } from 'dsh-data-kaggle/archive-safety'
import { runKaggleDownload } from 'dsh-data-kaggle/download-adapter'
import { downloadDestinationForSlug } from 'dsh-data-kaggle/download-job'
import {
  parseKaggleDatasetMetadata,
  parseKagglePublicMetadata,
  readKaggleDatasetMetadataPayload,
  readKagglePublicMetadataPayload,
  type KaggleDatasetMetadata,
} from 'dsh-data-kaggle/metadata-adapter'
import {
  modelPublisherSuppliedMetadata,
  parsePublisherSuppliedMetadata,
  type ModelPublisherSuppliedMetadata,
} from 'dsh-data-kaggle/publisher-metadata'
import { inspectSourceFiles } from './source-inspector.js'

/**
 * Why a column in a *reused* candidate carries no per-column inference evidence: the
 * stored recipe keeps the proposal, not the sampling that produced it. Stated in words
 * rather than left empty — a blank reason renders as a missing "why this type" cell
 * and reads as a defect, and every column is contracted to carry a reason (the
 * wide-table gate asserts it).
 */
const REUSED_CANDIDATE_REASON = 'Reused proposal: inferred when the source was first inspected'

export interface PreviewIngestSourceRequest {
  slug: string
  /**
   * Pinned Kaggle dataset version number. When omitted (and the slug is not
   * already reviewed), the current version reported by Kaggle's public view
   * API is resolved and pinned automatically — never persisted as `"latest"`.
   */
  sourceVersion?: string
  workspace: WorkspacePaths
  kaggleExecutable: string
  /** From authenticated session context, never a model tool argument. */
  actorId: string
  signal?: AbortSignal
  /** Operator/test only; never accepted from a model tool argument. */
  localArchivePath?: string
  /** Operator/test only; never accepted from a model tool argument. */
  fetchImpl?: typeof fetch
  /** Restrict the proposal to these table ids (all proposed tables when omitted). */
  tables?: readonly string[]
  /** Case-insensitive substring filter on column names. */
  search?: string
  /** Max columns returned across all tables; enables paging via `offset`, same contract as `get_schema`. */
  limit?: number
  /** Column offset for continuation; meaningful only with `limit`. */
  offset?: number
}

export interface PreviewIngestTableProposal {
  sourceFile: string
  sourceFormat: 'csv' | 'parquet' | 'json' | 'excel'
  tableId: string
  columns: Array<{ name: string; sourceName: string; type: string; reason: string }>
  warnings: string[]
  excelSheet?: string
  sourceEncoding?: 'windows-1252' | 'utf-8' | 'utf-16le' | 'utf-16be'
}

export interface PreviewIngestSourceResult {
  slug: string
  sourceVersion?: string
  /** True when an approved workspace pin already covers this source. */
  alreadyReviewed: boolean
  datasetId?: string
  pinId?: string
  status?: 'candidate'
  /** Present on new candidate proposals (defaults to raw_then_typed). */
  loadStrategy?: 'typed_recipe' | 'raw_then_typed'
  tables?: PreviewIngestTableProposal[]
  unsupportedFiles?: Array<{ name: string; reason: string }>
  /** Complete archive inventory with per-file disposition (proposed vs skipped). */
  files?: Array<{ name: string; bytes: number; status: 'proposed' | 'skipped'; reason?: string }>
  /**
   * Publisher-supplied description/column dictionary, quoted and labelled
   * `publisher-supplied`/`unverified` — evidence to confirm with the analyst,
   * never an approved definition. Bounded excerpt; the analyst review loads the
   * full stored block from the authenticated recipe route.
   */
  publisherSupplied?: ModelPublisherSuppliedMetadata
  license?: string | null
  observedLicense?: string | null
  observedSourceVersion?: string | null
  licenseVersionVerified?: boolean
  /** One clear verification state; metadataWarning carries the remediation. */
  provenanceStatus?: 'verified' | 'version-unverified' | 'metadata-unavailable'
  metadataWarning?: string
  /** True when `tables`/`search` filtering left tables out of `tables` entirely. */
  tablesFiltered?: boolean
  /** True when `limit` paging left columns unreturned; fetch the next page with `nextOffset`. */
  columnsTruncated?: boolean
  /** Continuation cursor for `offset`, or null when no more columns remain. */
  nextOffset?: number | null
  /** Total proposed tables before `tables`/`search` filtering. */
  totalTables?: number
  /** Total columns across the filtered table set (before `limit`/`offset`). */
  totalColumns?: number
  /**
   * This proposal is an existing candidate already under review, returned
   * as-is: no download happened and `sourceVersion` is whatever that candidate
   * was pinned to, which may no longer be Kaggle's current version.
   *
   * Reuse is deliberate — a re-preview must never overwrite a candidate the
   * analyst may have edited — but it also means an omitted `sourceVersion`
   * cannot pick up a newer release while a candidate is pending. Pass the
   * wanted `sourceVersion` explicitly to propose against it instead.
   */
  reusedCandidate?: boolean
}

/**
 * Table/column-name filter plus column paging over a proposal's table list —
 * same contract (`tables`, `search`, `limit`/`offset` over columns,
 * `nextOffset`) as `getDatasetSchemaSlice` in `dsh-data-core/catalog-query`,
 * applied here so a wide proposal (many tables, each with many columns) can
 * be paged explicitly instead of having whole tables silently dropped by the
 * model-observation byte cap with no way to ask for the rest.
 */
function filterAndPageTableProposals(
  proposalTables: readonly PreviewIngestTableProposal[],
  options: { tables?: readonly string[]; search?: string; limit?: number; offset?: number },
): {
  tables: PreviewIngestTableProposal[]
  tablesFiltered: boolean
  columnsTruncated: boolean
  nextOffset: number | null
  totalTables: number
  totalColumns: number
} {
  const requestedTables = options.tables ? new Set(options.tables) : undefined
  const search = options.search?.trim().toLowerCase()
  const filtered = proposalTables
    .filter((table) => (requestedTables ? requestedTables.has(table.tableId) : true))
    .map((table) =>
      search === undefined
        ? table
        : {
            ...table,
            columns: table.columns.filter((column) => column.name.toLowerCase().includes(search)),
          },
    )

  const totalColumns = filtered.reduce((sum, table) => sum + table.columns.length, 0)
  const limit = options.limit
  const offset = limit !== undefined ? (options.offset ?? 0) : 0
  let columnsTruncated = false
  let nextOffset: number | null = null
  let tables = filtered

  if (limit !== undefined) {
    columnsTruncated = offset + limit < totalColumns
    nextOffset = columnsTruncated ? offset + limit : null
    let skip = offset
    let take = limit
    tables = filtered.map((table) => {
      if (table.columns.length === 0) return table
      if (take <= 0) return { ...table, columns: [] }
      const length = table.columns.length
      if (skip >= length) {
        skip -= length
        return { ...table, columns: [] }
      }
      const start = skip
      const end = Math.min(length, start + take)
      skip = 0
      take -= end - start
      return { ...table, columns: table.columns.slice(start, end) }
    })
  }

  return {
    tables,
    tablesFiltered: filtered.length < proposalTables.length,
    columnsTruncated,
    nextOffset,
    totalTables: proposalTables.length,
    totalColumns,
  }
}

function sanitizeDatasetIdSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

/** `_` + 8 hex chars, always reserved out of the 128-char id cap. */
const DATASET_ID_HASH_HEX_LENGTH = 8
const DATASET_ID_HASH_SUFFIX_LENGTH = DATASET_ID_HASH_HEX_LENGTH + 1
const DATASET_ID_MAX_LENGTH = 128

/**
 * Deterministic, safe, collision-proof dataset id derived from a Kaggle
 * slug. Always namespaces by owner when the slug has an `owner/name` shape —
 * otherwise two different owners' same-named
 * datasets (e.g. `someone/widgets` and `other/widgets`) would collide on a
 * single generic `widgets` dataset id. Never returns a reserved in-code
 * Core dataset id — if the owner-namespaced (or
 * bare, ownerless) readable stem would still collide, it is further
 * prefixed with `workspace_`, so a workspace recipe can never resolve to —
 * and `ingest_dataset` can never publish over — a Core dataset id.
 *
 * The readable owner/name stem alone is still lossy: `-` and `_` both sanitize to `_`, so e.g. `some-one/widgets`
 * and `some_one/widgets` sanitize to the same `some_one_widgets` stem. To
 * stay collision-proof, every id always ends with an 8-hex-character
 * SHA-256 digest of the *normalized* (trimmed, lowercased, unsanitized)
 * slug — the two examples above hash differently even though their
 * sanitized stems match. Those trailing 9 characters (`_` + 8 hex) are
 * reserved out of the 128-char cap *before* truncating the readable stem
 * (same idea as `recipe-proposer.ts`'s `allocateUniqueName`), so a long
 * owner/name stem can never crowd out — or get the 128-char cap drop — the
 * collision-proofing suffix.
 */
export function datasetIdFromSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase()
  const hasOwner = normalized.includes('/')
  const ownerRaw = hasOwner ? normalized.split('/')[0]! : ''
  const nameRaw = hasOwner ? normalized.split('/').slice(1).join('_') : normalized

  let stem = sanitizeDatasetIdSegment(nameRaw)
  if (stem.length === 0 || /^\d/.test(stem)) stem = `dataset_${stem}`

  if (hasOwner) {
    const owner = sanitizeDatasetIdSegment(ownerRaw) || 'workspace'
    stem = sanitizeDatasetIdSegment(`${owner}_${stem}`)
    if (stem.length === 0 || /^\d/.test(stem)) stem = `dataset_${stem}`
  }

  const hash = createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, DATASET_ID_HASH_HEX_LENGTH)
  const maxStemLength = DATASET_ID_MAX_LENGTH - DATASET_ID_HASH_SUFFIX_LENGTH
  const truncatedStem = stem.slice(0, maxStemLength).replace(/_+$/, '') || 'dataset'

  return `${truncatedStem}_${hash}`
}

/** Minimal structural table shape shared by inspected and reviewed recipe tables. */
export interface HashableTable {
  sourceFile: string
  tableId: string
  columns: readonly { name: string; type: string }[]
  sourceFormat?: string
  sourceEncoding?: string
  dateFormat?: string
  timestampFormat?: string
}

export function recipeHashFor(
  slug: string,
  sourceVersion: string,
  tables: readonly HashableTable[],
  loadStrategy: 'typed_recipe' | 'raw_then_typed' = 'typed_recipe',
): string {
  const material = tables
    .map((table) => {
      const sourceFormat = 'sourceFormat' in table ? table.sourceFormat : 'csv'
      const sourceEncoding = 'sourceEncoding' in table ? (table.sourceEncoding ?? 'utf-8') : 'utf-8'
      const dateFormat = 'dateFormat' in table ? (table.dateFormat ?? '') : ''
      const timestampFormat = 'timestampFormat' in table ? (table.timestampFormat ?? '') : ''
      return `${table.sourceFile}:${sourceFormat}:${sourceEncoding}:${dateFormat}:${timestampFormat}:${table.tableId}:${table.columns
        .map((column) => `${column.name}=${column.type}`)
        .join(',')}`
    })
    .sort()
    .join('|')
  return createHash('sha256')
    .update(`${slug}\0${sourceVersion}\0${loadStrategy}\0${material}`)
    .digest('hex')
    .slice(0, 24)
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

/**
 * Read at most `maxLines` lines off disk — never the whole file. Stops
 * reading (and destroys the underlying stream) as soon as the limit is
 * hit, so a multi-GiB extracted CSV never gets `readFile`'d, or even
 * streamed past its first `header + SAMPLE_ROW_LIMIT` rows, just to
 * propose a recipe from a bounded sample. Exported for unit testing.
 */
export async function readLinePrefix(path: string, maxLines: number): Promise<string> {
  const lines: string[] = []
  const stream = createReadStream(path, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      lines.push(line)
      if (lines.length >= maxLines) break
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return lines.join('\n')
}

export async function previewIngestSource(
  request: PreviewIngestSourceRequest,
): Promise<PreviewIngestSourceResult> {
  const slug = normalizeSourceSlug(request.slug)

  const store = new MetadataStore(request.workspace.catalogPath)
  try {
    // Already an analyst-approved workspace pin — reuse it, no re-download —
    // UNLESS it is a legacy `typed_recipe` pin: those keep strict
    // `maxRejectedRows=0` semantics and cannot be ingested adaptively, so
    // fall through and re-propose a `raw_then_typed` candidate (new pin
    // revision + fresh approval) instead of short-circuiting (adaptive
    // ingest design, "Pin / recipe compatibility").
    const existingPins = store.listWorkspaceSourcePins(slug)
    let legacySourceVersion: string | undefined
    try {
      const resolved = resolveSourcePin(slug, existingPins)
      if (effectiveLoadStrategy(resolved.recipe) !== 'typed_recipe') {
        // Re-surface the stored publisher block (still labelled unverified) so a
        // second call does not silently drop the publisher's own wording.
        const storedPublisher = resolved.recipe.publisherSupplied
        return {
          slug: resolved.slug,
          sourceVersion: resolved.sourceVersion,
          alreadyReviewed: true,
          datasetId: resolved.recipe.datasetId,
          ...(storedPublisher
            ? { publisherSupplied: modelPublisherSuppliedMetadata(storedPublisher) }
            : {}),
        }
      }
      legacySourceVersion = resolved.sourceVersion
    } catch (error) {
      if (!(error instanceof UnsupportedSourceError)) throw error
    }

    // An unreviewed candidate already covers this source: reuse it instead of
    // minting a second pending review. The scoped/paged schema view used to fall
    // through here and create its own candidate pin, so one dataset produced TWO
    // "pending review" cards and the analyst could approve the narrower one (live
    // WebUI finding on dhoogla/unswnb15: two column reviews, one of them left
    // pending against an already-published dataset). Reuse returns the proposal
    // already under review, untouched - a re-preview must never silently replace a
    // candidate the analyst may have edited - and needs no re-download.
    const requestedPreviewVersion = request.sourceVersion?.trim()
    const candidatePin = existingPins.find(
      (candidate) =>
        candidate.status === 'candidate' &&
        (!requestedPreviewVersion || candidate.sourceVersion === requestedPreviewVersion),
    )
    if (candidatePin) {
      const pagedRecipe = filterAndPageTableProposals(
        candidatePin.recipe.tables.map((table) => ({
          sourceFile: table.sourceFile,
          // The recipe documents an omitted sourceFormat as CSV for existing pins.
          sourceFormat: table.sourceFormat ?? 'csv',
          tableId: table.tableId,
          ...(table.excelSheet ? { excelSheet: table.excelSheet } : {}),
          ...(table.sourceEncoding ? { sourceEncoding: table.sourceEncoding } : {}),
          ...(table.dateFormat ? { dateFormat: table.dateFormat } : {}),
          ...(table.timestampFormat ? { timestampFormat: table.timestampFormat } : {}),
          columns: table.columns.map((column) => ({
            name: column.name,
            // The source label is the column name when the source did not differ.
            sourceName: column.sourceName ?? column.name,
            type: column.type,
            // Per-column inference evidence is not persisted on the recipe, so a
            // reused candidate states that rather than inventing a per-column claim;
            // the table-level warnings ARE persisted and ride along below.
            reason: REUSED_CANDIDATE_REASON,
          })),
          warnings: [...(table.warnings ?? [])],
        })),
        {
          tables: request.tables,
          search: request.search,
          limit: request.limit,
          offset: request.offset,
        },
      )
      const storedPublisher = candidatePin.recipe.publisherSupplied
      return {
        slug: candidatePin.slug,
        sourceVersion: candidatePin.sourceVersion,
        alreadyReviewed: false,
        // Say that this is the pending candidate rather than a fresh look at the
        // source: with no `sourceVersion` asked for, reuse pins whatever version
        // that candidate already carried, so a newer Kaggle release cannot arrive
        // by re-previewing. Naming it is what lets the caller ask for one.
        reusedCandidate: true,
        datasetId: candidatePin.recipe.datasetId,
        pinId: candidatePin.pinId,
        status: 'candidate',
        loadStrategy: effectiveLoadStrategy(candidatePin.recipe),
        tables: pagedRecipe.tables,
        license: candidatePin.recipe.license,
        ...(storedPublisher
          ? { publisherSupplied: modelPublisherSuppliedMetadata(storedPublisher) }
          : {}),
        tablesFiltered: pagedRecipe.tablesFiltered,
        columnsTruncated: pagedRecipe.columnsTruncated,
        nextOffset: pagedRecipe.nextOffset,
        totalTables: pagedRecipe.totalTables,
        totalColumns: pagedRecipe.totalColumns,
      }
    }

    // 3. Unreviewed (or legacy typed_recipe pin): download (or reuse a cached
    // archive), validate, propose. The legacy pin already pins the version, so
    // a re-proposal does not require the caller to repeat `sourceVersion`.
    let sourceVersion = (request.sourceVersion?.trim() || legacySourceVersion)?.trim()
    // Kept only as a publisher-text fallback when the CLI metadata read fails:
    // same validated payload, second use, no extra network call.
    let viewMetadataPayload: Record<string, unknown> | undefined
    if (!sourceVersion) {
      // No explicit pin and nothing already reviewed: resolve Kaggle's current
      // version so a plain "ingest <slug>" always lands on the latest data.
      // The numeric version is what gets persisted, never the string "latest".
      viewMetadataPayload = await readKagglePublicMetadataPayload(slug, {
        signal: request.signal,
        fetchImpl: request.fetchImpl,
      })
      const latest = parseKagglePublicMetadata(viewMetadataPayload, slug)
      if (latest.sourceVersion) {
        sourceVersion = latest.sourceVersion
      } else {
        throw new Error(
          `Kaggle did not report a current version for "${slug}"; pass sourceVersion explicitly (see the dataset's Kaggle page)`,
        )
      }
    }
    const destinationDir = downloadDestinationForSlug(
      request.workspace.sourcesDir,
      slug,
      sourceVersion,
    )
    let archivePath = request.localArchivePath
    if (!archivePath) archivePath = await findZipInDir(destinationDir)
    if (!archivePath) {
      await mkdir(destinationDir, { recursive: true })
      const download = await runKaggleDownload(
        { slug, sourceVersion, destinationDir },
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
      throw new Error(`Download finished but no .zip was found for "${slug}"`)
    }

    let metadata: KaggleDatasetMetadata | undefined
    // Publisher text is quoted only from a payload whose dataset identity the
    // metadata parse accepted — a payload for another dataset is never quoted.
    let cliMetadataPayload: unknown
    let provenanceStatus: 'verified' | 'version-unverified' | 'metadata-unavailable' =
      'metadata-unavailable'
    let metadataWarning: string | undefined
    try {
      cliMetadataPayload = await readKaggleDatasetMetadataPayload(
        { slug, destinationDir: join(destinationDir, 'metadata') },
        { kaggleExecutable: request.kaggleExecutable, signal: request.signal },
      )
      metadata = parseKaggleDatasetMetadata(cliMetadataPayload, slug, sourceVersion)
      if (metadata.versionVerified) {
        provenanceStatus = 'verified'
      } else {
        provenanceStatus = 'version-unverified'
        metadataWarning = metadata.observedSourceVersion
          ? `Kaggle metadata reports version ${metadata.observedSourceVersion}, not the pinned ${sourceVersion}; the observed license is unverified.`
          : `Kaggle metadata omits the version number, so pinned version ${sourceVersion} cannot be verified and the observed license is unverified. Verify the version and license on the dataset's Kaggle page.`
      }
    } catch (error) {
      cliMetadataPayload = undefined
      const errorName = error instanceof Error ? error.name : 'UnknownMetadataError'
      provenanceStatus = 'metadata-unavailable'
      metadataWarning = `Kaggle metadata is unavailable (${errorName}); version and license remain unverified.`
    }

    // `preview-extracted/` is temporary scratch space for this one preview
    // call: always removed in `finally`, whether the proposal below
    // succeeds, finds no usable CSV, or throws — never left behind as a
    // multi-GiB extract on disk.
    const extractDir = join(destinationDir, 'preview-extracted')
    let proposal: Awaited<ReturnType<typeof inspectSourceFiles>>
    let extractedEntries: Array<{ name: string; bytes: number }> = []
    try {
      const extracted = await safeExtractZip(archivePath, extractDir)
      extractedEntries = extracted.map((entry) => ({ name: entry.name, bytes: entry.bytes }))
      proposal = await inspectSourceFiles(
        extracted.map((entry) => ({
          sourceFile: entry.name,
          path: join(extractDir, entry.name),
          sizeBytes: entry.bytes,
        })),
        { signal: request.signal },
      )
    } finally {
      await rm(extractDir, { recursive: true, force: true })
    }

    if (proposal.tables.length === 0) {
      const details = proposal.unsupportedFiles
        .slice(0, 5)
        .map((file) => `${file.name}: ${file.reason}`)
        .join('; ')
      throw new Error(
        `No supported CSV, Parquet, JSON/JSONL, or Excel files could be proposed for "${slug}"${details ? ` (${details})` : ''}`,
      )
    }

    const loadStrategy = 'raw_then_typed' as const
    const datasetId = datasetIdFromSlug(slug)
    // Publisher-supplied text is captured as its own labelled block: quoted,
    // marked unverified, and stored beside (never inside) the observed column
    // proposal, so it can never be read as an observed fact or promoted into an
    // approved definition (docs/implementation.md, "Publisher-supplied text").
    const publisherSupplied =
      cliMetadataPayload === undefined && viewMetadataPayload === undefined
        ? undefined
        : parsePublisherSuppliedMetadata({
            ...(cliMetadataPayload === undefined ? {} : { cliMetadata: cliMetadataPayload }),
            ...(viewMetadataPayload === undefined ? {} : { viewApi: viewMetadataPayload }),
            proposedTables: proposal.tables.map((table) => ({
              tableId: table.tableId,
              sourceFile: table.sourceFile,
            })),
          })

    const recipe: IngestRecipe = {
      datasetId,
      recipeHash: `workspace-tabular-v2-${recipeHashFor(slug, sourceVersion, proposal.tables, loadStrategy)}`,
      importerVersion: '0.1.0',
      license: metadata?.verifiedLicense ?? null,
      sourceUrl: `https://www.kaggle.com/datasets/${slug}`,
      loadStrategy,
      ...(publisherSupplied ? { publisherSupplied } : {}),
      tables: proposal.tables.map((table) => ({
        sourceFile: table.sourceFile,
        sourceFormat: table.sourceFormat,
        tableId: table.tableId,
        ...(table.excelSheet ? { excelSheet: table.excelSheet } : {}),
        ...(table.sourceEncoding ? { sourceEncoding: table.sourceEncoding } : {}),
        ...(table.dateFormat ? { dateFormat: table.dateFormat } : {}),
        ...(table.timestampFormat ? { timestampFormat: table.timestampFormat } : {}),
        ...(table.warnings && table.warnings.length > 0 ? { warnings: [...table.warnings] } : {}),
        columns: table.columns.map((column) => ({
          name: column.name,
          sourceName: column.sourceName,
          type: column.type,
        })),
      })),
    }

    const pin = store.createWorkspaceSourcePin({
      slug,
      sourceVersion,
      recipe,
      actorId: request.actorId,
    })

    // Complete archive inventory so the analyst can see what was proposed vs
    // skipped (unsupported format, junk entry, preview cap, inspection failure)
    // — never silently dropping a small lookup table needed to interpret a
    // large fact table.
    const proposedNames = new Set(proposal.tables.map((table) => table.sourceFile))
    const skippedReason = new Map(proposal.unsupportedFiles.map((file) => [file.name, file.reason]))
    const files = extractedEntries.map((entry) =>
      proposedNames.has(entry.name)
        ? { name: entry.name, bytes: entry.bytes, status: 'proposed' as const }
        : {
            name: entry.name,
            bytes: entry.bytes,
            status: 'skipped' as const,
            ...(skippedReason.has(entry.name) ? { reason: skippedReason.get(entry.name) } : {}),
          },
    )

    const fullProposalTables: PreviewIngestTableProposal[] = proposal.tables.map((table) => ({
      sourceFile: table.sourceFile,
      sourceFormat: table.sourceFormat,
      tableId: table.tableId,
      ...(table.excelSheet ? { excelSheet: table.excelSheet } : {}),
      ...(table.sourceEncoding ? { sourceEncoding: table.sourceEncoding } : {}),
      ...(table.dateFormat ? { dateFormat: table.dateFormat } : {}),
      ...(table.timestampFormat ? { timestampFormat: table.timestampFormat } : {}),
      columns: table.columns.map((column) => ({
        name: column.name,
        sourceName: column.sourceName,
        type: column.type,
        reason: column.reason,
      })),
      warnings: table.warnings,
    }))
    const page = filterAndPageTableProposals(fullProposalTables, {
      tables: request.tables,
      search: request.search,
      limit: request.limit,
      offset: request.offset,
    })

    return {
      slug,
      sourceVersion,
      alreadyReviewed: false,
      datasetId,
      pinId: pin.pinId,
      status: 'candidate',
      loadStrategy,
      tables: page.tables,
      unsupportedFiles: proposal.unsupportedFiles,
      files,
      ...(publisherSupplied
        ? { publisherSupplied: modelPublisherSuppliedMetadata(publisherSupplied) }
        : {}),
      license: metadata?.verifiedLicense ?? null,
      observedLicense: metadata?.observedLicense ?? null,
      observedSourceVersion: metadata?.observedSourceVersion ?? null,
      licenseVersionVerified: metadata?.versionVerified ?? false,
      provenanceStatus,
      ...(metadataWarning ? { metadataWarning } : {}),
      tablesFiltered: page.tablesFiltered,
      columnsTruncated: page.columnsTruncated,
      nextOffset: page.nextOffset,
      totalTables: page.totalTables,
      totalColumns: page.totalColumns,
    }
  } finally {
    store.close()
  }
}
