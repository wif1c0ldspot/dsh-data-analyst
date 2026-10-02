/**
 * Structured, delimited model observations for analyst tools.
 *
 * dsh's think-act-observe loop hands whatever a tool `render`s straight back
 * to the model as text. Before this module every tool dumped its full result
 * object as raw JSON: internal ids, filesystem paths, and (on error) the
 * operator's workspace layout could all leak into model context, and the
 * model had no fixed shape to parse. `renderObserve` produces one delimited,
 * allowlisted, size-capped block per tool kind instead — see
 * docs/architecture.md ("Bounded evidence and precise values").
 */

import { z } from 'zod'
import { ResultEvidenceSchema, type ResultEvidence } from './result-evidence.js'

/** Model-facing observation kinds. One per tool family. */
export type ObserveKind = 'query' | 'schema' | 'ingest' | 'chart' | 'catalog' | 'error'

export interface ObserveDocument {
  kind: ObserveKind
  /** Hard cap 8 KiB UTF-8 for model text, delimiters included. */
  text: string
}

const OPEN = (kind: ObserveKind) => `<<observe kind=${kind}>>`
const CLOSE = '<</observe>>'

/** Hard cap 8 KiB UTF-8 for the full delimited block. */
export const OBSERVE_MAX_BYTES = 8 * 1024

/** Schema-level cap on `query.preview` rows, independent of the byte cap. */
const MAX_PREVIEW_ROWS = 20

/** Evidence is selected independently of preview rows and remains comfortably inside 8 KiB. */
const MAX_EVIDENCE_FACTS = 16
const MAX_EVIDENCE_WARNINGS = 6
const MAX_EVIDENCE_WARNING_CODE_POINTS = 256
export const OBSERVE_EVIDENCE_MAX_BYTES = 2 * 1024

const REDACT = '[redacted]'

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Redact absolute `/Users/...` paths, `DSH_HOME`-style workspace paths, and
 * `key=value`/`key: value` credential-shaped substrings (api key, token,
 * password, secret, authorization) from a free-text error message. This is
 * a bounded best-effort scrub for operator-facing strings that were never
 * meant to reach the model, not a general secret scanner.
 */
