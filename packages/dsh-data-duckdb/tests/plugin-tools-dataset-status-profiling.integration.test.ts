/**
 * `dataset_status` must surface
 * the per-table ingestion diagnostics (row-count breakdown, per-column
 * cast-null counts) that `ingest-pipeline.ts` already writes into the
 * published manifest, once the job reaches `ready` — not just `warnings`.
 * No network: mirrors `plugin-tools-preview-single-flight.integration.test.ts`'s
 * fixture-archive setup and tool-registration pattern.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { downloadDestinationForSlug } from 'dsh-data-kaggle/download-job'
import { DuckdbAnalystService } from '../src/plugin-service.js'
import { registerDuckdbAnalystTools } from '../src/plugin-tools.js'

const SLUG = 'someone/widgets'
const VERSION = '1'

let directory: string

async function buildFixtureArchive(destination: string): Promise<string> {
  const fixtureCsvPath = fileURLToPath(
    new URL('../../../tests/fixtures/propose-ingest/orders.csv', import.meta.url),
  )
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(await readFile(fixtureCsvPath), 'orders.csv')
  const path = join(destination, 'source.zip')
  const writeStream = createWriteStream(path)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return path
}

interface CapturedTool {
  name: string
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

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-dataset-status-profiling-'))
  await mkdir(join(directory, 'sources'), { recursive: true })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('exposes per-table row-count breakdown and cast-null counts once a job is ready', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const destinationDir = downloadDestinationForSlug(workspace.sourcesDir, SLUG, VERSION)
  await mkdir(destinationDir, { recursive: true })
  await buildFixtureArchive(destinationDir)

  const service = new DuckdbAnalystService(workspace)
  const tools = new Map<string, CapturedTool>()
  registerDuckdbAnalystTools(fakeToolsContext(tools), service)
  const previewTool = tools.get('preview_ingest_source')!
  const ingestTool = tools.get('ingest_dataset')!
  const statusTool = tools.get('dataset_status')!

  const preview = (await previewTool.execute(
    { slug: SLUG, sourceVersion: VERSION },
    { signal: new AbortController().signal },
  )) as { pinId: string; datasetId: string }

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

  const ingest = (await ingestTool.execute(
    { slug: SLUG },
    { signal: new AbortController().signal },
  )) as { jobId: string; status: string }
  expect(ingest.status).toBe('ready')

  const status = (await statusTool.execute(
    { jobId: ingest.jobId },
    { signal: new AbortController().signal },
  )) as {
    status: string
    profiling?: {
      tables: Array<{
        id: string
        rows: number
        rejectedRows: number
        sourceRowCount?: number
        rawRowCount?: number
        projectionRowCount?: number
        castNullCounts?: Record<string, number>
      }>
    }
  }

  expect(status.status).toBe('ready')
  expect(status.profiling?.tables).toEqual([
    {
      id: 'orders',
      rows: 4,
      rejectedRows: 0,
      sourceRowCount: 4,
      rawRowCount: 4,
      projectionRowCount: 4,
      castNullCounts: { region: 0, sales: 0 },
    },
  ])

  service.dispose()
})

it('omits profiling before the job reaches ready', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const store = new MetadataStore(workspace.catalogPath)
  let jobId: string
  try {
    const job = store.createImportJob({
      slug: SLUG,
      sourceVersion: VERSION,
      idempotencyKey: `${SLUG}:${VERSION}`,
    })
    jobId = job.jobId
  } finally {
    store.close()
  }

  const service = new DuckdbAnalystService(workspace)
  const tools = new Map<string, CapturedTool>()
  registerDuckdbAnalystTools(fakeToolsContext(tools), service)
  const statusTool = tools.get('dataset_status')!

  const status = (await statusTool.execute(
    { jobId },
    { signal: new AbortController().signal },
  )) as { status: string; profiling?: unknown }

  expect(status.status).toBe('queued')
  expect(status.profiling).toBeUndefined()

  service.dispose()
})
