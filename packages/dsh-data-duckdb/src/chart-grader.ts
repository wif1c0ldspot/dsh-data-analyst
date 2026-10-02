/**
 * Chart appropriateness grader for Core v1 held-out eval.
 * Compares a proposed ChartIntent-like object against reviewed acceptableCharts.
 */

import { TOP_N_OUTPUT_COLUMNS } from './analytical-recipes.js'
import { cellsMatch } from './value-tolerance.js'

export type ChartMark = 'bar' | 'line' | 'point'

export interface AcceptableChart {
  mark: ChartMark
  x?: string
  y?: string
  /**
   * Case-specific alternate names for `x`, in addition to the global
   * `MEASURE_ALIASES` synonym groups below. Populated per case (from that
   * case's own `goldenSql`/question, or from an actually-observed model
   * alias) when a model is expected to plausibly name this column
   * differently than the single literal `x` string — e.g. `EXTRACT(year
   * FROM ...) AS yr` inviting a model-authored `year` instead of `yr`. This
   * is the intended way to extend chart-appropriateness coverage for a NEW
   * eval case: add the alias here, scoped to that one case, instead of
   * growing `MEASURE_ALIASES` (a global list every future case would then
   * depend on remembering to extend).
   */
  xAliases?: readonly string[]
  /** Same as {@link xAliases}, for `y`. */
  yAliases?: readonly string[]
}

export interface ChartIntentLike {
  mark: string
  x?: string
  y?: string
}

function normalizeColumn(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  let cleaned = value
    .trim()
    .toLowerCase()
    .replace(/@[\w.-]+$/g, '')
  // Collapse model-authored aggregates into result-alias roles.
  if (
    /count\s*\(\s*distinct\s+invoice/i.test(cleaned) ||
    /invoice_count/.test(cleaned) ||
    cleaned === 'distinct_invoices'
  ) {
    return 'invoices'
  }
  if (/^count\s*\(/i.test(cleaned) || cleaned === 'count(*)') return 'n'
  if (
    /sum\s*\(\s*quantity\s*\)/i.test(cleaned) ||
    /^total[_\s]?quantity\b/.test(cleaned) ||
    cleaned === 'net_quantity' ||
    cleaned === 'quantity_sold'
  ) {
    return 'qty'
  }
  if (/sum\s*\(\s*(sales|amount)\s*\)/i.test(cleaned)) return 'revenue'
  if (/sum\s*\(\s*profit\s*\)/i.test(cleaned) || /^profit\b/.test(cleaned)) return 'profit'
  if (/sum\s*\(\s*price\s*\)/i.test(cleaned) || cleaned === 'summed_unit_price') {
    return 'total_price'
  }
  if (/sum\s*\(\s*payment_value\s*\)/i.test(cleaned) || cleaned === 'total_payment_value') {
    return 'total'
  }
  if (/payment_row_count/.test(cleaned)) {
    return 'payment_row_count'
  }
  if (/order_item_count/.test(cleaned)) {
    return 'order_item_count'
  }
  // English category column → reviewed alias used in golden SQL.
  if (cleaned === 'product_category_name_english' || cleaned === 'category_en') return 'category'
  // Bare expressions like "SUM(quantity)" already handled; strip remaining fn wrappers.
  const inner = cleaned.match(/^(?:sum|avg|min|max|count)\s*\(\s*([a-z_][\w]*)\s*\)$/i)
  if (inner?.[1]) cleaned = inner[1].toLowerCase()
  return cleaned
}

/** Reviewed measure aliases that count as the same chart y/x role. */
const MEASURE_ALIASES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['revenue', 'sales', 'sales_revenue', 'total_sales', 'sum_sales', 'amount']),
  new Set([
    'n',
    'count',
    'order_line_count',
    'line_item_count',
    'line_items',
    'payment_row_count',
    'payment_rows',
    'order_item_count',
    'review_count',
    'customer_count',
    'customers',
    'seller_count',
  ]),
  new Set(['qty', 'quantity', 'total_quantity']),
  new Set(['orders', 'order_count']),
  new Set(['profit', 'total_profit']),
  new Set(['total_price', 'total_unit_price', 'price', 'unit_price_sum', 'unit_price']),
  new Set(['total', 'payment_value', 'sum_payment']),
  new Set(['invoices', 'invoice_count', 'invoice']),
  new Set(['payment_row_count', 'payments']),
]

function columnsEquivalent(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a === b) return true
  return MEASURE_ALIASES.some((group) => group.has(a) && group.has(b))
}

/**
 * True when `intentValue` matches `entryValue` either directly (with
 * measure-alias tolerance, {@link columnsEquivalent}) or matches one of that
 * entry's case-specific `aliases` (also alias-tolerant, so an alias itself
 * can be written in whatever casing/form is natural). `aliases` is the
 * per-case escape hatch described on {@link AcceptableChart}.
 */
