/**
 * SQL isolation policy. Authorizes a single candidate SQL string
 * against the *actual pinned DuckDB grammar* before it is ever executed, by
 * asking the real engine to parse and serialize it (`json_serialize_sql`) and
 * walking the resulting AST — not a handwritten grammar, not a keyword
 * denylist, and not regex column matching.
 *
 * What this rejects, and why the engine itself enforces most of it:
 * - Anything that is not a single SELECT (DDL/DML/ATTACH/COPY/CALL/PRAGMA/SET/
 *   INSTALL/LOAD/multi-statement): `json_serialize_sql` itself returns
 *   `error: true, error_message: "Only SELECT statements can be serialized to
 *   json!"` for every one of these, and a semicolon-separated string produces
 *   more than one entry in `statements`. Both are checked explicitly below so
 *   the reason is never inferred from an empty allowlist match.
 * - Any table-producing function (`TABLE_FUNCTION` nodes: `read_csv`,
 *   `read_parquet`, `duckdb_tables()`, `pragma_*()`, extension-provided
 *   readers, etc.) — covers filesystem/network reads and catalog
 *   introspection in one rule, because v1 datasets are plain tables and never
 *   need a table function at query time (ingestion, not querying, reads files).
 * - Any table reference outside the authorized dataset: a schema other than
 *   the default (`information_schema`, `pg_catalog`, ...), any non-default
 *   catalog, an `AT` time-travel clause, or a table name not in the caller's
 *   allowlist. CTE names are collected first and added to the allowlist for
 *   their own query, so `WITH x AS (...) SELECT * FROM x` is not rejected as
 *   an unknown table.
 * - Any scalar/aggregate/window function not in the approved allowlist, or a
 *   schema/catalog-qualified function call (which could otherwise reach an
 *   extension function or dodge the allowlist by qualification).
 *
 * What this does NOT yet do (documented, not hidden): it does not restrict
 * which expression *shapes* are allowed (CASE/CAST/OPERATOR/etc. are
 * unrestricted), it does not enforce column-level authorization, and it does
 * not replace engine-level `enable_external_access=false`/read-only mode —
 * this is one required layer among several (see "Why these choices" and
 * "Security and deployment" in docs/architecture.md), not a complete
 * isolation boundary by itself.
 */
import type { DuckDBConnection } from '@duckdb/node-api'

export class QueryPolicyViolation extends Error {}

const MAX_SQL_LENGTH = 65_536

/**
 * Conservative default allowlist for the walking-skeleton scope: aggregates,
 * simple scalar/date/string helpers used by the reference fixtures. Extend
 * deliberately alongside reviewed semantic/metric definitions, never as a
 * blanket "allow everything not yet seen to break" change.
 */
export const DEFAULT_ALLOWED_FUNCTIONS: readonly string[] = [
  'sum',
  'avg',
  'count',
  'count_star', // DuckDB's internal name for the bare COUNT(*) form.
  'min',
  'max',
  'round',
  // Built-in numeric bucketing and distribution statistics; no I/O capabilities.
  'floor',
  'median',
  'quantile_cont',
  'coalesce',
  'nullif',
  'abs',
  'upper',
  'lower',
  'length',
  'date_trunc',
  'date_part',
  'extract',
  'strftime',
]

export interface QueryPolicyOptions {
  /** Table names (case-insensitive) the authorized dataset version exposes. */
  allowedTables: readonly string[]
  /** Overrides {@link DEFAULT_ALLOWED_FUNCTIONS} when supplied. */
  allowedFunctions?: readonly string[]
}

interface SerializedSql {
  error: boolean
  error_message?: string
  statements?: unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sqlLiteral(sql: string): string {
  return `'${sql.replace(/'/g, "''")}'`
}

/** Depth-first collection of every CTE name bound anywhere in the tree. */
/**
 * Collects every CTE name anywhere in the statement into one flat set, not
 * scoped per-subquery: a name bound inside one branch is authorized
 * everywhere in the query, including sibling/outer scopes where a real SQL
 * engine wouldn't have it in scope. This is deliberately permissive rather
 * than unsafe — the authorized name still has to match a table that exists
 * and is allowed within the same already-authorized dataset version, so a
 * same-named real table in a different branch is the worst case, not a
 * cross-dataset escape. Per-scope binding would be more precise but adds
 * real complexity for a gap this narrow; revisit if a case ever needs it.
 */
function collectCteNames(node: unknown, names: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectCteNames(item, names)
    return names
  }
  if (!isRecord(node)) return names
  const cteMap = node.cte_map
  if (isRecord(cteMap) && Array.isArray(cteMap.map)) {
    for (const entry of cteMap.map) {
      if (isRecord(entry) && typeof entry.key === 'string') names.add(entry.key.toLowerCase())
    }
  }
  for (const value of Object.values(node)) collectCteNames(value, names)
  return names
}

