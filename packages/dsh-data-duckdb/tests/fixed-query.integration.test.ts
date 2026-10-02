import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import { expect, it } from 'vitest'
import { runFixedQuery } from '../src/fixed-query.js'

it('executes one fixed reviewed query against a read-only connection with typed, capped-preview results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-fixed-query-test-'))
  const databasePath = join(directory, 'fixture.duckdb')
  const fixturePath = fileURLToPath(new URL('../../../tests/fixtures/retail.csv', import.meta.url))
  try {
    const writer = await DuckDBInstance.create(databasePath)
    try {
      const connection = await writer.connect()
      try {
        await connection.run(
          `CREATE TABLE retail AS SELECT * FROM read_csv(?, header=true,
          columns={'line_id':'VARCHAR','customer_id':'VARCHAR','order_date':'DATE','region':'VARCHAR','amount':'DECIMAL(18,2)'})`,
          [fixturePath],
        )
        await connection.run('CHECKPOINT')
      } finally {
        connection.closeSync()
      }
    } finally {
      writer.closeSync()
    }

    const reader = await DuckDBInstance.create(databasePath, {
      access_mode: 'READ_ONLY',
      enable_external_access: 'false',
    })
    try {
      const connection = await reader.connect()
      try {
        const result = await runFixedQuery(
          connection,
          'SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region ORDER BY revenue DESC, region',
        )
        expect(result.columns).toEqual([
          { name: 'region', logicalType: 'VARCHAR' },
          // DuckDB's SUM() widens DECIMAL(18,2) precision to avoid overflow.
          { name: 'revenue', logicalType: 'DECIMAL(38,2)' },
        ])
        expect(result.rows).toEqual([
          ['North', '80.00'],
          ['South', '50.00'],
        ])
        expect(result.rowCount).toBe(2)
        expect(result.previewTruncated).toBe(false)
        expect(result.resultComplete).toBe(true)
        expect(result.warnings).toEqual([])

        const capped = await runFixedQuery(connection, 'SELECT * FROM retail ORDER BY line_id', {
          maxPreviewRows: 1,
        })
        expect(capped.rowCount).toBeGreaterThan(1)
        expect(capped.preview).toHaveLength(1)
        expect(capped.previewTruncated).toBe(true)
        expect(capped.warnings[0]).toMatch(/Preview capped at 1/)
        // Full authorized result remains complete even though the preview is capped.
        expect(capped.rows.length).toBe(capped.rowCount)

        const empty = await runFixedQuery(
          connection,
          "SELECT region, SUM(amount) AS revenue FROM retail WHERE region = 'Nonexistent' GROUP BY region",
        )
        expect(empty.rowCount).toBe(0)
        expect(empty.rows).toEqual([])
        expect(empty.previewTruncated).toBe(false)
      } finally {
        connection.closeSync()
      }
    } finally {
      reader.closeSync()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
