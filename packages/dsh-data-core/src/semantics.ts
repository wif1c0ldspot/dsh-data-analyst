/**
 * Reviewed semantic aliases. Product base is empty — aliases apply only after
 * analyst approval in SQLite. Exported `*_SEMANTICS_V1` constants remain for
 * fixture/held-out tests via {@link getFixtureSemantics}.
 */
import { createHash } from 'node:crypto'

export interface SemanticAlias {
  term: string
  /** Trusted SQL expression fragment reviewed by an analyst (e.g. `SUM(sales)`). */
  expression: string
  description: string
  tableId: string
}

export interface SemanticRevision {
  contractVersion: 1
  datasetId: string
  semanticRevisionId: string
  aliases: readonly SemanticAlias[]
  /** Reviewed metric terms that need an approved alias before interpretation. */
  metricTermsRequiringApproval?: readonly string[]
  createdAt: string
}

/** Catalog surface needed to overlay approved alias candidates. */
export interface SemanticAliasCatalog {
  listAliasCandidates(
    datasetId?: string,
    status?: 'candidate' | 'approved' | 'revoked',
  ): ReadonlyArray<{
    term: string
    expression: string
    description: string
    tableId: string
  }>
}

export const SUPERSTORE_SEMANTICS_V1: SemanticRevision = {
  contractVersion: 1,
  datasetId: 'superstore',
  semanticRevisionId: 'sem-superstore-v1',
  createdAt: '2026-09-13T00:00:00.000Z',
  aliases: [
    {
      term: 'revenue',
      expression: 'SUM(sales)',
      description: 'Gross sales amount (Superstore Sales column)',
      tableId: 'orders',
    },
    {
      term: 'profit',
      expression: 'SUM(profit)',
      description: 'Reported profit',
      tableId: 'orders',
    },
  ],
}

export const ONLINE_RETAIL_SEMANTICS_V1: SemanticRevision = {
  contractVersion: 1,
  datasetId: 'online-retail',
  semanticRevisionId: 'sem-online-retail-v1',
  createdAt: '2026-09-13T00:00:00.000Z',
  aliases: [
    {
      term: 'revenue',
      expression: 'SUM(quantity * price)',
      description: 'Line revenue including returns (negative quantities)',
      tableId: 'online_retail',
    },
  ],
}

export const OLIST_SEMANTICS_V1: SemanticRevision = {
  contractVersion: 1,
  datasetId: 'olist',
  semanticRevisionId: 'sem-olist-v1',
  createdAt: '2026-09-13T00:00:00.000Z',
  aliases: [
    {
      term: 'revenue',
      expression: 'SUM(price)',
      description: 'Sum of order-item price (excludes freight)',
      tableId: 'order_items',
    },
    {
      term: 'gmv',
      expression: 'SUM(price + freight_value)',
      description: 'Item price plus freight',
      tableId: 'order_items',
    },
  ],
}

export const RETAIL_FIXTURE_SEMANTICS_V1: SemanticRevision = {
  contractVersion: 1,
  datasetId: 'retail-fixture',
  semanticRevisionId: 'sem-retail-fixture-v1',
  createdAt: '2026-09-13T00:00:00.000Z',
  aliases: [
    {
      term: 'revenue',
      expression: 'SUM(amount)',
      description: 'Sum of line amount',
      tableId: 'retail',
    },
  ],
}

export const OLIST_MINI_SEMANTICS_V1: SemanticRevision = {
  contractVersion: 1,
  datasetId: 'olist-mini',
  semanticRevisionId: 'sem-olist-mini-v1',
  createdAt: '2026-09-13T00:00:00.000Z',
  aliases: [
    {
      term: 'revenue',
      expression: 'SUM(price)',
      description: 'Sum of order-item price (excludes freight)',
      tableId: 'order_items',
    },
  ],
}

const FIXTURE_REVISIONS: readonly SemanticRevision[] = [
  SUPERSTORE_SEMANTICS_V1,
  ONLINE_RETAIL_SEMANTICS_V1,
  OLIST_SEMANTICS_V1,
  RETAIL_FIXTURE_SEMANTICS_V1,
  OLIST_MINI_SEMANTICS_V1,
]

const FIXTURE_BY_DATASET: Record<string, SemanticRevision> = Object.fromEntries(
  FIXTURE_REVISIONS.map((revision) => [revision.datasetId, revision]),
)

const BY_REVISION_ID: Record<string, SemanticRevision> = Object.fromEntries(
  FIXTURE_REVISIONS.map((revision) => [revision.semanticRevisionId, revision]),
)

/** Reviewed product hints are versioned independently from historical fixture revisions. */
const PRODUCT_METRIC_TERMS_REQUIRING_APPROVAL = new Map<string, readonly string[]>([
  ['olist', ['revenue']],
])

/** Product path: no in-code semantic privilege (empty base). */
export function getCurrentSemantics(_datasetId: string): SemanticRevision | undefined {
  return undefined
}

/** Fixture/held-out helper — seed tests/evals; not used by product catalog resolve. */
export function getFixtureSemantics(datasetId: string): SemanticRevision | undefined {
  return FIXTURE_BY_DATASET[datasetId]
}