/** Depth-first authorization walk; throws {@link QueryPolicyViolation} on the first violation. */
function walk(
  node: unknown,
  allowedTables: ReadonlySet<string>,
  allowedFunctions: ReadonlySet<string>,
  /**
   * Original-cased published table names, for the error message only — never
   * used for matching (matching stays on the lowercased `allowedTables` set,
   * which also includes the query's own CTE names). Kept separate so a
   * denial never advertises the caller's CTE aliases as if they were real
   * published tables to guess from.
   */
  publishedTableNames: readonly string[],
): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, allowedTables, allowedFunctions, publishedTableNames)
    return
  }
  if (!isRecord(node)) return

  if (node.type === 'BASE_TABLE') {
    const tableName = String(node.table_name ?? '').toLowerCase()
    const schemaName = String(node.schema_name ?? '')
    const catalogName = String(node.catalog_name ?? '')
    if (catalogName !== '') {
      throw new QueryPolicyViolation(
        `Cross-catalog table reference is not allowed: "${catalogName}"`,
      )
    }
    if (schemaName !== '' && schemaName.toLowerCase() !== 'main') {
      throw new QueryPolicyViolation(
        `Only the default schema is allowed; rejected schema "${schemaName}"`,
      )
    }
    if (node.at_clause != null) {
      throw new QueryPolicyViolation('Time-travel table references (AT clause) are not allowed')
    }
    if (!allowedTables.has(tableName)) {
      const tableList = [...publishedTableNames].sort().join(', ') || '(none published yet)'
      throw new QueryPolicyViolation(
        `Table "${tableName}" is not part of the authorized dataset. This is not the dataset id, ` +
          `Kaggle slug, or a friendly dataset title — those are never table names. The only ` +
          `queryable tables are the published table names: ${tableList}. Raw/staging ingestion ` +
          `tables are never exposed to any table name, so retrying with a different guessed name ` +
          'will not help; call get_schema(datasetId) if you need to confirm table names, columns, ' +
          'or grain.',
      )
    }
  } else if (node.type === 'TABLE_FUNCTION') {
    const fn = isRecord(node.function)
      ? String(node.function.function_name ?? 'unknown')
      : 'unknown'
    throw new QueryPolicyViolation(
      `Table functions are not allowed (attempted "${fn}"); only plain tables in the authorized dataset may be queried`,
    )
  }

  if (
    (node.class === 'FUNCTION' || node.class === 'WINDOW') &&
    typeof node.function_name === 'string'
  ) {
    const schema = String(node.schema ?? '')
    const catalog = String(node.catalog ?? '')
    const name = node.function_name.toLowerCase()
    // DuckDB's parser normalizes SQL-standard syntax such as
    // `EXTRACT(YEAR FROM value)` to the built-in `main.date_part(...)` in the
    // serialized AST. Allow only the default `main` schema here and still
    // require the normalized function name to be on our allowlist. Catalogs
    // and every other schema remain forbidden.
    if (catalog !== '' || (schema !== '' && schema.toLowerCase() !== 'main')) {
      throw new QueryPolicyViolation(
        `Schema/catalog-qualified function calls are not allowed: "${schema}.${name}"`,
      )
    }
    // DuckDB represents arithmetic/string operators as FUNCTION nodes (e.g. "*").
    // docs/architecture.md's policy rationale leaves expression operators
    // unrestricted; only named identifier functions are allowlisted.
    if (/^[a-z_][a-z0-9_]*$/i.test(name) && !allowedFunctions.has(name)) {
      const allowed = [...allowedFunctions].sort().join(', ')
      throw new QueryPolicyViolation(
        `Function "${name}" is not on the approved allowlist (allowed: ${allowed})`,
      )
    }
  }

  for (const value of Object.values(node)) {
    walk(value, allowedTables, allowedFunctions, publishedTableNames)
  }
}

