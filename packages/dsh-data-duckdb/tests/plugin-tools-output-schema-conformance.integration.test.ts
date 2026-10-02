/**
 * Payload conformance for declared `output.schema`s.
 *
 * The runtime validates every successful tool result against its declared schema
 * and throws `ToolOutputError` on a violation (`@deepseek-ai/dsh-tools`), so a
 * declared schema is load-bearing: too strict and the tool breaks in a live
 * session, too loose and the harness validates nothing. The census canary only
 * counts declarations — nothing previously checked a real payload against them,
 * which is why a schema/payload drift could only ever surface at runtime.
 *
 * This publishes three real fixtures (one dataset each, as the product is used),
 * captures every recipe-backed tool payload from real service entry points, and
 * validates each with the harness's OWN validator. The second test checks the
 * other direction: a strict schema must actually reject an undeclared top-level
 * key and a missing required one.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { downloadDestinationForSlug } from 'dsh-data-kaggle/download-job'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DuckdbAnalystService } from '../src/plugin-service.js'
import { registerDuckdbAnalystTools } from '../src/plugin-tools.js'

const VERSION = '1'
const RETAIL_SLUG = 'someone/retail'
const DUPLICATES_SLUG = 'someone/duplicates'
const ELAPSED_SLUG = 'someone/elapsed'

interface CapturedTool {
  name: string
  output: { schema: Record<string, unknown> }
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

function fakeToolsContext(captured: Map<string, CapturedTool>): Context {
  return {
    tools: {
      register: (definition: CapturedTool) => {
        captured.set(definition.name, definition)
      },
    },
  } as unknown as Context
}

/** Same snapshot the runtime validates: a JSON round-trip of the returned value. */
const snapshot = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-output-schema-'))
  await mkdir(join(directory, 'sources'), { recursive: true })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Publish one fixture file as its own dataset through the real tools. */
async function publishFixture(
  tools: Map<string, CapturedTool>,
  workspace: ReturnType<typeof resolveWorkspacePaths>,
  slug: string,
  relative: string,
  name: string,
  signal: AbortSignal,
): Promise<{ datasetId: string; tableId: string; columns: string[] }> {
  const destinationDir = downloadDestinationForSlug(workspace.sourcesDir, slug, VERSION)
  await mkdir(destinationDir, { recursive: true })
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(await readFile(fileURLToPath(new URL(relative, import.meta.url))), name)
  const path = join(destinationDir, 'source.zip')
  const writeStream = createWriteStream(path)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)

  const preview = (await tools
    .get('preview_ingest_source')!
    .execute({ slug, sourceVersion: VERSION }, { signal })) as {
    pinId: string
    datasetId: string
    tables?: Array<{ tableId: string; columns: Array<{ name: string }> }>
  }
  const store = new MetadataStore(workspace.catalogPath)
  try {
    store.setWorkspaceSourcePinStatus(
      preview.pinId,
      'approved',
      store.getWorkspaceSourcePin(preview.pinId)?.revision ?? 1,
    )
  } finally {
    store.close()
  }
  const ingest = (await tools.get('ingest_dataset')!.execute({ slug }, { signal })) as {
    jobId: string
    status: string
  }
  expect(ingest.status, `${slug} must publish`).toBe('ready')
  const table = preview.tables?.[0]
  expect(table, `${slug} must propose one table`).toBeTruthy()
  return {
    datasetId: preview.datasetId,
    tableId: table!.tableId,
    columns: table!.columns.map((column) => column.name),
  }
}

