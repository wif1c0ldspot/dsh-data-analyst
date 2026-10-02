/**
 * SQL join fanout warnings (P1, generalized). Keyword-presence heuristics
 * against the *reviewed* relationship graph (in-code fixtures plus
 * analyst-approved structure candidates), not a SQL parser — see
 * `sql-policy.ts` for the actual authorization boundary. A warning here is
 * advice quoted back to the analyst; it never denies a query.
 */
import { relationshipsForDataset, type TableRelationship } from './grains.js'

function mentionsTable(sql: string, tableId: string): boolean {
  return new RegExp(`\\b${tableId}\\b`, 'i').test(sql)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A query is treated as pre-aggregated (safe) when it contains a `GROUP BY`
 * naming one of the shared join-key columns before the last mention of either
 * fan-out table — the textual shape of "aggregate the many-side to one row per
 * parent key in a subquery, then join". This is a heuristic marker, not a
 * join-tree analysis.
 */
function hasAggregateSubqueryMarker(
  sql: string,
  keyColumns: readonly string[],
  tableIds: readonly string[],
): boolean {
  const keys = [...new Set(keyColumns.filter(Boolean))]
  if (keys.length === 0) return false
  const groupByRe = new RegExp(
    `group\\s+by\\s+[\\w.,\\s]*\\b(?:${keys.map(escapeRegExp).join('|')})\\b`,
    'gi',
  )
  const lowerSql = sql.toLowerCase()
  const lastJoinTarget = Math.max(...tableIds.map((tableId) => lowerSql.lastIndexOf(tableId)))
  let match: RegExpExecArray | null
  while ((match = groupByRe.exec(sql))) {
    if (match.index < lastJoinTarget) return true
  }
  return false
}

/**
 * Push a `fanout-risk: <a> x <b>` warning when the SQL mentions two tables that
 * would fan out when joined:
 *
 * 1. a reviewed `n:n` relationship directly between them; or
 * 2. two tables that are each the "many" side (`n:1` / `1:n`) of a common
 *    parent table (e.g. `order_items` and `order_payments` both `n:1` to
 *    `orders`), unless the query already pre-aggregates one side.
 *
 * Returns an empty array when the tables are unrelated, only one is mentioned,
 * or a pre-aggregation marker is present.
 */
export function joinWarningsForSql(
  datasetId: string,
  sql: string,
  relationships: readonly TableRelationship[] = relationshipsForDataset(datasetId),
): string[] {
  const mentioned = new Set<string>()
  for (const rel of relationships) {
    if (mentionsTable(sql, rel.fromTable)) mentioned.add(rel.fromTable)
    if (mentionsTable(sql, rel.toTable)) mentioned.add(rel.toTable)
  }
  if (mentioned.size === 0) return []

  const warnings: string[] = []

  // Direct many-to-many between two mentioned tables.
  for (const rel of relationships) {
    if (rel.cardinality === 'n:n' && mentioned.has(rel.fromTable) && mentioned.has(rel.toTable)) {
      warnings.push(`fanout-risk: ${rel.fromTable} x ${rel.toTable}`)
    }
  }

  // Transitive fan-out through a shared parent: collect the "many" side of each
  // 1:n / n:1 relationship, grouped by the "one" (parent) side.
  const manySidesByParent = new Map<string, { tables: string[]; keys: string[] }>()
  for (const rel of relationships) {
    let manySide: string | undefined
    let oneSide: string | undefined
    if (rel.cardinality === 'n:1') {
      manySide = rel.fromTable
      oneSide = rel.toTable
    } else if (rel.cardinality === '1:n') {
      manySide = rel.toTable
      oneSide = rel.fromTable
    }
    if (!manySide || !oneSide) continue
    const entry = manySidesByParent.get(oneSide) ?? { tables: [], keys: [] }
    entry.tables.push(manySide)
    entry.keys.push(...rel.fromColumns, ...rel.toColumns)
    manySidesByParent.set(oneSide, entry)
  }

  for (const [, entry] of manySidesByParent) {
    if (entry.tables.length < 2) continue
    for (let i = 0; i < entry.tables.length; i += 1) {
      for (let j = i + 1; j < entry.tables.length; j += 1) {
        const a = entry.tables[i]!
        const b = entry.tables[j]!
        if (!mentioned.has(a) || !mentioned.has(b)) continue
        if (hasAggregateSubqueryMarker(sql, entry.keys, [a, b])) continue
        warnings.push(`fanout-risk: ${a} x ${b}`)
      }
    }
  }

  return [...new Set(warnings)]
}