/** Empty alias layer plus content-addressed reviewed hints for workspace datasets. */
export function getWorkspaceBaseSemantics(datasetId: string): SemanticRevision {
  const fingerprint = createHash('sha256').update(datasetId, 'utf8').digest('hex').slice(0, 12)
  const metricTermsRequiringApproval = PRODUCT_METRIC_TERMS_REQUIRING_APPROVAL.get(datasetId) ?? []
  const hintsSuffix =
    metricTermsRequiringApproval.length === 0
      ? ''
      : `+hints.${createHash('sha256')
          .update(
            [...new Set(metricTermsRequiringApproval.map((term) => term.trim().toLowerCase()))]
              .sort()
              .join('\n'),
            'utf8',
          )
          .digest('hex')
          .slice(0, 12)}`
  return {
    contractVersion: 1,
    datasetId,
    semanticRevisionId: `sem-workspace-${fingerprint}-v1${hintsSuffix}`,
    createdAt: '1970-01-01T00:00:00.000Z',
    aliases: [],
    metricTermsRequiringApproval,
  }
}

/**
 * Content fingerprint of approved overlays for auditable revision ids.
 * Format: sorted `term\\texpression\\ttableId` lines → sha256 hex prefix.
 */
export function approvedAliasOverlayFingerprint(
  overlays: ReadonlyArray<{ term: string; expression: string; tableId: string }>,
): string {
  const lines = overlays
    .map((alias) => `${alias.term.toLowerCase()}\t${alias.expression}\t${alias.tableId}`)
    .sort()
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex').slice(0, 12)
}

/**
 * Effective semantics for query binding: in-code revision plus optional
 * approved SQLite alias overlays. Does not mutate in-code constants.
 * Without a store (or with no approved rows), returns the code revision as-is.
 */
export function getEffectiveSemantics(
  datasetId: string,
  store?: SemanticAliasCatalog,
): SemanticRevision | undefined {
  const base = getCurrentSemantics(datasetId) ?? getWorkspaceBaseSemantics(datasetId)
  if (!store) return base

  const approved = store.listAliasCandidates(datasetId, 'approved')
  if (approved.length === 0) return base

  const byTerm = new Map<string, SemanticAlias>()
  for (const alias of base.aliases) {
    byTerm.set(alias.term.toLowerCase(), { ...alias })
  }

  // listAliasCandidates is newest-first; keep the first (newest) per term.
  const seenApproved = new Set<string>()
  const overlayApplied: Array<{ term: string; expression: string; tableId: string }> = []
  for (const candidate of approved) {
    const key = candidate.term.toLowerCase()
    if (seenApproved.has(key)) continue
    seenApproved.add(key)
    const alias: SemanticAlias = {
      term: candidate.term,
      expression: candidate.expression,
      description: candidate.description,
      tableId: candidate.tableId,
    }
    byTerm.set(key, alias)
    overlayApplied.push({
      term: alias.term,
      expression: alias.expression,
      tableId: alias.tableId,
    })
  }

  const codeTerms = new Set(base.aliases.map((alias) => alias.term.toLowerCase()))
  const aliases: SemanticAlias[] = base.aliases.map((alias) =>
    byTerm.get(alias.term.toLowerCase())!,
  )
  for (const [key, alias] of byTerm) {
    if (!codeTerms.has(key)) aliases.push(alias)
  }

  const fingerprint = approvedAliasOverlayFingerprint(overlayApplied)
  return {
    contractVersion: 1,
    datasetId: base.datasetId,
    semanticRevisionId: `${base.semanticRevisionId}+aliases.${fingerprint}`,
    createdAt: base.createdAt,
    aliases,
    metricTermsRequiringApproval: base.metricTermsRequiringApproval,
  }
}

/**
 * Resolve a concrete semantic revision id for a dataset. Rejects unknown ids
 * and revisions whose datasetId does not match the request (prevents binding
 * another dataset's aliases into a query). Overlay ids
 * (`sem-…+aliases.<fingerprint>`) are not registered here — use
 * `getEffectiveSemantics` when a catalog is open.
 */
export function resolveSemanticRevision(
  datasetId: string,
  semanticRevisionId: string,
): SemanticRevision {
  const revision = BY_REVISION_ID[semanticRevisionId]
  if (!revision) {
    throw new Error(`Unknown semantic revision "${semanticRevisionId}"`)
  }
  if (revision.datasetId !== datasetId) {
    throw new Error(
      `Semantic revision "${semanticRevisionId}" belongs to dataset "${revision.datasetId}", not "${datasetId}"`,
    )
  }
  return revision
}

/**
 * Accept a base in-code revision id or the current effective overlay id for a
 * dataset when a catalog is available. Returns the effective revision used for
 * query binding (auditable id includes approved overlay fingerprint when any).
 */
export function resolveEffectiveSemanticRevision(
  datasetId: string,
  semanticRevisionId: string,
  store?: SemanticAliasCatalog,
): SemanticRevision {
  const effective = getEffectiveSemantics(datasetId, store)
  if (!effective) {
    throw new Error(`No semantics for dataset "${datasetId}"`)
  }
  const baseId = getWorkspaceBaseSemantics(datasetId).semanticRevisionId
  const fixtureId = getFixtureSemantics(datasetId)?.semanticRevisionId
  if (
    semanticRevisionId === effective.semanticRevisionId ||
    semanticRevisionId === baseId ||
    (fixtureId !== undefined && semanticRevisionId === fixtureId)
  ) {
    return effective
  }
  // Unknown, stale overlay, or cross-dataset base id → same errors as resolve.
  return resolveSemanticRevision(datasetId, semanticRevisionId)
}

export function resolveAlias(revision: SemanticRevision, term: string): SemanticAlias | undefined {
  const needle = term.trim().toLowerCase()
  return revision.aliases.find((alias) => alias.term.toLowerCase() === needle)
}
