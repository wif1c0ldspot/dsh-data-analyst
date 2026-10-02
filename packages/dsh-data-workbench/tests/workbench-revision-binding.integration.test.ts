/**
 * Defect 7: export/save must bind to the stored result revision, not the
 * catalog's current pointer, and must verify artifact sidecar resultId.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  directory = await mkdtemp(join(tmpdir(), 'dsh-wb-rev-'))
  process.env.DSH_DATA_WORKSPACE = directory
  await mkdir(join(directory, 'artifacts'), { recursive: true })
  await mkdir(join(directory, 'results'), { recursive: true })

  const store = new MetadataStore(join(directory, 'catalog.sqlite'))
  try {
    const oldManifest: DatasetManifest = {
      contractVersion: 1,
      datasetId: 'superstore',
      datasetVersionId: 'superstore-v1-old',
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
    const newManifest: DatasetManifest = {
      ...oldManifest,
      datasetVersionId: 'superstore-v1-current',
      source: { ...oldManifest.source, version: '2' },
    }
    store.publishDatasetVersion(oldManifest)
    store.publishDatasetVersion(newManifest)
  } finally {
    store.close()
  }

  await writeFile(
    join(directory, 'results', 'res_bound123.json'),
    JSON.stringify({
      resultId: 'res_bound123',
      datasetVersionId: 'superstore-v1-old',
      semanticRevisionId: 'sem-superstore-v1',
      sql: 'SELECT region FROM orders',
      columns: [{ name: 'region', logicalType: 'VARCHAR' }],
      preview: [['West']],
      rows: [['West'], ['=1+1']],
      rowCount: 2,
      previewTruncated: false,
      warnings: [],
    }),
    'utf8',
  )
  await writeFile(
    join(directory, 'artifacts', 'art_bound123.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'utf8',
  )
  await writeFile(
    join(directory, 'artifacts', 'art_bound123.json'),
    JSON.stringify({ artifactId: 'art_bound123', resultId: 'res_bound123' }),
    'utf8',
  )
  await writeFile(
    join(directory, 'artifacts', 'art_mismatch.json'),
    JSON.stringify({ artifactId: 'art_mismatch', resultId: 'res_other' }),
    'utf8',
  )
  await writeFile(
    join(directory, 'artifacts', 'art_mismatch.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'utf8',
  )

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
  delete process.env.DSH_DATA_WORKSPACE
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  await rm(directory, { recursive: true, force: true })
})

it('export uses datasetVersionId from stored result, not current catalog pointer', async () => {
  const res = await fetch(
    `http://127.0.0.1:${port}/dataset/superstore/export?resultId=res_bound123&artifactId=art_bound123&title=Bound`,
  )
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toContain('superstore-v1-old')
  expect(html).not.toContain('superstore-v1-current')
})

it('CSV export uses full authorized rows with spreadsheet-safe escaping', async () => {
  const res = await fetch(
    `http://127.0.0.1:${port}/dataset/superstore/export.csv?resultId=res_bound123`,
  )
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toMatch(/text\/csv/)
  const csv = await res.text()
  expect(csv).toContain('region')
  expect(csv).toContain('West')
  expect(csv).toContain("'=1+1")
})

it('export rejects artifact whose sidecar resultId does not match', async () => {
  const res = await fetch(
    `http://127.0.0.1:${port}/dataset/superstore/export?resultId=res_bound123&artifactId=art_mismatch&title=Bad`,
  )
  expect(res.status).toBe(400)
})

it('save reloads SQL and version ids from result JSON, ignoring client SQL', async () => {
  const body = new URLSearchParams({
    sql: 'SELECT 1 -- malicious client sql',
    resultId: 'res_bound123',
    artifactId: 'art_bound123',
    title: 'Saved bound',
    question: 'Revenue',
  })
  const res = await fetch(`http://127.0.0.1:${port}/dataset/superstore/save`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Origin: `http://127.0.0.1:${port}`,
    },
    body,
  })
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toMatch(/Saved ana_/)

  const { listAnalysisRevisions } = await import('../../dsh-data-core/src/analysis-store.js')
  const listed = await listAnalysisRevisions(join(directory, 'catalog.sqlite'))
  expect(listed).toHaveLength(1)
  expect(listed[0]!.query.sql).toBe('SELECT region FROM orders')
  expect(listed[0]!.datasetVersionId).toBe('superstore-v1-old')
  expect(listed[0]!.semanticRevisionId).toBe('sem-superstore-v1')
})

it('save rejects artifact sidecar that references a different resultId', async () => {
  const body = new URLSearchParams({
    sql: 'SELECT region FROM orders',
    resultId: 'res_bound123',
    artifactId: 'art_mismatch',
    title: 'Bad save',
  })
  const res = await fetch(`http://127.0.0.1:${port}/dataset/superstore/save`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Origin: `http://127.0.0.1:${port}`,
    },
    body,
  })
  expect(res.status).toBe(400)
})
