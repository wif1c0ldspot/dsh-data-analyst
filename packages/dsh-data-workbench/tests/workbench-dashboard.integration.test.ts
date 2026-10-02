/**
 * P2: dashboard pin, feedback submit, alias propose/approve with Origin trust.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { saveAnalysisRevision } from '../../dsh-data-core/src/analysis-store.js'
import type { DatasetManifest } from '../../dsh-data-core/src/contracts.js'
import { MetadataStore } from '../../dsh-data-core/src/metadata-store.js'
import { createWorkbenchServer } from '../src/server.js'

let directory: string
let port: number
let server: ReturnType<typeof createWorkbenchServer>
let analysisId: string
let catalogPath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-wb-dash-'))
  catalogPath = join(directory, 'catalog.sqlite')
  await mkdir(join(directory, 'artifacts'), { recursive: true })
  await writeFile(
    join(directory, 'artifacts', 'art_pin.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><text>chart</text></svg>',
    'utf8',
  )

  const store = new MetadataStore(catalogPath)
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

  const saved = await saveAnalysisRevision(catalogPath, {
    datasetVersionId: 'superstore-v1-test',
    semanticRevisionId: 'sem-superstore-v1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'superstore-v1-test',
      semanticRevisionId: 'sem-superstore-v1',
      sql: 'SELECT region FROM orders',
      parameters: [],
    },
    resultId: 'res_pin',
    chart: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    artifactIds: ['art_pin'],
  })
  analysisId = saved.analysisId

  server = createWorkbenchServer({
    workspace: {
      root: directory,
      catalogPath,
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

function originHeaders(): Record<string, string> {
  return {
    'content-type': 'application/x-www-form-urlencoded',
    Origin: `http://127.0.0.1:${port}`,
  }
}

it('creates a dashboard, pins an analysis, and renders chart cards', async () => {
  const home = await fetch(`http://127.0.0.1:${port}/`)
  const homeHtml = await home.text()
  expect(homeHtml).toContain('/dashboard')
  expect(homeHtml).toContain('/aliases')

  const createRes = await fetch(`http://127.0.0.1:${port}/dashboard/create`, {
    method: 'POST',
    headers: originHeaders(),
    body: new URLSearchParams({ title: 'Ops board' }).toString(),
    redirect: 'manual',
  })
  expect(createRes.status).not.toBe(403)
  expect([200, 302, 303]).toContain(createRes.status)

  const dashPage = await fetch(`http://127.0.0.1:${port}/dashboard`)
  expect(dashPage.status).toBe(200)
  let dashHtml = await dashPage.text()
  expect(dashHtml).toContain('Ops board')

  const store = new MetadataStore(catalogPath)
  let dashboards
  try {
    dashboards = store.listDashboards()
  } finally {
    store.close()
  }
  expect(dashboards).toHaveLength(1)
  const dashboardId = dashboards[0]!.dashboardId

  const pinRes = await fetch(`http://127.0.0.1:${port}/dashboard/${dashboardId}/pin`, {
    method: 'POST',
    headers: originHeaders(),
    body: new URLSearchParams({
      analysisId,
      revision: '1',
      title: 'West revenue',
    }).toString(),
  })
  expect(pinRes.status).not.toBe(403)
  expect(pinRes.status).toBe(200)
  dashHtml = await pinRes.text()
  expect(dashHtml).toContain('West revenue')
  expect(dashHtml).toContain('art_pin')
  expect(dashHtml).toMatch(/shared filter/i)

  const analysisPin = await fetch(`http://127.0.0.1:${port}/analyses/${analysisId}`, {
    method: 'POST',
    headers: originHeaders(),
    body: new URLSearchParams({
      action: 'pin',
      dashboardId,
      title: 'From analysis page',
    }).toString(),
  })
  // Pin from analysis page may be a dedicated form posting to /dashboard/:id/pin
  // or an analysis-page action — either path must accept Origin trust.
  expect([200, 302, 303, 404]).toContain(analysisPin.status)
})

it('submits feedback from the analysis page with Origin trust', async () => {
  const denied = await fetch(`http://127.0.0.1:${port}/analyses/${analysisId}/feedback`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Origin: 'http://evil.example',
    },
    body: new URLSearchParams({
      kind: 'vote',
      comment: 'Looks good',
    }).toString(),
  })
  expect(denied.status).toBe(403)

  const ok = await fetch(`http://127.0.0.1:${port}/analyses/${analysisId}/feedback`, {
    method: 'POST',
    headers: originHeaders(),
    body: new URLSearchParams({
      kind: 'preference',
      comment: 'Prefer stacked bars',
    }).toString(),
  })
  expect(ok.status).toBe(200)
  expect(await ok.text()).toMatch(/feedback|Prefer stacked/i)

  const store = new MetadataStore(catalogPath)
  try {
    const listed = store.listFeedback(analysisId)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.kind).toBe('preference')
    expect(listed[0]?.actorId).toBe('operator-local')
    expect(listed[0]?.status).toBe('candidate')
  } finally {
    store.close()
  }
})

it('lists semantics aliases, proposes a candidate, and approves it', async () => {
  const seed = new MetadataStore(catalogPath)
  try {
    const revenue = seed.createAliasCandidate({
      datasetId: 'superstore',
      term: 'revenue',
      expression: 'SUM(sales)',
      description: 'Gross sales',
      tableId: 'orders',
      actorId: 'analyst-test',
    })
    seed.setAliasCandidateStatus(revenue.candidateId, 'approved')
  } finally {
    seed.close()
  }

  const page = await fetch(`http://127.0.0.1:${port}/aliases`)
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain('revenue')
  expect(html).toMatch(/sem-workspace-|Current semantics/i)
  expect(html).toMatch(/approved/i)

  const proposeDenied = await fetch(`http://127.0.0.1:${port}/aliases/propose`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Origin: 'http://evil.example',
    },
    body: new URLSearchParams({
      datasetId: 'superstore',
      term: 'margin',
      expression: 'SUM(profit)/NULLIF(SUM(sales),0)',
      description: 'Margin ratio',
      tableId: 'orders',
    }).toString(),
  })
  expect(proposeDenied.status).toBe(403)

  const propose = await fetch(`http://127.0.0.1:${port}/aliases/propose`, {
    method: 'POST',
    headers: originHeaders(),
    body: new URLSearchParams({
      datasetId: 'superstore',
      term: 'margin',
      expression: 'SUM(profit)/NULLIF(SUM(sales),0)',
      description: 'Margin ratio',
      tableId: 'orders',
    }).toString(),
  })
  expect(propose.status).toBe(200)
  const proposeHtml = await propose.text()
  expect(proposeHtml).toContain('margin')

  const store = new MetadataStore(catalogPath)
  let candidateId: string
  try {
    const candidates = store.listAliasCandidates('superstore', 'candidate')
    expect(candidates).toHaveLength(1)
    candidateId = candidates[0]!.candidateId
    expect(candidates[0]!.actorId).toBe('operator-local')
  } finally {
    store.close()
  }

  const approve = await fetch(`http://127.0.0.1:${port}/aliases/${candidateId}/status`, {
    method: 'POST',
    headers: originHeaders(),
    body: new URLSearchParams({ status: 'approved' }).toString(),
  })
  expect(approve.status).toBe(200)
  const approveHtml = await approve.text()
  expect(approveHtml).toContain('approved')
  // Approved overlay is runtime-effective (revision id bump + term in current table).
  expect(approveHtml).toMatch(/sem-workspace-.+\+aliases\./)
  expect(approveHtml).toContain('margin')

  const store2 = new MetadataStore(catalogPath)
  try {
    expect(store2.listAliasCandidates('superstore', 'approved')).toHaveLength(2)
  } finally {
    store2.close()
  }
})

it('rejects cross-origin dashboard create with 403', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/dashboard/create`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Origin: 'http://evil.example',
    },
    body: 'title=Evil',
  })
  expect(res.status).toBe(403)
})
