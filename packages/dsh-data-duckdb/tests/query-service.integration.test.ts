import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { expect, it } from 'vitest'
import { QueryCancelledError } from '../src/cancellable-query.js'
import { QueryBudgetViolation, runFixedQuery } from '../src/fixed-query.js'
import { QueryPolicyViolation } from '../src/sql-policy.js'
import { executeAuthorizedQuery } from '../src/query-service.js'

it('runs a policy-approved SELECT against a read-only dataset and returns a bounded summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-query-service-'))
  try {
    const datasetPath = join(directory, 'dataset.duckdb')
    const writer = await DuckDBInstance.create(datasetPath)
    const writerConnection = await writer.connect()
    try {
      await writerConnection.run(
        `CREATE TABLE orders AS SELECT * FROM (VALUES
          ('West', 100.00::DECIMAL(18,2)),
          ('East', 50.00::DECIMAL(18,2))
        ) AS t(region, sales)`,
      )
      await writerConnection.run('CHECKPOINT')
    } finally {
      writerConnection.closeSync()
      writer.closeSync()
    }

    const summary = await executeAuthorizedQuery({
      datasetPath,
      datasetVersionId: 'orders-v1',
      semanticRevisionId: 'sem-v1',
      sql: 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region ORDER BY revenue DESC',
      parameters: [],
      allowedTables: ['orders'],
    })

    expect(summary.datasetVersionId).toBe('orders-v1')
    expect(summary.semanticRevisionId).toBe('sem-v1')
    expect(summary.resultComplete).toBe(true)
    expect(summary.rowCount).toBe(2)
    expect(summary.preview).toEqual([
      ['West', '100.00'],
      ['East', '50.00'],
    ])
    expect(summary.resultId).toMatch(/^res_/)
    expect(summary.evidence.facts).toEqual([])
    expect(summary.evidence.warnings.join(' ')).toContain('exact decimal')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('keeps the payload-preview notice out of the stored result and its evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-query-preview-notice-'))
  try {
    const datasetPath = join(directory, 'dataset.duckdb')
    const writer = await DuckDBInstance.create(datasetPath)
    const writerConnection = await writer.connect()
    try {
      await writerConnection.run('CREATE TABLE nums AS SELECT i FROM range(0, 50) t(i)')
      await writerConnection.run('CHECKPOINT')
    } finally {
      writerConnection.closeSync()
      writer.closeSync()
    }

    const resultStoreDir = join(directory, 'results')
    const summary = await executeAuthorizedQuery({
      datasetPath,
      datasetVersionId: 'nums-v1',
      semanticRevisionId: 'sem-v1',
      sql: 'SELECT i AS value FROM nums ORDER BY i',
      parameters: [],
      allowedTables: ['nums'],
      maxPreviewRows: 20,
      resultStoreDir,
    })

    // The model still learns that its payload was capped…
    expect(summary.previewTruncated).toBe(true)
    expect(summary.warnings.join(' ')).toMatch(/Preview capped at 20 of 50 rows/)
    // …but the stored result and its derived evidence carry data caveats only, so
    // charts and exported reports cannot claim a complete chart is a 20-row preview.
    const stored = JSON.parse(
      await readFile(join(resultStoreDir, `${summary.resultId}.json`), 'utf8'),
    )
    expect(stored.warnings.join(' ')).not.toMatch(/Preview capped/)
    expect(summary.evidence.warnings.join(' ')).not.toMatch(/Preview capped/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('binds typed positional parameters without interpolating them into SQL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-query-parameters-'))
  try {
    const datasetPath = join(directory, 'dataset.duckdb')
    const writer = await DuckDBInstance.create(datasetPath)
    const writerConnection = await writer.connect()
    try {
      await writerConnection.run(
        `CREATE TABLE orders AS SELECT * FROM (VALUES
          ('West', 100.00::DECIMAL(18,2)),
          ('South', 50.00::DECIMAL(18,2))
        ) AS t(region, sales)`,
      )
      await writerConnection.run('CHECKPOINT')
    } finally {
      writerConnection.closeSync()
      writer.closeSync()
    }

    const summary = await executeAuthorizedQuery({
      datasetPath,
      datasetVersionId: 'orders-v1',
      semanticRevisionId: 'sem-v1',
      sql: 'SELECT region, SUM(sales) AS revenue FROM orders WHERE region = ? GROUP BY region',
      parameters: [{ logicalType: 'VARCHAR', value: 'South' }],
      resultStoreDir: join(directory, 'results'),
      allowedTables: ['orders'],
    })

    expect(summary.preview).toEqual([['South', '50.00']])
    const stored = JSON.parse(
      await readFile(join(directory, 'results', `${summary.resultId}.json`), 'utf8'),
    )
    expect(stored.parameters).toEqual([{ logicalType: 'VARCHAR', value: 'South' }])
    expect(stored.evidence).toEqual(summary.evidence)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects unsupported or structurally invalid bound parameter values', async () => {
  await expect(
    executeAuthorizedQuery({
      datasetPath: '/tmp/does-not-matter.duckdb',
      datasetVersionId: 'orders-v1',
      semanticRevisionId: 'sem-v1',
      sql: 'SELECT * FROM orders WHERE region = ?',
      parameters: [{ logicalType: 'STRUCT', value: { nested: true } }],
      allowedTables: ['orders'],
    }),
  ).rejects.toBeInstanceOf(QueryPolicyViolation)
})