it('every captured payload satisfies the schema the runtime enforces', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const service = new DuckdbAnalystService(workspace)
  const tools = new Map<string, CapturedTool>()
  registerDuckdbAnalystTools(fakeToolsContext(tools), service)
  const signal = new AbortController().signal

  const retail = await publishFixture(
    tools,
    workspace,
    RETAIL_SLUG,
    '../../../tests/fixtures/retail.csv',
    'retail.csv',
    signal,
  )
  const duplicates = await publishFixture(
    tools,
    workspace,
    DUPLICATES_SLUG,
    '../../../tests/fixtures/dirty-data/full-row-duplicates.csv',
    'duplicates.csv',
    signal,
  )
  // A genuine integer elapsed-seconds column, so the interval and ratio tools are
  // exercised on data that means what they document.
  const elapsed = await publishFixture(
    tools,
    workspace,
    ELAPSED_SLUG,
    '../../../tests/fixtures/dirty-data/elapsed-intervals.csv',
    'elapsed.csv',
    signal,
  )
  expect(retail.columns).toContain('amount')
  expect(elapsed.columns).toContain('elapsed_seconds')
  expect(duplicates.columns).toContain('customer_id')

  const captured: Array<{ tool: string; payload: unknown }> = [
    {
      tool: 'find_duplicate_rows',
      payload: await tools
        .get('find_duplicate_rows')!
        .execute({ datasetId: duplicates.datasetId, table: duplicates.tableId }, { signal }),
    },
    {
      tool: 'bin_elapsed_intervals',
      payload: await tools.get('bin_elapsed_intervals')!.execute(
        {
          datasetId: elapsed.datasetId,
          table: elapsed.tableId,
          elapsedColumn: 'elapsed_seconds',
          widthSeconds: 3600,
        },
        { signal },
      ),
    },
    {
      tool: 'ratio_of_sums',
      payload: await tools.get('ratio_of_sums')!.execute(
        {
          datasetId: elapsed.datasetId,
          table: elapsed.tableId,
          numeratorColumn: 'amount',
          denominatorColumn: 'elapsed_seconds',
        },
        { signal },
      ),
    },
    {
      tool: 'describe_column',
      payload: await tools
        .get('describe_column')!
        .execute(
          { datasetId: retail.datasetId, table: retail.tableId, valueColumn: 'amount' },
          { signal },
        ),
    },
  ]

  for (const { tool, payload } of captured) {
    const schema = tools.get(tool)!.output.schema
    const violations = validateJsonSchemaValue(schema, snapshot(payload), 'value')
    // A violation here is exactly what would surface as a ToolOutputError mid-session.
    expect(violations, `${tool}: ${JSON.stringify(violations)}`).toEqual([])
  }

  // The recipes, not just the schemas: each must return its documented columns.
  const columnsOf = (tool: string): string[] =>
    (
      captured.find((entry) => entry.tool === tool)!.payload as { columns: Array<{ name: string }> }
    ).columns.map((column) => column.name)

  for (const name of [
    'total_count',
    'null_share',
    'min_value',
    'median_value',
    'distribution_precision',
  ]) {
    expect(columnsOf('describe_column'), `describe_column must return ${name}`).toContain(name)
  }
  for (const name of ['interval_index', 'row_count']) {
    expect(columnsOf('bin_elapsed_intervals'), `bin must return ${name}`).toContain(name)
  }

  service.dispose()
})

it('the strict top-level contract actually rejects drift', () => {
  const service = new DuckdbAnalystService(resolveWorkspacePaths(directory))
  const tools = new Map<string, CapturedTool>()
  registerDuckdbAnalystTools(fakeToolsContext(tools), service)

  const strictTools = [
    'dataset_status',
    'cancel_job',
    'get_metrics',
    'describe_column',
    'find_duplicate_rows',
    'bin_elapsed_intervals',
    'ratio_of_sums',
  ]
  for (const name of strictTools) {
    const schema = tools.get(name)!.output.schema
    // `defineTool` normalizes the declared spec: a per-property `required: true`
    // becomes a top-level `required` array, so accept either shape.
    const declared = Object.entries(schema.properties as Record<string, { required?: boolean }>)
      .filter(([, spec]) => spec.required === true)
      .map(([key]) => key)
    const required = Array.isArray(schema.required)
      ? [...(schema.required as string[]), ...declared]
      : declared
    expect(required.length, `${name} must require at least one field`).toBeGreaterThan(0)

    // An undeclared top-level key: the failure mode a loose schema would swallow.
    const extra = Object.fromEntries([...required.map((key) => [key, 'x']), ['notARealField', 1]])
    expect(
      validateJsonSchemaValue(schema, extra, 'value').length,
      `${name} extra key`,
    ).toBeGreaterThan(0)

    // A missing required field: what a renamed/removed payload key looks like.
    const missing = Object.fromEntries(required.slice(1).map((key) => [key, 'x']))
    expect(
      validateJsonSchemaValue(schema, missing, 'value').length,
      `${name} missing required`,
    ).toBeGreaterThan(0)
  }

  service.dispose()
})