function columnMatches(
  entryValue: string | undefined,
  aliases: readonly string[] | undefined,
  intentValue: string | undefined,
): boolean {
  if (entryValue === undefined) return true
  if (columnsEquivalent(normalizeColumn(entryValue), intentValue)) return true
  if (aliases === undefined) return false
  return aliases.some((alias) => columnsEquivalent(normalizeColumn(alias), intentValue))
}

/** Additional evidence available when the grader can see the answer call's actual result. */
export interface ChartGradeContext {
  /**
   * The column names the answer-producing tool call actually returned (e.g.
   * `duckdb_query`'s `columns`, or `find_top_n`'s fixed recipe output). These
   * are the columns `intent.x`/`intent.y` must be drawn from when grading by
   * role instead of by name.
   */
  resultColumns?: readonly string[]
  /**
   * The answer's actual cell values for each of `resultColumns`, keyed by
   * column name (e.g. the answer preview transposed column-by-column). Used
   * together with {@link ChartGradeContext.roleValues} to confirm that a
   * bound column really *is* the expected role, by value, rather than
   * inferring identity from where the column sits among `resultColumns`.
   * Optional: when absent (older recorded traces with no column-level data),
   * value confirmation cannot run and a column can only be accepted via rule
   * 1 (the tool's own fixed output names) or rule 2 (suffix-stripped name
   * match) — never via position alone.
   */
  columnValues?: Readonly<Record<string, readonly unknown[]>>
  /**
   * The reviewed *expected* values for each role (dimension/measure),
   * derived by the caller from the graded case's own expected result — e.g.
   * `expectedPreview`'s first column for the dimension and its last column
   * for the measure. Deliberately supplied by the caller rather than looked
   * up here: `chart-grader.ts` stays free of any corpus/case knowledge.
   */
  roleValues?: {
    dimension?: readonly unknown[]
    measure?: readonly unknown[]
  }
  /**
   * Value-tolerant equality predicate for comparing an actual cell against
   * an expected one. Defaults to {@link cellsMatch} — the same tolerance
   * `previewMatchesExpected`/`previewContainsExpectedMeasures` use for SQL
   * grading — so there is one definition of "value matches" across the eval
   * harness. Callers can override it, but chart-grader.ts never hardcodes a
   * second tolerance itself.
   */
  valueMatches?: (actual: unknown, expected: unknown) => boolean
}

/**
 * True when every value in `expected` is found, via `matches`, among a
 * distinct, not-yet-consumed value of `actual` — the same "required values
 * present somewhere, order-independent" shape as `nl-eval.ts`'s
 * `rowContainsAllValues`, generalized to an injectable predicate so it can
 * reuse whatever tolerance the caller supplies (normally {@link cellsMatch})
 * instead of a second hardcoded one.
 */
function valuesConfirmRole(
  actual: readonly unknown[],
  expected: readonly unknown[],
  matches: (actual: unknown, expected: unknown) => boolean,
): boolean {
  if (expected.length === 0) return false
  const consumed = new Array<boolean>(actual.length).fill(false)
  return expected.every((expectedValue) => {
    const index = actual.findIndex((value, i) => !consumed[i] && matches(value, expectedValue))
    if (index === -1) return false
    consumed[index] = true
    return true
  })
}

/**
 * Scale-normalized measure suffixes a model attaches to its *own*
 * expression (`profit / sales * 100 AS profit_margin_pct`) that the golden
 * SQL's alias never carries (`margin_pct`). Stripping one and re-checking
 * the existing alias-tolerant comparison lets `profit_margin_pct` reach the
 * reviewed `profit_margin`/`margin` aliases without adding
 * `profit_margin_pct` itself as a new per-case alias — the next model to
 * invent `..._ratio` or `..._rate` is covered by the same rule instead of
 * needing its own list entry.
 */
const RELATIVE_MEASURE_SUFFIXES = ['_percentage', '_percent', '_pct', '_ratio', '_rate'] as const

function stripRelativeMeasureSuffix(value: string): string | undefined {
  for (const suffix of RELATIVE_MEASURE_SUFFIXES) {
    if (value.endsWith(suffix) && value.length > suffix.length) {
      return value.slice(0, -suffix.length)
    }
  }
  return undefined
}

