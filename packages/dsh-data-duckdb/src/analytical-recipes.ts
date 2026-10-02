/**
 * Narrow analytical SQL recipes for recurring, hand-auditable calculations.
 *
 * Callers supply identifiers from an already approved schema scope. This module
 * validates membership and builds fixed statement shapes; it does not accept SQL
 * fragments, predicates, expressions, or paths. The resulting SQL and typed
 * parameters still run through executeAuthorizedQuery, so policy, read-only
 * access, cancellation, and result budgets remain the enforcement boundary.
 */

/**
 * Fixed output column names `top-n-extrema` (via `find_top_n`) always
 * produces for its grouped form: the dimension is `dimension_value`, the
 * aggregate is `aggregate_value`. These are chosen by this module, not by
 * the model, so a chart-grading pass that recognizes them by name is
 * recognizing the tool's contract, not guessing at model-authored aliases —
 * see `chart-grader.ts`'s role-based matching, which uses this constant so
 * the two places that need this mapping (the SQL builder below and the
 * grader) can't drift apart.
 */
export const TOP_N_OUTPUT_COLUMNS = {
  dimension: 'dimension_value',
  measure: 'aggregate_value',
} as const

export interface AnalyticalRecipeScope {
  table: string
  columns: readonly string[]
  /** DuckDB logical types from the approved schema, keyed by every scoped column. */
  columnTypes: Readonly<Record<string, string>>
  grainStatus: 'approved' | 'unknown'
}

export interface AnalyticalRecipeQuery {
  kind: AnalyticalRecipeInput['kind']
  sql: string
  parameters: readonly { logicalType: string; value: unknown }[]
}

/**
 * `reconcile-grains` compares independent population totals from two
 * different tables (e.g. an order-level total vs. an item-level total),
 * unlike every other recipe kind here, which validates one table scope.
 * Reusing that single-table `AnalyticalRecipeScope` shape twice keeps the
 * same identifier/type validation for each table instead of inventing a
 * second scope-checking path.
 */
export interface ReconcileGrainsScope {
  primary: AnalyticalRecipeScope
  secondary: AnalyticalRecipeScope
  /**
   * True when an analyst-approved relationship links `primary.table` and
   * `secondary.table` (from `getEffectiveRelationships`) — resolved by the
   * caller, same "reviewed structure only" precondition `ratio-of-sums`
   * already applies via `grainStatus`. Comparing two tables the ingest
   * profiler never found related to each other is not a grain
   * reconciliation; it is an arbitrary, likely meaningless number pair.
   */
  relationshipApproved: boolean
}

export type AnalyticalRecipeInput =
  | {
      kind: 'descriptive-statistics'
      valueColumn: string
      groupColumn?: string
    }
  | {
      kind: 'full-row-duplicate-excess'
      /** Must contain every approved column in the table scope, exactly once. */
      rowColumns: readonly string[]
    }
  | {
      kind: 'elapsed-intervals'
      elapsedColumn: string
      widthSeconds: number
      originSeconds: number
    }
  | {
      kind: 'ratio-of-sums'
      numeratorColumn: string
      denominatorColumn: string
      nullRule: 'withhold-on-incomplete-pairs' | 'exclude-incomplete-pairs'
    }
  | {
      kind: 'reconcile-grains'
      /** Column in the primary scope's table, e.g. an order-level total. */
      primaryColumn: string
      /** Column in the secondary scope's table, e.g. an item-level line amount. */
      secondaryColumn: string
    }
  | {
      kind: 'top-n-extrema'
      /** Approved numeric column to rank by. */
      measureColumn: string
      /**
       * Approved grouping/dimension column. When present, ranks aggregate
       * (summed) values per distinct group. When absent, ranks individual
       * rows and projects every approved column.
       */
      groupColumn?: string
      direction: 'top' | 'bottom'
      /** Bounded row/group count; see MAX_TOP_N_LIMIT. */
      limit: number
    }

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_INTERVAL_SECONDS = 10 * 365 * 24 * 60 * 60
/** Hard cap on `top-n-extrema`'s LIMIT — never an unbounded scan result. */
const MAX_TOP_N_LIMIT = 50
const INTEGER_UP_TO_64_BIT_TYPE = /^(?:U?(?:TINYINT|SMALLINT|INTEGER|INT|BIGINT))$/i
const NUMERIC_TYPE =
  /^(?:U?(?:TINY|SMALL|BIG|HUGE)?INT(?:EGER)?|FLOAT|REAL|DOUBLE|DECIMAL\(\d{1,2},\d{1,2}\))$/i
