import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import type { Context } from '@deepseek-ai/cordis'
import type { DatasetManifest } from 'dsh-data-core/contracts'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { OBSERVE_MAX_BYTES } from 'dsh-data-core/tool-observe'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DuckdbAnalystService } from '../src/plugin-service.js'
import { registerDuckdbAnalystTools } from '../src/plugin-tools.js'

interface CapturedTool {
  name: string
  description: string
  execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown>
  output: {
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
}

function fakeToolsContext(captured: Map<string, CapturedTool>): Context {
  return {
    tools: {
      register: (definition: CapturedTool) => captured.set(definition.name, definition),
    },
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

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-tool-evidence-'))
  const workspace = resolveWorkspacePaths(directory)
  const manifest: DatasetManifest = {
    contractVersion: 1,
    datasetId: 'superstore',
    datasetVersionId: 'superstore-v1-evidence',
    source: {
      slug: 'test/superstore',
      version: '1',
      url: 'https://example.invalid',
      retrievedAt: new Date().toISOString(),
      license: null,
    },
    files: [],
    recipeHash: 'evidence-fixture',
    importerVersion: '0.1.0',
    tables: [
      { id: 'orders', sourceFile: 'orders.csv', rows: 48, rejectedRows: 0 },
      { id: 'quality_rows', sourceFile: 'quality.csv', rows: 3, rejectedRows: 0 },
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
    await connection.run(
      'CREATE TABLE orders AS SELECT i::INTEGER AS hour, CASE WHEN i = 21 THEN 9895 ELSE (1082 + i)::INTEGER END AS observations, 9007199254740993::BIGINT AS unsafe_count, 0.123456789012345678::DECIMAL(38,18) AS exact_amount FROM range(0, 48) t(i)',
    )
    await connection.run(
      "CREATE TABLE quality_rows(value VARCHAR); INSERT INTO quality_rows VALUES ('same'), ('same'), ('other')",
    )
    await connection.run('CHECKPOINT')
  } finally {
    connection.closeSync()
    writer.closeSync()
  }

  service = new DuckdbAnalystService(workspace)
  tools = new Map()
  registerDuckdbAnalystTools(fakeToolsContext(tools), service)
})

afterEach(async () => {
  service.dispose()
  await rm(directory, { recursive: true, force: true })
})

it('scopes registered catalog counts as ingestion-only despite zero rejects and actual duplicates', async () => {
  const signal = new AbortController().signal
  const listTool = tools.get('list_datasets')!
  const listResult = await listTool.execute({}, { signal })
  const listBody = parseObserve(listTool.output.render({}, listResult)[0]!.text, 'catalog') as {
    datasets: Array<{
      qualityScope: string
      tables: Array<{ id: string; rejectedRows: number }>
    }>
  }
  const listed = listBody.datasets.find((dataset) =>
    dataset.tables.some((table) => table.id === 'quality_rows'),
  )!
  expect(listed.tables.find((table) => table.id === 'quality_rows')?.rejectedRows).toBe(0)
  expect(listed.qualityScope).toContain('ingestion counts only')
  expect(listed.qualityScope).toContain('do not provide duplicate')
  expect(listTool.description).toContain('ingestion-rejection counts')

  const schemaTool = tools.get('get_schema')!
  const schemaArgs = { datasetId: 'superstore' }
  const schemaResult = await schemaTool.execute(schemaArgs, { signal })
  const schemaBody = parseObserve(
    schemaTool.output.render(schemaArgs, schemaResult)[0]!.text,
    'schema',
  )
  expect(schemaBody.qualityScope).toContain('do not provide duplicate')
  expect(schemaTool.description).toContain('ingestion-rejection counts')

  const queryTool = tools.get('duckdb_query')!
  const queryArgs = {
    datasetId: 'superstore',
    sql:
      'WITH row_counts AS (SELECT value, count(*) AS row_count FROM quality_rows GROUP BY value) ' +
      'SELECT coalesce(sum(row_count - 1), 0) AS duplicate_excess FROM row_counts',
    parameters: [],
  }
  const queryResult = await queryTool.execute(queryArgs, { signal })
  const queryBody = parseObserve(
    queryTool.output.render(queryArgs, queryResult)[0]!.text,
    'query',
  ) as { preview: unknown[][] }
  expect(queryBody.preview).toEqual([['1']])
})

it('carries a post-preview maximum through worker, registered tool, and model observe', async () => {
  const tool = tools.get('duckdb_query')!
  const args = {
    datasetId: 'superstore',
    sql: 'SELECT hour, observations FROM orders ORDER BY hour',
    parameters: [],
  }
  const result = await tool.execute(args, { signal: new AbortController().signal })
  const text = tool.output.render(args, result)[0]!.text
  const body = parseObserve(text, 'query') as {
    preview: unknown[]
    rowCount: number
    evidence: {
      complete: boolean
      scope: string
      facts: Array<{ column: string; maximum: number; maximumRow: number }>
    }
  }

  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(OBSERVE_MAX_BYTES)
  expect(body.rowCount).toBe(48)
  expect(body.preview).toHaveLength(20)
  expect(body.evidence.complete).toBe(true)
  expect(body.evidence.scope).toContain('query limits and filters still apply')
  expect(body.evidence.facts.find((fact) => fact.column === 'observations')).toMatchObject({
    maximum: 9895,
    maximumRow: 21,
  })
  expect(text).not.toContain('dataset.duckdb')
})

it('carries independently bound current and baseline evidence through investigate_metric observe', async () => {
  const tool = tools.get('investigate_metric')!
  const args = {
    datasetId: 'superstore',
    sqlCurrent: 'SELECT hour, observations FROM orders ORDER BY hour',
    sqlBaseline: 'SELECT hour, observations FROM orders WHERE hour < 21 ORDER BY hour',
    parameters: [],
  }
  const result = await tool.execute(args, { signal: new AbortController().signal })
  const text = tool.output.render(args, result)[0]!.text
  const body = parseObserve(text, 'catalog') as {
    current: { rowCount: number; evidence: { rowCount: number; facts: Array<{ maximum: number }> } }
    baseline: {
      rowCount: number
      evidence: { rowCount: number; facts: Array<{ maximum: number }> }
    }
  }

  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(OBSERVE_MAX_BYTES)
  expect(body.current.rowCount).toBe(48)
  expect(body.current.evidence.rowCount).toBe(48)
  expect(body.current.evidence.facts[1]!.maximum).toBe(9895)
  expect(body.baseline.rowCount).toBe(21)
  expect(body.baseline.evidence.rowCount).toBe(21)
  expect(body.baseline.evidence.facts[1]!.maximum).toBe(1102)
})

it('withholds unsafe BIGINT and DECIMAL facts while carrying an explicit model warning', async () => {
  const tool = tools.get('duckdb_query')!
  const args = {
    datasetId: 'superstore',
    sql: 'SELECT unsafe_count, exact_amount FROM orders LIMIT 1',
    parameters: [],
  }
  const result = await tool.execute(args, { signal: new AbortController().signal })
  const body = parseObserve(tool.output.render(args, result)[0]!.text, 'query') as {
    evidence: { facts: unknown[]; warnings: string[] }
  }

  expect(body.evidence.facts).toEqual([])
  expect(body.evidence.warnings).toEqual(
    expect.arrayContaining([
      expect.stringContaining('unsafe_count'),
      expect.stringContaining('exact_amount'),
    ]),
  )
  expect(body.evidence.warnings.join(' ')).toContain('exact decimal or integer handling')
})