/**
 * True when `intentValue` reproduces the accepted entry's `role` (dimension
 * for x, measure for y) via the answer call's *actual* result columns,
 * rather than via any name/alias list. This is the mechanism that stops the
 * alias treadmill described in `gradeChartIntent`'s doc comment: no list of
 * names can anticipate `profit_margin_pct`, `order_year`,
 * `total_quantity_sold`, or whatever the next model invents, but the result
 * columns are the tool's actual output and are already visible to the
 * model — a chart that binds the dimension slot to the dimension column and
 * the measure slot to the measure column is correct regardless of what the
 * SQL aliased them.
 *
 * Three independent ways a result column can be identified as playing
 * `role`, tried in order:
 *  1. It is `find_top_n`'s own fixed output column for that role
 *     (`TOP_N_OUTPUT_COLUMNS`) — chosen by the tool, not the model, and
 *     therefore knowable in advance regardless of what the accepted entry's
 *     own `x`/`y` literal happens to be named.
 *  2. Stripping a known relative-measure suffix from it reaches the
 *     existing alias-tolerant name match (`profit_margin_pct` -> `profit_margin`).
 *  3. **Value confirms identity**: the caller-supplied expected values for
 *     `role` ({@link ChartGradeContext.roleValues}) are all found, using the
 *     SQL grader's own tolerance ({@link cellsMatch} or the caller's
 *     `valueMatches`), among the column's *actual* values
 *     ({@link ChartGradeContext.columnValues}). This replaced an earlier
 *     rule that inferred identity purely from column position ("exactly two
 *     columns, so column 2 is the measure") — position alone proved nothing
 *     about which value it held, so a wrong measure in a two-column result
 *     passed, and a correct measure with a name unreachable by (1)/(2) could
 *     fail the moment a third column appeared. Confirming by value fixes
 *     both: a column is accepted for `role` only when it actually carries
 *     that role's expected values, in *any* result shape, not only when it
 *     happens to sit in a particular slot.
 * When none of (1)-(3) identifies the model's column — including when the
 * caller supplies no `roleValues`/`columnValues` at all, e.g. older recorded
 * traces with no column-level evidence — the role is deliberately left
 * unresolved (returns false) rather than guessed.
 */
function reproducesRole(
  role: 'dimension' | 'measure',
  entryValue: string | undefined,
  aliases: readonly string[] | undefined,
  intentValue: string | undefined,
  resultColumns: readonly string[],
  context?: Pick<ChartGradeContext, 'columnValues' | 'roleValues' | 'valueMatches'>,
): boolean {
  if (entryValue === undefined) return true
  if (intentValue === undefined) return false
  const normalizedResultColumns = resultColumns.map((column) => normalizeColumn(column))
  const matchIndex = normalizedResultColumns.indexOf(intentValue)
  if (matchIndex === -1) return false

  const topNName = normalizeColumn(
    role === 'dimension' ? TOP_N_OUTPUT_COLUMNS.dimension : TOP_N_OUTPUT_COLUMNS.measure,
  )
  if (intentValue === topNName) return true

  const stripped = stripRelativeMeasureSuffix(intentValue)
  if (stripped !== undefined && columnMatches(entryValue, aliases, stripped)) return true

  const expectedValues = context?.roleValues?.[role]
  const originalColumnName = resultColumns[matchIndex]
  const actualValues =
    originalColumnName !== undefined ? context?.columnValues?.[originalColumnName] : undefined
  if (expectedValues !== undefined && actualValues !== undefined) {
    const matches = context?.valueMatches ?? cellsMatch
    if (valuesConfirmRole(actualValues, expectedValues, matches)) return true
  }

  return false
}

/**
 * Grade a proposed chart intent against reviewed acceptable charts.
 * Mark must match one entry; when that entry specifies x/y, those columns
 * must match case-insensitively on the intent (with measure-alias tolerance,
 * plus that entry's own case-specific `xAliases`/`yAliases` when present).
 *
 * When `context.resultColumns` is supplied (the answer call's actual result
 * columns), an axis that the name/alias check above rejects gets a second
 * chance via {@link reproducesRole}: the column is accepted when it
 * reproduces the accepted entry's *role* in that real result, not when its
 * name happens to be on a list. This is the fallback-of-last-resort, tried
 * only for axes the direct name/alias match didn't already accept — traces
 * recorded before this change (or direct unit calls) that never pass
 * `context` grade exactly as they did before, via the name/alias path alone.
 */
export function gradeChartIntent(
  intent: ChartIntentLike,
  acceptable: readonly AcceptableChart[],
  context?: ChartGradeContext,
): boolean {
  if (acceptable.length === 0) return false
  const intentX = normalizeColumn(intent.x)
  const intentY = normalizeColumn(intent.y)
  const resultColumns = context?.resultColumns
  return acceptable.some((entry) => {
    if (entry.mark !== intent.mark) return false
    const xMatchesByName = columnMatches(entry.x, entry.xAliases, intentX)
    const yMatchesByName = columnMatches(entry.y, entry.yAliases, intentY)
    if (xMatchesByName && yMatchesByName) return true
    if (resultColumns === undefined) return false
    const xOk =
      xMatchesByName ||
      reproducesRole('dimension', entry.x, entry.xAliases, intentX, resultColumns, context)
    const yOk =
      yMatchesByName ||
      reproducesRole('measure', entry.y, entry.yAliases, intentY, resultColumns, context)
    return xOk && yOk
  })
}
