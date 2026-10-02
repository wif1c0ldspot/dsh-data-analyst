/**
 * Shared dashboard filter planning. Decides which pinned slots can
 * accept a shared equality filter and produces the next authorized-shaped SQL
 * for each supported slot via {@link applyEqualityFilter} — no new SQL
 * parser. Unsupported slots are disclosed with a reason instead of silently
 * changing (docs/architecture.md "no model-accessible ... writable SQL
 * bypass"; a dashboard card must never claim to reflect a filter it did not
 * apply).
 */
import { applyEqualityFilter } from './query-filter.js'

export interface SharedFilter {
  column: string
  value: string
}

export interface SlotFilterPlan {
  analysisId: string
  revision: number
  supported: boolean
  reason?: 'no-shared-filter-keys' | 'column-not-mapped'
  nextSql?: string
}

const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Conservative, human-reviewed list of column names a shared filter bar may
 * offer. Extend deliberately alongside a reviewed dashboard UX change, never
 * as a blanket "allow anything seen in a query" rule.
 */
const CANDIDATE_SHARED_FILTER_KEYS: ReadonlySet<string> = new Set([
  'region',
  'country',
  'year',
  'month',
  'category',
  'segment',
  'state',
])

/**
 * Plan the next authorized-shaped SQL for every pinned slot given one shared
 * equality filter. A slot with no declared `sharedFilterKeys` is disclosed as
 * unsupported rather than guessed at; a slot that declared keys but not this
 * particular column is also disclosed unsupported. `applyEqualityFilter`
 * still throws for a non-identifier column or an oversized value — this
 * function does not loosen that boundary.
 */
export function planDashboardFilters(
  slots: ReadonlyArray<{ analysisId: string; revision: number; sharedFilterKeys: string[] }>,
  sqlByAnalysis: ReadonlyMap<string, string>,
  filter: SharedFilter,
): SlotFilterPlan[] {
  return slots.map((slot) => {
    if (slot.sharedFilterKeys.length === 0) {
      return {
        analysisId: slot.analysisId,
        revision: slot.revision,
        supported: false,
        reason: 'no-shared-filter-keys',
      }
    }
    if (!slot.sharedFilterKeys.includes(filter.column)) {
      return {
        analysisId: slot.analysisId,
        revision: slot.revision,
        supported: false,
        reason: 'column-not-mapped',
      }
    }
    const sql = sqlByAnalysis.get(slot.analysisId)
    if (sql === undefined) {
      return {
        analysisId: slot.analysisId,
        revision: slot.revision,
        supported: false,
        reason: 'column-not-mapped',
      }
    }
    return {
      analysisId: slot.analysisId,
      revision: slot.revision,
      supported: true,
      nextSql: applyEqualityFilter(sql, filter.column, filter.value),
    }
  })
}

/**
 * Intersection of a result's own column names (simple identifiers) with the
 * conservative reviewed list, matched case-insensitively but returned in the
 * result's own casing. `sql` is accepted (not used to re-derive columns) so
 * a future reviewed extension of this heuristic never needs a signature
 * change; the result's own column names, not SQL text, remain the only
 * source of truth — this stays a lookup against reviewed columns, not a new
 * SQL parser.
 */
export function inferSharedFilterKeys(sql: string, columns: readonly string[]): string[] {
  void sql
  return columns.filter(
    (name) => SIMPLE_IDENTIFIER.test(name) && CANDIDATE_SHARED_FILTER_KEYS.has(name.toLowerCase()),
  )
}

const EQUALITY_FILTER_PREFIX = 'WITH _analysis_filter AS ('
const EQUALITY_FILTER_SUFFIX_RE =
  /\) SELECT \* FROM _analysis_filter WHERE "[A-Za-z_][A-Za-z0-9_]*" = '(?:[^']|'')*'$/

/**
 * Reverse a single outer `_analysis_filter` wrapper produced by
 * `applyEqualityFilter` (query-filter.ts), returning the SQL that was
 * originally passed to it. Returns `sql` unchanged when it does not match
 * that exact fixed shape. This only reverses our own generated template —
 * not a general SQL parser — and only ever strips one outer layer, which is
 * all a pinned dashboard slot's SQL can ever carry: `applyDashboardSharedFilter`
 * always unwraps a slot's *current* pinned revision before rewrapping it, so
 * a revision produced by this module is wrapped at most once.
 */
export function unwrapEqualityFilter(sql: string): string {
  if (!sql.startsWith(EQUALITY_FILTER_PREFIX)) return sql
  const suffixMatch = EQUALITY_FILTER_SUFFIX_RE.exec(sql)
  if (!suffixMatch) return sql
  return sql.slice(EQUALITY_FILTER_PREFIX.length, suffixMatch.index)
}

const FILTER_CAPTION_RE = / \[filter [A-Za-z_][A-Za-z0-9_]*=.*\]$/

/**
 * Strip a single trailing ` [filter col=value]` caption appended by
 * `saveAnalysisRevision` (analysis-store.ts) when given a `filter`. Returns
 * `question` unchanged when it carries no such trailing caption. Paired
 * with {@link unwrapEqualityFilter} so reapplying a shared filter to a
 * pinned revision replaces its previous filter's SQL and caption instead of
 * compounding either one.
 */
export function stripFilterCaption(question: string): string {
  return question.replace(FILTER_CAPTION_RE, '')
}

/**
 * Append the single ` [filter col=value]` caption that discloses an applied
 * equality filter on a revision's question. Shared by `saveAnalysisRevision`
 * (the persisted tool path) and the staged dashboard-filter publish path so
 * both produce identical questions. Pass a caption-free `question`
 * ({@link stripFilterCaption}) so captions replace rather than compound.
 */
export function withFilterCaption(question: string, filter?: SharedFilter): string {
  if (!filter || !filter.column) return question
  return `${question} [filter ${filter.column}=${filter.value}]`
}
