/**
 * Workbench POST /dataset/:id/ask with fixture generator + retail-fixture.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import * as yazl from 'yazl'
import { expect, it } from 'vitest'
import { RETAIL_FIXTURE_RECIPE } from '../../dsh-data-core/src/recipes/retail-fixture.js'
import { resolveWorkspacePaths } from '../../dsh-data-core/src/workspace-paths.js'
import { runIngestFromArchive } from '../../dsh-data-duckdb/src/ingest-pipeline.js'
import { createWorkbenchServer } from '../src/server.js'

async function buildFixtureArchive(destination: string): Promise<string> {
  const fixtureCsvPath = fileURLToPath(
    new URL('../../../tests/fixtures/retail.csv', import.meta.url),
  )
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(await readFile(fixtureCsvPath), 'retail.csv')
  const archivePath = join(destination, 'source.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return archivePath
}

it('POST /dataset/retail-fixture/ask returns fixture SQL preview and chart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wb-ask-'))
  const previousWorkspace = process.env.DSH_DATA_WORKSPACE
  const previousGenerator = process.env.DSH_NL_GENERATOR
  process.env.DSH_DATA_WORKSPACE = directory
  process.env.DSH_NL_GENERATOR = 'fixture'

  try {
    const datasetWorkspace = join(directory, 'workspaces', 'retail-fixture')
    await mkdir(join(datasetWorkspace, 'sources'), { recursive: true })
    const archivePath = await buildFixtureArchive(directory)
    await runIngestFromArchive({
      archivePath,
      workspaceDir: datasetWorkspace,
      catalogPath: join(directory, 'catalog.sqlite'),
      recipe: RETAIL_FIXTURE_RECIPE,
      slug: 'test/fixture-retail',
      sourceVersion: '1',
      idempotencyKey: 'workbench-ask-v1',
    })

    const workspace = resolveWorkspacePaths(directory)
    const server = createWorkbenchServer({ workspace })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')
    const origin = `http://127.0.0.1:${address.port}`

    try {
      const body = new URLSearchParams({ question: 'revenue by region' })
      const res = await fetch(`${origin}/dataset/retail-fixture/ask`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin,
        },
        body,
      })
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('SELECT region, SUM(amount) AS revenue FROM retail')
      expect(html).toContain('North')
      expect(html).toContain('Download PNG')
      expect(html).toMatch(/\/analyst\/artifacts\/art_[a-z0-9]+\/png/)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  } finally {
    if (previousWorkspace === undefined) delete process.env.DSH_DATA_WORKSPACE
    else process.env.DSH_DATA_WORKSPACE = previousWorkspace
    if (previousGenerator === undefined) delete process.env.DSH_NL_GENERATOR
    else process.env.DSH_NL_GENERATOR = previousGenerator
    await rm(directory, { recursive: true, force: true })
  }
})

it('POST /dataset/:id/chart changes mark without re-query', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wb-mark-'))
  const previousWorkspace = process.env.DSH_DATA_WORKSPACE
  process.env.DSH_DATA_WORKSPACE = directory

  try {
    const datasetWorkspace = join(directory, 'workspaces', 'retail-fixture')
    await mkdir(join(datasetWorkspace, 'sources'), { recursive: true })
    const archivePath = await buildFixtureArchive(directory)
    await runIngestFromArchive({
      archivePath,
      workspaceDir: datasetWorkspace,
      catalogPath: join(directory, 'catalog.sqlite'),
      recipe: RETAIL_FIXTURE_RECIPE,
      slug: 'test/fixture-retail',
      sourceVersion: '1',
      idempotencyKey: 'workbench-mark-v1',
    })

    const workspace = resolveWorkspacePaths(directory)
    const server = createWorkbenchServer({ workspace })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')
    const origin = `http://127.0.0.1:${address.port}`

    try {
      const queryRes = await fetch(`${origin}/dataset/retail-fixture/query`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin,
        },
        body: new URLSearchParams({
          sql: 'SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region ORDER BY revenue DESC, region',
          title: 'Revenue',
          x: 'region',
          y: 'revenue',
        }),
      })
      expect(queryRes.status).toBe(200)
      const queryHtml = await queryRes.text()
      const resultMatch = queryHtml.match(/result <code>(res_[a-z0-9]+)<\/code>/i)
      const artMatch = queryHtml.match(/\/analyst\/artifacts\/(art_[a-z0-9]+)\.svg/)
      expect(resultMatch?.[1]).toBeTruthy()
      expect(artMatch?.[1]).toBeTruthy()
      const resultId = resultMatch![1]!
      const firstArtifact = artMatch![1]!

      const chartRes = await fetch(`${origin}/dataset/retail-fixture/chart`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin,
        },
        body: new URLSearchParams({
          resultId,
          mark: 'line',
          title: 'Revenue',
          x: 'region',
          y: 'revenue',
          sql: 'SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region ORDER BY revenue DESC, region',
        }),
      })
      expect(chartRes.status).toBe(200)
      const chartHtml = await chartRes.text()
      expect(chartHtml).toMatch(/Mark refined to line without re-query/)
      expect(chartHtml).toMatch(/mark <code>line<\/code>/)
      const secondArt = chartHtml.match(/\/analyst\/artifacts\/(art_[a-z0-9]+)\.svg/)
      expect(secondArt?.[1]).toBeTruthy()
      expect(secondArt![1]).not.toBe(firstArtifact)
      expect(chartHtml).toContain(resultId)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  } finally {
    if (previousWorkspace === undefined) delete process.env.DSH_DATA_WORKSPACE
    else process.env.DSH_DATA_WORKSPACE = previousWorkspace
    await rm(directory, { recursive: true, force: true })
  }
})
