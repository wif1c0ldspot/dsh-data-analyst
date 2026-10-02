/**
 * Reviewed ingest coordinator against the synthetic retail fixture (no network).
 */
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveReviewedSource } from 'dsh-data-core/recipes/registry'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { downloadDestinationForSlug } from 'dsh-data-kaggle/download-job'
import { runReviewedIngest } from '../src/ingest-coordinator.js'

let directory: string
let archivePath: string

async function buildFixtureArchive(destination: string): Promise<string> {
  const fixtureCsvPath = fileURLToPath(
    new URL('../../../tests/fixtures/retail.csv', import.meta.url),
  )
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(await readFile(fixtureCsvPath), 'retail.csv')
  const path = join(destination, 'source.zip')
  const writeStream = createWriteStream(path)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return path
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-ingest-coord-'))
  await mkdir(join(directory, 'sources'), { recursive: true })
  archivePath = await buildFixtureArchive(directory)
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('publishes a fixture slug through the reviewed ingest coordinator', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const pin = resolveReviewedSource('test/fixture-retail')
  const result = await runReviewedIngest({
    slug: pin.slug,
    pin,
    workspace,
    kaggleExecutable: '/bin/false',
    localArchivePath: archivePath,
  })
  expect(result.status).toBe('ready')
  expect(result.datasetId).toBe('retail-fixture')
  expect(result.tables[0]?.rejectedRows).toBe(0)
  const store = new MetadataStore(workspace.catalogPath)
  try {
    expect(store.getCurrentDatasetVersion('retail-fixture')?.datasetVersionId).toBe(
      result.datasetVersionId,
    )
  } finally {
    store.close()
  }
})

it('rejects ingest without an explicit pin before download', async () => {
  const workspace = resolveWorkspacePaths(directory)
  await expect(
    runReviewedIngest({
      slug: 'owner/not-a-reviewed-dataset',
      pin: undefined as never,
      workspace,
      kaggleExecutable: '/bin/false',
    }),
  ).rejects.toThrow(/No analyst-approved workspace pin|Unsupported source/)
})

it('does not reuse a source archive cached under a different version', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const pin = resolveReviewedSource('test/fixture-retail')
  const staleDir = downloadDestinationForSlug(workspace.sourcesDir, 'test/fixture-retail', '2')
  await mkdir(staleDir, { recursive: true })
  await buildFixtureArchive(staleDir)
  await expect(
    runReviewedIngest({
      slug: pin.slug,
      pin,
      workspace,
      kaggleExecutable: '/bin/false',
    }),
  ).rejects.toThrow(/archive missing/)
  const pinnedDir = downloadDestinationForSlug(workspace.sourcesDir, 'test/fixture-retail', '1')
  await mkdir(pinnedDir, { recursive: true })
  await buildFixtureArchive(pinnedDir)
  expect(
    (
      await runReviewedIngest({
        slug: pin.slug,
        pin,
        workspace,
        kaggleExecutable: '/bin/false',
      })
    ).status,
  ).toBe('ready')
})
