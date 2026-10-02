#!/usr/bin/env node
/**
 * Native query-worker isolation probe.
 * Creates a tiny DuckDB in TMPDIR, runs executeIsolatedQuery, and asserts
 * scrubWorkerEnv drops credential-bearing variables that may be present on
 * the parent.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { executeIsolatedQuery, scrubWorkerEnv } from '../dist/query-worker.js'

const CREDENTIAL_KEYS = ['KAGGLE_API_TOKEN', 'DEEPSEEK_API_KEY', 'KAGGLE_USERNAME']

function assertScrub() {
  const scrubbed = scrubWorkerEnv()
  for (const key of CREDENTIAL_KEYS) {
    if (scrubbed[key] !== undefined) {
      throw new Error(`scrubWorkerEnv leaked ${key}`)
    }
  }
  if (scrubbed.NODE_OPTIONS !== undefined) {
    throw new Error('scrubWorkerEnv leaked NODE_OPTIONS')
  }
}

const directory = await mkdtemp(join(tmpdir(), 'dsh-isolation-probe-'))
const datasetPath = join(directory, 'dataset.duckdb')
const resultsDir = join(directory, 'results')
await mkdir(resultsDir)

try {
  assertScrub()

  const writer = await DuckDBInstance.create(datasetPath)
  const connection = await writer.connect()
  try {
    await connection.run(
      `CREATE TABLE orders AS SELECT * FROM (VALUES ('West', 10.00::DECIMAL(18,2))) t(region, sales)`,
    )
    await connection.run('CHECKPOINT')
  } finally {
    connection.closeSync()
    writer.closeSync()
  }

  const summary = await executeIsolatedQuery({
    datasetPath,
    datasetVersionId: 'probe-v1',
    semanticRevisionId: 'sem-probe',
    sql: 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region',
    parameters: [],
    allowedTables: ['orders'],
    resultStoreDir: resultsDir,
  })

  if (summary.rowCount !== 1 || String(summary.preview[0]?.[0]) !== 'West') {
    throw new Error(`unexpected summary: ${JSON.stringify(summary)}`)
  }

  let denied = false
  try {
    await executeIsolatedQuery({
      datasetPath,
      datasetVersionId: 'probe-v1',
      semanticRevisionId: 'sem-probe',
      sql: 'DELETE FROM orders',
      parameters: [],
      allowedTables: ['orders'],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/SELECT|policy|not allowed|Only a single/i.test(message)) denied = true
    else throw error
  }
  if (!denied) throw new Error('expected isolated policy reject, but query succeeded')

  console.log(
    JSON.stringify({
      ok: true,
      rowCount: summary.rowCount,
      preview: summary.preview,
      parentHadCredentials: CREDENTIAL_KEYS.some((k) => process.env[k]),
      scope: 'native child process with scrubbed environment and read-only query policy',
    }),
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
