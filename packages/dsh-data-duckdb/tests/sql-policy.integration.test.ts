import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import type { Context } from '@deepseek-ai/cordis'
import type { DatasetManifest } from 'dsh-data-core/contracts'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_SQL_ATTEMPTS } from '../src/request-budget.js'
import { DuckdbAnalystService } from '../src/plugin-service.js'
import { registerDuckdbAnalystTools } from '../src/plugin-tools.js'
import { authorizeQuery, QueryPolicyViolation } from '../src/sql-policy.js'

let connection: DuckDBConnection

beforeAll(async () => {
  const db = await DuckDBInstance.create(':memory:')
  connection = await db.connect()
  await connection.run(
    'CREATE TABLE retail (line_id VARCHAR, region VARCHAR, amount DECIMAL(18,2))',
  )
  await connection.run('CREATE TABLE other_table (secret VARCHAR)')
})

afterAll(() => {
  connection.closeSync()
})

const options = { allowedTables: ['retail'] }

async function violation(sql: string): Promise<string> {
  try {
    await authorizeQuery(connection, sql, options)
  } catch (error) {
    expect(error).toBeInstanceOf(QueryPolicyViolation)
    return (error as Error).message
  }
  throw new Error(`expected a QueryPolicyViolation for: ${sql}`)
}

it('accepts a plain SELECT over an authorized table', async () => {
  await expect(
    authorizeQuery(connection, 'SELECT region, amount FROM retail', options),
  ).resolves.not.toBeUndefined()
})

it('accepts CTEs, joins, and window functions over the authorized table', async () => {
  await expect(
    authorizeQuery(
      connection,
      'WITH totals AS (SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region) SELECT region, revenue, SUM(revenue) OVER (ORDER BY region) AS running FROM totals',
      options,
    ),
  ).resolves.not.toBeUndefined()
})

it('accepts arithmetic operators (DuckDB FUNCTION nodes like *)', async () => {
  await expect(
    authorizeQuery(
      connection,
      'SELECT region, SUM(amount * 2) AS doubled FROM retail GROUP BY region',
      options,
    ),
  ).resolves.not.toBeUndefined()
})

it('rejects stacked statements', async () => {
  expect(await violation('SELECT 1 FROM retail; SELECT 2 FROM retail')).toMatch(
    /Exactly one SELECT statement/,
  )
})

it('rejects non-SELECT statements (DDL/DML/config/extension)', async () => {
  expect(await violation("ATTACH 'other.db'")).toMatch(/Only a single reviewed SELECT statement/)
  expect(await violation("SET memory_limit='100GB'")).toMatch(
    /Only a single reviewed SELECT statement/,
  )
  expect(await violation('PRAGMA version')).toMatch(/Only a single reviewed SELECT statement/)
  expect(await violation("COPY retail TO 'out.csv'")).toMatch(
    /Only a single reviewed SELECT statement/,
  )
  expect(await violation('CALL pragma_version()')).toMatch(
    /Only a single reviewed SELECT statement/,
  )
  expect(await violation('INSTALL httpfs')).toMatch(/Only a single reviewed SELECT statement/)
  expect(await violation('DELETE FROM retail')).toMatch(/Only a single reviewed SELECT statement/)
})

it('rejects external file/network table functions', async () => {
  expect(await violation("SELECT * FROM read_csv('/etc/passwd')")).toMatch(
    /Table functions are not allowed/,
  )
  expect(await violation("SELECT * FROM read_parquet('s3://bucket/key')")).toMatch(
    /Table functions are not allowed/,
  )
})

it('rejects catalog introspection table functions', async () => {
  expect(await violation('SELECT * FROM duckdb_tables()')).toMatch(
    /Table functions are not allowed/,
  )
})

it('rejects a table outside the authorized dataset, teaching the fix on the first failure', async () => {
  const message = await violation('SELECT * FROM other_table')
  expect(message).toBe(
    'Table "other_table" is not part of the authorized dataset. This is not the dataset id, ' +
      'Kaggle slug, or a friendly dataset title — those are never table names. The only ' +
      'queryable tables are the published table names: retail. Raw/staging ingestion tables are ' +
      'never exposed to any table name, so retrying with a different guessed name will not help; ' +
      'call get_schema(datasetId) if you need to confirm table names, columns, or grain.',
  )
})

it('rejects a non-default schema (information_schema, pg_catalog)', async () => {
  expect(await violation('SELECT * FROM information_schema.tables')).toMatch(
    /Only the default schema is allowed/,
  )
})

it('rejects an unapproved function', async () => {
  expect(await violation("SELECT current_setting('memory_limit')")).toMatch(
    /not on the approved allowlist/,
  )
})

