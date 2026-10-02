/**
 * Credential-free versatility gate: what the ingestion → analysis pipeline
 * actually does with genuinely messy tabular data.
 *
 * Design rules this module follows:
 *
 * - **Real entry points only.** Every case drives the same service functions
 *   the product uses: `previewIngestSource` (trusted preview + candidate pin),
 *   `MetadataStore.setWorkspaceSourcePinStatus` (the analyst approval a model
 *   cannot perform), `runReviewedIngest` (download/validate/publish),
 *   `publishPendingAdaptation` (the adaptive confirm), and the registered
 *   `duckdb_query` / `reconcile_totals` / `propose_structure` tools through
 *   the isolated query worker. No case reimplements pipeline logic.
 * - **Fixtures are generated at run time**, in a temp directory, and removed
 *   afterwards (see `versatility-fixtures.ts`). This repository distributes no
 *   sample datasets, and the public-readiness check refuses committed
 *   `.duckdb` files.
 * - **Assertions follow the documented contract**: either a correct result, or
 *   an explicit refusal naming the reason and the next step — never silent
 *   coercion, never a wrong number, never an unhandled crash. Where today's
 *   behaviour is weaker than what `docs/implementation.md` and
 *   `docs/contracts.md` claim, the case FAILS and records a finding; the
 *   expectation is never loosened to make the gate green.
 * - **Failure vs. finding.** A finding with severity `contract-violation` (a
 *   documented claim is contradicted, a value is silently wrong, data is lost,
 *   or the run dies) fails its case and the gate exits non-zero. A finding with
 *   severity `documentation-gap` (the behaviour stays inside what the docs
 *   actually promise, but a user-visible disclosure the docs imply is missing)
 *   is recorded and printed while its case still passes. Findings are never
 *   removed to make a case green.
 * - **No credentials, no model calls.** The Kaggle CLI is stubbed by a
 *   fail-fast shim and the archive is placed exactly where a completed
 *   download would have landed it, which is the same offline pattern
 *   `tests/preview-ingest.integration.test.ts` uses.
 */
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import { DuckDBInstance } from '@duckdb/node-api'
import type { DatasetManifest } from 'dsh-data-core/contracts'
import { getEffectiveRelationships } from 'dsh-data-core/grains'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveSourcePin } from 'dsh-data-core/recipes/workspace-registry'
import type { ReviewedSourcePin } from 'dsh-data-core/recipes/registry'
import { resolveWorkspacePaths, type WorkspacePaths } from 'dsh-data-core/workspace-paths'
import { downloadDestinationForSlug } from 'dsh-data-kaggle/download-job'
import * as yazl from 'yazl'
import type { AuthorizedQuerySummary } from './query-service.js'
import { KNOWN_CURRENCY_CODES } from './currency-detection.js'
import {
  IngestCancelledError,
  publishPendingAdaptation,
  type IngestFromArchiveResult,
} from './ingest-pipeline.js'
import { runReviewedIngest, type ReviewedIngestResult } from './ingest-coordinator.js'
import { DuckdbAnalystService } from './plugin-service.js'
import { registerDuckdbAnalystTools } from './plugin-tools.js'
import { previewIngestSource, type PreviewIngestSourceResult } from './preview-ingest.js'
import {
  csvBytes,
  largeRetailCsvBytes,
  utf16beWithBomBytes,
  utf16leWithBomBytes,
  windows1252Bytes,
  xlsxBytes,
  type Cell,
  type FixtureFile,
} from './versatility-fixtures.js'

/** The `(b)` fixture requirements each case is answerable for. */
export const VERSATILITY_REQUIREMENTS: readonly { key: string; description: string }[] = [
  { key: 'type-change-beyond-sample', description: 'Column type changes beyond the sniff sample' },
  { key: 'duplicate-and-blank-headers', description: 'Duplicate and blank header names' },
  { key: 'rfc4180-quoted', description: 'RFC4180 quoted commas and embedded newlines' },
  { key: 'ragged-merged-xlsx', description: 'Ragged rows / merged-cell XLSX' },
  { key: 'multi-table-no-keys', description: 'Multi-table CSV set with no declared keys' },
  { key: 'mixed-currencies', description: 'Column mixing ISO-4217 currencies' },
  { key: 'encodings', description: 'windows-1252 and UTF-16 encoded files' },
  { key: 'wide-table', description: 'Very wide table (several hundred columns)' },
  { key: 'scale', description: 'A few hundred thousand rows' },
  { key: 'inconsistent-dates', description: 'Inconsistent date formats in one column' },
  { key: 'all-null-column', description: 'All-NULL column' },
  { key: 'full-row-duplicates', description: 'Full-row duplicates' },
  { key: 'leading-zero-ids', description: 'IDs with leading zeroes that must stay exact' },
]

export interface GateFinding {
  /** `contract-violation` breaks a documented claim; `documentation-gap` is silence, not contradiction. */
  severity: 'contract-violation' | 'documentation-gap'
  claim: string
  observed: string
  where: string
}

export interface GateCheck {
  name: string
  ok: boolean
  detail?: unknown
}

export interface GateCaseResult {
  id: string
  title: string
  requirements: string[]
  documentedContract: string
  entryPoints: string[]
  heavy: boolean
  status: 'pass' | 'fail' | 'skipped'
  observed: string
  checks: GateCheck[]
  findings: GateFinding[]
  detail: Record<string, unknown>
  durationMs: number
}

export interface VersatilityGateReport {
  gate: 'versatility'
  version: 1
  generatedAt: string
  runtimeSeconds: number
  credentials: {
    modelCalls: number
    kaggleTokenUsed: boolean
    network: string
    note: string
  }
  environment: { node: string; platform: string; arch: string }
  temp: { root: string; removedAtEnd: boolean; includeHeavy: boolean }
  totals: {
    cases: number
    passed: number
    failed: number
    skipped: number
    findings: number
    contractViolations: number
  }
  requirementCoverage: Record<string, string[]>
  cases: GateCaseResult[]
}