const DECIMAL_TYPE = /^DECIMAL\((\d{1,2}),(\d{1,2})\)$/i
const MAX_DERIVED_DECIMAL_PRECISION = 15

/**
 * `find_top_n`'s `direction` synonyms, normalized to the canonical
 * `'top'`/`'bottom'` values `topNExtrema` orders on. A live model-driven eval
 * run found 6/9 calls to this tool errored because the model naturally said
 * `"desc"`/`"descending"` instead of the literal `"top"` — this table is the
 * single place that vocabulary is defined, reused by both the tool's input
 * validation and its error message so the two never drift apart.
 */
export const TOP_N_DIRECTION_SYNONYMS: Readonly<Record<string, 'top' | 'bottom'>> = {
  top: 'top',
  desc: 'top',
  descending: 'top',
  highest: 'top',
  largest: 'top',
  max: 'top',
  bottom: 'bottom',
  asc: 'bottom',
  ascending: 'bottom',
  lowest: 'bottom',
  smallest: 'bottom',
  min: 'bottom',
}

/**
 * Normalizes a caller-supplied `direction` string (case-insensitive) to the
 * canonical `'top'`/`'bottom'` value, or throws an error that lists the full
 * accepted vocabulary so a caller sees every valid option in one shot
 * instead of guessing again after a rejection.
 */
export function normalizeTopNDirection(direction: string): 'top' | 'bottom' {
  const normalized = TOP_N_DIRECTION_SYNONYMS[direction.trim().toLowerCase()]
  if (normalized === undefined) {
    const accepted = [...new Set(Object.keys(TOP_N_DIRECTION_SYNONYMS))].join(', ')
    throw new Error(`direction must be one of: ${accepted}`)
  }
  return normalized
}

function validateIdentifier(identifier: string, label: string): void {
  if (!IDENTIFIER.test(identifier)) {
    throw new Error(`${label} must be an approved internal SQL identifier`)
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier}"`
}

function validateScope(scope: AnalyticalRecipeScope): Set<string> {
  validateIdentifier(scope.table, 'table')
  if (scope.columns.length === 0) throw new Error('approved columns must not be empty')
  const columns = new Set<string>()
  for (const column of scope.columns) {
    validateIdentifier(column, 'column')
    if (columns.has(column)) throw new Error(`approved column is duplicated: ${column}`)
    const logicalType = scope.columnTypes[column]
    if (typeof logicalType !== 'string' || logicalType.trim().length === 0) {
      throw new Error(`approved column is missing DuckDB logical type metadata: ${column}`)
    }
    columns.add(column)
  }
  const unknownTypeColumns = Object.keys(scope.columnTypes).filter((column) => !columns.has(column))
  if (unknownTypeColumns.length > 0) {
    throw new Error(`logical type metadata contains columns outside the approved scope`)
  }
  return columns
}

function approvedColumnType(scope: AnalyticalRecipeScope, column: string): string {
  const logicalType = scope.columnTypes[column]
  if (logicalType === undefined) throw new Error(`column has no approved logical type: ${column}`)
  return logicalType.trim().toUpperCase()
}

