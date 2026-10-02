/**
 * Native query cancellation. `AbortSignal`/timeout alone only
 * stops *awaiting* a promise; the underlying native DuckDB worker keeps
 * running unless something calls its own interrupt. This wraps a query so an
 * abort/deadline also calls `DuckDBConnection.interrupt()`, which stops the
 * actual native execution — proven in
 * tests/cancellation.integration.test.ts by timing the rejection and reusing
 * the same connection for a follow-up query afterward.
 */
import type { DuckDBConnection, DuckDBResultReader, DuckDBValue } from '@duckdb/node-api'

export class QueryCancelledError extends Error {
  constructor(reason: 'aborted' | 'timeout') {
    super(reason === 'timeout' ? 'Query cancelled: deadline exceeded' : 'Query cancelled: aborted')
    this.name = 'QueryCancelledError'
  }
}

export interface RunCancellableQueryOptions {
  /** Caller-owned cancellation; the connection is interrupted, not just abandoned. */
  signal?: AbortSignal
  /** Hard wall-clock deadline in milliseconds; interrupts the connection when exceeded. */
  timeoutMs?: number
  /** Values bound to positional `?` placeholders by DuckDB. */
  parameters?: DuckDBValue[]
}

/**
 * Run one query on `connection`, interrupting the *native* worker (not only
 * the awaiting promise) when `signal` aborts or `timeoutMs` elapses. The
 * connection remains usable for a subsequent query after an interruption —
 * callers do not need to discard and reopen it.
 */
export async function runCancellableQuery(
  connection: DuckDBConnection,
  sql: string,
  options: RunCancellableQueryOptions = {},
): Promise<DuckDBResultReader> {
  const { signal, timeoutMs } = options
  if (signal?.aborted) throw new QueryCancelledError('aborted')
  let cancelReason: 'aborted' | 'timeout' | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const onAbort = (): void => {
    cancelReason = 'aborted'
    connection.interrupt()
  }
  signal?.addEventListener('abort', onAbort)
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      cancelReason = 'timeout'
      connection.interrupt()
    }, timeoutMs)
  }

  try {
    return await connection.runAndReadAll(sql, options.parameters)
  } catch (error) {
    if (cancelReason !== undefined) throw new QueryCancelledError(cancelReason)
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (timer !== undefined) clearTimeout(timer)
  }
}