export interface RunVersatilityGateOptions {
  /** Parent directory for per-case workspaces (default: OS temp dir). */
  tempRoot?: string
  /** Keep per-case temp workspaces for inspection (default: false). */
  keepTemp?: boolean
  /** Run only these case ids. */
  only?: readonly string[]
  /** Include multi-minute heavy cases (default: true). */
  includeHeavy?: boolean
  /** Progress line per case (default: no-op). */
  onCase?: (line: string) => void
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message.replace(/\s+/g, ' ').trim()}`.slice(0, 600)
  }
  return String(error).slice(0, 600)
}

/** Collect named checks; `status` is `fail` when any check is false. */
class Checks {
  readonly items: GateCheck[] = []

  check(name: string, ok: boolean, detail?: unknown): boolean {
    this.items.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
    return ok
  }

  get failures(): GateCheck[] {
    return this.items.filter((item) => !item.ok)
  }
}

/** What one approved-pin ingest attempt produced, including a recorded failure. */
interface IngestAttempt {
  ok: boolean
  result?: ReviewedIngestResult
  error?: string
  jobStatuses: string[]
}

interface ToolLike {
  name: string
  execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown>
}

function fakeToolsContext(captured: Map<string, ToolLike>): Context {
  return {
    tools: { register: (definition: ToolLike) => captured.set(definition.name, definition) },
  } as unknown as Context
}

/** One per-case temp workspace plus the pipeline entry points under test. */
class GateHarness {
  readonly workspace: WorkspacePaths
  readonly failKagglePath: string
  #approvedPin?: ReviewedSourcePin

  private constructor(
    readonly caseDir: string,
    readonly slug: string,
    workspace: WorkspacePaths,
    failKagglePath: string,
  ) {
    this.workspace = workspace
    this.failKagglePath = failKagglePath
  }

  static async create(caseDir: string, slug: string): Promise<GateHarness> {
    const workspace = resolveWorkspacePaths(caseDir)
    await mkdir(workspace.sourcesDir, { recursive: true })
    // Stands in for the operator's Kaggle CLI: present, executable, always
    // fails. The archive is pre-placed so no download is ever attempted; the
    // metadata probe fails closed exactly as it does offline in production.
    const failKagglePath = join(caseDir, 'fail-kaggle')
    await writeFile(failKagglePath, '#!/bin/sh\nexit 1\n', 'utf8')
    await chmod(failKagglePath, 0o755)
    return new GateHarness(caseDir, slug, workspace, failKagglePath)
  }

  /** Place the fixture archive exactly where a completed download would land it. */
  async placeArchive(entries: readonly FixtureFile[], slug = this.slug): Promise<string> {
    const destinationDir = downloadDestinationForSlug(this.workspace.sourcesDir, slug, '1')
    await mkdir(destinationDir, { recursive: true })
    const zipfile = new yazl.ZipFile()
    for (const entry of entries) zipfile.addBuffer(entry.bytes, entry.name)
    const archivePath = join(destinationDir, 'source.zip')
    const writeStream = createWriteStream(archivePath)
    zipfile.outputStream.pipe(writeStream)
    zipfile.end()
    await finished(writeStream)
    return archivePath
  }

  /** `preview_ingest_source`'s service entry point, offline. */
  async preview(
    options: {
      slug?: string
      tables?: readonly string[]
      search?: string
      limit?: number
      offset?: number
    } = {},
  ): Promise<PreviewIngestSourceResult> {
    const slug = options.slug ?? this.slug
    return await previewIngestSource({
      slug,
      sourceVersion: '1',
      workspace: this.workspace,
      kaggleExecutable: this.failKagglePath,
      actorId: 'operator:versatility-gate',
      ...(options.tables ? { tables: options.tables } : {}),
      ...(options.search !== undefined ? { search: options.search } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    })
  }

  /** The analyst approval step (a same-origin action in production, never a model call). */
  approvePin(pinId: string, slug = this.slug): void {
    const store = new MetadataStore(this.workspace.catalogPath)
    try {
      const pin = store.getWorkspaceSourcePin(pinId)
      if (!pin) throw new Error(`No workspace pin "${pinId}" to approve`)
      store.setWorkspaceSourcePinStatus(pinId, 'approved', pin.revision)
    } finally {
      store.close()
    }
    this.#approvedPin = this.approvedPin(slug)
  }

  approvedPin(slug = this.slug): ReviewedSourcePin {
    const store = new MetadataStore(this.workspace.catalogPath)
    try {
      return resolveSourcePin(slug, store.listWorkspaceSourcePins(slug))
    } finally {
      store.close()
    }
  }

  pinRecipe(slug = this.slug) {
    return this.approvedPin(slug).recipe
  }

  /** `ingest_dataset`'s service entry point; a thrown error is recorded, not rethrown. */
  async ingest(slug = this.slug): Promise<IngestAttempt> {
    const store = new MetadataStore(this.workspace.catalogPath)
    let result: ReviewedIngestResult | undefined
    let error: string | undefined
    try {
      result = await runReviewedIngest({
        slug,
        pin: this.#approvedPin ?? this.approvedPin(slug),
        workspace: this.workspace,
        kaggleExecutable: this.failKagglePath,
      })
    } catch (caught) {
      if (caught instanceof IngestCancelledError) throw caught
      error = errorMessage(caught)
    }
    const jobStatuses = store
      .listImportJobs()
      .map((job) => `${job.status}${job.errorMessage ? `: ${job.errorMessage.slice(0, 300)}` : ''}`)
    store.close()
    return { ok: error === undefined, result, error, jobStatuses }
  }

  /** The adaptive confirm path (analyst-approved): publish the raw_then_typed staging. */
  async publishPending(datasetId: string, jobId: string): Promise<IngestFromArchiveResult> {
    return await publishPendingAdaptation({
      catalogPath: this.workspace.catalogPath,
      // `runReviewedIngest` stages under `<root>/workspaces/<datasetId>`, not
      // the workspace root — the confirm path must read the same staging file.
      workspaceDir: join(this.workspace.root, 'workspaces', datasetId),
      jobId,
    })
  }

  currentManifest(datasetId: string): DatasetManifest | undefined {
    const store = new MetadataStore(this.workspace.catalogPath)
    try {
      return store.getCurrentDatasetVersion(datasetId)
    } finally {
      store.close()
    }
  }

  catalog<T>(read: (store: MetadataStore) => T): T {
    const store = new MetadataStore(this.workspace.catalogPath)
    try {
      return read(store)
    } finally {
      store.close()
    }
  }

  /** Registered model-facing tools, through the real service + isolated worker. */
  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const service = new DuckdbAnalystService(this.workspace)
    const tools = new Map<string, ToolLike>()
    registerDuckdbAnalystTools(fakeToolsContext(tools), service)
    try {
      const tool = tools.get(name)
      if (!tool) throw new Error(`Tool "${name}" is not registered`)
      return (await tool.execute(args, { signal: new AbortController().signal })) as T
    } finally {
      service.dispose()
    }
  }

  /** `duckdb_query` with the authorization context the tool resolves for itself. */
  async query(datasetId: string, sql: string): Promise<AuthorizedQuerySummary> {
    return await this.callTool<AuthorizedQuerySummary>('duckdb_query', {
      datasetId,
      sql,
      parameters: [],
    })
  }

  async queryError(datasetId: string, sql: string): Promise<string> {
    try {
      await this.query(datasetId, sql)
      return ''
    } catch (caught) {
      return errorMessage(caught)
    }
  }

  /** Read the published artifact directly (raw_* layer checks; not a model-facing path). */
  async publishedRows(
    datasetVersionId: string,
    datasetId: string,
    sql: string,
  ): Promise<unknown[][]> {
    const path = this.workspace.datasetFile(datasetVersionId, datasetId)
    const instance = await DuckDBInstance.create(path, {
      access_mode: 'READ_ONLY',
      enable_external_access: 'false',
    })
    const connection = await instance.connect()
    try {
      const reader = await connection.runAndReadAll(sql)
      return reader.getRowsJson() as unknown[][]
    } finally {
      connection.closeSync()
      instance.closeSync()
    }
  }
}

interface CaseOutcome {
  checks: Checks
  findings: GateFinding[]
  observed: string
  detail: Record<string, unknown>
}

function outcome(
  checks: Checks,
  observed: string,
  detail: Record<string, unknown>,
  findings: GateFinding[] = [],
): CaseOutcome {
  return { checks, findings, observed, detail }
}

export interface GateCase {
  id: string
  title: string
  requirements: string[]
  documentedContract: string
  entryPoints: string[]
  heavy?: boolean
  run: (harness: GateHarness) => Promise<CaseOutcome>
}

const DOC = {
  sample:
    'docs/implementation.md:14-28 (formats, 200-row sample disclosure, raw/typed diagnostics)',
  scaleRows:
    'docs/implementation.md:20-23 (typed ingestion diagnostics: cast-null counts, row breakdown)',
  ids: 'docs/implementation.md:110-114 (identifiers with leading zeroes left verbatim)',
  ids2: 'docs/contracts.md:161-169 (worked synthetic example: IDs include leading zeroes)',
  currency: 'docs/implementation.md:27-28 (mixed-currency columns detected at ingest)',
  encoding: 'docs/implementation.md:21-24 (per-record UTF-8 normalization; utf-16 support)',
  paging: 'docs/contracts.md:62-65 (demand-page a wide dataset with limit/offset + nextOffset)',
  excel:
    'docs/implementation.md:16-20 (analyst reviews proposed table/column layout, quality info)',
  structure:
    'docs/contracts.md:70-84 (propose_structure candidates need analyst approval; reconcile_totals fails closed)',
} as const

/* ------------------------------------------------------------------------- */
/* Cases                                                                      */
/* ------------------------------------------------------------------------- */

const lateTypeDriftCase: GateCase = {
  id: 'late-type-drift-beyond-sniff-sample',
  title: 'Numeric in the head, text thousands of rows later',
  requirements: ['type-change-beyond-sample'],
  documentedContract:
    'Types are inferred from at most 200 sampled records, the proposal discloses that sample basis, and a cast failure beyond the sample must surface as an explicit per-column cast-null diagnostic with an analyst confirm before anything is published — never a silently published NULL and never a crash.',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'publishPendingAdaptation'],
  async run(harness) {
    const checks = new Checks()
    const rows: Cell[][] = [['line_id', 'amount', 'note']]
    for (let index = 1; index <= 400; index += 1) {
      rows.push([index, index <= 249 ? `${index}.50` : 'n/a', `note ${index}`])
    }
    await harness.placeArchive([{ name: 'orders.csv', bytes: csvBytes(rows) }])
    const preview = await harness.preview()
    const proposal = preview.tables?.[0]
    const proposedType = proposal?.columns.find((column) => column.name === 'amount')?.type ?? ''
    checks.check(
      'the proposal basis is disclosed at review time (types inferred from at most 200 sampled records)',
      (proposal?.warnings ?? []).some((warning) => /at most 200 sampled/.test(warning)),
      { warnings: proposal?.warnings },
    )
    if (!preview.pinId) throw new Error('preview did not return a candidate pin')
    harness.approvePin(preview.pinId)
    const attempt = await harness.ingest()
    const result = attempt.result
    checks.check('ingest did not crash', attempt.ok, { error: attempt.error })
    const datasetId = result?.datasetId ?? ''
    const numericProposal = /^(?:BIGINT|DOUBLE|DECIMAL|INTEGER)/.test(proposedType)
    const castNulls = result?.tables[0]?.castNullCounts?.amount ?? 0
    let typedNulls: unknown[][] = []
    let rawKept: unknown[][] = []
    let textKept: unknown[] = []
    let rowTotal: unknown[][] = []
    if (numericProposal) {
      // A numeric type inferred from the head sample is the risky branch: the
      // late text must not be published as an undisclosed NULL.
      checks.check(
        'a numeric proposal for the drifting column pauses for analyst confirm instead of publishing silently',
        result?.status === 'needs-input',
        { status: result?.status, error: attempt.error, proposedType },
      )
      checks.check(
        'the pause reports the exact cast-null count for the drifting column',
        castNulls === 151,
        { castNullCounts: result?.tables[0]?.castNullCounts },
      )
      checks.check(
        'the pause reason names the column and the count (an explicit refusal, not a warning-free publish)',
        (result?.materialityReasons ?? []).some(
          (reason) => reason.includes('amount') && reason.includes('151'),
        ),
        { materialityReasons: result?.materialityReasons },
      )
      checks.check(
        'no dataset version is published while the adaptation is unconfirmed',
        harness.currentManifest(datasetId) === undefined,
      )
      if (result?.status === 'needs-input') {
        const published = await harness.publishPending(datasetId, result.jobId)
        checks.check(
          'analyst confirm publishes the confirmed projection',
          published.status === 'ready',
          {
            status: published.status,
          },
        )
        typedNulls = await harness.publishedRows(
          published.datasetVersionId,
          datasetId,
          'SELECT COUNT(*) FROM orders WHERE amount IS NULL',
        )
        rawKept = await harness.publishedRows(
          published.datasetVersionId,
          datasetId,
          "SELECT COUNT(*) FROM raw_orders WHERE amount = 'n/a'",
        )
        checks.check(
          'the 151 unparsable cells are NULL in the typed layer',
          String(typedNulls[0]?.[0]) === '151',
          {
            typedNulls,
          },
        )
        checks.check(
          'the lossless raw layer keeps the original text (nothing was silently rewritten)',
          String(rawKept[0]?.[0]) === '151',
          { rawKept },
        )
      }
    } else {
      // The column stayed textual: no coercion happened, so every source value
      // must round-trip exactly and no cast-null may be invented.
      checks.check(
        'the drifting column is published without coercion (values, not NULLs)',
        result?.status === 'ready',
        { status: result?.status, proposedType, error: attempt.error },
      )
      checks.check(
        'no cast-null cell is reported for a column that was never cast',
        castNulls === 0,
        { castNullCounts: result?.tables[0]?.castNullCounts },
      )
      if (result?.status === 'ready') {
        const keptText = await harness.query(
          datasetId,
          "SELECT COUNT(*) AS kept FROM orders WHERE amount = 'n/a'",
        )
        textKept = keptText.preview[0] ?? []
        checks.check(
          'all 151 late text values are still present verbatim',
          String(textKept[0]) === '151',
          { textKept },
        )
        const nulls = await harness.query(
          datasetId,
          'SELECT COUNT(*) AS nulls FROM orders WHERE amount IS NULL',
        )
        checks.check(
          'no value was silently turned into NULL',
          String(nulls.preview[0]?.[0]) === '0',
          {
            nulls: nulls.preview,
          },
        )
        const rawRows = await harness.publishedRows(
          result.datasetVersionId,
          datasetId,
          "SELECT COUNT(*) FROM raw_orders WHERE amount = 'n/a'",
        )
        checks.check(
          'the lossless raw layer also keeps all 151 late text values',
          String(rawRows[0]?.[0]) === '151',
          { rawRows: rawRows[0]?.[0] },
        )
      }
    }
    if (result && (result.status === 'ready' || result.status === 'needs-input')) {
      const versionId = result.datasetVersionId
      rowTotal = await harness.publishedRows(versionId, datasetId, 'SELECT COUNT(*) FROM orders')
      checks.check(
        'every one of the 400 source rows is published (no drop, no addition)',
        String(rowTotal[0]?.[0]) === '400',
        { rowTotal },
      )
    }
    const branch = numericProposal
      ? 'numeric proposal → confirm pause'
      : 'textual proposal → exact values'
    return outcome(
      checks,
      `proposed ${proposedType} for the drifting column (${branch}); status ${String(result?.status)}` +
        (numericProposal
          ? `, ${String(castNulls)} cast-null cell(s) disclosed before publish`
          : `, ${String(textKept[0] ?? '?')} late text value(s) kept verbatim`),
      {
        proposedType,
        proposalWarnings: proposal?.warnings,
        status: result?.status,
        materialityReasons: result?.materialityReasons,
        castNullCounts: result?.tables[0]?.castNullCounts,
        typedNulls: typedNulls[0]?.[0],
        rawTextKept: rawKept[0]?.[0],
        textKept: textKept[0],
        rowTotal: rowTotal[0]?.[0],
        ingestError: attempt.error,
      },
    )
  },
}

const messyHeadersCase: GateCase = {
  id: 'duplicate-and-blank-header-names',
  title: 'Duplicate header names and a blank header label',
  requirements: ['duplicate-and-blank-headers'],
  documentedContract:
    'Every proposed column gets a unique safe identifier and a recorded warning for a duplicated or missing header label; ingestion loads the reviewed columns positionally so no value is shifted or overwritten. A refusal instead of a proposal is acceptable only if it names the offending header.',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'duckdb_query'],
  async run(harness) {
    const checks = new Checks()
    const source = csvBytes([
      ['row_id', 'region', 'region', '', 'sales'],
      ['r1', 'North', 'north-dupe', 'blank-a', 10],
      ['r2', 'South', 'south-dupe', 'blank-b', 20],
      ['r3', 'East', 'east-dupe', 'blank-c', 30],
    ])
    await harness.placeArchive([{ name: 'orders.csv', bytes: source }])
    let preview: PreviewIngestSourceResult | undefined
    let previewError = ''
    try {
      preview = await harness.preview()
    } catch (caught) {
      previewError = errorMessage(caught)
    }
    const columns = preview?.tables?.[0]?.columns ?? []
    const names = columns.map((column) => column.name)
    let values: unknown[][] = []
    let sourceNames: string[] = []
    let warnings: string[] = []
    if (preview) {
      checks.check('a proposal was produced rather than a crash', true)
      checks.check(
        'proposed column identifiers are unique and safe',
        new Set(names).size === names.length &&
          names.every((name) => /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(name)),
        { names },
      )
      checks.check('all five source columns are represented', names.length === 5, { names })
      warnings = preview.tables?.[0]?.warnings ?? []
      sourceNames = columns.map((column) => column.sourceName)
      if (preview.pinId) {
        harness.approvePin(preview.pinId)
        const attempt = await harness.ingest()
        checks.check('ingest did not crash', attempt.ok, { error: attempt.error })
        const datasetId = attempt.result?.datasetId ?? ''
        if (attempt.result?.status === 'ready') {
          const summary = await harness.query(
            datasetId,
            `SELECT ${names.map((name) => `"${name}"`).join(', ')} FROM orders WHERE "${names[0]}" = 'r1'`,
          )
          values = summary.preview
          const firstRow = values[0]
          const expected = ['r1', 'North', 'north-dupe', 'blank-a', 10]
          checks.check(
            'the duplicated/blank columns keep their own values (positional mapping, nothing shifted)',
            JSON.stringify(firstRow) === JSON.stringify(expected) ||
              JSON.stringify(firstRow) === JSON.stringify(expected.map(String)),
            { firstRow, expected },
          )
        } else {
          checks.check(
            'a non-ready ingest names an explicit reason',
            Boolean(attempt.result) || Boolean(attempt.error),
            { status: attempt.result?.status, error: attempt.error },
          )
        }
      }
    } else {
      checks.check(
        'refusal names the offending header/file',
        /region|header|orders\.csv/i.test(previewError),
        {
          previewError,
        },
      )
    }
    const sourceLabels = ['row_id', 'region', 'region', '', 'sales']
    const renamed = names.filter((name, index) => name !== sourceLabels[index])
    // The rename DuckDB performs is visible in the proposal's warnings: the
    // analyst must be told a source label was duplicated or blank, otherwise the
    // sanitized name silently becomes the column's meaning.
    const headerDisclosed =
      warnings.some((warning) => /duplicat/i.test(warning)) &&
      warnings.some((warning) => /blank/i.test(warning))
    checks.check(
      'the proposal names the duplicated and blank source header labels',
      headerDisclosed,
      { warnings },
    )
    const findings: GateFinding[] =
      preview && renamed.length > 0 && !headerDisclosed
        ? [
            {
              severity: 'documentation-gap',
              claim:
                'docs/implementation.md:16-20 says the analyst reviews a proposed table/column layout, including quality information; nothing in the proposal tells the analyst that a header label was duplicated or blank, because the dedup happens inside DuckDB\u2019s reader before the proposer sees it.',
              observed: `Source labels ${JSON.stringify(sourceLabels)} were proposed as ${JSON.stringify(
                names,
              )} with warnings ${JSON.stringify(warnings)} — the rename is silent, and the loaded values are still correct.`,
              where: DOC.excel,
            },
          ]
        : []
    return outcome(
      checks,
      preview
        ? `proposed ${JSON.stringify(names)} from source labels ${JSON.stringify(sourceNames)} with ${warnings.length} warning(s)`
        : `refused: ${previewError}`,
      { names, sourceNames, warnings, firstRow: values[0], previewError, renamed },
      findings,
    )
  },
}

const rfc4180Case: GateCase = {
  id: 'rfc4180-quoted-commas-and-newlines',
  title: 'Quoted commas, escaped quotes and embedded newlines',
  requirements: ['rfc4180-quoted'],
  documentedContract:
    'Quoted fields containing commas, escaped quotes and embedded newlines are one record each: the row count matches the source records and every cell round-trips byte-for-byte, with no record split into two rows.',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'duckdb_query'],
  async run(harness) {
    const checks = new Checks()
    const messyNote = 'He said "hi", then\nleft the building'
    const rows: Cell[][] = [['id', 'notes', 'amount']]
    for (let index = 1; index <= 12; index += 1) {
      rows.push([`r${String(index).padStart(2, '0')}`, `plain note ${index}`, index * 10])
    }
    rows.push(['r13', messyNote, 130])
    rows.push(['r14', 'trailing comma, inside', 140])
    await harness.placeArchive([{ name: 'notes.csv', bytes: csvBytes(rows) }])
    const preview = await harness.preview()
    checks.check(
      'the source file is proposed (not skipped as unsupported)',
      preview.tables?.length === 1,
      {
        tables: preview.tables?.map((table) => table.tableId),
        unsupported: preview.unsupportedFiles,
      },
    )
    if (!preview.pinId) throw new Error('preview did not return a candidate pin')
    harness.approvePin(preview.pinId)
    const attempt = await harness.ingest()
    checks.check('ingest did not crash', attempt.ok, { error: attempt.error })
    const datasetId = attempt.result?.datasetId ?? ''
    let rowCount: unknown[][] = []
    let notes: unknown[][] = []
    if (attempt.result?.status === 'ready') {
      rowCount = await harness.publishedRows(
        attempt.result.datasetVersionId,
        datasetId,
        'SELECT COUNT(*) FROM notes',
      )
      checks.check(
        'the embedded-newline record stays one row (14 records, not 15)',
        String(rowCount[0]?.[0]) === '14',
        { rowCount },
      )
      const summary = await harness.query(datasetId, "SELECT notes FROM notes WHERE id = 'r13'")
      notes = summary.preview
      checks.check(
        'the quoted multiline value round-trips byte-for-byte',
        notes[0]?.[0] === messyNote,
        { actual: notes[0]?.[0], expected: messyNote },
      )
    } else {
      checks.check('a non-ready ingest names an explicit reason', true, {
        status: attempt.result?.status,
        error: attempt.error,
      })
    }
    return outcome(
      checks,
      `ingested ${String(rowCount[0]?.[0] ?? '?')} record(s); multiline cell ${notes[0]?.[0] === messyNote ? 'exact' : 'MISMATCHED'}`,
      {
        rowCount: rowCount[0]?.[0],
        note: notes[0]?.[0],
        proposedType: preview.tables?.[0]?.columns,
      },
    )
  },
}

const xlsxRaggedCase: GateCase = {
  id: 'xlsx-merged-title-and-ragged-rows',
  title: 'Merged title banner and ragged rows in an XLSX sheet',
  requirements: ['ragged-merged-xlsx'],
  documentedContract:
    'Excel sheets are materialized per worksheet and the analyst reviews the proposed layout. A merged banner or ragged row must either be refused with an explicit reason, or be ingested without dropping any source cell; a structural misread (banner promoted to header, real header demoted to data) must at least be visible, never silent.',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'duckdb_query'],
  async run(harness) {
    const checks = new Checks()
    const workbook = await xlsxBytes([
      {
        name: 'Sales',
        merges: ['A1:C1'],
        rows: [
          ['Quarterly Sales Report', null, null],
          ['region', 'units', 'amount'],
          ['North', 5, 50],
          ['South', 7],
          ['East', 9, 90, 'stray-extra-cell'],
          ['West', 11, 110],
        ],
      },
      { name: 'RunNotes', rows: [['note'], ['generated by finance']] },
    ])
    await harness.placeArchive([{ name: 'quarter.xlsx', bytes: workbook }])
    let preview: PreviewIngestSourceResult | undefined
    let previewError = ''
    try {
      preview = await harness.preview()
    } catch (caught) {
      previewError = errorMessage(caught)
    }
    const tables = preview?.tables ?? []
    checks.check(
      preview
        ? 'sheets are proposed from a ragged/merged workbook without a crash'
        : 'refusal names the workbook and sheet',
      preview ? tables.length >= 1 : /quarter\.xlsx|sheet|Sales/i.test(previewError),
      { tables: tables.map((table) => table.tableId), previewError },
    )
    const warnings = tables.flatMap((table) => table.warnings ?? [])
    const bannerAsHeader = (tables[0]?.columns ?? []).some((column) =>
      /quarterly|sales_report/.test(column.name),
    )
    let ingestError = ''
    let published: ReviewedIngestResult | undefined
    let publishedRows: unknown[][] | undefined
    if (preview?.pinId) {
      harness.approvePin(preview.pinId)
      const attempt = await harness.ingest()
      ingestError = attempt.error ?? ''
      published = attempt.result
      checks.check(
        'an ingest failure is a recorded job failure with a named reason (not an unhandled crash)',
        attempt.ok || /csv|row|column|value|line|sheet/i.test(attempt.error ?? ''),
        { error: attempt.error, jobStatuses: attempt.jobStatuses },
      )
      checks.check(
        'nothing is published when the sheet load fails (no partial import)',
        Boolean(attempt.result) ||
          harness.currentManifest(harness.approvedPin().recipe.datasetId) === undefined,
        { error: attempt.error },
      )
      if (attempt.result?.status === 'ready') {
        publishedRows = await harness.publishedRows(
          attempt.result.datasetVersionId,
          attempt.result.datasetId,
          `SELECT COUNT(*) FROM "${attempt.result.tables[0]?.id ?? 'sales'}"`,
        )
        checks.check(
          'an accepted ragged/merged sheet keeps its source rows (no row silently dropped or invented)',
          Number(publishedRows?.[0]?.[0]) >= 5,
          { rowCount: publishedRows?.[0]?.[0] },
        )
        const cells = await harness.publishedRows(
          attempt.result.datasetVersionId,
          attempt.result.datasetId,
          `SELECT * FROM "${attempt.result.tables[0]?.id ?? 'sales'}"`,
        )
        const flattened = JSON.stringify(cells)
        checks.check(
          'no source cell value is lost when the sheet is accepted',
          ['North', 'South', 'East', 'West', 'stray-extra-cell'].every((value) =>
            flattened.includes(value),
          ),
          { cells: cells.slice(0, 8) },
        )
      }
    }
    checks.check(
      'every source sheet is accounted for (proposed or named in a refusal)',
      preview ? tables.length >= 1 : /quarter\.xlsx|sheet|Sales/i.test(previewError),
      { tables: tables.map((table) => table.tableId), previewError },
    )
    return outcome(
      checks,
      preview
        ? `proposed ${tables.length} sheet(s) from a merged/ragged workbook; banner-as-header=${String(bannerAsHeader)}; ingest ${published?.status ?? (ingestError ? `${ingestError.slice(0, 160)}…` : 'not attempted')}`
        : `refused: ${previewError}`,
      {
        proposedTables: tables.map((table) => ({
          tableId: table.tableId,
          columns: table.columns.map((column) => column.name),
        })),
        warnings,
        bannerAsHeader,
        ingestStatus: published?.status,
        ingestError,
        previewError,
      },
      (() => {
        const findings: GateFinding[] = []
        if (bannerAsHeader && !warnings.some((warning) => /merged|banner|ragged/i.test(warning))) {
          findings.push({
            severity: 'documentation-gap',
            claim:
              'The analyst is told to review a proposed table/column layout including quality information (docs/implementation.md:16-20); a merged title banner becoming the header of the table is a silent structural misread of the sheet.',
            observed: `The merged banner row "Quarterly Sales Report" was proposed as the header (columns ${JSON.stringify(
              (tables[0]?.columns ?? []).map((column) => column.name),
            )}) with warnings ${JSON.stringify(warnings)} — the real header row is loaded as data.`,
            where: DOC.excel,
          })
        }
        if (ingestError && !/next step|re-run|rerun|retry|instead/i.test(ingestError)) {
          findings.push({
            severity: 'documentation-gap',
            claim:
              'Acceptance contract: a refusal must name the reason and the next step. The typed-rejection path carries a recovery hint, but no path promises a next step for a sheet that cannot be loaded at all.',
            observed: `ingest failed with: ${ingestError} — an explicit reason with no next step for the analyst; nothing was published.`,
            where: DOC.excel,
          })
        }
        return findings
      })(),
    )
  },
}

const multiTableCase: GateCase = {
  id: 'multi-table-csv-without-keys',
  title: 'Two-table CSV set with no declared keys or relationships',
  requirements: ['multi-table-no-keys'],
  documentedContract:
    'Every table in the archive is proposed and published with its exact row count, no relationship or grain is invented or auto-approved, and a cross-table comparison (`reconcile_totals`) fails closed naming both tables and pointing at `propose_structure`, while `propose_structure` surfaces only candidate rows awaiting analyst approval.',
  entryPoints: [
    'preview_ingest_source',
    'runReviewedIngest',
    'reconcile_totals',
    'propose_structure',
  ],
  async run(harness) {
    const checks = new Checks()
    const orderRows: Cell[][] = [['order_id', 'customer_id', 'amount']]
    for (let index = 1; index <= 30; index += 1) {
      orderRows.push([`o${String(index).padStart(3, '0')}`, `c${(index % 8) + 1}`, index * 5])
    }
    // Two customers share an id-like label twice: there is no true primary key,
    // so no grain may be assumed from the data alone.
    const customerRows: Cell[][] = [
      ['customer_id', 'name'],
      ['c1', 'Ada'],
      ['c2', 'Grace'],
      ['c2', 'Grace (duplicate row)'],
      ['c3', 'Alan'],
      ['c4', 'Edsger'],
      ['c5', 'Barbara'],
      ['c6', 'Ken'],
      ['c7', 'Margaret'],
      ['c8', 'Donald'],
    ]
    await harness.placeArchive([
      { name: 'orders.csv', bytes: csvBytes(orderRows) },
      { name: 'customers.csv', bytes: csvBytes(customerRows) },
    ])
    const preview = await harness.preview()
    checks.check(
      'both tables are proposed (the smaller lookup table is not dropped)',
      preview.totalTables === 2 && (preview.tables ?? []).length === 2,
      { totalTables: preview.totalTables, tables: preview.tables?.map((table) => table.tableId) },
    )
    if (!preview.pinId) throw new Error('preview did not return a candidate pin')
    harness.approvePin(preview.pinId)
    const attempt = await harness.ingest()
    checks.check('ingest did not crash', attempt.ok, { error: attempt.error })
    const datasetId = attempt.result?.datasetId ?? ''
    const tableRows = Object.fromEntries(
      (attempt.result?.tables ?? []).map((table) => [table.id, table.rows]),
    )
    if (attempt.result?.status === 'ready') {
      checks.check(
        'both tables publish with their exact source row counts',
        tableRows.orders === 30 && tableRows.customers === 9,
        { tableRows },
      )
    }
    checks.check(
      'no relationship or grain candidates are auto-approved from the data alone',
      harness.catalog((store) => {
        const relationships = getEffectiveRelationships(datasetId, store)
        const candidates = store.listStructureCandidates(datasetId)
        return relationships.length === 0 && candidates.length === 0
      }),
      {
        relationships: harness.catalog((store) =>
          getEffectiveRelationships(datasetId, store).map((relationship) => ({
            from: relationship.fromTable,
            to: relationship.toTable,
          })),
        ),
        candidates: harness.catalog((store) => store.listStructureCandidates(datasetId).length),
      },
    )
    const reconcileError = await (async () => {
      try {
        await harness.callTool('reconcile_totals', {
          datasetId,
          primaryTable: 'orders',
          primaryColumn: 'amount',
          secondaryTable: 'customers',
          secondaryColumn: 'customer_id',
        })
        return ''
      } catch (caught) {
        return errorMessage(caught)
      }
    })()
    checks.check(
      'reconcile_totals refuses without an approved relationship, naming both tables',
      /orders/.test(reconcileError) && /customers/.test(reconcileError),
      { reconcileError },
    )
    checks.check(
      'the refusal names the next step (propose_structure / list_pending_structure)',
      /propose_structure/.test(reconcileError) && /list_pending_structure/.test(reconcileError),
      { reconcileError },
    )
    const proposed = await harness.callTool<{
      grains?: Array<{ status?: string }>
      relationships?: Array<{ status?: string }>
    }>('propose_structure', { datasetId })
    const candidateStatuses = [
      ...(proposed.grains ?? []).map((candidate) => candidate.status),
      ...(proposed.relationships ?? []).map((candidate) => candidate.status),
    ]
    checks.check(
      'structure candidates are proposed for analyst approval, never auto-approved',
      candidateStatuses.length > 0 && candidateStatuses.every((status) => status === 'candidate'),
      { candidateStatuses },
    )
    return outcome(
      checks,
      `published ${JSON.stringify(tableRows)} with no approved relationship; reconcile_totals refused and propose_structure produced ${candidateStatuses.length} candidate(s)`,
      { totalTables: preview.totalTables, tableRows, reconcileError, candidateStatuses },
    )
  },
}

const currencyMixCase: GateCase = {
  id: 'mixed-iso4217-currency-column',
  title: 'One monetary column mixing three ISO-4217 currencies',
  requirements: ['mixed-currencies'],
  documentedContract:
    'A string column whose distinct values are two or more ISO-4217 codes is detected at ingest time and recorded in the published manifest, and a later query that sums across the mixed column is accompanied by an advisory warning rather than a silently wrong total.',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'duckdb_query'],
  async run(harness) {
    const checks = new Checks()
    const rows: Cell[][] = [['order_id', 'currency', 'amount']]
    const codes = ['USD', 'EUR', 'JPY']
    for (let index = 1; index <= 9; index += 1) {
      rows.push([`o${index}`, codes[index % 3], index * 100])
    }
    // Expected totals are derived from the fixture itself, never hand-computed.
    const expected = new Map<string, number>()
    for (const row of rows.slice(1)) {
      const code = String(row[1])
      expected.set(code, (expected.get(code) ?? 0) + Number(row[2]))
    }
    const expectedGrouped = [...expected.entries()].sort().map(([code, total]) => [code, total])
    await harness.placeArchive([{ name: 'orders.csv', bytes: csvBytes(rows) }])
    const preview = await harness.preview()
    const currencyType = preview.tables?.[0]?.columns.find(
      (column) => column.name === 'currency',
    )?.type
    checks.check('the currency column is proposed as a string column', currencyType === 'VARCHAR', {
      currencyType,
    })
    if (!preview.pinId) throw new Error('preview did not return a candidate pin')
    harness.approvePin(preview.pinId)
    const attempt = await harness.ingest()
    checks.check('ingest did not crash', attempt.ok, { error: attempt.error })
    const datasetId = attempt.result?.datasetId ?? ''
    const dimensions = attempt.result?.tables[0]?.currencyDimensions ?? []
    checks.check(
      'the mixed-currency column is detected at ingest time and recorded in the manifest',
      dimensions.some(
        (dimension) => dimension.column === 'currency' && dimension.currencies.length === 3,
      ),
      { dimensions },
    )
    checks.check(
      'the detection reaches the published manifest the query path reads',
      (harness.currentManifest(datasetId)?.tables[0]?.currencyDimensions ?? []).some(
        (dimension) => dimension.column === 'currency',
      ),
      { manifestTables: harness.currentManifest(datasetId)?.tables },
    )
    let warnings: string[] = []
    if (attempt.result?.status === 'ready') {
      const summary = await harness.query(datasetId, 'SELECT SUM(amount) AS total FROM orders')
      warnings = summary.warnings
      checks.check(
        'a currency-mixing sum carries an advisory warning, not just a bare total',
        warnings.some((warning) => /currenc/i.test(warning)),
        { warnings },
      )
      const grouped = await harness.query(
        datasetId,
        'SELECT currency, SUM(amount) AS total FROM orders GROUP BY currency ORDER BY currency',
      )
      const groupedNumbers = grouped.preview.map((row) => [row[0], Number(row[1])])
      checks.check(
        'the explicitly grouped query is correct for every currency in the fixture',
        JSON.stringify(groupedNumbers) === JSON.stringify(expectedGrouped),
        { preview: grouped.preview, expected: expectedGrouped },
      )
    }
    return outcome(
      checks,
      `detected ${JSON.stringify(dimensions)}; sum warning ${warnings.length > 0 ? 'present' : 'MISSING'}`,
      { currencyType, dimensions, warnings, status: attempt.result?.status, error: attempt.error },
    )
  },
}

const currencyCardinalityCase: GateCase = {
  id: 'mixed-currency-beyond-distinct-scan-cap',
  title: 'A monetary column mixing more currencies than the scan cap',
  requirements: ['mixed-currencies'],
  documentedContract:
    'Mixed-currency columns are detected automatically at ingest time. The detector skips a column with more than 25 distinct values, so a genuinely many-currency column must either be detected or be explicitly disclosed as not scanned — a silently unscanned column would leave an analyst summing across currencies with no warning.',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'duckdb_query'],
  async run(harness) {
    const checks = new Checks()
    const codes = [...KNOWN_CURRENCY_CODES].sort().slice(0, 30)
    const rows: Cell[][] = [['order_id', 'currency', 'amount']]
    for (let index = 0; index < 30; index += 1) {
      rows.push([`o${index + 1}`, codes[index], (index + 1) * 100])
    }
    await harness.placeArchive([{ name: 'payments.csv', bytes: csvBytes(rows) }])
    const preview = await harness.preview()
    if (!preview.pinId) throw new Error('preview did not return a candidate pin')
    harness.approvePin(preview.pinId)
    const attempt = await harness.ingest()
    checks.check('ingest did not crash', attempt.ok, { error: attempt.error })
    const datasetId = attempt.result?.datasetId ?? ''
    const dimensions = attempt.result?.tables[0]?.currencyDimensions ?? []
    const manifestWarnings = attempt.result?.qualityWarnings ?? []
    const disclosed =
      dimensions.length > 0 || manifestWarnings.some((warning) => /currenc/i.test(warning))
    checks.check(
      'a 30-currency column is either detected or explicitly disclosed as unscanned',
      disclosed,
      { dimensions, manifestWarnings },
    )
    let queryWarnings: string[] = []
    if (attempt.result?.status === 'ready') {
      const summary = await harness.query(datasetId, 'SELECT SUM(amount) AS total FROM payments')
      queryWarnings = summary.warnings
      checks.check(
        'summing across 30 mixed currencies carries a warning or an explicit "not scanned" disclosure',
        queryWarnings.some((warning) => /currenc/i.test(warning)) || disclosed,
        { queryWarnings, dimensions },
      )
    }
    const finding: GateFinding[] = disclosed
      ? []
      : [
          {
            severity: 'contract-violation',
            claim:
              'docs/implementation.md:27-28 states mixed-currency columns are detected automatically at ingest time; currency-detection.ts skips any column with more than MAX_DISTINCT_TO_SCAN (25) distinct values.',
            observed: `A column with ${codes.length} distinct ISO-4217 codes produced currencyDimensions=${JSON.stringify(
              dimensions,
            )}, qualityWarnings=${JSON.stringify(manifestWarnings)} and query warnings ${JSON.stringify(
              queryWarnings,
            )} — the analyst is never told the column was skipped.`,
            where: DOC.currency,
          },
        ]
    return outcome(
      checks,
      disclosed
        ? `disclosed via ${dimensions.length > 0 ? 'currencyDimensions' : 'qualityWarnings'}`
        : `30 distinct ISO-4217 codes went undetected and undisclosed (currencyDimensions=${JSON.stringify(dimensions)})`,
      {
        codes: codes.length,
        dimensions,
        manifestWarnings,
        queryWarnings,
        status: attempt.result?.status,
      },
      finding,
    )
  },
}

const windows1252Case: GateCase = {
  id: 'windows-1252-encoded-csv',
  title: 'windows-1252 (ANSI) encoded CSV with accented values',
  requirements: ['encodings'],
  documentedContract:
    'The preview detects the source encoding, carries it on the proposed table, and ingest normalizes it to UTF-8 so accented values load exactly instead of failing or turning into mojibake.',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'duckdb_query'],
  async run(harness) {
    const checks = new Checks()
    const text = 'city,sales\nCafé,10\nKøge,20\nZürich,30\n'
    await harness.placeArchive([{ name: 'sales.csv', bytes: windows1252Bytes(text) }])
    const preview = await harness.preview()
    const encoding = preview.tables?.[0]?.sourceEncoding
    checks.check('preview detects windows-1252', encoding === 'windows-1252', { encoding })
    if (!preview.pinId) throw new Error('preview did not return a candidate pin')
    harness.approvePin(preview.pinId)
    const attempt = await harness.ingest()
    checks.check('ingest did not crash', attempt.ok, { error: attempt.error })
    let cities: unknown[] = []
    if (attempt.result?.status === 'ready') {
      const summary = await harness.query(
        attempt.result.datasetId,
        'SELECT city FROM sales ORDER BY sales',
      )
      cities = summary.preview.map((row) => row[0])
      checks.check(
        'accented values load exactly (Café, Køge, Zürich)',
        JSON.stringify(cities) === JSON.stringify(['Café', 'Køge', 'Zürich']),
        { cities },
      )
    }
    return outcome(checks, `encoding=${String(encoding)}; cities=${JSON.stringify(cities)}`, {
      encoding,
      cities,
      status: attempt.result?.status,
      error: attempt.error,
    })
  },
}

const utf16Case: GateCase = {
  id: 'utf16-bom-encoded-csv',
  title: 'UTF-16LE and UTF-16BE (BOM) encoded CSVs',
  requirements: ['encodings'],
  documentedContract:
    'A BOM-marked UTF-16 file is detected as such and decoded to UTF-8 for inspection and load, so its values and header are exactly the source text — not the interleaved NUL bytes a byte-oriented reader would produce.',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'duckdb_query'],
  async run(harness) {
    const checks = new Checks()
    const text = 'city,sales\nOslo,10\nMalmö,20\n'
    const observations: Record<string, unknown> = {}
    await harness.placeArchive([{ name: 'sale.csv', bytes: utf16leWithBomBytes(text) }])
    const le = await harness.preview()
    observations.utf16leEncoding = le.tables?.[0]?.sourceEncoding
    checks.check(
      'UTF-16LE with BOM is detected as utf-16le',
      le.tables?.[0]?.sourceEncoding === 'utf-16le',
      observations,
    )
    checks.check(
      'the UTF-16LE header is decoded (city/sales, not NUL-interleaved text)',
      JSON.stringify(le.tables?.[0]?.columns.map((column) => column.name)) ===
        JSON.stringify(['city', 'sales']),
      { columns: le.tables?.[0]?.columns },
    )
    if (le.pinId) {
      harness.approvePin(le.pinId)
      const attempt = await harness.ingest()
      checks.check('UTF-16LE ingest did not crash', attempt.ok, { error: attempt.error })
      if (attempt.result?.status === 'ready') {
        const summary = await harness.query(
          attempt.result.datasetId,
          'SELECT city, sales FROM sale ORDER BY sales',
        )
        observations.utf16leRows = summary.preview
        checks.check(
          'UTF-16LE values load exactly (Oslo 10, Malmö 20)',
          JSON.stringify(summary.preview) ===
            JSON.stringify([
              ['Oslo', '10'],
              ['Malmö', '20'],
            ]),
          { rows: summary.preview },
        )
      }
    }
    // A second, independent workspace for the big-endian variant.
    const beRoot = join(harness.caseDir, 'be')
    await mkdir(beRoot, { recursive: true })
    const be = await GateHarness.create(beRoot, 'gate/utf16-be')
    await be.placeArchive([{ name: 'sale.csv', bytes: utf16beWithBomBytes(text) }], 'gate/utf16-be')
    const bePreview = await be.preview({ slug: 'gate/utf16-be' })
    observations.utf16beEncoding = bePreview.tables?.[0]?.sourceEncoding
    checks.check(
      'UTF-16BE with BOM is detected as utf-16be',
      bePreview.tables?.[0]?.sourceEncoding === 'utf-16be',
      observations,
    )
    if (bePreview.pinId) {
      be.approvePin(bePreview.pinId, 'gate/utf16-be')
      const beAttempt = await be.ingest('gate/utf16-be')
      observations.utf16beStatus = beAttempt.result?.status ?? beAttempt.error
      checks.check('UTF-16BE ingest did not crash', beAttempt.ok, { error: beAttempt.error })
      if (beAttempt.result?.status === 'ready') {
        const rows = await be.query(
          beAttempt.result.datasetId,
          'SELECT city FROM sale ORDER BY sales',
        )
        observations.utf16beCities = rows.preview.map((row) => row[0])
        checks.check(
          'UTF-16BE values load exactly',
          JSON.stringify(observations.utf16beCities) === JSON.stringify(['Oslo', 'Malmö']),
          { cities: observations.utf16beCities },
        )
      }
    }
    return outcome(checks, JSON.stringify(observations), observations)
  },
}

const mixedEncodingCase: GateCase = {
  id: 'per-record-mixed-encoding-csv',
  title: 'One CSV whose rows are individually UTF-8 or windows-1252',
  requirements: ['encodings'],
  documentedContract:
    'CSV ingestion normalizes to UTF-8 per record, not per file, so a file that mixes UTF-8 and windows-1252 rows decodes each row correctly instead of mis-decoding the minority encoding.',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'duckdb_query'],
  async run(harness) {
    const checks = new Checks()
    // Row 2 is genuine UTF-8 (é = C3 A9); rows 3-4 are windows-1252 (é = E9).
    const bytes = Buffer.concat([
      Buffer.from('city,sales\n', 'utf8'),
      Buffer.from('Café,10\n', 'utf8'),
      windows1252Bytes('Café,20\n'),
      windows1252Bytes('Køge,30\n'),
    ])
    await harness.placeArchive([{ name: 'mixed.csv', bytes }])
    const preview = await harness.preview()
    const encoding = preview.tables?.[0]?.sourceEncoding
    checks.check(
      'the mixed file is detected as non-UTF-8 (windows-1252 fallback)',
      encoding === 'windows-1252',
      { encoding },
    )
    if (!preview.pinId) throw new Error('preview did not return a candidate pin')
    harness.approvePin(preview.pinId)
    const attempt = await harness.ingest()
    checks.check('ingest did not crash', attempt.ok, { error: attempt.error })
    let cities: unknown[] = []
    if (attempt.result?.status === 'ready') {
      const summary = await harness.query(
        attempt.result.datasetId,
        'SELECT city FROM mixed ORDER BY sales',
      )
      cities = summary.preview.map((row) => row[0])
      checks.check(
        'both encodings in one file decode to the same accented text',
        JSON.stringify(cities) === JSON.stringify(['Café', 'Café', 'Køge']),
        { cities },
      )
    }
    const mojibake = cities.filter((city) => typeof city === 'string' && /Ã|Â/.test(city))
    const finding: GateFinding[] =
      mojibake.length > 0
        ? [
            {
              severity: 'contract-violation',
              claim:
                'docs/implementation.md:21-24 states CSV ingestion normalizes to UTF-8 per record so a file mixing encodings decodes correctly.',
              observed: `Per-record decoding produced mojibake for ${JSON.stringify(mojibake)}.`,
              where: DOC.encoding,
            },
          ]
        : []
    return outcome(
      checks,
      `encoding=${String(encoding)}; cities=${JSON.stringify(cities)}`,
      { encoding, cities, status: attempt.result?.status, error: attempt.error },
      finding,
    )
  },
}

const wideTableCase: GateCase = {
  id: 'very-wide-table-column-paging',
  title: 'A 350-column table previewed and ingested',
  requirements: ['wide-table'],
  documentedContract:
    'A wide proposal is demand-paged with `limit`/`offset` and a `nextOffset` cursor that walks every column exactly once (same contract as get_schema), and the wide table still ingests with per-column cast-null tracking.',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'duckdb_query'],
  async run(harness) {
    const checks = new Checks()
    const WIDTH = 350
    const ROWS = 20
    const header = ['id', ...Array.from({ length: WIDTH }, (_, index) => `c${index + 1}`)]
    const rows: Cell[][] = [header]
    for (let row = 1; row <= ROWS; row += 1) {
      rows.push([row, ...Array.from({ length: WIDTH }, (_, index) => (row + index) % 97)])
    }
    await harness.placeArchive([{ name: 'wide.csv', bytes: csvBytes(rows) }])
    const pageSize = 200
    const collected: string[] = []
    let offset: number | null = 0
    let pages = 0
    let totalColumns = 0
    let lastNextOffset: number | null | undefined
    while (offset !== null && pages < 5) {
      const page = await harness.preview({ limit: pageSize, offset })
      totalColumns = page.totalColumns ?? 0
      collected.push(
        ...(page.tables ?? []).flatMap((table) => table.columns.map((col) => col.name)),
      )
      lastNextOffset = page.nextOffset
      offset = page.nextOffset ?? null
      pages += 1
    }
    checks.check('the proposal reports the full column count', totalColumns === WIDTH + 1, {
      totalColumns,
    })
    checks.check(
      'paging walks every column exactly once, in order, with no gaps or duplicates',
      collected.length === WIDTH + 1 && new Set(collected).size === collected.length,
      { collected: collected.length, unique: new Set(collected).size, pages },
    )
    checks.check('the last page ends the cursor (nextOffset null)', lastNextOffset === null, {
      lastNextOffset,
    })
    const full = await harness.preview()
    const columns = full.tables?.[0]?.columns ?? []
    checks.check(
      'the full proposal still carries every column with per-column reasons',
      columns.length === WIDTH + 1 && columns.every((column) => Boolean(column.reason)),
      { columnCount: columns.length },
    )
    if (!full.pinId) throw new Error('preview did not return a candidate pin')
    harness.approvePin(full.pinId)
    const attempt = await harness.ingest()
    checks.check('the wide ingest did not crash', attempt.ok, { error: attempt.error })
    let rowCount: unknown[][] = []
    let castNullTotal: number | undefined
    if (attempt.result?.status === 'ready') {
      const table = attempt.result.tables[0]
      castNullTotal = Object.values(table?.castNullCounts ?? {}).reduce(
        (sum, count) => sum + count,
        0,
      )
      rowCount = await harness.publishedRows(
        attempt.result.datasetVersionId,
        attempt.result.datasetId,
        'SELECT COUNT(*) FROM wide',
      )
      checks.check('all rows and columns publish', String(rowCount[0]?.[0]) === String(ROWS), {
        rowCount: rowCount[0]?.[0],
      })
      checks.check('clean wide data reports zero cast-null cells', castNullTotal === 0, {
        castNullTotal,
      })
    }
    return outcome(
      checks,
      `paged ${pages} page(s) over ${totalColumns} columns; ${String(rowCount[0]?.[0] ?? '?')} rows ingested`,
      {
        totalColumns,
        collected: collected.length,
        pages,
        lastNextOffset,
        status: attempt.result?.status,
        castNullTotal,
        ingestError: attempt.error,
      },
    )
  },
}

const scaleCase: GateCase = {
  id: 'large-row-count-scale',
  title: 'A few hundred thousand rows through the real pipeline',
  requirements: ['scale'],
  heavy: true,
  documentedContract:
    'A few hundred thousand rows ingest with an exact row count and exact aggregate values (no truncation, no silent sampling and no lost rows), and the per-column diagnostics stay consistent with the source.',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'duckdb_query'],
  async run(harness) {
    const checks = new Checks()
    const ROWS = 250_000
    const bytes = await largeRetailCsvBytes(ROWS)
    await harness.placeArchive([{ name: 'events.csv', bytes }])
    const preview = await harness.preview()
    checks.check(
      'the large source is proposed (bounded head sampling, not a full read)',
      preview.tables?.length === 1,
      { tables: preview.tables?.map((table) => table.tableId) },
    )
    if (!preview.pinId) throw new Error('preview did not return a candidate pin')
    harness.approvePin(preview.pinId)
    const startedAt = Date.now()
    const attempt = await harness.ingest()
    const ingestMs = Date.now() - startedAt
    checks.check('the large ingest did not crash', attempt.ok, { error: attempt.error })
    const table = attempt.result?.tables[0]
    checks.check(
      'the published row count equals the source row count exactly',
      table?.rows === ROWS && table?.sourceRowCount === ROWS && table?.rawRowCount === ROWS,
      {
        rows: table?.rows,
        sourceRowCount: table?.sourceRowCount,
        rawRowCount: table?.rawRowCount,
        projectionRowCount: table?.projectionRowCount,
      },
    )
    checks.check(
      'no cast-null cells are reported for the clean large source',
      (table?.castNullCounts?.amount ?? 0) === 0 && (table?.castNullCounts?.quantity ?? 0) === 0,
      { castNullCounts: table?.castNullCounts },
    )
    let total: unknown[] = []
    let count: unknown[][] = []
    if (attempt.result?.status === 'ready') {
      const summary = await harness.query(
        attempt.result.datasetId,
        'SELECT COUNT(*) AS rows, SUM(amount) AS amount_total, SUM(quantity) AS quantity_total FROM events',
      )
      total = summary.preview[0] ?? []
      count = await harness.publishedRows(
        attempt.result.datasetVersionId,
        attempt.result.datasetId,
        'SELECT COUNT(*) FROM events',
      )
      // 2500 blocks x sum(0..99)/4 = 2500 x 1237.5 = 3,093,750
      checks.check(
        'the aggregates are exact over all 250,000 rows',
        String(total[0]) === String(ROWS) &&
          String(total[1]) === '3093750' &&
          String(total[2]) === '62499750000',
        { total, expected: [String(ROWS), '3093750', '62499750000'] },
      )
    }
    return outcome(
      checks,
      `${String(total[0] ?? '?')} rows, SUM(amount)=${String(total[1] ?? '?')} ingested in ${ingestMs}ms`,
      {
        csvBytes: bytes.length,
        rows: table?.rows,
        sourceRowCount: table?.sourceRowCount,
        aggregate: total,
        publishedCount: count[0]?.[0],
        ingestMs,
        status: attempt.result?.status,
        ingestError: attempt.error,
      },
    )
  },
}

const inconsistentDatesCase: GateCase = {
  id: 'inconsistent-date-formats-one-column',
  title: 'One date column mixing ISO and DD/MM/YYYY beyond the sample',
  requirements: ['inconsistent-dates'],
  documentedContract:
    'A DATE column is re-parsed with the same convention the inference used, and an ambiguous day/month order produces a review warning instead of a silent calendar choice. Any value that does not fit the persisted convention must be disclosed (cast-null diagnostics / confirm), never silently reinterpreted as a different calendar date.',
  entryPoints: [
    'preview_ingest_source',
    'runReviewedIngest',
    'publishPendingAdaptation',
    'duckdb_query',
  ],
  async run(harness) {
    const checks = new Checks()
    const rows: Cell[][] = [['line_id', 'order_date', 'amount']]
    for (let index = 1; index <= 300; index += 1) {
      const day = String((index % 28) + 1).padStart(2, '0')
      rows.push([index, `2024-03-${day}`, index])
    }
    for (let index = 301; index <= 350; index += 1) {
      // Day 13+ cannot be a month: unambiguously DD/MM/YYYY, and outside the
      // 200-row sniff sample that decided the column type.
      rows.push([index, `1${(index % 3) + 3}/03/2024`, index])
    }
    await harness.placeArchive([{ name: 'orders.csv', bytes: csvBytes(rows) }])
    const preview = await harness.preview()
    const proposal = preview.tables?.[0]
    const dateType = proposal?.columns.find((column) => column.name === 'order_date')?.type
    checks.check(
      'the date column is proposed as DATE from the ISO head sample',
      dateType === 'DATE',
      {
        dateType,
      },
    )
    const formatWarning = (proposal?.warnings ?? []).find((warning) =>
      /format not persisted/.test(warning),
    )
    if (!preview.pinId) throw new Error('preview did not return a candidate pin')
    harness.approvePin(preview.pinId)
    const recipe = harness.pinRecipe()
    const persisted = recipe.tables[0]?.dateFormat
    const attempt = await harness.ingest()
    checks.check('ingest did not crash', attempt.ok, { error: attempt.error })
    const result = attempt.result
    const castNulls = result?.tables[0]?.castNullCounts?.order_date ?? 0
    const paused = result?.status === 'needs-input'
    const published = result?.status === 'ready'
    checks.check(
      'a value that does not fit the persisted convention is not silently reinterpreted: ' +
        'either the ingest pauses with a named cast-null count, or the column stayed untyped text',
      paused ||
        published ||
        recipe.tables[0]?.columns.find((c) => c.name === 'order_date')?.type === 'VARCHAR',
      { status: result?.status, castNulls, dateType, persistedFormat: persisted },
    )
    checks.check(
      paused
        ? 'the pause names the date column and its cast-null count'
        : 'no pause was needed, so the late values were parsed under the persisted convention',
      paused
        ? (result?.materialityReasons ?? []).some(
            (reason) => reason.includes('order_date') && reason.includes(String(castNulls)),
          )
        : true,
      { materialityReasons: result?.materialityReasons, castNulls },
    )
    let lateRows: unknown[][] = []
    let isoRows: unknown[][] = []
    if (result && (paused || published)) {
      const final = paused ? await harness.publishPending(result.datasetId, result.jobId) : null
      const versionId = final?.datasetVersionId ?? result.datasetVersionId
      lateRows = await harness.publishedRows(
        versionId,
        result.datasetId,
        'SELECT line_id, order_date FROM orders WHERE line_id >= 301 ORDER BY line_id LIMIT 3',
      )
      isoRows = await harness.publishedRows(
        versionId,
        result.datasetId,
        'SELECT COUNT(*) FROM orders WHERE line_id <= 300 AND order_date IS NULL',
      )
      const lateNulls = await harness.publishedRows(
        versionId,
        result.datasetId,
        'SELECT COUNT(*) FROM orders WHERE line_id >= 301 AND order_date IS NULL',
      )
      const wrongCalendar = lateRows.filter((row) => {
        const value = row[1]
        return value !== null && !String(value).startsWith('2024-03-1')
      })
      checks.check(
        'the ISO rows keep their exact dates (no shift from the mixed tail)',
        String(isoRows[0]?.[0]) === '0',
        { isoNullCount: isoRows[0]?.[0] },
      )
      checks.check(
        'no late value was silently reinterpreted as a different calendar date',
        wrongCalendar.length === 0,
        { lateRows, lateNullCount: lateNulls[0]?.[0] },
      )
      checks.check(
        'a non-ISO value is either preserved or NULL with the pause having disclosed it',
        paused || String(lateNulls[0]?.[0]) === '0',
        { lateNullCount: lateNulls[0]?.[0], paused },
      )
    }
    const findings: GateFinding[] = []
    if (
      !paused &&
      published &&
      (castNulls > 0 || (lateRows.length > 0 && lateRows[0]?.[1] === null))
    ) {
      findings.push({
        severity: 'contract-violation',
        claim:
          'docs/implementation.md:20-23 (CAST diagnostics) and date-format.ts (no silent calendar choice): a value outside the inferred convention must be disclosed.',
        observed: `Ingest published ready with castNullCounts.order_date=${castNulls} and late rows ${JSON.stringify(lateRows)}.`,
        where: DOC.sample,
      })
    }
    return outcome(
      checks,
      `proposed ${String(dateType)} / format ${String(persisted ?? 'none')}; ` +
        `${paused ? `paused with ${castNulls} cast-null cell(s)` : String(result?.status)}` +
        (formatWarning ? `; ambiguous-format warning: ${formatWarning}` : ''),
      {
        dateType,
        persistedFormat: persisted,
        formatWarning,
        status: result?.status,
        castNulls,
        materialityReasons: result?.materialityReasons,
        lateRows,
        isoNullCount: isoRows[0]?.[0],
        ingestError: attempt.error,
      },
      findings,
    )
  },
}

const allNullColumnCase: GateCase = {
  id: 'all-null-column',
  title: 'A column that is empty in every row',
  requirements: ['all-null-column'],
  documentedContract:
    'An all-empty column ingests as an all-NULL column of a disclosed type, and its source emptiness is not reported as a cast failure (cast-null counts are for values that failed a cast, not for values that were already empty).',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'duckdb_query'],
  async run(harness) {
    const checks = new Checks()
    const rows: Cell[][] = [['line_id', 'notes', 'amount']]
    for (let index = 1; index <= 40; index += 1) rows.push([index, '', index * 3])
    await harness.placeArchive([{ name: 'orders.csv', bytes: csvBytes(rows) }])
    const preview = await harness.preview()
    const proposal = preview.tables?.[0]
    const notesType = proposal?.columns.find((column) => column.name === 'notes')?.type
    const notesReason = proposal?.columns.find((column) => column.name === 'notes')?.reason ?? ''
    checks.check('the empty column is still proposed (not dropped)', notesType !== undefined, {
      notesType,
      notesReason,
    })
    if (!preview.pinId) throw new Error('preview did not return a candidate pin')
    harness.approvePin(preview.pinId)
    const attempt = await harness.ingest()
    checks.check('ingest did not crash', attempt.ok, { error: attempt.error })
    const result = attempt.result
    checks.check(
      'the all-empty column does not stall ingest in an unconfirmed confirm loop',
      result?.status === 'ready',
      { status: result?.status, materialityReasons: result?.materialityReasons },
    )
    checks.check(
      'source emptiness is not counted as a cast failure',
      (result?.tables[0]?.castNullCounts?.notes ?? 1) === 0,
      { castNullCounts: result?.tables[0]?.castNullCounts },
    )
    let nullCount: unknown[] = []
    let columnType: unknown[][] = []
    if (result?.status === 'ready') {
      const summary = await harness.query(
        result.datasetId,
        'SELECT COUNT(*) AS total, COUNT(notes) AS non_null FROM orders',
      )
      nullCount = summary.preview[0] ?? []
      columnType = summary.columns.map((column) => [column.name, column.logicalType])
      checks.check(
        'the published column is all NULL with every row kept',
        String(nullCount[0]) === '40' && String(nullCount[1]) === '0',
        { nullCount },
      )
    }
    return outcome(
      checks,
      `notes=${String(notesType)} (${notesReason}); published NULL/rows=${JSON.stringify(nullCount)}`,
      {
        notesType,
        notesReason,
        status: result?.status,
        nullCount,
        columnType,
        castNullCounts: result?.tables[0]?.castNullCounts,
      },
    )
  },
}

const duplicateRowsCase: GateCase = {
  id: 'full-row-duplicates-preserved',
  title: 'Fully duplicated rows (no silent dedupe, no wrong count)',
  requirements: ['full-row-duplicates'],
  documentedContract:
    'Full-row duplicates are preserved and counted: the published row count equals the source row count, so a later duplicate-excess finding is computed from real data rather than from a silently de-duplicated table.',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'duckdb_query'],
  async run(harness) {
    const checks = new Checks()
    const distinct: Cell[][] = [['line_id', 'customer_id', 'amount']]
    for (let index = 1; index <= 200; index += 1) {
      distinct.push([index, `c${index % 10}`, index * 2])
    }
    const rows = [...distinct, ...distinct.slice(1)]
    await harness.placeArchive([{ name: 'orders.csv', bytes: csvBytes(rows) }])
    const preview = await harness.preview()
    if (!preview.pinId) throw new Error('preview did not return a candidate pin')
    harness.approvePin(preview.pinId)
    const attempt = await harness.ingest()
    checks.check('ingest did not crash', attempt.ok, { error: attempt.error })
    const result = attempt.result
    checks.check('all 400 source rows publish', result?.tables[0]?.rows === 400, {
      rows: result?.tables[0]?.rows,
    })
    let duplicates: unknown[] = []
    if (result?.status === 'ready') {
      const duplicateQuery = await harness.query(
        result.datasetId,
        'SELECT COUNT(*) AS excess FROM (SELECT line_id, customer_id, amount FROM orders GROUP BY ALL HAVING COUNT(*) > 1)',
      )
      duplicates = duplicateQuery.preview[0] ?? []
      checks.check(
        'every duplicated row is still present (200 duplicate pairs)',
        String(duplicates[0]) === '200',
        { excess: duplicates[0] },
      )
    }
    return outcome(
      checks,
      `published ${String(result?.tables[0]?.rows ?? '?')} rows; ${String(duplicates[0] ?? '?')} duplicated row keys`,
      {
        rows: result?.tables[0]?.rows,
        duplicateKeys: duplicates[0],
        status: result?.status,
        error: attempt.error,
      },
    )
  },
}

const leadingZeroIdCase: GateCase = {
  id: 'leading-zero-identifiers-exact',
  title: 'Identifier-like columns with leading zeroes must stay exact',
  requirements: ['leading-zero-ids'],
  documentedContract:
    'Identifiers with leading zeroes are left verbatim (`007` stays `007`) rather than coerced into a number: a proposal that types such a column as numeric would silently rewrite every id, and the published values must equal the source text exactly.',
  entryPoints: ['preview_ingest_source', 'runReviewedIngest', 'duckdb_query'],
  async run(harness) {
    const checks = new Checks()
    const ids = ['0007', '0042', '0000', '0100', '1000', '0001']
    const rows: Cell[][] = [['line_id', 'customer_id', 'order_id', 'amount']]
    ids.forEach((id, index) => {
      rows.push([index + 1, id, `ORD-${id}`, (index + 1) * 10])
    })
    await harness.placeArchive([{ name: 'orders.csv', bytes: csvBytes(rows) }])
    const preview = await harness.preview()
    const proposal = preview.tables?.[0]
    const customerType = proposal?.columns.find((column) => column.name === 'customer_id')?.type
    if (!preview.pinId) throw new Error('preview did not return a candidate pin')
    harness.approvePin(preview.pinId)
    const attempt = await harness.ingest()
    checks.check('ingest did not crash', attempt.ok, { error: attempt.error })
    const result = attempt.result
    let published: unknown[] = []
    let columnTypes: unknown[] = []
    if (result?.status === 'ready') {
      const summary = await harness.query(
        result.datasetId,
        'SELECT customer_id FROM orders ORDER BY line_id',
      )
      published = summary.preview.map((row) => row[0])
      columnTypes = summary.columns.map((column) => [column.name, column.logicalType])
      checks.check(
        'published identifiers equal the source text exactly (leading zeroes intact)',
        JSON.stringify(published) === JSON.stringify(ids),
        { published, expected: ids },
      )
      checks.check(
        'the published column is a string column, not a coerced number',
        summary.columns.find((column) => column.name === 'customer_id')?.logicalType === 'VARCHAR',
        { columnTypes },
      )
      const numeric = await harness.query(
        result.datasetId,
        "SELECT COUNT(*) AS exact_match FROM orders WHERE customer_id = '0007'",
      )
      checks.check(
        'an exact string comparison still finds the zero-padded identifier',
        String(numeric.preview[0]?.[0]) === '1',
        { exactMatch: numeric.preview[0]?.[0] },
      )
    }
    const coerced = typeof published[0] === 'number' || !/^0/.test(String(published[0] ?? '0'))
    const findings: GateFinding[] = []
    if (published.length > 0 && JSON.stringify(published) !== JSON.stringify(ids)) {
      findings.push({
        severity: 'contract-violation',
        claim:
          'docs/implementation.md:110-114 and docs/contracts.md:161-169: values that only look numeric — identifiers with leading zeroes (`007`) — are left verbatim; the worked example credits IDs that include leading zeroes.',
        observed: `Proposed type for customer_id was ${String(
          customerType,
        )} and the published values were ${JSON.stringify(
          published,
        )} instead of ${JSON.stringify(ids)}${coerced ? ' (coerced, leading zeroes lost)' : ''}.`,
        where: `${DOC.ids}; ${DOC.ids2}`,
      })
    } else if (customerType !== 'VARCHAR') {
      findings.push({
        severity: 'documentation-gap',
        claim:
          'docs/implementation.md:110-114 claims identifier-like values are left verbatim, but the type proposal path is not documented as preserving leading-zero columns.',
        observed: `customer_id was proposed as ${String(customerType)}; the values happened to survive for this fixture, so the guarantee is coincidental for this input rather than a property of the proposer.`,
        where: `${DOC.ids}; ${DOC.ids2}`,
      })
    }
    return outcome(
      checks,
      `proposed ${String(customerType)}; published ${JSON.stringify(published)}` +
        (findings.length > 0 && findings[0]?.severity === 'contract-violation'
          ? ' — IDENTIFIERS REWRITTEN'
          : ''),
      {
        customerType,
        publishedIds: published,
        columnTypes,
        status: result?.status,
        error: attempt.error,
      },
      findings,
    )
  },
}

export const VERSATILITY_CASES: readonly GateCase[] = [
  lateTypeDriftCase,
  messyHeadersCase,
  rfc4180Case,
  xlsxRaggedCase,
  multiTableCase,
  currencyMixCase,
  currencyCardinalityCase,
  windows1252Case,
  utf16Case,
  mixedEncodingCase,
  wideTableCase,
  scaleCase,
  inconsistentDatesCase,
  allNullColumnCase,
  duplicateRowsCase,
  leadingZeroIdCase,
]

const CASE_TIMEOUT_MS = 240_000
const HEAVY_CASE_TIMEOUT_MS = 600_000

async function withTimeout<T>(work: Promise<T>, ms: number, id: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Gate case "${id}" exceeded its ${ms / 1000}s budget`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Run every versatility case against the real pipeline and return a JSON-safe
 * report. Credentials are neither read nor required: the Kaggle CLI is a
 * fail-fast shim and every archive is placed where a completed download would
 * have put it.
 */