function approvedColumn(columns: ReadonlySet<string>, column: string): string {
  validateIdentifier(column, 'column')
  if (!columns.has(column)) throw new Error(`column is not in the approved scope: ${column}`)
  return quoteIdentifier(column)
}

function validateSafeSeconds(value: number, label: string, allowNegative: boolean): void {
  if (!Number.isSafeInteger(value))
    throw new Error(`${label} must be a safe integer number of seconds`)
  if (!allowNegative && value <= 0) throw new Error(`${label} must be greater than zero`)
  if (Math.abs(value) > MAX_INTERVAL_SECONDS) {
    throw new Error(`${label} exceeds the ${MAX_INTERVAL_SECONDS}-second recipe bound`)
  }
}

function descriptiveStatistics(
  table: string,
  columns: ReadonlySet<string>,
  scope: AnalyticalRecipeScope,
  input: Extract<AnalyticalRecipeInput, { kind: 'descriptive-statistics' }>,
): AnalyticalRecipeQuery {
  const value = approvedColumn(columns, input.valueColumn)
  const valueType = approvedColumnType(scope, input.valueColumn)
  if (!NUMERIC_TYPE.test(valueType)) {
    throw new Error('descriptive statistics require an approved numeric column type')
  }
  const group = input.groupColumn ? approvedColumn(columns, input.groupColumn) : undefined
  const prefix = group ? `${group} AS comparison_group,\n       ` : ''
  const suffix = group ? `\nGROUP BY ${group}\nORDER BY ${group}` : ''
  const decimal = DECIMAL_TYPE.exec(valueType)
  const highPrecisionDecimal =
    decimal !== null && Number(decimal[1]) > MAX_DERIVED_DECIMAL_PRECISION
  const unsafe = highPrecisionDecimal
    ? 'TRUE'
    : `min(${value}) < -9007199254740991 OR max(${value}) > 9007199254740991`
  const guarded = (expression: string) => `CASE WHEN ${unsafe} THEN NULL ELSE ${expression} END`
  return {
    kind: input.kind,
    sql:
      `SELECT ${prefix}count(*) AS total_count,\n` +
      `       count(${value}) AS non_null_count,\n` +
      `       count(*) - count(${value}) AS null_count,\n` +
      `       (count(*) - count(${value})) / nullif(count(*), 0) AS null_share,\n` +
      `       min(${value}) AS min_value,\n` +
      `       max(${value}) AS max_value,\n` +
      `       ${guarded(`avg(${value})`)} AS mean_value,\n` +
      `       ${guarded(`median(${value})`)} AS median_value,\n` +
      `       ${guarded(`quantile_cont(${value}, 0.25)`)} AS first_quartile,\n` +
      `       ${guarded(`quantile_cont(${value}, 0.75)`)} AS third_quartile,\n` +
      `       CASE\n` +
      `         WHEN count(${value}) = 0 THEN 'NO_NON_NULL_VALUES'\n` +
      (highPrecisionDecimal ? `         WHEN TRUE THEN 'WITHHELD_HIGH_PRECISION_DECIMAL'\n` : '') +
      (highPrecisionDecimal
        ? ''
        : `         WHEN ${unsafe} THEN 'WITHHELD_UNSAFE_DOUBLE_PRECISION'\n`) +
      `         ELSE 'DERIVED_DOUBLE'\n` +
      `       END AS distribution_precision\n` +
      `FROM ${table}${suffix}`,
    parameters: [],
  }
}

