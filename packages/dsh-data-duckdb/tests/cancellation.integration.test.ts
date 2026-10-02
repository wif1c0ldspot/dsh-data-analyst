import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { QueryCancelledError, runCancellableQuery } from '../src/cancellable-query.js'

let connection: DuckDBConnection

// A query DuckDB cannot fold to a constant: a per-row transcendental
// comparison over enough rows to still be running when we interrupt it.
const EXPENSIVE_QUERY =
  'SELECT count(*) FROM range(200000000) t(i) WHERE (sin(i * 1.0000001) * cos(i)) > 999999999'

beforeEach(async () => {
  const db = await DuckDBInstance.create(':memory:')
  connection = await db.connect()
})

afterEach(() => {
  connection.closeSync()
})

it('a timeout interrupts the native worker rather than only abandoning the awaited promise', async () => {
  const started = performance.now()
  await expect(
    runCancellableQuery(connection, EXPENSIVE_QUERY, { timeoutMs: 200 }),
  ).rejects.toBeInstanceOf(QueryCancelledError)
  const elapsedMs = performance.now() - started
  // Native interruption should land close to the deadline, not run to completion
  // (which would take several seconds for this row count on typical hardware).
  expect(elapsedMs).toBeLessThan(2_000)

  // The connection is reusable immediately afterward: the worker actually
  // stopped and recovered, it was not left wedged mid-query.
  const followUp = await connection.runAndReadAll('SELECT 42')
  expect(followUp.getRowsJson()).toEqual([[42]])
})

it('an AbortSignal interrupts the native worker the same way', async () => {
  const controller = new AbortController()
  const runPromise = runCancellableQuery(connection, EXPENSIVE_QUERY, { signal: controller.signal })
  setTimeout(() => controller.abort(), 150)

  await expect(runPromise).rejects.toBeInstanceOf(QueryCancelledError)

  const followUp = await connection.runAndReadAll('SELECT 7')
  expect(followUp.getRowsJson()).toEqual([[7]])
})

it('an uncancelled query still resolves normally through the same wrapper', async () => {
  const result = await runCancellableQuery(connection, 'SELECT 1 + 1 AS two', { timeoutMs: 10_000 })
  expect(result.getRowsJson()).toEqual([[2]])
})
