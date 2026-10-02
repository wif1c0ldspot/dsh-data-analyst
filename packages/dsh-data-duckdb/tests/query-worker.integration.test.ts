import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { executeIsolatedQuery, hardStop, scrubWorkerEnv } from '../src/query-worker.js'

let directory: string
let datasetPath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-query-worker-'))
  datasetPath = join(directory, 'dataset.duckdb')
  const writer = await DuckDBInstance.create(datasetPath)
  const connection = await writer.connect()
  try {
    await connection.run(
      `CREATE TABLE orders AS SELECT * FROM (VALUES ('West', 10.00::DECIMAL(18,2))) t(region, sales)`,
    )
    // Large table for abort tests that must stay within SQL policy
    // (no range() table functions on the SELECT path).
    await connection.run('CREATE TABLE big AS SELECT i FROM range(0, 40000) t(i)')
    await connection.run(
      'CREATE TABLE hourly AS SELECT i::INTEGER AS hour, CASE WHEN i = 21 THEN 9895 ELSE (1082 + i)::INTEGER END AS observations FROM range(0, 48) t(i)',
    )
    await connection.run('CHECKPOINT')
  } finally {
    connection.closeSync()
    writer.closeSync()
  }
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('scrubs credential-bearing environment variables from the worker env', () => {
  const scrubbed = scrubWorkerEnv({
    PATH: '/usr/bin',
    HOME: '/home/analyst',
    KAGGLE_API_TOKEN: 'secret-token',
    DEEPSEEK_API_KEY: 'secret-key',
    KAGGLE_USERNAME: 'someone',
    NODE_OPTIONS: '--input-type=module',
  })
  expect(scrubbed.PATH).toBe('/usr/bin')
  expect(scrubbed.KAGGLE_API_TOKEN).toBeUndefined()
  expect(scrubbed.DEEPSEEK_API_KEY).toBeUndefined()
  expect(scrubbed.KAGGLE_USERNAME).toBeUndefined()
  expect(scrubbed.NODE_OPTIONS).toBeUndefined()
})

it('runs a policy-gated query in a child process and returns the summary', async () => {
  const summary = await executeIsolatedQuery({
    datasetPath,
    datasetVersionId: 'orders-v1',
    semanticRevisionId: 'sem-v1',
    sql: 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region',
    parameters: [],
    allowedTables: ['orders'],
  })
  expect(summary.rowCount).toBe(1)
  expect(summary.preview).toEqual([['West', '10.00']])
})

it('carries complete-result extrema beyond the 20-row preview across the worker boundary', async () => {
  const summary = await executeIsolatedQuery({
    datasetPath,
    datasetVersionId: 'orders-v1',
    semanticRevisionId: 'sem-v1',
    sql: 'SELECT hour, observations FROM hourly ORDER BY hour',
    parameters: [],
    allowedTables: ['hourly'],
    resultStoreDir: join(directory, 'results'),
  })

  expect(summary.rowCount).toBe(48)
  expect(summary.preview).toHaveLength(20)
  expect(summary.previewTruncated).toBe(true)
  expect(summary).not.toHaveProperty('rows')
  expect(summary.evidence).toMatchObject({
    resultId: summary.resultId,
    datasetVersionId: 'orders-v1',
    semanticRevisionId: 'sem-v1',
    complete: true,
    rowCount: 48,
  })
  expect(summary.evidence.facts.find((fact) => fact.column === 'observations')).toMatchObject({
    minimum: 1082,
    maximum: 9895,
    maximumRow: 21,
    nonNullCount: 48,
    integerDomain: true,
    distinctCount: 48,
  })
})

it('rejects unauthorized SQL inside the isolated worker', async () => {
  await expect(
    executeIsolatedQuery({
      datasetPath,
      datasetVersionId: 'orders-v1',
      semanticRevisionId: 'sem-v1',
      sql: 'DELETE FROM orders',
      parameters: [],
      allowedTables: ['orders'],
    }),
  ).rejects.toThrow(/SELECT|policy|not allowed|Only a single/i)
})

it('aborts an isolated query and terminates the child process', async () => {
  const controller = new AbortController()
  const expensive = 'SELECT count(*) AS n FROM big a CROSS JOIN big b'
  const runPromise = executeIsolatedQuery({
    datasetPath,
    datasetVersionId: 'orders-v1',
    semanticRevisionId: 'sem-v1',
    sql: expensive,
    parameters: [],
    allowedTables: ['big'],
    signal: controller.signal,
    killGraceMs: 100,
  })

  // Abort promptly — the 40k cross-join can finish in well under 200ms.
  setTimeout(() => controller.abort(), 20)

  await expect(runPromise).rejects.toThrow(/aborted/i)
})

it('hardStop sends SIGKILL when the child ignores SIGTERM', async () => {
  // bash trap ignores SIGTERM; a Node SIGTERM handler is not a reliable stand-in
  // because child.kill('SIGTERM') still reports signalCode=SIGTERM once reaped.
  const child = spawn('/bin/bash', ['-c', "trap '' TERM; sleep 60"], { stdio: 'ignore' })
  const pid = child.pid
  expect(pid).toBeTypeOf('number')
  await hardStop(child, 50)
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  expect(() => process.kill(pid!, 0)).toThrow()
}, 5_000)

it('rejects immediately when the abort signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    executeIsolatedQuery({
      datasetPath,
      datasetVersionId: 'orders-v1',
      semanticRevisionId: 'sem-v1',
      sql: 'SELECT 1',
      parameters: [],
      allowedTables: ['orders'],
      signal: controller.signal,
    }),
  ).rejects.toThrow(/aborted/i)
})

it('recovers after a hard-killed worker and serves a later query', async () => {
  const controller = new AbortController()
  const expensive = 'SELECT count(*) AS n FROM big a CROSS JOIN big b'
  const killed = executeIsolatedQuery({
    datasetPath,
    datasetVersionId: 'orders-v1',
    semanticRevisionId: 'sem-v1',
    sql: expensive,
    parameters: [],
    allowedTables: ['big'],
    signal: controller.signal,
    killGraceMs: 50,
  })
  setTimeout(() => controller.abort(), 15)
  await expect(killed).rejects.toThrow(/aborted/i)

  const summary = await executeIsolatedQuery({
    datasetPath,
    datasetVersionId: 'orders-v1',
    semanticRevisionId: 'sem-v1',
    sql: 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region',
    parameters: [],
    allowedTables: ['orders'],
  })
  expect(summary.rowCount).toBe(1)
  expect(summary.preview).toEqual([['West', '10.00']])
})