function duplicateExcess(
  table: string,
  columns: ReadonlySet<string>,
  input: Extract<AnalyticalRecipeInput, { kind: 'full-row-duplicate-excess' }>,
): AnalyticalRecipeQuery {
  const requested = new Set(input.rowColumns)
  if (
    requested.size !== input.rowColumns.length ||
    requested.size !== columns.size ||
    [...columns].some((column) => !requested.has(column))
  ) {
    throw new Error('full-row duplicate excess requires every approved table column exactly once')
  }
  const row = input.rowColumns.map((column) => approvedColumn(columns, column)).join(', ')
  return {
    kind: input.kind,
    sql:
      `WITH row_counts AS (\n` +
      `  SELECT count(*) AS row_count\n` +
      `  FROM ${table}\n` +
      `  GROUP BY ${row}\n` +
      `)\n` +
      `SELECT coalesce(sum(row_count), 0) AS total_count,\n` +
      `       count(*) AS distinct_row_count,\n` +
      `       coalesce(sum(row_count - 1), 0) AS duplicate_excess\n` +
      `FROM row_counts`,
    parameters: [],
  }
}

function elapsedIntervals(
  table: string,
  columns: ReadonlySet<string>,
  scope: AnalyticalRecipeScope,
  input: Extract<AnalyticalRecipeInput, { kind: 'elapsed-intervals' }>,
): AnalyticalRecipeQuery {
  validateSafeSeconds(input.widthSeconds, 'widthSeconds', false)
  validateSafeSeconds(input.originSeconds, 'originSeconds', true)
  const elapsed = approvedColumn(columns, input.elapsedColumn)
  if (!INTEGER_UP_TO_64_BIT_TYPE.test(approvedColumnType(scope, input.elapsedColumn))) {
    throw new Error('elapsed intervals require an approved integer column type up to 64 bits')
  }
  return {
    kind: input.kind,
    sql:
      `WITH interval_values AS (\n` +
      `  SELECT CAST(${elapsed} AS HUGEINT) - CAST(? AS HUGEINT) AS offset_seconds,\n` +
      `         CAST(? AS HUGEINT) AS width_seconds\n` +
      `  FROM ${table}\n` +
      `  WHERE ${elapsed} IS NOT NULL\n` +
      `), indexed AS (\n` +
      `  SELECT CASE\n` +
      `           WHEN offset_seconds < 0 AND offset_seconds % width_seconds <> 0\n` +
      `             THEN offset_seconds // width_seconds - 1\n` +
      `           ELSE offset_seconds // width_seconds\n` +
      `         END AS interval_index\n` +
      `  FROM interval_values\n` +
      `)\n` +
      `SELECT interval_index,\n` +
      `       count(*) AS row_count\n` +
      `FROM indexed\n` +
      `GROUP BY interval_index\n` +
      `ORDER BY interval_index`,
    parameters: [
      { logicalType: 'BIGINT', value: String(input.originSeconds) },
      { logicalType: 'BIGINT', value: String(input.widthSeconds) },
    ],
  }
}

function ratioOfSums(
  table: string,
  columns: ReadonlySet<string>,
  input: Extract<AnalyticalRecipeInput, { kind: 'ratio-of-sums' }>,
): AnalyticalRecipeQuery {
  const numerator = approvedColumn(columns, input.numeratorColumn)
  const denominator = approvedColumn(columns, input.denominatorColumn)
  const complete = `${numerator} IS NOT NULL AND ${denominator} IS NOT NULL`
  const numeratorSum = `sum(CASE WHEN ${complete} THEN ${numerator} ELSE NULL END)`
  const denominatorSum = `sum(CASE WHEN ${complete} THEN ${denominator} ELSE NULL END)`
  const incompleteCount = `count(*) - count(CASE WHEN ${complete} THEN 1 ELSE NULL END)`
  const division = `${numeratorSum} / nullif(${denominatorSum}, 0)`
  const rate =
    input.nullRule === 'withhold-on-incomplete-pairs'
      ? `CASE\n         WHEN ${incompleteCount} > 0 THEN NULL\n         ELSE ${division}\n       END`
      : division
  const incompleteReason =
    input.nullRule === 'withhold-on-incomplete-pairs'
      ? `         WHEN ${incompleteCount} > 0 THEN 'INCOMPLETE_PAIRS'\n`
      : ''
  return {
    kind: input.kind,
    sql:
      `SELECT count(*) AS total_count,\n` +
      `       ${incompleteCount} AS incomplete_pair_count,\n` +
      `       ${numeratorSum} AS numerator_sum,\n` +
      `       ${denominatorSum} AS denominator_sum,\n` +
      `       ${rate} AS population_rate,\n` +
      `       CASE\n` +
      incompleteReason +
      `         WHEN ${denominatorSum} IS NULL THEN 'NO_COMPLETE_PAIRS'\n` +
      `         WHEN ${denominatorSum} = 0 THEN 'ZERO_DENOMINATOR'\n` +
      `         ELSE NULL\n` +
      `       END AS undefined_reason\n` +
      `FROM ${table}`,
    parameters: [],
  }
}

