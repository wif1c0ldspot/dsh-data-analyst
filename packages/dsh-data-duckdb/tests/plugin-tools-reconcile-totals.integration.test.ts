/**
 * `reconcile_totals`: the
 * design-review finding that `buildReconcileGrainsRecipe` was fully
 * implemented and tested but never reachable by the model, only used
 * internally as an eval oracle. This exercises it as an actual registered
 * tool end to end, through the same `executeIsolatedQuery` worker path
 * `duckdb_query` uses, mirroring `plugin-tools-result-evidence.integration.test.ts`'s
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
const DATASET_ID = 'reconcile-fixture'
const SLUG = 'test/reconcile-fixture'

async function publishDataset(withApprovedRelationship: boolean) {
  const workspace = resolveWorkspacePaths(directory)
  const store = new MetadataStore(workspace.catalogPath)
  try {
    const pin = store.createWorkspaceSourcePin({
      slug: SLUG,
      sourceVersion: '1',
      actorId: 'analyst-session',
      recipe: {
        datasetId: DATASET_ID,
        recipeHash: 'reconcile-fixture-v1',
        importerVersion: '0.1.0',
        license: null,
        sourceUrl: 'https://example.invalid',
        tables: [
          {
            sourceFile: 'orders.csv',
            tableId: 'orders',
            columns: [
              { name: 'order_id', sourceName: 'order_id', type: 'VARCHAR' },
              { name: 'total_amount', sourceName: 'total_amount', type: 'DECIMAL(18,2)' },
            ],
          },
          {
            sourceFile: 'order_items.csv',
            tableId: 'order_items',
            columns: [
              { name: 'order_id', sourceName: 'order_id', type: 'VARCHAR' },
              { name: 'line_amount', sourceName: 'line_amount', type: 'DECIMAL(18,2)' },
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
      recipeHash: 'reconcile-fixture-v1',
      importerVersion: '0.1.0',
      tables: [
        { id: 'orders', sourceFile: 'orders.csv', rows: 2, rejectedRows: 0 },
        { id: 'order_items', sourceFile: 'order_items.csv', rows: 3, rejectedRows: 0 },
      ],
    }
    store.publishDatasetVersion(manifest)

    if (withApprovedRelationship) {
      const candidate = store.createRelationshipCandidate({
        datasetId: DATASET_ID,
        fromTable: 'orders',
        toTable: 'order_items',
        fromColumns: ['order_id'],
        toColumns: ['order_id'],
        cardinality: '1:n',
        evidence: { reason: 'test fixture' },
        actorId: 'analyst-session',
      })
      store.setStructureCandidateStatus(candidate.candidateId, 'approved')
    }

    const datasetPath = workspace.datasetFile(manifest.datasetVersionId, manifest.datasetId)
    await mkdir(dirname(datasetPath), { recursive: true })
    const writer = await DuckDBInstance.create(datasetPath)
    const connection = await writer.connect()
    try {
      await connection.run(`
        CREATE TABLE orders (order_id VARCHAR, total_amount DECIMAL(18,2));
        INSERT INTO orders VALUES ('o1', 25), ('o2', 40);
        CREATE TABLE order_items (order_id VARCHAR, line_amount DECIMAL(18,2));
        INSERT INTO order_items VALUES ('o1', 10), ('o1', 20), ('o2', 40);
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
  directory = await mkdtemp(join(tmpdir(), 'dsh-reconcile-tool-'))
})

afterEach(async () => {
  service?.dispose()
  await rm(directory, { recursive: true, force: true })
})

it('reconciles two tables end to end through the registered tool', async () => {
  await publishDataset(true)
  const tool = tools.get('reconcile_totals')!
  const args = {
    datasetId: DATASET_ID,
    primaryTable: 'orders',
    primaryColumn: 'total_amount',
    secondaryTable: 'order_items',
    secondaryColumn: 'line_amount',
  }
  const result = await tool.execute(args, { signal: new AbortController().signal })
  const body = parseObserve(tool.output.render(args, result)[0]!.text, 'query') as {
    preview: unknown[][]
  }
  // orders sums to 65.00 (25+40); order_items sums to 70.00 (10+20+40).
  expect(body.preview).toEqual([['65.00', '2', '70.00', '3', '-5.00', -0.07692307692307693, null]])
}, 15_000)

it('refuses reconciliation without an analyst-approved relationship between the two tables', async () => {
  await publishDataset(false)
  const tool = tools.get('reconcile_totals')!
  await expect(
    tool.execute(
      {
        datasetId: DATASET_ID,
        primaryTable: 'orders',
        primaryColumn: 'total_amount',
        secondaryTable: 'order_items',
        secondaryColumn: 'line_amount',
      },
      { signal: new AbortController().signal },
    ),
  ).rejects.toThrow(/approved relationship/)
})

it('refuses an unpublished table name instead of leaking an unrelated table', async () => {
  await publishDataset(true)
  const tool = tools.get('reconcile_totals')!
  await expect(
    tool.execute(
      {
        datasetId: DATASET_ID,
        primaryTable: 'orders',
        primaryColumn: 'total_amount',
        secondaryTable: 'not_a_real_table',
        secondaryColumn: 'line_amount',
      },
      { signal: new AbortController().signal },
    ),
  ).rejects.toThrow(/not a published table/)
})
