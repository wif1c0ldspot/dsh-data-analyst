/**
 * SQL currency-mix warnings. Walks the real
 * parsed statement DuckDB's own `json_serialize_sql` produces
 * (`sql-policy.ts:parseSqlStatement`/`authorizeQuery`) — not a SQL parser of
 * our own, and not regex against SQL text — but still an advisory layer,
 * never a policy gate: "a warning here is advice quoted back to the
 * analyst; it never denies a query," same design stance as `join-warnings.ts`.
 *
 * A hard `QueryPolicyViolation` denial is still deliberately not built here.
 * Resolving which column an aggregate closes over and whether it's already
 * scoped is exactly what this module now does correctly — but a *denial*
 * built on it would fail closed on any AST shape this walk doesn't
 * recognize (a window frame, a lateral join, a DuckDB syntax extension not
 * exercised by this module's fixtures), turning an unfamiliar-but-safe
 * query into a hard block. A missed warning here is still just missing
 * advice, not a false safety guarantee; a wrong denial would be worse than
 * either. Enforcement stays a documented follow-up.
 *
 * This module takes an already-parsed statement (`unknown`, narrowed with
 * `isRecord`/`Array.isArray` exactly like `sql-policy.ts` treats every AST
 * node) rather than a SQL string, deliberately: `dsh-data-core` has no
 * DuckDB dependency (parsing needs a live connection via
 * `json_serialize_sql`), and reusing the statement `authorizeQuery` already
 * parsed for policy avoids parsing the same SQL twice.
 */

export interface CurrencyDimensionRef {
  tableId: string
  column: string
  currencies: readonly string[]
}

const AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set(['sum', 'avg'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function lastSegment(columnNames: readonly unknown[]): string {
  const last = columnNames[columnNames.length - 1]
  return typeof last === 'string' ? last.toLowerCase() : ''
}

/** Qualifier (alias or bare table name) → real table name, for one `from_table` scope. */
interface TableScope {
  qualifierToTable: Map<string, string>
}

/**
 * Populate `scope` from a `from_table` tree (`BASE_TABLE`/`JOIN` nodes).
 * `SUBQUERY` aliases are deliberately NOT added: a derived column read
 * through a subquery alias is never the same risk shape as a raw table
 * column — if the subquery itself sums a flagged column unsafely, its own
 * nested `SELECT_NODE` is walked as an independent scope by
 * {@link collectSelectNodes} and flagged there instead.
 */
function collectTableScope(fromTable: unknown, scope: TableScope): void {
  if (!isRecord(fromTable)) return
  if (fromTable.type === 'BASE_TABLE') {
    const tableName = String(fromTable.table_name ?? '').toLowerCase()
    if (!tableName) return
    const alias =
      typeof fromTable.alias === 'string' && fromTable.alias ? fromTable.alias.toLowerCase() : ''
    if (alias) scope.qualifierToTable.set(alias, tableName)
    scope.qualifierToTable.set(tableName, tableName)
  } else if (fromTable.type === 'JOIN') {
    collectTableScope(fromTable.left, scope)
    collectTableScope(fromTable.right, scope)
  }
}

/**
 * Resolve a `COLUMN_REF`'s table. A qualified reference
 * (`column_names: [qualifier, column]`) resolves through the scope's alias
 * map. An unqualified reference only resolves when exactly one real table
 * is in scope — with two or more tables joined, an unqualified column is
 * genuinely ambiguous and is left unresolved rather than guessed, the same
 * "a spurious warning costs nothing, a wrong one costs trust" conservatism
 * the rest of this module applies.
 */
function resolveColumnTable(
  columnNames: readonly unknown[],
  scope: TableScope,
): string | undefined {
  if (columnNames.length >= 2) {
    const qualifier = columnNames[columnNames.length - 2]
    return typeof qualifier === 'string'
      ? scope.qualifierToTable.get(qualifier.toLowerCase())
      : undefined
  }
  const tables = new Set(scope.qualifierToTable.values())
  return tables.size === 1 ? [...tables][0] : undefined
}

/** Every `COLUMN_REF` compared with `=` to a literal, directly or through `AND` — safe-scoping filters. */
function collectEqualityFilterColumns(node: unknown, into: Set<string>): void {
  if (!isRecord(node)) return
  if (node.class === 'CONJUNCTION' && node.type === 'CONJUNCTION_AND') {
    if (Array.isArray(node.children)) {
      for (const child of node.children) collectEqualityFilterColumns(child, into)
    }
    return
  }
  if (node.class === 'COMPARISON' && node.type === 'COMPARE_EQUAL') {
    const left = node.left
    const right = node.right
    // Either operand order (`column = 'USD'` or `'USD' = column`) counts.
    const [columnOperand, constOperand] =
      isRecord(left) && left.class === 'COLUMN_REF' ? [left, right] : [right, left]
    if (
      isRecord(columnOperand) &&
      columnOperand.class === 'COLUMN_REF' &&
      Array.isArray(columnOperand.column_names) &&
      isRecord(constOperand) &&
      constOperand.class === 'CONSTANT'
    ) {
      into.add(lastSegment(columnOperand.column_names))
    }
  }
}

/** Every `COLUMN_REF` in a `group_expressions` array. */
function collectGroupByColumns(groupExpressions: unknown): Set<string> {
  const result = new Set<string>()
  if (!Array.isArray(groupExpressions)) return result
  for (const expression of groupExpressions) {
    if (
      isRecord(expression) &&
      expression.class === 'COLUMN_REF' &&
      Array.isArray(expression.column_names)
    ) {
      result.add(lastSegment(expression.column_names))
    }
  }
  return result
}

/**
 * Every `SUM`/`AVG` call's `COLUMN_REF` argument(s) reachable from `node`
 * without crossing into a nested `SELECT_NODE` — that nested scope (a
 * subquery, a CTE body) is walked independently by
 * {@link collectSelectNodes}, so its own aggregates are attributed to its
 * own `from_table`, not this one's.
 */
function collectAggregateColumnRefs(
  node: unknown,
  into: Array<{ columnNames: readonly unknown[] }>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) collectAggregateColumnRefs(item, into)
    return
  }
  if (!isRecord(node) || node.type === 'SELECT_NODE') return
  if (
    node.class === 'FUNCTION' &&
    typeof node.function_name === 'string' &&
    AGGREGATE_FUNCTIONS.has(node.function_name.toLowerCase()) &&
    Array.isArray(node.children)
  ) {
    for (const child of node.children) {
      if (isRecord(child) && child.class === 'COLUMN_REF' && Array.isArray(child.column_names)) {
        into.push({ columnNames: child.column_names })
      }
    }
  }
  for (const value of Object.values(node)) collectAggregateColumnRefs(value, into)
}