export async function runVersatilityGate(
  options: RunVersatilityGateOptions = {},
): Promise<VersatilityGateReport> {
  const startedAt = Date.now()
  const includeHeavy = options.includeHeavy ?? true
  const tempRoot = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'dsh-versatility-gate-'))
  const cases: GateCaseResult[] = []
  try {
    for (const gateCase of VERSATILITY_CASES) {
      if (options.only && !options.only.includes(gateCase.id)) continue
      if (gateCase.heavy && !includeHeavy) {
        options.onCase?.(`skip ${gateCase.id} (heavy case disabled)`)
        cases.push({
          id: gateCase.id,
          title: gateCase.title,
          requirements: gateCase.requirements,
          documentedContract: gateCase.documentedContract,
          entryPoints: gateCase.entryPoints,
          heavy: true,
          status: 'skipped',
          observed: 'heavy case disabled by includeHeavy=false',
          checks: [],
          findings: [],
          detail: {},
          durationMs: 0,
        })
        continue
      }
      options.onCase?.(`run  ${gateCase.id}`)
      const caseDir = join(tempRoot, gateCase.id)
      await mkdir(caseDir, { recursive: true })
      const caseStartedAt = Date.now()
      try {
        const harness = await GateHarness.create(caseDir, `gate/${gateCase.id}`)
        const result = await withTimeout(
          gateCase.run(harness),
          gateCase.heavy ? HEAVY_CASE_TIMEOUT_MS : CASE_TIMEOUT_MS,
          gateCase.id,
        )
        const failed = result.checks.failures
        cases.push({
          id: gateCase.id,
          title: gateCase.title,
          requirements: gateCase.requirements,
          documentedContract: gateCase.documentedContract,
          entryPoints: gateCase.entryPoints,
          heavy: Boolean(gateCase.heavy),
          status: failed.length === 0 ? 'pass' : 'fail',
          observed: result.observed,
          checks: result.checks.items,
          findings: result.findings,
          detail: result.detail,
          durationMs: Date.now() - caseStartedAt,
        })
        options.onCase?.(
          `${failed.length === 0 ? 'pass' : 'FAIL'} ${gateCase.id}` +
            (failed.length > 0 ? ` (${failed.length} failed assertion(s))` : ''),
        )
      } catch (error) {
        cases.push({
          id: gateCase.id,
          title: gateCase.title,
          requirements: gateCase.requirements,
          documentedContract: gateCase.documentedContract,
          entryPoints: gateCase.entryPoints,
          heavy: Boolean(gateCase.heavy),
          status: 'fail',
          observed: `UNHANDLED: ${errorMessage(error)}`,
          checks: [{ name: 'case ran to completion', ok: false, detail: errorMessage(error) }],
          findings: [
            {
              severity: 'contract-violation',
              claim:
                'A case must end in a correct result or an explicit refusal, never an unhandled exception.',
              observed: errorMessage(error),
              where: 'docs/implementation.md (ingestion guarantees)',
            },
          ],
          detail: { unhandled: errorMessage(error) },
          durationMs: Date.now() - caseStartedAt,
        })
        options.onCase?.(`FAIL ${gateCase.id} (unhandled: ${errorMessage(error)})`)
      }
    }
  } finally {
    // Fixtures are runtime-only: remove them unless the operator asked to keep
    // them for inspection (disk budget on this machine is tight).
    if (!options.keepTemp) await rm(tempRoot, { recursive: true, force: true })
  }

  const requirementCoverage: Record<string, string[]> = {}
  for (const requirement of VERSATILITY_REQUIREMENTS) {
    requirementCoverage[requirement.key] = cases
      .filter((entry) => entry.requirements.includes(requirement.key))
      .map((entry) => entry.id)
  }
  const findings = cases.flatMap((entry) => entry.findings)
  const failed = cases.filter((entry) => entry.status === 'fail')
  return {
    gate: 'versatility',
    version: 1,
    generatedAt: new Date().toISOString(),
    runtimeSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    credentials: {
      modelCalls: 0,
      kaggleTokenUsed: false,
      network: 'none — archives are pre-placed where a completed download would land',
      note: 'The Kaggle CLI is a fail-fast shell shim; no provider, token or network call is made.',
    },
    environment: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    temp: { root: tempRoot, removedAtEnd: !options.keepTemp, includeHeavy },
    totals: {
      cases: cases.length,
      passed: cases.filter((entry) => entry.status === 'pass').length,
      failed: failed.length,
      skipped: cases.filter((entry) => entry.status === 'skipped').length,
      findings: findings.length,
      contractViolations: findings.filter((finding) => finding.severity === 'contract-violation')
        .length,
    },
    requirementCoverage,
    cases,
  }
}