/**
 * The `{ node: SELECT_NODE, named_param_map }` wrapper `json_serialize_sql`
 * returns for one statement — deliberately untyped (`unknown`) past this
 * point, same as every other node this module walks; callers that need to
 * inspect it (e.g. deriving warnings from the already-parsed tree) narrow
 * with `isRecord`/`Array.isArray` exactly as {@link walk} does, never by
 * assuming a full AST type.
 */
export type ParsedSqlStatement = unknown

/**
 * True when the statement's own top-level SELECT already carries an
 * `ORDER BY` (`json_serialize_sql` represents it as an `ORDER_MODIFIER`
 * entry in `node.modifiers`). Used by the query service to decide whether a
 * *caller-invisible* stable tiebreaker (`ORDER BY ALL`) is needed around an
 * otherwise `ORDER BY`-free query: without one, DuckDB's hash aggregation
 * and parallel scans are free to return the same logical result in a
 * different physical row order on independent runs of the identical SQL,
 * which silently breaks the repeatability of anything derived from row
 * position (e.g. `deriveResultEvidence`'s `minimumRow`/`maximumRow`) even
 * though the aggregate values themselves are correct and unchanged. A
 * statement that already orders its own output is left untouched so its
 * caller-intended order (e.g. `ORDER BY revenue DESC`) is never overridden.
 */
export function hasTopLevelOrderBy(statement: ParsedSqlStatement): boolean {
  if (!isRecord(statement)) return false
  const node = statement.node
  if (!isRecord(node)) return false
  const modifiers = node.modifiers
  if (!Array.isArray(modifiers)) return false
  return modifiers.some((modifier) => isRecord(modifier) && modifier.type === 'ORDER_MODIFIER')
}

/**
 * Parse `sql` with the real DuckDB parser (`json_serialize_sql`) and return
 * its single statement, without authorizing it. Throws
 * {@link QueryPolicyViolation} for anything `authorizeQuery` would also
 * reject at the parse stage (empty/oversized text, a parse error, or more
 * than one statement) — callers that need the parsed tree for a purpose
 * other than authorization (e.g. deriving advisory warnings) still get the
 * same fail-closed parse behavior. Exported so a caller that already has an
 * authorized statement (e.g. `authorizeQuery` itself) never parses `sql`
 * twice.
 */
export async function parseSqlStatement(
  connection: DuckDBConnection,
  sql: string,
): Promise<ParsedSqlStatement> {
  if (sql.length === 0 || sql.length > MAX_SQL_LENGTH) {
    throw new QueryPolicyViolation(`Query text must be between 1 and ${MAX_SQL_LENGTH} characters`)
  }
  const reader = await connection.runAndReadAll(
    `SELECT json_serialize_sql(${sqlLiteral(sql)}) AS ast`,
  )
  const rows = reader.getRowsJson() as unknown[][]
  const serialized = rows[0]?.[0]
  if (typeof serialized !== 'string') {
    throw new QueryPolicyViolation('The query could not be parsed by the pinned DuckDB grammar')
  }
  const parsed = JSON.parse(serialized) as SerializedSql
  if (parsed.error) {
    throw new QueryPolicyViolation(
      `Only a single reviewed SELECT statement is allowed: ${parsed.error_message ?? 'parse error'}`,
    )
  }
  if (!Array.isArray(parsed.statements) || parsed.statements.length !== 1) {
    throw new QueryPolicyViolation(
      `Exactly one SELECT statement is allowed; found ${parsed.statements?.length ?? 0}`,
    )
  }
  return parsed.statements[0]
}

/**
 * Parse and authorize one candidate SQL string using the real DuckDB parser
 * (via `json_serialize_sql` on the supplied connection) before it is ever
 * executed. Resolves with the parsed statement when the query is authorized
 * (callers that only care about pass/fail can ignore the return value);
 * throws {@link QueryPolicyViolation} (or a plain `Error` for malformed
 * input) otherwise. Does not execute `sql` itself.
 */
export async function authorizeQuery(
  connection: DuckDBConnection,
  sql: string,
  options: QueryPolicyOptions,
): Promise<ParsedSqlStatement> {
  const statement = await parseSqlStatement(connection, sql)
  const cteNames = collectCteNames(statement)
  const allowedTables = new Set<string>([
    ...options.allowedTables.map((name) => name.toLowerCase()),
    ...cteNames,
  ])
  const allowedFunctions = new Set(
    (options.allowedFunctions ?? DEFAULT_ALLOWED_FUNCTIONS).map((name) => name.toLowerCase()),
  )
  walk(statement, allowedTables, allowedFunctions, options.allowedTables)
  return statement
}
