/**
 * Important 3 review: `preview_ingest_source` must refuse a concurrent
 * preview of the same slug, the same single-flight pattern `ingest_dataset`
 * already uses (`slug:${slug}` via `DuckdbAnalystService.createJobController`).
 * No network: the fixture archive is pre-placed exactly where a completed
 * Kaggle download would land it, mirroring
 * `preview-ingest.integration.test.ts`'s `localArchivePath`-free case.
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
  directory = await mkdtemp(join(tmpdir(), 'dsh-preview-single-flight-'))
  await mkdir(join(directory, 'sources'), { recursive: true })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('refuses a concurrent preview_ingest_source call for the same slug', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const destinationDir = downloadDestinationForSlug(workspace.sourcesDir, SLUG, VERSION)
  await mkdir(destinationDir, { recursive: true })
  await buildFixtureArchive(destinationDir)

  const service = new DuckdbAnalystService(workspace)
  const tools = new Map<string, CapturedTool>()
  registerDuckdbAnalystTools(fakeToolsContext(tools), service)
  const previewTool = tools.get('preview_ingest_source')
  expect(previewTool).toBeDefined()

  // Neither call awaited yet: the first call's synchronous
  // `createJobController` (before its first `await`) must register the
  // single-flight key before the second call's body ever runs.
  const first = previewTool!.execute(
    { slug: SLUG, sourceVersion: VERSION },
    { signal: new AbortController().signal },
  )
  await expect(
    previewTool!.execute(
      { slug: SLUG, sourceVersion: VERSION },
      { signal: new AbortController().signal },
    ),
  ).rejects.toThrow(/already running/)

  await expect(first).resolves.toBeDefined()
  service.dispose()
})

it('allows a second preview of the same slug once the first has finished', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const destinationDir = downloadDestinationForSlug(workspace.sourcesDir, SLUG, VERSION)
  await mkdir(destinationDir, { recursive: true })
  await buildFixtureArchive(destinationDir)

  const service = new DuckdbAnalystService(workspace)
  const tools = new Map<string, CapturedTool>()
  registerDuckdbAnalystTools(fakeToolsContext(tools), service)
  const previewTool = tools.get('preview_ingest_source')!

  const firstResult = (await previewTool.execute(
    { slug: SLUG, sourceVersion: VERSION },
    { signal: new AbortController().signal },
  )) as { pinId?: string }
  expect(firstResult.pinId).toMatch(/^pin_/)

  // The single-flight key was released when the first call finished — a
  // second preview of the same slug must not be refused.
  await expect(
    previewTool.execute(
      { slug: SLUG, sourceVersion: VERSION },
      { signal: new AbortController().signal },
    ),
  ).resolves.toBeDefined()

  service.dispose()
})