/** Every `SELECT_NODE` reachable from `node` — the main query, every CTE body, every subquery. */
function collectSelectNodes(node: unknown, into: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSelectNodes(item, into)
    return
  }
  if (!isRecord(node)) return
  if (node.type === 'SELECT_NODE') into.push(node)
  for (const value of Object.values(node)) collectSelectNodes(value, into)
}

/**
 * A column the ingest could not type: its approved DATE/TIMESTAMP format parsed none
 * of its values, so the published column holds raw text (see `typeFallbacks`).
 */
export interface TextDateColumnRef {
  tableId: string
  column: string
  /** The approved type whose format parsed nothing, e.g. `DATE`. */
  approvedType: string
}

/**
 * Comparison node types whose result depends on the stored order of the values.
 *
 * `BETWEEN` is deliberately absent even though it is an ordering comparison:
 * DuckDB serializes it as its own node (`class: 'BETWEEN'`, `type: 'COMPARE_BETWEEN'`)
 * carrying `input`/`lower`/`upper` rather than `left`/`right`, so listing it here
 * would leave it unmatched — see the dedicated branch in
 * `collectOrderSensitiveColumnRefs`. Confirmed with `json_serialize_sql`: with
 * `COMPARE_BETWEEN` in this set and only a `left`/`right` scan, a `BETWEEN` on a
 * text-held date answered 3,773 rows with no warning.
 */
const ORDERING_COMPARISON_TYPES = new Set([
  'COMPARE_LESSTHAN',
  'COMPARE_GREATERTHAN',
  'COMPARE_LESSTHANOREQUALTO',
  'COMPARE_GREATERTHANOREQUALTO',
])

