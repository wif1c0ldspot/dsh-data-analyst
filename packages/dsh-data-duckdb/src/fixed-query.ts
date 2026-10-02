/**
 * Hardcoded/allowlisted query execution against an already read-only-opened
 * DuckDB connection. This is intentionally NOT the
 * general SQL policy/parser gate: the caller supplies one fixed,
 * reviewed SQL string, never model- or user-composed text. Encodes results
 * per docs/contracts.md "Result and rendering boundary": DECIMAL/unsafe
 * BIGINT stay decimal strings, dates stay ISO strings, native values are
 * never serialized directly.
 *
 * Result budgets (see docs/architecture.md "Why these choices"): default 30s deadline, 10_000 rows /
 * 10 MiB. Because `@duckdb/node-api` `runAndReadAll` materializes the full
 * reader, the authorized path wraps SQL as
 * `SELECT * FROM (<sql>) AS _dsh_budget LIMIT maxResultRows+1` so overflow
 * is detected without loading an unbounded result set. Byte budget is
 * checked after the capped read, before callers persist rows.
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import type { DuckDBValue } from '@duckdb/node-api'
import { runCancellableQuery } from './cancellable-query.js'
import { PAYLOAD_PREVIEW_WARNING_PREFIX } from 'dsh-data-core/result-warnings'

export interface FixedQueryResultColumn {
  name: string
  logicalType: string
}

export interface FixedQueryResult {
  columns: FixedQueryResultColumn[]
  /** Every row, already type-preserving encoded (string decimals/dates, JSON null). */
  rows: unknown[][]
  rowCount: number
  preview: unknown[][]
  previewTruncated: boolean
  resultComplete: true
  elapsedMs: number
  warnings: string[]
}

export interface RunFixedQueryOptions {
  /** Model preview cap; the full `rows` array remains the authorized complete result. */
  maxPreviewRows?: number
  /** Hard wall-clock deadline; forwarded to runCancellableQuery (default 30_000). */
  timeoutMs?: number
  /** Caller-owned cancellation; interrupts the native DuckDB worker. */
  signal?: AbortSignal
  /** Max rows retained (default 10_000). Overflow throws QueryBudgetViolation. */
  maxResultRows?: number
  /** Max estimated UTF-8/JSON byte size of rows (default 10 MiB). */
  maxResultBytes?: number
  /** Values bound to positional `?` placeholders by DuckDB. */
  parameters?: DuckDBValue[]
  /**
   * Append a stable `ORDER BY ALL` tiebreaker when `sql` has no top-level
   * `ORDER BY` of its own, so repeated runs of the identical SQL return rows
   * in a repeatable physical order (see `wrapSqlWithRowBudget`). Default
   * false preserves prior behavior for callers (fixed internal recipes) that
   * already guarantee their own deterministic order.
   */
  stableOrder?: boolean
}

export class QueryBudgetViolation extends Error {
  readonly kind: 'rows' | 'bytes'

  constructor(kind: 'rows' | 'bytes', detail: string) {
    super(detail)
    this.name = 'QueryBudgetViolation'
    this.kind = kind
  }
}

const DEFAULT_MAX_PREVIEW_ROWS = 20
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESULT_ROWS = 10_000
const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024

/**
 * Wrap caller SQL so DuckDB stops after limit+1 rows (detect overflow
 * without full materialization). When `stableOrder` is set (the caller's own
 * SQL has no top-level `ORDER BY` — see `sql-policy.ts`'s
 * `hasTopLevelOrderBy`), also appends `ORDER BY ALL` so the *set* of rows
 * DuckDB selected is presented in a repeatable order across independent runs
 * of the identical SQL, instead of whatever order that run's hash
 * aggregation/parallel scan happened to produce. This changes only the
 * caller-invisible physical ordering of an otherwise-unordered result, never
 * which rows are selected (any `LIMIT`/`ORDER BY` inside the caller's own
 * SQL is still evaluated first, inside this subquery).
 */
export function wrapSqlWithRowBudget(
  sql: string,
  maxResultRows: number,
  stableOrder = false,
): string {
  const trimmed = sql.trim().replace(/;+\s*$/, '')
  const orderClause = stableOrder ? ' ORDER BY ALL' : ''
  return `SELECT * FROM (${trimmed}) AS _dsh_budget${orderClause} LIMIT ${maxResultRows + 1}`
}

function estimateResultBytes(rows: unknown[][]): number {
  let total = 0
  for (const row of rows) {
    for (const cell of row) {
      if (cell === null || cell === undefined) {
        total += 4
      } else if (typeof cell === 'string') {
        total += Buffer.byteLength(cell, 'utf8')
      } else if (typeof cell === 'number' || typeof cell === 'boolean') {
        total += Buffer.byteLength(String(cell), 'utf8')
      } else {
        total += Buffer.byteLength(JSON.stringify(cell), 'utf8')
      }
    }
  }
  return total
}

/**
 * Execute exactly one fixed, reviewed SQL string against an already-opened
 * connection and return a typed, capped-preview result. Does not parse,
 * authorize, or accept caller-composed SQL fragments; that is the SQL policy
 * service's responsibility once model-generated SQL is in scope.
 */
export async function runFixedQuery(
  connection: DuckDBConnection,
  sql: string,
  options: RunFixedQueryOptions = {},
): Promise<FixedQueryResult> {
  const maxPreviewRows = options.maxPreviewRows ?? DEFAULT_MAX_PREVIEW_ROWS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResultRows = options.maxResultRows ?? DEFAULT_MAX_RESULT_ROWS
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES
  const budgetedSql = wrapSqlWithRowBudget(sql, maxResultRows, options.stableOrder ?? false)

  const startedAt = performance.now()
  const reader = await runCancellableQuery(connection, budgetedSql, {
    signal: options.signal,
    timeoutMs,
    parameters: options.parameters,
  })
  const elapsedMs = performance.now() - startedAt

  const columns: FixedQueryResultColumn[] = reader.columnNames().map((name, index) => ({
    name,
    logicalType: reader.columnType(index).toString(),
  }))
  const rawRows = reader.getRowsJson() as unknown[][]
  if (rawRows.length > maxResultRows) {
    throw new QueryBudgetViolation(
      'rows',
      `Query result exceeded maxResultRows budget of ${maxResultRows}`,
    )
  }

  const estimatedBytes = estimateResultBytes(rawRows)
  if (estimatedBytes > maxResultBytes) {
    throw new QueryBudgetViolation(
      'bytes',
      `Query result exceeded maxResultBytes budget of ${maxResultBytes} (estimated ${estimatedBytes})`,
    )
  }

  const rows = rawRows
  const warnings: string[] = []
  const previewTruncated = rows.length > maxPreviewRows
  if (previewTruncated) {
    warnings.push(
      `${PAYLOAD_PREVIEW_WARNING_PREFIX}${maxPreviewRows} of ${rows.length} rows; the full result remains authorized and complete.`,
    )
  }
  return {
    columns,
    rows,
    rowCount: rows.length,
    preview: rows.slice(0, maxPreviewRows),
    previewTruncated,
    resultComplete: true,
    elapsedMs,
    warnings,
  }
}