it('accepts approved functions in DuckDB default schema and SQL-standard EXTRACT', async () => {
  await expect(
    authorizeQuery(connection, 'SELECT main.sum(amount) FROM retail', options),
  ).resolves.not.toBeUndefined()
  await expect(
    authorizeQuery(connection, "SELECT EXTRACT(YEAR FROM DATE '2020-01-01') FROM retail", options),
  ).resolves.not.toBeUndefined()
})

it('rejects bare trim()/year() but accepts the already-allowed idioms the skill now names', async () => {
  // trim() and year() are ordinary scalar functions a model reaches for, but
  // both stay off DEFAULT_ALLOWED_FUNCTIONS: the packaged skill reference
  // (skills/sql-safety/references/analytical-recipes.md) instead names the
  // already-allowed spelling, verified against the fixture data to be an
  // exact substitute. No allowlist change; this only pins the denial + the alternative.
  expect(await violation("SELECT trim(state) FROM retail WHERE trim(state) <> ''")).toMatch(
    /not on the approved allowlist/,
  )
  expect(await violation('SELECT year(order_date) FROM retail')).toMatch(
    /not on the approved allowlist/,
  )
  // Named alternative for the blank-or-missing filter: compare the raw value.
  await expect(
    authorizeQuery(connection, "SELECT * FROM retail WHERE state <> ''", options),
  ).resolves.not.toBeUndefined()
  // Named alternative for year extraction: EXTRACT normalizes to date_part.
  await expect(
    authorizeQuery(connection, 'SELECT EXTRACT(YEAR FROM order_date) FROM retail', options),
  ).resolves.not.toBeUndefined()
  // No unintended widening: I/O-bearing surfaces stay denied.
  expect(await violation("SELECT * FROM read_csv('x.csv')")).toMatch(
    /Table functions are not allowed/,
  )
})

it('rejects functions in non-default schemas', async () => {
  expect(await violation('SELECT unsafe.sum(amount) FROM retail')).toMatch(
    /Schema\/catalog-qualified function/,
  )
})

it('rejects an oversized query', async () => {
  const huge = `SELECT ${'1+'.repeat(40_000)}1 FROM retail`
  await expect(authorizeQuery(connection, huge, options)).rejects.toThrow(/between 1 and/)
})

it('executes explicit numeric buckets and interpolated distribution statistics without broadening table access', async () => {
  const db = await DuckDBInstance.create(':memory:')
  const conn = await db.connect()
  try {
    await conn.run('CREATE TABLE samples (amount DOUBLE)')
    await conn.run('INSERT INTO samples VALUES (-1), (0), (9), (10), (11), (20)')
    const scope = { allowedTables: ['samples'] }
    const buckets = 'SELECT floor(amount / 10) AS bucket FROM samples ORDER BY amount'
    await authorizeQuery(conn, buckets, scope)
    expect((await conn.runAndReadAll(buckets)).getRows()).toEqual([[-1], [0], [0], [1], [1], [2]])
    const stats =
      'SELECT median(amount), quantile_cont(amount, 0.25), quantile_cont(amount, 0.75) FROM samples'
    await authorizeQuery(conn, stats, scope)
    expect((await conn.runAndReadAll(stats)).getRows()).toEqual([[9.5, 2.25, 10.75]])
    await expect(authorizeQuery(conn, stats, { allowedTables: ['other'] })).rejects.toThrow(
      /authorized dataset/,
    )
    await expect(
      authorizeQuery(conn, 'SELECT unsafe.median(amount) FROM samples', scope),
    ).rejects.toThrow(QueryPolicyViolation)
  } finally {
    conn.closeSync()
    db.closeSync()
  }
})

/**
 * Loop-detection stress test:
 * reproduces the original walkthrough's "speculating about hidden raw
 * tables" shape directly — a scripted sequence of `duckdb_query` calls
 * against increasingly-implausible guessed table names, through the real
 * registered tool (`registerDuckdbAnalystTools`) and the real
 * `DuckdbAnalystService` request budget, not a synthetic call to
 * `budgetDenial` directly. The single-call coverage above only proves one
 * guessed table name is denied; this proves the *sequence* is stopped
 * within the documented `MAX_SQL_ATTEMPTS` cap, not just capped eventually,
 * and that each denial names the concrete limitation (raw/staging tables
 * are never queryable under any guessed name; the budget denial names its
 * own reason).
 */