/**
 * Column references anywhere inside an operand subtree. Comparisons, `BETWEEN`
 * bounds and MIN/MAX arguments can be wrapped (`CAST(col AS VARCHAR) BETWEEN …`,
 * `max(col::VARCHAR)`), and every one of those reads the stored text, so the scan
 * descends rather than only accepting a bare `COLUMN_REF`.
 */
function collectColumnRefsDeep(
  node: unknown,
  into: Array<{ columnNames: readonly unknown[] }>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) collectColumnRefsDeep(item, into)
    return
  }
  if (!isRecord(node)) return
  if (node.class === 'COLUMN_REF' && Array.isArray(node.column_names)) {
    into.push({ columnNames: node.column_names })
    return
  }
  for (const value of Object.values(node)) collectColumnRefsDeep(value, into)
}

/** MIN/MAX, as an aggregate (`class: 'FUNCTION'`) or a window (`class: 'WINDOW'`). */
function isMinMaxFunction(node: Record<string, unknown>): boolean {
  return (
    typeof node.function_name === 'string' &&
    ['min', 'max'].includes(node.function_name.toLowerCase()) &&
    Array.isArray(node.children)
  )
}

/**
 * Column references whose result would silently be wrong on a text date: range
 * comparisons (including `BETWEEN`), ORDER BY and MIN/MAX — aggregate or window —
 * all compare strings when the column holds text. (`date_trunc` and other date
 * functions fail loudly instead, so they are not listed.)
 *
 * Known limits, measured against `json_serialize_sql` output and left undocumented
 * by design rather than half-supported — do not read the absence of this warning as
 * proof that a query is safe when it matches one of these shapes:
 *
 *  - `ORDER BY <select alias>` and `ORDER BY <position>`: the ORDER_MODIFIER has no
 *    reference to the underlying column (`expression.column_names: ['d']`, or a bare
 *    integer CONSTANT), so resolving it back needs the select list and, for a view
 *    or CTE, the definition behind it.
 *  - An aggregate read through a derived table or CTE whose column cannot be traced
 *    back to the text-date table (`WITH d AS (SELECT order_date FROM t) SELECT
 *    max(order_date) FROM d`): the outer `max` resolves against `d`, not `t`.
 *
 * The function allowlist blocks `row_number`, `lag` and `arg_max`, so those cannot
 * reach a text date in the first place.
 */
function collectOrderSensitiveColumnRefs(
  node: unknown,
  into: Array<{ columnNames: readonly unknown[] }>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) collectOrderSensitiveColumnRefs(item, into)
    return
  }
  if (!isRecord(node)) return
  if (
    node.class === 'COMPARISON' &&
    typeof node.type === 'string' &&
    ORDERING_COMPARISON_TYPES.has(node.type)
  ) {
    for (const operand of [node.left, node.right]) collectColumnRefsDeep(operand, into)
  }
  // `x BETWEEN a AND b` is its own node shape (`input`/`lower`/`upper`), so the
  // left/right scan above never matched it.
  if (node.class === 'BETWEEN' || node.type === 'COMPARE_BETWEEN') {
    for (const operand of [node.input, node.lower, node.upper]) {
      collectColumnRefsDeep(operand, into)
    }
  }
  // MIN/MAX as an aggregate, or as a window function (`max(x) OVER ()` serializes
  // as `class: 'WINDOW'`, not `class: 'FUNCTION'`).
  if ((node.class === 'FUNCTION' || node.class === 'WINDOW') && isMinMaxFunction(node)) {
    for (const child of node.children as unknown[]) collectColumnRefsDeep(child, into)
  }
  // `json_serialize_sql` puts ORDER BY in the SELECT node's `modifiers` as an entry
  // with `type: 'ORDER_MODIFIER'` (see sql-policy's `hasTopLevelOrderBy`).
  if (node.type === 'ORDER_MODIFIER' && Array.isArray(node.orders)) {
    for (const order of node.orders) {
      const expression = isRecord(order) ? order.expression : undefined
      if (
        isRecord(expression) &&
        expression.class === 'COLUMN_REF' &&
        Array.isArray(expression.column_names)
      ) {
        into.push({ columnNames: expression.column_names })
      }
    }
  }
  for (const value of Object.values(node)) collectOrderSensitiveColumnRefs(value, into)
}

