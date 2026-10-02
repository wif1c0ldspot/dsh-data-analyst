/**
 * Same-origin adaptation confirm: 403 cross-origin, publish/keep resume.
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { RETAIL_FIXTURE_RECIPE } from 'dsh-data-core/recipes/retail-fixture'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { runIngestFromArchive } from 'dsh-data-duckdb/ingest-pipeline'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { handleIngestAdaptConfirmRequest } from '../src/ingest-adapt-confirm.js'

let directory: string
let previousWorkspace: string | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-adapt-confirm-'))
  previousWorkspace = process.env.DSH_DATA_WORKSPACE
  process.env.DSH_DATA_WORKSPACE = directory
})

afterEach(async () => {
  if (previousWorkspace === undefined) delete process.env.DSH_DATA_WORKSPACE
  else process.env.DSH_DATA_WORKSPACE = previousWorkspace
  await rm(directory, { recursive: true, force: true })
})

async function pauseAdaptiveIngest(idempotencyKey: string): Promise<{
  jobId: string
  catalogPath: string
}> {
  const workspace = resolveWorkspacePaths(directory)
  const datasetWorkspace = join(workspace.root, 'workspaces', 'retail-fixture')
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(
    Buffer.from(
      'line_id,customer_id,order_date,region,amount\n' +
        '001,0007,2024-01-01,North,100.00\n' +
        '002,0008,2024-01-02,South,not-a-number\n' +
        '003,0007,2024-02-01,North,-20.00\n',
      'utf8',
    ),
    'retail.csv',
  )
  const archivePath = join(directory, `${idempotencyKey}.zip`)
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)

  const paused = await runIngestFromArchive({
    archivePath,
    workspaceDir: datasetWorkspace,
    catalogPath: workspace.catalogPath,
    recipe: {
      ...RETAIL_FIXTURE_RECIPE,
      recipeHash: `retail-adapt-${idempotencyKey}`,
      loadStrategy: 'raw_then_typed',
    },
    slug: 'test/fixture-retail',
    sourceVersion: idempotencyKey,
    idempotencyKey,
  })
  expect(paused.status).toBe('needs-input')
  return { jobId: paused.jobId, catalogPath: workspace.catalogPath }
}

it('rejects cross-origin confirm POST with 403', async () => {
  const { jobId, catalogPath } = await pauseAdaptiveIngest('cross-origin')
  const response = await handleIngestAdaptConfirmRequest(
    new Request('http://127.0.0.1:3080/api/analyst/ingest-adapt/confirm', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3080',
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jobId, action: 'publish' }),
    }),
    catalogPath,
    directory,
  )
  expect(response.status).toBe(403)
})

it('publishes on trusted confirm', async () => {
  const { jobId, catalogPath } = await pauseAdaptiveIngest('publish')
  const publish = await handleIngestAdaptConfirmRequest(
    new Request('http://127.0.0.1:3080/api/analyst/ingest-adapt/confirm', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3080',
        origin: 'http://127.0.0.1:3080',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jobId, action: 'publish' }),
    }),
    catalogPath,
    directory,
  )
  expect(publish.status).toBe(200)
  const published = (await publish.json()) as { status: string; datasetVersionId: string }
  expect(published.status).toBe('ready')
  expect(published.datasetVersionId).toBeTruthy()
})

it('cancels on keep staging', async () => {
  const { jobId, catalogPath } = await pauseAdaptiveIngest('keep')
  const keep = await handleIngestAdaptConfirmRequest(
    new Request('http://127.0.0.1:3080/api/analyst/ingest-adapt/confirm', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3080',
        origin: 'http://127.0.0.1:3080',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jobId, action: 'keep' }),
    }),
    catalogPath,
    directory,
  )
  expect(keep.status).toBe(200)
  expect(((await keep.json()) as { status: string }).status).toBe('cancelled')
})
