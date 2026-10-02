/**
 * End-to-end coverage that `duckdb_query`'s actual returned result carries
 * the AST-based currency-mix warning — through the real registered tool,
 * the real forked `executeIsolatedQuery` worker, and the real DuckDB parse
 * inside `query-service.ts`, not a mocked render function. Mirrors
 * `plugin-tools-reconcile-totals.integration.test.ts`'s fixture pattern.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DuckDBInstance } from '@duckdb/node-api'
import type { Context } from '@deepseek-ai/cordis'
import type { DatasetManifest } from 'dsh-data-core/contracts'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DuckdbAnalystService } from '../src/plugin-service.js'
import { registerDuckdbAnalystTools } from '../src/plugin-tools.js'

interface CapturedTool {
  name: string
  execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown>
  output: { render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }> }
}

function fakeToolsContext(captured: Map<string, CapturedTool>): Context {
  return {
    tools: { register: (definition: CapturedTool) => captured.set(definition.name, definition) },
  } as unknown as Context
}

function parseObserve(text: string, kind: string): Record<string, unknown> {
  const open = `<<observe kind=${kind}>>\n`
  const close = '\n<</observe>>'
  expect(text.startsWith(open)).toBe(true)
  expect(text.endsWith(close)).toBe(true)
  return JSON.parse(text.slice(open.length, text.length - close.length)) as Record<string, unknown>
}

let directory: string
let service: DuckdbAnalystService
let tools: Map<string, CapturedTool>
const DATASET_ID = 'currency-fixture'

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-currency-tool-'))
  const workspace = resolveWorkspacePaths(directory)
  const manifest: DatasetManifest = {
    contractVersion: 1,
    datasetId: DATASET_ID,
    datasetVersionId: `${DATASET_ID}-v1`,
    source: {
      slug: 'test/currency-fixture',
      version: '1',
      url: 'https://example.invalid',
      retrievedAt: new Date().toISOString(),
      license: null,
    },
    files: [],
    recipeHash: 'currency-fixture-v1',
    importerVersion: '0.1.0',
    tables: [
      {
        id: 'orders',
        sourceFile: 'orders.csv',
        rows: 3,
        rejectedRows: 0,
        currencyDimensions: [{ column: 'currency', currencies: ['EUR', 'GBP', 'USD'] }],
      },
    ],
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
      CREATE TABLE orders (order_id VARCHAR, currency VARCHAR, amount DECIMAL(18,2));
      INSERT INTO orders VALUES ('o1', 'USD', 10), ('o2', 'GBP', 20), ('o3', 'EUR', 30);
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

it('surfaces the currency-mix warning in a real duckdb_query call', async () => {
  const tool = tools.get('duckdb_query')!
  const args = { datasetId: DATASET_ID, sql: 'SELECT SUM(amount) FROM orders', parameters: [] }
  const result = await tool.execute(args, { signal: new AbortController().signal })
  const body = parseObserve(tool.output.render(args, result)[0]!.text, 'query') as {
    warnings: string[]
  }
  expect(body.warnings).toContain(
    'currency-mix-risk: orders.currency mixes EUR, GBP, USD — group or filter by currency before trusting a SUM/AVG in this table',
  )
}, 15_000)

it('omits the warning once the query groups by the currency column', async () => {
  const tool = tools.get('duckdb_query')!
  const args = {
    datasetId: DATASET_ID,
    sql: 'SELECT currency, SUM(amount) FROM orders GROUP BY currency',
    parameters: [],
  }
  const result = await tool.execute(args, { signal: new AbortController().signal })
  const body = parseObserve(tool.output.render(args, result)[0]!.text, 'query') as {
    warnings: string[]
  }
  expect(body.warnings.some((warning) => warning.includes('currency-mix-risk'))).toBe(false)
}, 15_000)