/**
 * Warn when a statement reads a text-held date in an order-sensitive way. A text
 * `order_date` compared with `<`, sorted, or reduced with MIN/MAX answers
 * lexicographically, not chronologically — measured live: `ship_date < order_date`
 * on the superstore snapshot returned 1,565 rows instead of 0, with no error. The
 * warning rides on the query result, so the model sees it at the moment of the risk
 * rather than only in the schema description it may not consult.
 */
export function textDateWarningsForStatement(
  statement: unknown,
  textDateColumns: readonly TextDateColumnRef[],
): string[] {
  if (textDateColumns.length === 0) return []
  const columnsByTable = new Map<string, TextDateColumnRef[]>()
  for (const entry of textDateColumns) {
    const key = entry.tableId.toLowerCase()
    const list = columnsByTable.get(key) ?? []
    list.push(entry)
    columnsByTable.set(key, list)
  }

  const selectNodes: Record<string, unknown>[] = []
  collectSelectNodes(statement, selectNodes)

  const warnings = new Set<string>()
  for (const node of selectNodes) {
    const scope: TableScope = { qualifierToTable: new Map() }
    collectTableScope(node.from_table, scope)
    if (scope.qualifierToTable.size === 0) continue

    const refs: Array<{ columnNames: readonly unknown[] }> = []
    collectOrderSensitiveColumnRefs(
      {
        where: node.where_clause,
        having: node.having,
        modifiers: node.modifiers,
        select: node.select_list,
      },
      refs,
    )

    for (const ref of refs) {
      const table = resolveColumnTable(ref.columnNames, scope)
      if (!table) continue
      const column = String(ref.columnNames[ref.columnNames.length - 1] ?? '').toLowerCase()
      for (const entry of columnsByTable.get(table) ?? []) {
        if (entry.column.toLowerCase() !== column) continue
        warnings.add(
          `text-date-risk: ${entry.tableId}.${entry.column} holds raw text because no ${entry.approvedType} format parsed it — range comparisons, ORDER BY and MIN/MAX read it lexicographically, not chronologically. Ask the analyst for the intended format and re-ingest before relying on those.`,
        )
      }
    }
  }
  return [...warnings]
}

/**
 * Push a `currency-mix-risk: <table>.<column> mixes <codes>` warning for
 * every detected currency dimension whose table is summed/averaged in
 * `statement` — in any `SELECT_NODE` at any nesting depth — unless that
 * specific `SELECT_NODE`'s own `GROUP BY` or an `=` filter already scopes
 * the query to the dimension column.
 */
export function currencyWarningsForStatement(
  statement: unknown,
  currencyDimensions: readonly CurrencyDimensionRef[],
): string[] {
  if (currencyDimensions.length === 0) return []
  const dimensionsByTable = new Map<string, CurrencyDimensionRef[]>()
  for (const dimension of currencyDimensions) {
    const key = dimension.tableId.toLowerCase()
    const list = dimensionsByTable.get(key) ?? []
    list.push(dimension)
    dimensionsByTable.set(key, list)
  }

  const selectNodes: Record<string, unknown>[] = []
  collectSelectNodes(statement, selectNodes)

  const warnings = new Set<string>()
  for (const node of selectNodes) {
    const scope: TableScope = { qualifierToTable: new Map() }
    collectTableScope(node.from_table, scope)
    if (scope.qualifierToTable.size === 0) continue

    const aggregateColumnRefs: Array<{ columnNames: readonly unknown[] }> = []
    collectAggregateColumnRefs(node.select_list, aggregateColumnRefs)
    collectAggregateColumnRefs(node.having, aggregateColumnRefs)
    if (aggregateColumnRefs.length === 0) continue

    const groupByColumns = collectGroupByColumns(node.group_expressions)
    const equalityFilterColumns = new Set<string>()
    collectEqualityFilterColumns(node.where_clause, equalityFilterColumns)

    for (const ref of aggregateColumnRefs) {
      const table = resolveColumnTable(ref.columnNames, scope)
      if (!table) continue
      for (const dimension of dimensionsByTable.get(table) ?? []) {
        const column = dimension.column.toLowerCase()
        if (groupByColumns.has(column) || equalityFilterColumns.has(column)) continue
        warnings.add(
          `currency-mix-risk: ${dimension.tableId}.${dimension.column} mixes ${dimension.currencies.join(', ')} — group or filter by ${dimension.column} before trusting a SUM/AVG in this table`,
        )
      }
    }
  }
  return [...warnings]
}