/**
 * Ranks the table by one approved numeric measure and returns a bounded
 * top/bottom slice — a fixed `ORDER BY ... LIMIT` shape, never
 * agent-composed SQL. With `groupColumn`, ranks aggregate (summed) values
 * per distinct group; without it, ranks individual rows and projects every
 * approved column. Both shapes append an explicit ascending tiebreaker
 * (the group column, or every other approved column) so ties at the LIMIT
 * boundary resolve deterministically across repeated runs, independent of
 * `runFixedQuery`'s own `ORDER BY ALL` stabilizer (which only applies when
 * the caller's SQL has no top-level `ORDER BY` of its own — this recipe
 * always has one).
 */
function topNExtrema(
  table: string,
  columns: ReadonlySet<string>,
  scope: AnalyticalRecipeScope,
  input: Extract<AnalyticalRecipeInput, { kind: 'top-n-extrema' }>,
): AnalyticalRecipeQuery {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_TOP_N_LIMIT) {
    throw new Error(`top-n-extrema limit must be an integer between 1 and ${MAX_TOP_N_LIMIT}`)
  }
  const measure = approvedColumn(columns, input.measureColumn)
  const measureType = approvedColumnType(scope, input.measureColumn)
  if (!NUMERIC_TYPE.test(measureType)) {
    throw new Error('top-n-extrema requires an approved numeric measure column type')
  }
  const order = input.direction === 'top' ? 'DESC' : 'ASC'
  if (input.groupColumn !== undefined) {
    const group = approvedColumn(columns, input.groupColumn)
    return {
      kind: input.kind,
      sql:
        `SELECT ${group} AS ${TOP_N_OUTPUT_COLUMNS.dimension},\n` +
        `       sum(${measure}) AS ${TOP_N_OUTPUT_COLUMNS.measure},\n` +
        `       count(*) AS row_count\n` +
        `FROM ${table}\n` +
        `WHERE ${measure} IS NOT NULL\n` +
        `GROUP BY ${group}\n` +
        `ORDER BY sum(${measure}) ${order}, ${group} ASC\n` +
        `LIMIT ${input.limit}`,
      parameters: [],
    }
  }
  const tiebreakers = [...columns]
    .filter((column) => column !== input.measureColumn)
    .sort()
    .map((column) => `${quoteIdentifier(column)} ASC`)
  const orderClause = [`${measure} ${order}`, ...tiebreakers].join(', ')
  return {
    kind: input.kind,
    sql:
      `SELECT *\n` +
      `FROM ${table}\n` +
      `WHERE ${measure} IS NOT NULL\n` +
      `ORDER BY ${orderClause}\n` +
      `LIMIT ${input.limit}`,
    parameters: [],
  }
}

/**
 * Two independent population sums, never a join: each side is `SUM(column)
 * FROM table` on its own approved scope. A per-key join comparison would
 * need row-level output (pagination, limits) unlike every other recipe's
 * single aggregate row, and the walkthrough finding this recipe targets
 * ("item-level net sales are ~9% higher than order-level values") is itself
 * a population-level comparison, not a per-order breakdown.
 */
