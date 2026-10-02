import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolveSafeArtifact } from '../src/artifact-path.js'
import { createWorkbenchServer } from '../src/server.js'
import { MetadataStore } from '../../dsh-data-core/src/metadata-store.js'
import type { DatasetManifest } from '../../dsh-data-core/src/contracts.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-workbench-'))
  process.env.DSH_DATA_WORKSPACE = directory
  await mkdir(join(directory, 'artifacts'), { recursive: true })
  await writeFile(
    join(directory, 'artifacts', 'art_demo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'utf8',
  )
  const store = new MetadataStore(join(directory, 'catalog.sqlite'))
  try {
    const manifest: DatasetManifest = {
      contractVersion: 1,
      datasetId: 'superstore',
      datasetVersionId: 'superstore-v1-test',
      source: {
        slug: 'test/superstore',
        version: '1',
        url: 'https://example.invalid',
        retrievedAt: new Date().toISOString(),
        license: null,
      },
      files: [],
      recipeHash: 'test',
      importerVersion: '0.1.0',
      tables: [{ id: 'orders', sourceFile: 'x.csv', rows: 1, rejectedRows: 0 }],
    }
    store.publishDatasetVersion(manifest)
  } finally {
    store.close()
  }
})

afterEach(async () => {
  delete process.env.DSH_DATA_WORKSPACE
  await rm(directory, { recursive: true, force: true })
})

it('rejects artifact path traversal', () => {
  expect(resolveSafeArtifact(join(directory, 'artifacts'), '../x.svg')).toBeNull()
})

it('serves the home page listing published datasets and artifact download route', async () => {
  const server = createWorkbenchServer({
    workspace: {
      root: directory,
      catalogPath: join(directory, 'catalog.sqlite'),
      resultsDir: join(directory, 'results'),
      artifactsDir: join(directory, 'artifacts'),
      analysesDir: join(directory, 'analyses'),
      sourcesDir: join(directory, 'sources'),
      datasetFile: () => join(directory, 'missing.duckdb'),
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  try {
    const home = await fetch(`http://127.0.0.1:${address.port}/`)
    expect(home.status).toBe(200)
    const html = await home.text()
    expect(html).toContain('superstore')
    expect(html).toContain('sem-workspace-')
    expect(html).toContain('/analyses')
    expect(html).toContain('/static/htmx.min.js')
    expect(html).toContain('hx-boost="true"')

    const htmx = await fetch(`http://127.0.0.1:${address.port}/static/htmx.min.js`)
    expect(htmx.status).toBe(200)
    expect(await htmx.text()).toContain('htmx')

    const deniedStatic = await fetch(
      `http://127.0.0.1:${address.port}/static/${encodeURIComponent('../package.json')}`,
    )
    expect(deniedStatic.status).toBe(400)

    const analyses = await fetch(`http://127.0.0.1:${address.port}/analyses`)
    expect(analyses.status).toBe(200)
    expect(await analyses.text()).toContain('Saved analyses')

    const art = await fetch(`http://127.0.0.1:${address.port}/analyst/artifacts/art_demo.svg`)
    expect(art.status).toBe(200)
    expect(await art.text()).toContain('<svg')

    const png = await fetch(`http://127.0.0.1:${address.port}/analyst/artifacts/art_demo/png`)
    expect(png.status).toBe(200)
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(png.headers.get('content-disposition')).toContain('art_demo.png')
    const pngBytes = Buffer.from(await png.arrayBuffer())
    expect(pngBytes.length).toBeGreaterThan(0)
    expect(pngBytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true)

    const imports = await fetch(`http://127.0.0.1:${address.port}/imports`)
    expect(imports.status).toBe(200)
    expect(await imports.text()).toContain('Import jobs')

    const denied = await fetch(
      `http://127.0.0.1:${address.port}/analyst/artifacts/${encodeURIComponent('../x.svg')}`,
    )
    expect(denied.status).toBe(400)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
