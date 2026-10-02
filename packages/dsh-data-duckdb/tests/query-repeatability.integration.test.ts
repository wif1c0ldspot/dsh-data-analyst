/**
 * Repeatability property:
 * `deriveResultEvidence`'s determinism (the same stored result always yields
 * the same facts) is architecturally implied but was never tested as a
 * property across independent runs — only within a single result's own
 * evidence-selection unit tests (`packages/dsh-data-core/tests/result-evidence.unit.test.ts`).
 * This drives the same dataset + same question/SQL through N=10 independent
 * calls to the *real registered* `duckdb_query` tool (through
 * `registerDuckdbAnalystTools`, the real forked `executeIsolatedQuery`
 * worker, and the real DuckDB engine — not a shortcut straight to
 * `deriveResultEvidence`) and asserts byte-identical `evidence.facts`/
 * `warnings` every time. This is meant to catch accidental nondeterminism —
 * an unstable `ORDER BY`-free aggregate, hash-map iteration order leaks,
 * etc. Mirrors `plugin-tools-duckdb-query-currency-warning.integration.test.ts`'s
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

let directory: string
let service: DuckdbAnalystService
let tools: Map<string, CapturedTool>
const DATASET_ID = 'repeatability-fixture'

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-repeatability-'))
  const workspace = resolveWorkspacePaths(directory)
  const manifest: DatasetManifest = {
    contractVersion: 1,
    datasetId: DATASET_ID,
    datasetVersionId: `${DATASET_ID}-v1`,
    source: {
      slug: 'test/repeatability-fixture',
      version: '1',
      url: 'https://example.invalid',
      retrievedAt: new Date().toISOString(),
      license: null,
    },
    files: [],
    recipeHash: 'repeatability-fixture-v1',
    importerVersion: '0.1.0',
    tables: [{ id: 'orders', sourceFile: 'orders.csv', rows: 24, rejectedRows: 0 }],
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
    // Five regions with overlapping/tied revenue totals and a wide row count
    // per group, deliberately shaped to give a hash aggregate room to
    // reorder groups between independent runs if grouping order were ever
    // unstable.
    await connection.run(`
      CREATE TABLE orders (order_id VARCHAR, region VARCHAR, amount DECIMAL(18,2));
      INSERT INTO orders
        SELECT 'o' || i::VARCHAR,
               ['West', 'East', 'North', 'South', 'Central'][(i % 5) + 1],
               ((i % 7) + 1)::DECIMAL(18,2)
        FROM range(0, 24) t(i);
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

it('produces byte-identical evidence facts and warnings across 10 independent duckdb_query calls', async () => {
  const tool = tools.get('duckdb_query')!
  const args = {
    datasetId: DATASET_ID,
    sql: 'SELECT region, SUM(amount) AS revenue, COUNT(*) AS n FROM orders GROUP BY region',
    parameters: [],
  }

  const RUNS = 10
  const snapshots: string[] = []
  for (let run = 0; run < RUNS; run += 1) {
    const result = (await tool.execute(args, {
      signal: new AbortController().signal,
    })) as { evidence: { facts: unknown; warnings: unknown }; warnings: unknown }
    snapshots.push(JSON.stringify({ facts: result.evidence.facts, warnings: result.warnings }))
  }

  expect(snapshots).toHaveLength(RUNS)
  const [first, ...rest] = snapshots
  for (const snapshot of rest) {
    expect(snapshot).toBe(first)
  }
  // Sanity: the facts are non-trivial (not an accidental empty-result pass).
  const parsedFirst = JSON.parse(first!) as { facts: unknown[] }
  expect(parsedFirst.facts.length).toBeGreaterThan(0)
}, 30_000)
