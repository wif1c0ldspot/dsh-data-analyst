import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import { expect, it } from 'vitest'

it('loads the fixture, preserves exact values, and reopens without write or external-file access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-duckdb-test-'))
  const databasePath = join(directory, 'fixture.duckdb')
  const fixturePath = fileURLToPath(new URL('../../../tests/fixtures/retail.csv', import.meta.url))
  const cases = JSON.parse(
    await readFile(new URL('../../../tests/fixtures/retail-cases.json', import.meta.url), 'utf8'),
  ) as {
    cases: Array<{ referenceSql: string; expectedRows: unknown[][] }>
  }
  try {
    const writer = await DuckDBInstance.create(databasePath)
    try {
      const connection = await writer.connect()
      try {
        // Trusted test ingestion only. DuckDB's maintained CSV reader parses data.
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
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
    })
    try {
      const connection = await reader.connect()
      try {
        for (const testCase of cases.cases) {
          const result = await connection.runAndReadAll(testCase.referenceSql)
          // Driver-native JSON conversion preserves DECIMAL/BIGINT as strings.
          expect(result.getRowsJson()).toEqual(testCase.expectedRows)
        }
        const identifiers = await connection.runAndReadAll(
          'SELECT customer_id FROM retail ORDER BY line_id LIMIT 1',
        )
        expect(identifiers.getRowsJson()).toEqual([['0007']])
        const exact = await connection.runAndReadAll(
          'SELECT 9007199254740993::BIGINT, 9007199254740993.01::DECIMAL(18,2)',
        )
        expect(exact.getRowsJson()).toEqual([['9007199254740993', '9007199254740993.01']])
        await expect(connection.run('DELETE FROM retail')).rejects.toThrow()
        await expect(connection.run('SELECT * FROM read_csv(?)', [fixturePath])).rejects.toThrow()
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
