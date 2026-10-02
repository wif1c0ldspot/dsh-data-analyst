/**
 * `find_top_n`: top/bottom-N and extrema was the one true gap in
 * full-result analytical helpers once `investigate_metric` already covered
 * period-over-period comparison. Exercises `buildAnalyticalRecipe`'s
 * `top-n-extrema` kind as an actual registered tool end to end, through the
 * same `executeIsolatedQuery` worker path `reconcile_totals`/`duckdb_query`
 * use, mirroring `plugin-tools-reconcile-totals.integration.test.ts`'s
 * fixture pattern (approved workspace pin + published manifest + a real
 * DuckDB dataset file at the exact path the worker opens).
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
const DATASET_ID = 'top-n-fixture'
const SLUG = 'test/top-n-fixture'

async function publishDataset() {
  const workspace = resolveWorkspacePaths(directory)
  const store = new MetadataStore(workspace.catalogPath)
  try {
    const pin = store.createWorkspaceSourcePin({
      slug: SLUG,
      sourceVersion: '1',
      actorId: 'analyst-session',
      recipe: {
        datasetId: DATASET_ID,
        recipeHash: 'top-n-fixture-v1',
        importerVersion: '0.1.0',
        license: null,
        sourceUrl: 'https://example.invalid',
        tables: [
          {
            sourceFile: 'sales.csv',
            tableId: 'sales',
            columns: [
              { name: 'customer', sourceName: 'customer', type: 'VARCHAR' },
              { name: 'region', sourceName: 'region', type: 'VARCHAR' },
              { name: 'revenue', sourceName: 'revenue', type: 'DECIMAL(18,2)' },
            ],
          },
        ],
      },
    })
    store.setWorkspaceSourcePinStatus(pin.pinId, 'approved', pin.revision)

    const manifest: DatasetManifest = {
      contractVersion: 1,
      datasetId: DATASET_ID,
      datasetVersionId: `${DATASET_ID}-v1`,
      source: {
        slug: SLUG,
        version: '1',
        url: 'https://example.invalid',
        retrievedAt: new Date().toISOString(),
        license: null,
      },
      files: [],
      recipeHash: 'top-n-fixture-v1',
      importerVersion: '0.1.0',
      tables: [{ id: 'sales', sourceFile: 'sales.csv', rows: 6, rejectedRows: 0 }],
    }
    store.publishDatasetVersion(manifest)

    const datasetPath = workspace.datasetFile(manifest.datasetVersionId, manifest.datasetId)
    await mkdir(dirname(datasetPath), { recursive: true })
    const writer = await DuckDBInstance.create(datasetPath)
    const connection = await writer.connect()
    try {
      await connection.run(`
        CREATE TABLE sales (customer VARCHAR, region VARCHAR, revenue DECIMAL(18,2));
        INSERT INTO sales VALUES
          ('c1', 'east', 100),
          ('c2', 'east', 90),
          ('c3', 'west', 90),
          ('c4', 'west', 50),
          ('c5', 'north', 50),
          ('c6', 'south', 10);
        CHECKPOINT;
      `)
    } finally {
      connection.closeSync()
      writer.closeSync()
    }
  } finally {
    store.close()
  }

  service = new DuckdbAnalystService(workspace)
  tools = new Map()
  registerDuckdbAnalystTools(fakeToolsContext(tools), service)
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-find-top-n-tool-'))
})

afterEach(async () => {
  service?.dispose()
  await rm(directory, { recursive: true, force: true })
})

it('finds the top-N rows end to end through the registered tool', async () => {
  await publishDataset()
  const tool = tools.get('find_top_n')!
  const args = {
    datasetId: DATASET_ID,
    table: 'sales',
    measureColumn: 'revenue',
    direction: 'top',
    limit: 3,
  }
  const result = await tool.execute(args, { signal: new AbortController().signal })
  const body = parseObserve(tool.output.render(args, result)[0]!.text, 'query') as {
    preview: unknown[][]
  }
  // Independently computed: 100(c1), then a tie at 90 between c2 (east)
  // and c3 (west), broken deterministically by customer ascending.
  expect(body.preview).toEqual([
    ['c1', 'east', '100.00'],
    ['c2', 'east', '90.00'],
    ['c3', 'west', '90.00'],
  ])
}, 15_000)

it('aggregates a grouped bottom-N ranking through the registered tool', async () => {
  await publishDataset()
  const tool = tools.get('find_top_n')!
  const args = {
    datasetId: DATASET_ID,
    table: 'sales',
    measureColumn: 'revenue',
    groupColumn: 'region',
    direction: 'bottom',
    limit: 2,
  }
  const result = await tool.execute(args, { signal: new AbortController().signal })
  const body = parseObserve(tool.output.render(args, result)[0]!.text, 'query') as {
    preview: unknown[][]
  }
  // Independently computed sums: south=10, north=50, west=140, east=190.
  expect(body.preview).toEqual([
    ['south', '10.00', '1'],
    ['north', '50.00', '1'],
  ])
}, 15_000)

it('accepts common direction synonyms and matches the canonical top/bottom result', async () => {
  await publishDataset()
  const tool = tools.get('find_top_n')!
  const baseArgs = {
    datasetId: DATASET_ID,
    table: 'sales',
    measureColumn: 'revenue',
    limit: 3,
  }
  const canonicalResult = await tool.execute(
    { ...baseArgs, direction: 'top' },
    { signal: new AbortController().signal },
  )
  const canonicalBody = parseObserve(
    tool.output.render(baseArgs, canonicalResult)[0]!.text,
    'query',
  )

  for (const synonym of ['desc', 'DESCENDING', 'Highest', 'largest', 'MAX']) {
    const result = await tool.execute(
      { ...baseArgs, direction: synonym },
      { signal: new AbortController().signal },
    )
    const body = parseObserve(tool.output.render(baseArgs, result)[0]!.text, 'query')
    expect(body.preview).toEqual(canonicalBody.preview)
  }

  const canonicalBottom = await tool.execute(
    { ...baseArgs, direction: 'bottom' },
    { signal: new AbortController().signal },
  )
  const canonicalBottomBody = parseObserve(
    tool.output.render(baseArgs, canonicalBottom)[0]!.text,
    'query',
  )
  for (const synonym of ['asc', 'ASCENDING', 'Lowest', 'smallest', 'min']) {
    const result = await tool.execute(
      { ...baseArgs, direction: synonym },
      { signal: new AbortController().signal },
    )
    const body = parseObserve(tool.output.render(baseArgs, result)[0]!.text, 'query')
    expect(body.preview).toEqual(canonicalBottomBody.preview)
  }
}, 15_000)

it('rejects an unrecognized direction and lists the full accepted vocabulary', async () => {
  await publishDataset()
  const tool = tools.get('find_top_n')!
  await expect(
    tool.execute(
      {
        datasetId: DATASET_ID,
        table: 'sales',
        measureColumn: 'revenue',
        direction: 'sideways',
        limit: 3,
      },
      { signal: new AbortController().signal },
    ),
  ).rejects.toThrow(
    /top, desc, descending, highest, largest, max, bottom, asc, ascending, lowest, smallest, min/,
  )
})

it('rejects an unbounded limit before touching the dataset', async () => {
  await publishDataset()
  const tool = tools.get('find_top_n')!
  await expect(
    tool.execute(
      {
        datasetId: DATASET_ID,
        table: 'sales',
        measureColumn: 'revenue',
        direction: 'top',
        limit: 500,
      },
      { signal: new AbortController().signal },
    ),
  ).rejects.toThrow(/integer between 1 and 50/)
})

it('refuses an unpublished table name instead of leaking an unrelated table', async () => {
  await publishDataset()
  const tool = tools.get('find_top_n')!
  await expect(
    tool.execute(
      {
        datasetId: DATASET_ID,
        table: 'not_a_real_table',
        measureColumn: 'revenue',
        direction: 'top',
        limit: 3,
      },
      { signal: new AbortController().signal },
    ),
  ).rejects.toThrow(/not a published table/)
})
