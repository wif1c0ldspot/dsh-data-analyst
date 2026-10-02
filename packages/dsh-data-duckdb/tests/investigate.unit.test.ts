import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { QueryPolicyViolation } from '../src/sql-policy.js'
import { investigateMetric } from '../src/investigate.js'

let directory: string
let datasetPath: string
let resultStoreDir: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-investigate-'))
  datasetPath = join(directory, 'dataset.duckdb')
  resultStoreDir = join(directory, 'results')
  const writer = await DuckDBInstance.create(datasetPath)
  const connection = await writer.connect()
  try {
    await connection.run(
      `CREATE TABLE orders AS SELECT * FROM (VALUES
        ('West', 100.00::DECIMAL(18,2)),
        ('East', 50.00::DECIMAL(18,2))
      ) AS t(region, sales)`,
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

it('returns current vs baseline previews for two authorized SELECTs', async () => {
  const observation = await investigateMetric({
    datasetId: 'orders-fixture',
    sqlCurrent:
      "SELECT region, SUM(sales) AS revenue FROM orders WHERE region = 'West' GROUP BY region",
    sqlBaseline:
      "SELECT region, SUM(sales) AS revenue FROM orders WHERE region = 'East' GROUP BY region",
    datasetPath,
    datasetVersionId: 'orders-v1',
    semanticRevisionId: 'sem-v1',
    allowedTables: ['orders'],
    resultStoreDir,
  })

  expect(observation.current.rowCount).toBe(1)
  expect(observation.current.preview).toEqual([['West', '100.00']])
  expect(observation.baseline.rowCount).toBe(1)
  expect(observation.baseline.preview).toEqual([['East', '50.00']])
  expect(observation.current.resultId).toMatch(/^res_/)
  expect(observation.baseline.resultId).toMatch(/^res_/)
  expect(observation.current.resultId).not.toBe(observation.baseline.resultId)

  const written = await readdir(resultStoreDir)
  expect(written.sort()).toEqual(
    [`${observation.current.resultId}.json`, `${observation.baseline.resultId}.json`].sort(),
  )
})

it('rejects a DROP TABLE in the baseline slot and writes nothing to resultStoreDir', async () => {
  await expect(
    investigateMetric({
      datasetId: 'orders-fixture',
      sqlCurrent: 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region',
      sqlBaseline: 'DROP TABLE orders',
      datasetPath,
      datasetVersionId: 'orders-v1',
      semanticRevisionId: 'sem-v1',
      allowedTables: ['orders'],
      resultStoreDir,
    }),
  ).rejects.toMatchObject({
    constructor: QueryPolicyViolation,
    message: expect.stringMatching(/POLICY_DENIED/),
  })

  await expect(readdir(resultStoreDir)).rejects.toThrow()

  // The dataset itself is untouched — the DROP never ran.
  const reader = await DuckDBInstance.create(datasetPath, { access_mode: 'READ_ONLY' })
  const connection = await reader.connect()
  try {
    const rows = await connection.runAndReadAll('SELECT count(*) FROM orders')
    expect(rows.getRowsJson()).toEqual([['2']])
  } finally {
    connection.closeSync()
    reader.closeSync()
  }
})

it('rejects a DELETE in the baseline slot before either query executes', async () => {
  await expect(
    investigateMetric({
      datasetId: 'orders-fixture',
      sqlCurrent: 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region',
      sqlBaseline: 'DELETE FROM orders',
      datasetPath,
      datasetVersionId: 'orders-v1',
      semanticRevisionId: 'sem-v1',
      allowedTables: ['orders'],
      resultStoreDir,
    }),
  ).rejects.toBeInstanceOf(QueryPolicyViolation)

  await expect(readdir(resultStoreDir)).rejects.toThrow()
})

it('rejects a denied current query without ever authorizing execution of the baseline', async () => {
  await expect(
    investigateMetric({
      datasetId: 'orders-fixture',
      sqlCurrent: 'DELETE FROM orders',
      sqlBaseline: 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region',
      datasetPath,
      datasetVersionId: 'orders-v1',
      semanticRevisionId: 'sem-v1',
      allowedTables: ['orders'],
      resultStoreDir,
    }),
  ).rejects.toBeInstanceOf(QueryPolicyViolation)

  await expect(readdir(resultStoreDir)).rejects.toThrow()
})

it('uses bound parameters for both comparison queries', async () => {
  const result = await investigateMetric({
    datasetId: 'orders-fixture',
    sqlCurrent: 'SELECT region FROM orders WHERE region = ?',
    sqlBaseline: 'SELECT region FROM orders WHERE region = ?',
    parameters: [{ logicalType: 'VARCHAR', value: 'West' }],
    datasetPath,
    datasetVersionId: 'orders-v1',
    semanticRevisionId: 'sem-v1',
    allowedTables: ['orders'],
    resultStoreDir,
  })

  expect(result.current.preview).toEqual([['West']])
  expect(result.baseline.preview).toEqual([['West']])
})