export function redactErrorMessage(message: string): string {
  return message
    .replace(/\bDSH_HOME\s*[=:]\s*\S+/gi, `DSH_HOME=${REDACT}`)
    .replace(/\/Users\/[^\s"'`)]+/g, REDACT)
    .replace(
      /\b((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
      (_match, prefix: string) => `${prefix}${REDACT}`,
    )
}

/**
 * Recursively apply {@link redactErrorMessage}'s path/DSH_HOME/credential
 * scrub to every string leaf in an observe payload — not just the `error`
 * kind's `message`. A `catalog` `errorMessage` (or any other allowlisted
 * string field, at any nesting depth) can carry the same operator-facing
 * text an `error` kind would, so it gets the same scrub before framing.
 */
function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactErrorMessage(value) as unknown as T
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as unknown as T
  if (isRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      result[key] = redactDeep(entry)
    }
    return result as unknown as T
  }
  return value
}

/**
 * `catalog` covers every workbench/kaggle/duckdb tool result that is not
 * query/schema/chart/ingest-shaped: saved analyses, dashboards, semantic
 * alias/SQL-correction proposals, import-job status, dataset/alias/example
 * listings, Kaggle source resolution, and export-pack downloads. This is an
 * explicit enumeration, never a passthrough — a new field on any of those
 * tools does not silently start reaching the model.
 *
 * A Zod object (not a flat string array): `.parse()` still just filters
 * (every field is `unknown().optional()` — this layer's job is presence
 * filtering, not deep shape validation, which stays each tool's own
 * responsibility), but declaring the shape once, by name, in one typed
 * object is easier to audit at a glance than a 90-entry array, and gives a
 * single place a coverage test (`tool-observe.unit.test.ts`'s
 * "declares exactly the expected set of catalog fields" /
 * "carries every expected catalog field through rendering" pair) can check
 * against an independent, hand-written expectation. This does not by
 * itself guarantee a new field can never be forgotten — see the coverage
 * test. A fully structural guarantee (deriving this schema from each tool's
 * own return type) would be a larger migration, not done here.
 */
const CatalogPayloadSchema = z
  .object({
    // Job / ingest-adjacent status (dataset_status, cancel_job, kaggle_download-shaped).
    jobId: z.unknown().optional(),
    status: z.unknown().optional(),
    slug: z.unknown().optional(),
    sourceVersion: z.unknown().optional(),
    errorMessage: z.unknown().optional(),
    // Reused schema/ingest field names (dataset/alias/schema-adjacent listings).
    datasetId: z.unknown().optional(),
    datasetVersionId: z.unknown().optional(),
    semanticRevisionId: z.unknown().optional(),
    tables: z.unknown().optional(),
    relationships: z.unknown().optional(),
    qualityWarnings: z.unknown().optional(),
    warnings: z.unknown().optional(),
    // Kaggle source resolution (resolve_kaggle_source).
    license: z.unknown().optional(),
    observedLicense: z.unknown().optional(),
    observedSourceVersion: z.unknown().optional(),
    licenseVersionVerified: z.unknown().optional(),
    metadataWarning: z.unknown().optional(),
    sourceUrl: z.unknown().optional(),
    recipeHash: z.unknown().optional(),
    requiresDownload: z.unknown().optional(),
    // Dataset/alias/example listings (list_datasets, get_metrics, get_learning_examples, list_pending_metrics).
    datasets: z.unknown().optional(),
    aliases: z.unknown().optional(),
    examples: z.unknown().optional(),
    candidates: z.unknown().optional(),
    candidateId: z.unknown().optional(),
    // Saved analyses (save_analysis, list_analyses, get_analysis, propose_sql_correction).
    analysisId: z.unknown().optional(),
    analyses: z.unknown().optional(),
    revision: z.unknown().optional(),
    question: z.unknown().optional(),
    sql: z.unknown().optional(),
    resultId: z.unknown().optional(),
    chart: z.unknown().optional(),
    artifactIds: z.unknown().optional(),
    mark: z.unknown().optional(),
    createdAt: z.unknown().optional(),
    correctedSql: z.unknown().optional(),
    // Semantic alias / SQL-correction proposals (propose_metric, propose_sql_correction).
    proposalId: z.unknown().optional(),
    term: z.unknown().optional(),
    expression: z.unknown().optional(),
    description: z.unknown().optional(),
    tableId: z.unknown().optional(),
    aggregation: z.unknown().optional(),
    units: z.unknown().optional(),
    dateColumn: z.unknown().optional(),
    inclusion: z.unknown().optional(),
    actorId: z.unknown().optional(),
    // Dashboards (list_dashboards, get_dashboard, add_to_dashboard, dashboard filters).
    dashboardId: z.unknown().optional(),
    dashboards: z.unknown().optional(),
    title: z.unknown().optional(),
    updatedAt: z.unknown().optional(),
    slots: z.unknown().optional(),
    slotCount: z.unknown().optional(),
    persisted: z.unknown().optional(),
    archived: z.unknown().optional(),
    sharedFilterKeys: z.unknown().optional(),
    applied: z.unknown().optional(),
    unsupported: z.unknown().optional(),
    // Export pack (export_report).
    downloads: z.unknown().optional(),
    files: z.unknown().optional(),
    ready: z.unknown().optional(),
    reportId: z.unknown().optional(),
    // Workspace ingest recipe preview/candidate (preview_ingest_source).
    alreadyReviewed: z.unknown().optional(),
    pinId: z.unknown().optional(),
    unsupportedFiles: z.unknown().optional(),
    loadStrategy: z.unknown().optional(),
    provenanceStatus: z.unknown().optional(),
    // Adaptive ingest materiality confirm (ingest_dataset needs-input).
    materialityReasons: z.unknown().optional(),
    /** Named type re-proposals for columns the typed load cast to NULL. */
    typeReproposals: z.unknown().optional(),
    // Composite current-vs-baseline read (investigate_metric).
    current: z.unknown().optional(),
    baseline: z.unknown().optional(),
    // Kaggle source search (search_kaggle_sources).
    results: z.unknown().optional(),
    // Structure profiling / grain-relationship candidates (propose_structure, list_pending_structure).
    grains: z.unknown().optional(),
    alreadyProposed: z.unknown().optional(),
    approvedCandidates: z.unknown().optional(),
    // Ingestion diagnostics from the published manifest (dataset_status).
    profiling: z.unknown().optional(),
    // Studio-availability check (check_studio_availability) — an
    // independently observed fact, never inferred from save_analysis.
    requestedRevision: z.unknown().optional(),
    latestRevision: z.unknown().optional(),
    availableInStudio: z.unknown().optional(),
    checkedVia: z.unknown().optional(),
    checkedAt: z.unknown().optional(),
    // Table/column paging on a wide proposal (preview_ingest_source) — same
    // contract as `schema` kind's columnsTruncated/nextOffset/totalColumns.
    tablesFiltered: z.unknown().optional(),
    columnsTruncated: z.unknown().optional(),
    nextOffset: z.unknown().optional(),
    totalTables: z.unknown().optional(),
    totalColumns: z.unknown().optional(),
    // Publisher-supplied Kaggle text (preview_ingest_source, resolve_kaggle_*):
    // the publisher's description excerpt and column dictionary, quoted and
    // labelled `publisher-supplied`/`unverified` — evidence to confirm with the
    // analyst, never an approved definition. Carried as its own key so it can
    // never be read as the observed `tables` on the same payload.
    publisherSupplied: z.unknown().optional(),
    // Ask-first outcome of `get_metrics` for a business term with no approved
    // definition: an observed *absence* plus the recovery action, never a
    // candidate definition.
    unresolvedTerms: z.unknown().optional(),
    nextAction: z.unknown().optional(),
    guidance: z.unknown().optional(),
    // Walkthrough observability (get_workflow_trail): compact
    // rendered/persisted/opened/delivery-verified milestone entries. Each
    // entry is already identifier-only (`WorkflowTrailEntrySchema`) — this
    // allowlist entry only lets the array itself, and the milestone-only
    // filter fields, reach the model; it never widens what an entry can
    // contain.
    trail: z.unknown().optional(),
  })
  .partial()

/** The catalog kind's declared field names — used by the coverage test, never by `buildPayload` itself. */
export const CATALOG_PAYLOAD_KEYS: readonly string[] = Object.keys(CatalogPayloadSchema.shape)

function filterAllowedKeys(source: Record<string, unknown>): Record<string, unknown> {
  return CatalogPayloadSchema.parse(source)
}

/**
 * Nested array property for a trimmable field whose value is an object:
 * `current`/`baseline` (`investigate_metric`'s composite read) shrink their
 * `preview` sub-array, the same shape `query`'s own `preview` field trims, and
 * `publisherSupplied` shrinks its `columnNotes` (the model-facing projection's
 * array — the stored block's `columnDictionary` field never reaches this module)
 * so a payload carrying publisher text can still shed those unverified,
 * excerpt-level notes rather than fall through to the last-resort empty
 * document.
 */
const NESTED_ARRAY_FIELD: Record<string, string> = {
  current: 'preview',
  baseline: 'preview',
  publisherSupplied: 'columnNotes',
}

/**
 * Array-valued fields worth shrinking, per kind, when a payload is over the
 * byte cap. Object-valued fields trim the nested array named by
 * {@link NESTED_ARRAY_FIELD}. `applied`/`unsupported`
 * (`apply_dashboard_filters`) are ordinary top-level arrays that can grow with
 * the number of dashboard cards.
 */
const TRIMMABLE_ARRAY_FIELDS: Record<ObserveKind, readonly string[]> = {
  query: ['preview'],
  schema: ['tables', 'relationships', 'aliases', 'rules'],
  ingest: ['tables', 'qualityWarnings'],
  chart: [],
  catalog: [
    'publisherSupplied',
    'datasets',
    'dashboards',
    'analyses',
    'examples',
    'aliases',
    'tables',
    'relationships',
    'slots',
    'unsupportedFiles',
    'applied',
    'unsupported',
    'current',
    'baseline',
    'results',
    'files',
    'trail',
  ],
  error: [],
}

/** Length of a trimmable field's own array, or its nested array when the field is an object. */
function trimmableFieldLength(value: unknown, field: string): number {
  if (Array.isArray(value)) return value.length
  if (isRecord(value)) {
    const nested = value[NESTED_ARRAY_FIELD[field] ?? 'preview']
    if (Array.isArray(nested)) return nested.length
  }
  return 0
}

/** Drop the last item from a trimmable field's array, or its nested array. */
function shrinkTrimmableField(value: unknown, field: string): unknown {
  if (Array.isArray(value)) return value.slice(0, -1)
  if (isRecord(value)) {
    const name = NESTED_ARRAY_FIELD[field] ?? 'preview'
    const nested = value[name]
    if (Array.isArray(nested)) return { ...value, [name]: nested.slice(0, -1) }
  }
  return value
}

/** Empty out a trimmable field's array outright, or its nested array. */
function emptyTrimmableField(value: unknown, field: string): unknown {
  if (Array.isArray(value)) return []
  if (isRecord(value)) {
    const name = NESTED_ARRAY_FIELD[field] ?? 'preview'
    if (Array.isArray(value[name])) return { ...value, [name]: [] }
  }
  return value
}

function mergeWarnings(existing: unknown, extra: readonly string[]): string[] {
  const base = Array.isArray(existing) ? existing.map((entry) => String(entry)) : []
  const merged = [...base]
  for (const warning of extra) {
    if (!merged.includes(warning)) merged.push(warning)
  }
  return merged
}

function clampPreviewRows(preview: unknown): { rows: unknown[]; truncated: boolean } {
  const rows = Array.isArray(preview) ? preview : []
  const truncated = rows.length > MAX_PREVIEW_ROWS
  return { rows: rows.slice(0, MAX_PREVIEW_ROWS), truncated }
}

function selectResultEvidence(
  value: unknown,
  expected: Record<string, unknown>,
): {
  evidence?: ResultEvidence
  warnings: string[]
} {
  if (value === undefined) return { warnings: [] }
  const parsed = ResultEvidenceSchema.safeParse(value)
  if (!parsed.success) {
    return { warnings: ['Result evidence failed validation and was withheld.'] }
  }

  const source = parsed.data
  if (
    source.resultId !== expected.resultId ||
    source.datasetVersionId !== expected.datasetVersionId ||
    source.semanticRevisionId !== expected.semanticRevisionId ||
    source.rowCount !== expected.rowCount
  ) {
    return { warnings: ['Result evidence provenance mismatch; facts were withheld.'] }
  }

  const candidateFacts = source.complete ? source.facts.slice(0, MAX_EVIDENCE_FACTS) : []
  const priorityWarnings = source.warnings.filter(
    (warning) =>
      warning.startsWith('Numeric evidence omitted') ||
      warning.startsWith('Complete stored rows are unavailable'),
  )
  const remainingWarnings = source.warnings.filter((warning) => !priorityWarnings.includes(warning))
  const boundedWarnings = [...priorityWarnings, ...remainingWarnings].filter(
    (warning) => codePointLength(warning) <= MAX_EVIDENCE_WARNING_CODE_POINTS,
  )
  const warningsWereOmitted =
    source.warnings.length > boundedWarnings.length ||
    boundedWarnings.length > MAX_EVIDENCE_WARNINGS
  const evidenceWarnings = boundedWarnings.slice(0, MAX_EVIDENCE_WARNINGS)
  if (
    !source.complete &&
    !evidenceWarnings.some((warning) => warning.startsWith('Complete stored rows'))
  ) {
    evidenceWarnings.unshift(
      'Complete stored rows are unavailable; descriptive facts are withheld.',
    )
  }
  const selected: ResultEvidence = { ...source, facts: [], warnings: evidenceWarnings }
  let byteLimitedWarnings = false
  while (
    utf8Length(JSON.stringify(selected)) > OBSERVE_EVIDENCE_MAX_BYTES &&
    selected.warnings.length
  ) {
    selected.warnings.pop()
    byteLimitedWarnings = true
  }
  if (utf8Length(JSON.stringify(selected)) > OBSERVE_EVIDENCE_MAX_BYTES) {
    return { warnings: ['Result evidence exceeded the byte budget and was withheld.'] }
  }
  let factsOmitted = source.facts.length > candidateFacts.length || !source.complete
  for (const fact of candidateFacts) {
    const withFact = { ...selected, facts: [...selected.facts, fact] }
    if (utf8Length(JSON.stringify(withFact)) > OBSERVE_EVIDENCE_MAX_BYTES) {
      factsOmitted = true
      break
    }
    selected.facts.push(fact)
  }

  const selectionWarnings: string[] = []
  if (factsOmitted && source.complete) {
    selectionWarnings.push(
      'Result evidence facts were limited; run a narrower aggregate query for additional columns.',
    )
  }
  if (warningsWereOmitted || byteLimitedWarnings) {
    selectionWarnings.push(
      'Result evidence warnings were limited; run a narrower aggregate query for additional detail.',
    )
  }
  return { evidence: selected, warnings: selectionWarnings }
}

function investigationSidePayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const { rows, truncated } = clampPreviewRows(value.preview)
  const selected = selectResultEvidence(value.evidence, value)
  return {
    resultId: value.resultId,
    datasetVersionId: value.datasetVersionId,
    semanticRevisionId: value.semanticRevisionId,
    columns: value.columns,
    rowCount: value.rowCount,
    preview: rows,
    previewTruncated: Boolean(value.previewTruncated) || truncated,
    resultComplete: value.resultComplete ?? true,
    ...(selected.evidence ? { evidence: selected.evidence } : {}),
    ...(selected.warnings.length ? { warnings: selected.warnings } : {}),
  }
}

function errorPayload(value: unknown): { code: string; message: string } {
  if (value instanceof Error) {
    return { code: value.name || 'ERROR', message: redactErrorMessage(value.message) }
  }
  if (isRecord(value)) {
    const code = typeof value.code === 'string' && value.code.length > 0 ? value.code : 'ERROR'
    const rawMessage =
      typeof value.message === 'string'
        ? value.message
        : value.message !== undefined
          ? String(value.message)
          : String(value)
    return { code, message: redactErrorMessage(rawMessage) }
  }
  return { code: 'ERROR', message: redactErrorMessage(String(value)) }
}

function buildPayload(
  kind: ObserveKind,
  value: unknown,
  warnings: readonly string[],
): Record<string, unknown> {
  const source = isRecord(value) ? value : {}
  switch (kind) {
    case 'query': {
      const { rows, truncated } = clampPreviewRows(source.preview)
      const selected = selectResultEvidence(source.evidence, source)
      return {
        resultId: source.resultId,
        datasetVersionId: source.datasetVersionId,
        semanticRevisionId: source.semanticRevisionId,
        columns: source.columns,
        rowCount: source.rowCount,
        preview: rows,
        previewTruncated: Boolean(source.previewTruncated) || truncated,
        resultComplete: source.resultComplete ?? true,
        ...(selected.evidence ? { evidence: selected.evidence } : {}),
        warnings: mergeWarnings(source.warnings, [...warnings, ...selected.warnings]),
      }
    }
    case 'schema': {
      const base = {
        datasetId: source.datasetId,
        datasetVersionId: source.datasetVersionId,
        semanticRevisionId: source.semanticRevisionId,
        qualityScope: source.qualityScope,
        tables: source.tables,
        relationships: source.relationships,
        aliases: source.aliases,
        rules: source.rules,
      }
      // Surface paging only on an explicitly paged page that has more columns,
      // so the non-paged schema observe keeps its original key set. Absence of
      // `nextOffset` means "no more columns".
      if (source.columnsTruncated === true) {
        return {
          ...base,
          columnsTruncated: true,
          nextOffset: typeof source.nextOffset === 'number' ? source.nextOffset : null,
          totalColumns: typeof source.totalColumns === 'number' ? source.totalColumns : undefined,
        }
      }
      return base
    }
    case 'chart':
      // `rendered`/`layoutValidation` are produced only by
      // `createChartArtifact` (the layout validator's own verdict, attached
      // server-side) — this passthrough never invents or accepts either
      // field from anywhere else, so a tool call cannot fabricate a
      // delivery-verified result. Neither field is ever read as a
      // persistence or Studio-availability claim. `refinement` is the
      // same kind of server-only fact — the bounded automatic retry attempt
      // `createChartArtifact` made, if any — surfaced here only when present
      // so a caller/model sees honest "what was tried" evidence rather than
      // a silent success.
      return {
        artifactId: source.artifactId,
        rendered: source.rendered,
        layoutValidation: source.layoutValidation,
        ...(source.refinement !== undefined ? { refinement: source.refinement } : {}),
      }
    case 'ingest':
      return {
        jobId: source.jobId,
        status: source.status,
        datasetId: source.datasetId,
        datasetVersionId: source.datasetVersionId,
        tables: source.tables,
        qualityWarnings: source.qualityWarnings,
      }
    case 'error':
      return errorPayload(value)
    case 'catalog': {
      const current = 'current' in source ? investigationSidePayload(source.current) : undefined
      const baseline = 'baseline' in source ? investigationSidePayload(source.baseline) : undefined
      const nestedPreviewClamped = [source.current, source.baseline].some(
        (side) =>
          isRecord(side) && Array.isArray(side.preview) && side.preview.length > MAX_PREVIEW_ROWS,
      )
      return {
        ...filterAllowedKeys(source),
        ...('current' in source ? { current } : {}),
        ...('baseline' in source ? { baseline } : {}),
        ...(nestedPreviewClamped
          ? { warnings: mergeWarnings(source.warnings, ['truncated']) }
          : {}),
      }
    }
    default:
      return {}
  }
}

/**
 * Frame one delimited document. `JSON.stringify` escapes every real newline
 * inside a payload string, so untrusted text (e.g. a publisher description, or a
 * source cell echoed into `errorMessage`) can never place a delimiter on its own
 * line and end the document early — a forged `<</observe>>` stays inline inside
 * its JSON string. See the delimiter-forgery test in
 * `tests/tool-observe.unit.test.ts`.
 */
function frame(kind: ObserveKind, payload: unknown): string {
  return `${OPEN(kind)}\n${JSON.stringify(payload)}\n${CLOSE}`
}

function withTruncatedWarning(payload: Record<string, unknown>): Record<string, unknown> {
  const existing = Array.isArray(payload.warnings)
    ? payload.warnings.map((entry) => String(entry))
    : []
  if (existing.includes('truncated')) return payload
  return { ...payload, warnings: [...existing, 'truncated'] }
}

/** Free-text string fields worth shrinking when arrays alone do not fit. */
const STRING_TRIM_FIELDS: readonly string[] = ['errorMessage', 'sql', 'message']

/** Unicode code-point count — never split a surrogate pair when trimming. */
function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * Truncate to at most `maxCodePoints` Unicode code points, splitting on
 * code-point boundaries (`Array.from` groups surrogate pairs together) so
 * the result is always a valid string and therefore always valid UTF-8
 * once framed — never a raw byte slice that could bisect a multi-byte
 * sequence.
 */
function truncateCodePoints(text: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return ''
  const codePoints = Array.from(text)
  if (codePoints.length <= maxCodePoints) return text
  return codePoints.slice(0, maxCodePoints).join('')
}

/**
 * Shrink an over-cap payload in stages, always keeping the kind's own
 * allowlisted shape and both framing delimiters, and always producing
 * valid JSON / valid UTF-8:
 *
 * 1. Drop items from the largest trimmable array field (see
 *    {@link TRIMMABLE_ARRAY_FIELDS}) one at a time, then empty every
 *    trimmable array field outright.
 * 2. Shrink the largest trimmable free-text field (see
 *    {@link STRING_TRIM_FIELDS} — `errorMessage`, `sql`, `message`) by
 *    code points (never bisecting a surrogate pair).
 * 3. If it still does not fit (should not happen for any real tool
 *    payload), fall back to the smallest possible valid, allowlisted,
 *    delimited document — `warnings: ["truncated"]` only — rather than
 *    ever hard-truncating framed bytes, which could drop the closing
 *    delimiter, break the JSON, or split a UTF-8 sequence.
 *
 * Every stage re-frames and re-checks the byte cap before returning, and
 * signals the cut via a `warnings: [...,"truncated"]` entry — never by
 * inventing a key outside the kind's own allowlisted shape. `query`
 * additionally marks its own `previewTruncated` field when its preview
 * array is the one trimmed.
 */
function capToBytes(kind: ObserveKind, payload: Record<string, unknown>): string {
  let working = payload
  let candidate = frame(kind, working)
  if (utf8Length(candidate) <= OBSERVE_MAX_BYTES) return candidate

  // Stage 1: shrink the largest trimmable array field one item at a time.
  const trimFields = TRIMMABLE_ARRAY_FIELDS[kind] ?? []
  let trimmedAny = false
  for (let guard = 0; guard < 100_000; guard++) {
    const sized = trimFields
      .map((field) => ({ field, length: trimmableFieldLength(working[field], field) }))
      .filter((entry) => entry.length > 0)
      .sort((a, b) => b.length - a.length)
    const target = sized[0]
    if (!target) break

    working = {
      ...working,
      [target.field]: shrinkTrimmableField(working[target.field], target.field),
      ...(kind === 'query' && target.field === 'preview' ? { previewTruncated: true } : {}),
    }
    trimmedAny = true
    candidate = frame(kind, withTruncatedWarning(working))
    if (utf8Length(candidate) <= OBSERVE_MAX_BYTES) return candidate
  }

  if (trimmedAny) {
    candidate = frame(kind, withTruncatedWarning(working))
    if (utf8Length(candidate) <= OBSERVE_MAX_BYTES) return candidate
  }

  const presentArrayFields = trimFields.filter(
    (field) => trimmableFieldLength(working[field], field) > 0,
  )
  if (presentArrayFields.length > 0) {
    working = {
      ...working,
      ...Object.fromEntries(
        presentArrayFields.map((field) => [field, emptyTrimmableField(working[field], field)]),
      ),
    }
    candidate = frame(kind, withTruncatedWarning(working))
    if (utf8Length(candidate) <= OBSERVE_MAX_BYTES) return candidate
  }

  // Stage 2: every trimmable array is already empty — shrink the largest
  // trimmable free-text field by ~30% each pass (geometric decay reaches
  // zero in a small, bounded number of iterations regardless of how huge
  // the original string was).
  for (let guard = 0; guard < 200; guard++) {
    const sized = STRING_TRIM_FIELDS.map((field) => {
      const value = working[field]
      return { field, length: typeof value === 'string' ? codePointLength(value) : 0 }
    })
      .filter((entry) => entry.length > 0)
      .sort((a, b) => b.length - a.length)
    const target = sized[0]
    if (!target) break

    const current = working[target.field] as string
    const currentLength = codePointLength(current)
    const nextLength = currentLength <= 1 ? 0 : Math.floor(currentLength * 0.7)
    working = { ...working, [target.field]: truncateCodePoints(current, nextLength) }
    candidate = frame(kind, withTruncatedWarning(working))
    if (utf8Length(candidate) <= OBSERVE_MAX_BYTES) return candidate
  }

  // Stage 3: last resort (should never trigger for any real tool payload)
  // — the smallest possible valid, allowlisted, delimited document.
  return frame(kind, { warnings: ['truncated'] })
}

/**
 * Render one delimited, allowlisted, size-capped, redacted observation for
 * a tool result. `warnings` (e.g. from `joinWarningsForSql`) are merged
 * into the `query` kind's `warnings` field; other kinds ignore this
 * parameter, though {@link capToBytes} may still add its own
 * `warnings: [...,"truncated"]` if the payload had to be shrunk to fit.
 */
export function renderObserve(
  kind: ObserveKind,
  value: unknown,
  warnings?: readonly string[],
): ObserveDocument {
  const payload = buildPayload(kind, value, warnings ?? [])
  const redacted = redactDeep(payload)
  return { kind, text: capToBytes(kind, redacted) }
}

/**
 * Convert a thrown tool error into an `Error` whose `.message` IS one
 * `renderObserve('error', ...)` document — redacted, delimited, size-capped.
 *
 * dsh-tools (`@deepseek-ai/dsh-tools`) never calls a tool's `output.render`
 * on a thrown value: it catches the throw, takes `error.message` verbatim
 * (`error instanceof Error ? error.message : ...`), and hands the model
 * `Error: ${message}` as the call's only content — `renderObserve('error',
 * …)` was previously unit-tested only, never actually reached for a real
 * thrown tool error. Wrapping an analyst tool's `execute` body with
 * {@link withObserveErrors} (or calling this directly in a catch) ensures a
 * thrown budget denial, policy violation, or filesystem error still reaches
 * the model as a `<<observe kind=error>>` document with the same redaction
 * every successful `render: observeRender('error')` path gets — critically
 * preserving a `POLICY_DENIED:` prefix inside the message (the persona's
 * no-retry signal) while still scrubbing `/Users/...` paths and
 * `DSH_HOME`/credential-shaped substrings.
 */
export function toObserveError(err: unknown): Error {
  return new Error(renderObserve('error', err).text)
}

/**
 * Wrap a tool `execute` body so every thrown error surfaces as an observe
 * error document (see {@link toObserveError}) instead of a raw, unredacted
 * `Error: ${message}`. A successful call is returned unchanged.
 */
export function withObserveErrors<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R | Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    try {
      return await fn(...args)
    } catch (err) {
      throw toObserveError(err)
    }
  }
}
