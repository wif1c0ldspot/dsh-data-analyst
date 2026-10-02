/**
 * Defect 8: state-changing routes require Origin/Host browser trust boundary.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MetadataStore } from '../../dsh-data-core/src/metadata-store.js'
import type { DatasetManifest } from '../../dsh-data-core/src/contracts.js'
import { createWorkbenchServer } from '../src/server.js'

let directory: string
let port: number
let server: ReturnType<typeof createWorkbenchServer>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-wb-origin-'))
  await mkdir(join(directory, 'artifacts'), { recursive: true })
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

  server = createWorkbenchServer({
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
  port = address.port
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  await rm(directory, { recursive: true, force: true })
})

it('rejects cross-origin POST with 403', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/dataset/superstore/query`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Origin: 'http://evil.example',
    },
    body: 'sql=SELECT+1',
  })
  expect(res.status).toBe(403)
})

it('allows same-origin POST (may fail later, but not 403)', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/dataset/superstore/query`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Origin: `http://127.0.0.1:${port}`,
    },
    body: 'sql=SELECT+1',
  })
  expect(res.status).not.toBe(403)
})

it('allows loopback curl POST without Origin', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/dataset/superstore/save`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'sql=SELECT+1&resultId=res_missing',
  })
  expect(res.status).not.toBe(403)
})