it('rejects unauthorized SQL before opening a query connection', async () => {
  await expect(
    executeAuthorizedQuery({
      datasetPath: '/tmp/does-not-matter.duckdb',
      datasetVersionId: 'orders-v1',
      semanticRevisionId: 'sem-v1',
      sql: 'DELETE FROM orders',
      parameters: [],
      allowedTables: ['orders'],
    }),
  ).rejects.toBeInstanceOf(QueryPolicyViolation)
})

it('rejects results that exceed the row budget without writing a result store entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-query-budget-rows-'))
  try {
    const datasetPath = join(directory, 'dataset.duckdb')
    const resultStoreDir = join(directory, 'results')
    const writer = await DuckDBInstance.create(datasetPath)
    const writerConnection = await writer.connect()
    try {
      await writerConnection.run('CREATE TABLE nums AS SELECT i FROM range(0, 5) t(i)')
      await writerConnection.run('CHECKPOINT')
    } finally {
      writerConnection.closeSync()
      writer.closeSync()
    }

    await expect(
      executeAuthorizedQuery({
        datasetPath,
        datasetVersionId: 'nums-v1',
        semanticRevisionId: 'sem-v1',
        sql: 'SELECT i FROM nums ORDER BY i',
        parameters: [],
        allowedTables: ['nums'],
        resultStoreDir,
        maxResultRows: 3,
      }),
    ).rejects.toBeInstanceOf(QueryBudgetViolation)

    await expect(readFile(join(resultStoreDir, 'any.json'), 'utf8')).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects results that exceed the byte budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-query-budget-bytes-'))
  try {
    const datasetPath = join(directory, 'dataset.duckdb')
    const writer = await DuckDBInstance.create(datasetPath)
    const writerConnection = await writer.connect()
    try {
      await writerConnection.run(
        `CREATE TABLE blobs AS SELECT repeat('x', 100) AS payload FROM range(0, 5)`,
      )
      await writerConnection.run('CHECKPOINT')
    } finally {
      writerConnection.closeSync()
      writer.closeSync()
    }

    await expect(
      executeAuthorizedQuery({
        datasetPath,
        datasetVersionId: 'blobs-v1',
        semanticRevisionId: 'sem-v1',
        sql: 'SELECT payload FROM blobs',
        parameters: [],
        allowedTables: ['blobs'],
        maxResultBytes: 200,
      }),
    ).rejects.toMatchObject({ name: 'QueryBudgetViolation' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('forwards timeout into runFixedQuery so a slow query is interrupted', async () => {
  // Policy forbids range()/sin; exercise the timeout wire on runFixedQuery
  // (executeAuthorizedQuery passes timeoutMs through unchanged).
  const db = await DuckDBInstance.create(':memory:')
  const connection = await db.connect()
  try {
    const expensive =
      'SELECT count(*) FROM range(200000000) t(i) WHERE (sin(i * 1.0000001) * cos(i)) > 999999999'
    const started = performance.now()
    await expect(runFixedQuery(connection, expensive, { timeoutMs: 200 })).rejects.toBeInstanceOf(
      QueryCancelledError,
    )
    expect(performance.now() - started).toBeLessThan(2_000)
  } finally {
    connection.closeSync()
    db.closeSync()
  }
})

it('executeAuthorizedQuery forwards AbortSignal into runFixedQuery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-query-budget-abort-'))
  try {
    const datasetPath = join(directory, 'dataset.duckdb')
    const writer = await DuckDBInstance.create(datasetPath)
    const writerConnection = await writer.connect()
    try {
      await writerConnection.run('CREATE TABLE big AS SELECT i FROM range(0, 80000) t(i)')
      await writerConnection.run('CHECKPOINT')
    } finally {
      writerConnection.closeSync()
      writer.closeSync()
    }

    const controller = new AbortController()
    const runPromise = executeAuthorizedQuery({
      datasetPath,
      datasetVersionId: 'big-v1',
      semanticRevisionId: 'sem-v1',
      sql: 'SELECT count(*) AS n FROM big a CROSS JOIN big b',
      parameters: [],
      allowedTables: ['big'],
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)
    await expect(runPromise).rejects.toBeInstanceOf(QueryCancelledError)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('keeps the model preview capped separately from the full result budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-query-preview-cap-'))
  try {
    const datasetPath = join(directory, 'dataset.duckdb')
    const writer = await DuckDBInstance.create(datasetPath)
    const writerConnection = await writer.connect()
    try {
      await writerConnection.run('CREATE TABLE nums AS SELECT i FROM range(0, 50) t(i)')
      await writerConnection.run('CHECKPOINT')
    } finally {
      writerConnection.closeSync()
      writer.closeSync()
    }

    const reader = await DuckDBInstance.create(datasetPath, {
      access_mode: 'READ_ONLY',
      enable_external_access: 'false',
    })
    const connection = await reader.connect()
    try {
      const result = await runFixedQuery(connection, 'SELECT i FROM nums ORDER BY i', {
        maxPreviewRows: 20,
        maxResultRows: 100,
      })
      expect(result.rowCount).toBe(50)
      expect(result.preview).toHaveLength(20)
      expect(result.previewTruncated).toBe(true)
    } finally {
      connection.closeSync()
      reader.closeSync()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