export function buildReconcileGrainsRecipe(
  scope: ReconcileGrainsScope,
  input: Extract<AnalyticalRecipeInput, { kind: 'reconcile-grains' }>,
): AnalyticalRecipeQuery {
  if (!scope.relationshipApproved) {
    throw new Error(
      `reconcile-grains requires an analyst-approved relationship between "${scope.primary.table}" and "${scope.secondary.table}". ` +
        'Call propose_structure on this dataset to profile and surface a candidate relationship for analyst approval (see list_pending_structure for anything already awaiting review), ' +
        'or ask the analyst whether one already exists, then retry reconcile_totals. Do not hand-write a join to work around this.',
    )
  }
  const primaryColumns = validateScope(scope.primary)
  const secondaryColumns = validateScope(scope.secondary)
  const primaryTable = quoteIdentifier(scope.primary.table)
  const secondaryTable = quoteIdentifier(scope.secondary.table)
  const primaryValue = approvedColumn(primaryColumns, input.primaryColumn)
  const primaryType = approvedColumnType(scope.primary, input.primaryColumn)
  const secondaryValue = approvedColumn(secondaryColumns, input.secondaryColumn)
  const secondaryType = approvedColumnType(scope.secondary, input.secondaryColumn)
  if (!NUMERIC_TYPE.test(primaryType) || !NUMERIC_TYPE.test(secondaryType)) {
    throw new Error('reconcile-grains requires approved numeric column types on both sides')
  }
  return {
    kind: input.kind,
    sql:
      `WITH primary_total AS (\n` +
      `  SELECT sum(${primaryValue}) AS total, count(*) AS row_count\n` +
      `  FROM ${primaryTable}\n` +
      `), secondary_total AS (\n` +
      `  SELECT sum(${secondaryValue}) AS total, count(*) AS row_count\n` +
      `  FROM ${secondaryTable}\n` +
      `)\n` +
      `SELECT primary_total.total AS primary_total,\n` +
      `       primary_total.row_count AS primary_row_count,\n` +
      `       secondary_total.total AS secondary_total,\n` +
      `       secondary_total.row_count AS secondary_row_count,\n` +
      `       primary_total.total - secondary_total.total AS delta,\n` +
      `       (primary_total.total - secondary_total.total) / nullif(primary_total.total, 0)\n` +
      `         AS delta_share_of_primary,\n` +
      `       CASE\n` +
      `         WHEN primary_total.total IS NULL OR secondary_total.total IS NULL\n` +
      `           THEN 'NO_NON_NULL_VALUES_ON_ONE_SIDE'\n` +
      `         WHEN primary_total.total = 0 THEN 'ZERO_PRIMARY_TOTAL'\n` +
      `         ELSE NULL\n` +
      `       END AS undefined_reason\n` +
      `FROM primary_total, secondary_total`,
    parameters: [],
  }
}

export function buildAnalyticalRecipe(
  scope: AnalyticalRecipeScope,
  input: AnalyticalRecipeInput,
): AnalyticalRecipeQuery {
  if (input.kind === 'reconcile-grains') {
    throw new Error(
      'reconcile-grains spans two tables; call buildReconcileGrainsRecipe instead of buildAnalyticalRecipe',
    )
  }
  const columns = validateScope(scope)
  const table = quoteIdentifier(scope.table)
  if (input.kind === 'ratio-of-sums' && scope.grainStatus !== 'approved') {
    throw new Error('ratio-of-sums requires an approved numerator/denominator table grain')
  }
  switch (input.kind) {
    case 'descriptive-statistics':
      return descriptiveStatistics(table, columns, scope, input)
    case 'full-row-duplicate-excess':
      return duplicateExcess(table, columns, input)
    case 'elapsed-intervals':
      return elapsedIntervals(table, columns, scope, input)
    case 'ratio-of-sums':
      return ratioOfSums(table, columns, input)
    case 'top-n-extrema':
      return topNExtrema(table, columns, scope, input)
  }
}
