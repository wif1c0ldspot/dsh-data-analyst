import { readFile } from 'node:fs/promises'
import { DuckDBInstance } from '@duckdb/node-api'
import { expect, it } from 'vitest'
import { authorizeQuery } from '../src/sql-policy.js'

it('authorizes and executes every SQL example shipped in the analytical reference', async () => {
  const reference = await readFile(
    new URL('../../../skills/sql-safety/references/analytical-recipes.md', import.meta.url),
    'utf8',
  )
  const examples = [...reference.matchAll(/```sql\n([\s\S]*?)\n```/g)].map((match) =>
    match[1]!.trim(),
  )
  expect(examples).toHaveLength(6)

  const database = await DuckDBInstance.create(':memory:')
  const connection = await database.connect()
  try {
    await connection.run(`
      CREATE TABLE analytical_fixture (
        elapsed_seconds BIGINT,
        value DOUBLE,
        numerator DECIMAL(18,2),
        denominator DECIMAL(18,2),
        comparison_group VARCHAR
      )
    `)
    await connection.run(`
      INSERT INTO analytical_fixture VALUES
        (-1, 1, 1, 2, 'a'),
        (0, 2, 9, 98, 'a'),
        (3599, NULL, 0, 0, 'b'),
        (3600, 100, NULL, NULL, 'b')
    `)

    for (const [index, sql] of examples.entries()) {
      await authorizeQuery(connection, sql, { allowedTables: ['analytical_fixture'] })
      await expect(
        connection.runAndReadAll(sql, index === 0 ? [0, 3600] : []),
      ).resolves.toBeDefined()
    }
  } finally {
    connection.closeSync()
    database.closeSync()
  }
})
