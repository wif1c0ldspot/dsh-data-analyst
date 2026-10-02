/**
 * Server-owned equality filter wrapper for workbench SQL. Column names are
 * strict identifiers; string values are single-quote escaped. The wrapped
 * statement still must pass authorizeQuery before execution.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export function applyEqualityFilter(sql: string, column: string, value: string): string {
  const col = column.trim()
  if (!col) return sql
  if (!IDENT.test(col)) {
    throw new Error(`Filter column must be a simple identifier (got "${column}")`)
  }
  if (value.length > 200) {
    throw new Error('Filter value exceeds 200 characters')
  }
  const escaped = value.replaceAll("'", "''")
  // CTE name is collected into the SQL policy allowlist; the inner query still
  // must only reference authorized base tables.
  return `WITH _analysis_filter AS (${sql}) SELECT * FROM _analysis_filter WHERE "${col}" = '${escaped}'`
}