describe('loop-detection: a session guessing raw/staging table names', () => {
  interface CapturedTool {
    name: string
    execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown>
  }

  function fakeToolsContext(captured: Map<string, CapturedTool>): Context {
    return {
      tools: { register: (definition: CapturedTool) => captured.set(definition.name, definition) },
    } as unknown as Context
  }

  let directory: string
  let service: DuckdbAnalystService
  let tools: Map<string, CapturedTool>
  const DATASET_ID = 'loop-detection-fixture'

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-loop-detection-'))
    const workspace = resolveWorkspacePaths(directory)
    const manifest: DatasetManifest = {
      contractVersion: 1,
      datasetId: DATASET_ID,
      datasetVersionId: `${DATASET_ID}-v1`,
      source: {
        slug: 'test/loop-detection-fixture',
        version: '1',
        url: 'https://example.invalid',
        retrievedAt: new Date().toISOString(),
        license: null,
      },
      files: [],
      recipeHash: 'loop-detection-fixture-v1',
      importerVersion: '0.1.0',
      tables: [{ id: 'orders', sourceFile: 'orders.csv', rows: 2, rejectedRows: 0 }],
    }
    const store = new MetadataStore(workspace.catalogPath)
    try {
      store.publishDatasetVersion(manifest)
    } finally {
      store.close()
    }

    const datasetPath = workspace.datasetFile(manifest.datasetVersionId, manifest.datasetId)
    await mkdir(dirname(datasetPath), { recursive: true })
    const writer = await DuckDBInstance.create(datasetPath)
    const connection = await writer.connect()
    try {
      await connection.run(`
        CREATE TABLE orders (order_id VARCHAR, region VARCHAR, amount DECIMAL(18,2));
        INSERT INTO orders VALUES ('o1', 'West', 10), ('o2', 'East', 20);
        CHECKPOINT;
      `)
    } finally {
      connection.closeSync()
      writer.closeSync()
    }

    service = new DuckdbAnalystService(workspace)
    tools = new Map()
    registerDuckdbAnalystTools(fakeToolsContext(tools), service)
  })

  afterEach(async () => {
    service?.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('denies the SQL-repair budget within MAX_SQL_ATTEMPTS while naming the concrete limitation on every attempt', async () => {
    const tool = tools.get('duckdb_query')!
    // Increasingly-implausible guessed raw/staging table names — the exact
    // shape the original walkthrough's runaway loop speculated over.
    const guesses = [
      'orders_raw',
      'stg_orders',
      'raw_orders_2023_backup',
      'orders_staging_v2_final',
      'internal_orders_source_of_truth',
    ]
    expect(guesses.length).toBeGreaterThan(MAX_SQL_ATTEMPTS)

    const outcomes: string[] = []
    for (const guess of guesses) {
      try {
        await tool.execute(
          { datasetId: DATASET_ID, sql: `SELECT * FROM ${guess}`, parameters: [] },
          { signal: new AbortController().signal },
        )
        outcomes.push('UNEXPECTED_SUCCESS')
      } catch (error) {
        outcomes.push((error as Error).message)
      }
    }

    // Every attempt up through the documented cap is a per-query policy
    // denial that names the concrete limitation: raw/staging tables are
    // never queryable, so a different guessed name will not help.
    for (let index = 0; index < MAX_SQL_ATTEMPTS; index += 1) {
      expect(outcomes[index]).toMatch(/not part of the authorized dataset/)
      expect(outcomes[index]).toMatch(
        /not the dataset id, Kaggle slug, or a friendly dataset title/,
      )
      expect(outcomes[index]).toMatch(/published table names: orders/)
      expect(outcomes[index]).toMatch(
        /Raw\/staging ingestion tables are never exposed to any table name/,
      )
      expect(outcomes[index]).toMatch(/retrying with a different guessed name will not help/)
    }

    // The very next call — the (MAX_SQL_ATTEMPTS + 1)th — is stopped by the
    // request budget itself before any further SQL is even parsed, not
    // "eventually" after further wasted attempts, and its denial also
    // names its own concrete reason (SQL_REPAIR_BUDGET). Errors surface
    // through `withObserveErrors` as a redacted `<<observe kind=error>>`
    // document (see `packages/dsh-data-core/src/tool-observe.ts`), which
    // still preserves the `POLICY_DENIED:` prefix verbatim.
    expect(outcomes[MAX_SQL_ATTEMPTS]).toMatch(/POLICY_DENIED: SQL_REPAIR_BUDGET/)

    // No later guess ever got a chance to run once the budget denied.
    expect(outcomes.length).toBe(guesses.length)
    for (let index = MAX_SQL_ATTEMPTS; index < outcomes.length; index += 1) {
      expect(outcomes[index]).toMatch(/POLICY_DENIED: SQL_REPAIR_BUDGET/)
    }
  }, 30_000)
})
