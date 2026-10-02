#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import { buildAnalyticalRecipe } from '../dist/analytical-recipes.js'
import { executeAuthorizedQuery } from '../dist/query-service.js'

async function createFixture(datasetPath) {
  const database = await DuckDBInstance.create(datasetPath)
  const connection = await database.connect()
  try {
    await connection.run(`
      CREATE TABLE measurements (elapsed_seconds BIGINT, value DOUBLE);
      INSERT INTO measurements VALUES (-3601, NULL), (-3600, 1), (-1, 2), (0, 2), (3599, 100), (3600, 1000);
      CREATE TABLE wide_intervals (elapsed_seconds BIGINT);
      INSERT INTO wide_intervals VALUES (-9223372036854775808), (-9007199254740993), (9007199254740993);
      CREATE TABLE precise_decimals (value DECIMAL(38,20));
      INSERT INTO precise_decimals VALUES (0.12345678901234567890), (0.12345678901234567892);
      CREATE TABLE duplicate_rows (key VARCHAR, value BIGINT);
      INSERT INTO duplicate_rows VALUES ('a', 1), ('a', 1), ('b', NULL), ('b', NULL);
      CREATE TABLE ratio_rows (numerator DECIMAL(38,2), denominator DECIMAL(38,2));
      INSERT INTO ratio_rows VALUES (1, 2), (9, 98);
      CHECKPOINT;
    `)
  } finally {
    connection.closeSync()
    database.closeSync()
  }
}

export async function runAnalyticalRecipeFixtures() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-recipe-runner-'))
  const datasetPath = join(directory, 'dataset.duckdb')
  try {
    await createFixture(datasetPath)
    const cases = [
      {
        scope: {
          table: 'measurements',
          columns: ['elapsed_seconds', 'value'],
          columnTypes: { elapsed_seconds: 'BIGINT', value: 'DOUBLE' },
          grainStatus: 'unknown',
        },
        input: {
          kind: 'elapsed-intervals',
          elapsedColumn: 'elapsed_seconds',
          originSeconds: 0,
          widthSeconds: 3600,
        },
        expected: [
          ['-2', '1'],
          ['-1', '2'],
          ['0', '2'],
          ['1', '1'],
        ],
      },
      {
        scope: {
          table: 'wide_intervals',
          columns: ['elapsed_seconds'],
          columnTypes: { elapsed_seconds: 'BIGINT' },
          grainStatus: 'unknown',
        },
        input: {
          kind: 'elapsed-intervals',
          elapsedColumn: 'elapsed_seconds',
          originSeconds: 1,
          widthSeconds: 1,
        },
        expected: [
          ['-9223372036854775809', '1'],
          ['-9007199254740994', '1'],
          ['9007199254740992', '1'],
        ],
      },
      {
        scope: {
          table: 'precise_decimals',
          columns: ['value'],
          columnTypes: { value: 'DECIMAL(38,20)' },
          grainStatus: 'unknown',
        },
        input: { kind: 'descriptive-statistics', valueColumn: 'value' },
        expected: [
          [
            '2',
            '2',
            '0',
            0,
            '0.12345678901234567890',
            '0.12345678901234567892',
            null,
            null,
            null,
            null,
            'WITHHELD_HIGH_PRECISION_DECIMAL',
          ],
        ],
      },
      {
        scope: {
          table: 'duplicate_rows',
          columns: ['key', 'value'],
          columnTypes: { key: 'VARCHAR', value: 'BIGINT' },
          grainStatus: 'unknown',
        },
        input: {
          kind: 'full-row-duplicate-excess',
          rowColumns: ['key', 'value'],
        },
        expected: [['4', '2', '2']],
      },
      {
        scope: {
          table: 'ratio_rows',
          columns: ['numerator', 'denominator'],
          columnTypes: { numerator: 'DECIMAL(38,2)', denominator: 'DECIMAL(38,2)' },
          grainStatus: 'approved',
        },
        input: {
          kind: 'ratio-of-sums',
          numeratorColumn: 'numerator',
          denominatorColumn: 'denominator',
          nullRule: 'withhold-on-incomplete-pairs',
        },
        expected: [['2', '0', '10.00', '100.00', 0.1, null]],
      },
    ]

    const results = []
    for (const fixture of cases) {
      const recipe = buildAnalyticalRecipe(fixture.scope, fixture.input)
      const result = await executeAuthorizedQuery({
        datasetPath,
        datasetVersionId: 'recipe-fixture-v1',
        semanticRevisionId: 'recipe-fixture-sem-v1',
        sql: recipe.sql,
        parameters: recipe.parameters,
        allowedTables: [fixture.scope.table],
      })
      assert.deepEqual(result.preview, fixture.expected)
      results.push({ kind: recipe.kind, rows: result.rowCount })
    }
    return results
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const results = await runAnalyticalRecipeFixtures()
  process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`)
}
