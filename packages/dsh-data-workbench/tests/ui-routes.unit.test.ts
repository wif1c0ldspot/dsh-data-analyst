import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { saveAnalysisRevision } from 'dsh-data-core/analysis-store'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import {
  handleAnalysisFragmentRequest,
  handleDashboardFragmentRequest,
  handleDashboardFilterKeysRequest,
  handleDashboardFilterRequest,
  handleDashboardPinRequest,
  handleAnalysisExportRequest,
} from '../src/ui-routes.js'

let directory: string
let analysisId: string
let analysisRevision: number
let dashboardId: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-ui-fragments-'))
  const catalogPath = join(directory, 'catalog.sqlite')
  const analysis = await saveAnalysisRevision(catalogPath, {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'result_1',
    chart: { mark: 'bar', title: 'Sales', x: 'region', y: 'sales' },
    artifactIds: ['artifact_1'],
  })
  analysisId = analysis.analysisId
  analysisRevision = analysis.revision
  const store = new MetadataStore(catalogPath)
  try {
    dashboardId = store.saveDashboard({
      title: 'Revenue',
      layout: {
        slots: [{ analysisId, revision: analysisRevision, title: 'Revenue', sharedFilterKeys: [] }],
      },
    }).dashboardId
  } finally {
    store.close()
  }
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function trustedRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { host: 'localhost', 'sec-fetch-site': 'same-origin' },
  })
}

function pinRequest(
  path: string,
  expectedVersion: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      host: 'localhost',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ expectedVersion, ...body }),
  })
}

function filterRequest(
  path: string,
  expectedVersion: string,
  body: Record<string, unknown> = { expectedVersion, column: 'region', value: 'North' },
): Request {
  // callers should include dashboardId; default kept for shape
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      host: 'localhost',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function postJson(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      host: 'localhost',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

it('returns 403 when the analysis browser request is not trusted', async () => {
  const response = await handleAnalysisFragmentRequest(
    new Request(`http://localhost/api/analyst/ui/analysis?analysisId=${analysisId}`, {
      headers: { host: 'localhost', 'sec-fetch-site': 'cross-site' },
    }),
    join(directory, 'catalog.sqlite'),
  )
  expect(response.status).toBe(403)
})

it('returns 403 when the dashboard browser request is not trusted', async () => {
  const response = await handleDashboardFragmentRequest(
    new Request(`http://localhost/api/analyst/ui/dashboard?dashboardId=${dashboardId}`, {
      headers: { host: 'localhost', 'sec-fetch-site': 'cross-site' },
    }),
    join(directory, 'catalog.sqlite'),
  )
  expect(response.status).toBe(403)
})

it('returns 404 when the workspace catalog is missing', async () => {
  const missingCatalog = join(directory, 'missing-catalog.sqlite')
  const analysisResponse = await handleAnalysisFragmentRequest(
    trustedRequest(`/api/analyst/ui/analysis?analysisId=${analysisId}`),
    missingCatalog,
  )
  expect(analysisResponse.status).toBe(404)
  expect(await analysisResponse.text()).toContain('unavailable')

  const dashboardResponse = await handleDashboardFragmentRequest(
    trustedRequest(`/api/analyst/ui/dashboard?dashboardId=${dashboardId}`),
    missingCatalog,
  )
  expect(dashboardResponse.status).toBe(404)
  expect(await dashboardResponse.text()).toContain('unavailable')
})

it('returns 400 for a malformed analysis id', async () => {
  const response = await handleAnalysisFragmentRequest(
    trustedRequest('/api/analyst/ui/analysis?analysisId=not-an-analysis'),
    join(directory, 'catalog.sqlite'),
  )
  expect(response.status).toBe(400)
})

it('returns 404 for a well-formed unknown analysis id', async () => {
  const response = await handleAnalysisFragmentRequest(
    trustedRequest('/api/analyst/ui/analysis?analysisId=ana_deadbeef00000000'),
    join(directory, 'catalog.sqlite'),
  )
  expect(response.status).toBe(404)
})

it('returns 404 for an unknown dashboard id', async () => {
  const response = await handleDashboardFragmentRequest(
    trustedRequest('/api/analyst/ui/dashboard?dashboardId=dash_0000000000000000'),
    join(directory, 'catalog.sqlite'),
  )
  expect(response.status).toBe(404)
})

it('degrades dashboard cards when a slot analysis id is invalid', async () => {
  const catalogPath = join(directory, 'catalog.sqlite')
  const store = new MetadataStore(catalogPath)
  let corruptDashboardId: string
  try {
    corruptDashboardId = store.saveDashboard({
      title: 'Mixed slots',
      layout: {
        slots: [
          { analysisId, revision: analysisRevision, title: 'Good card', sharedFilterKeys: [] },
          { analysisId: 'not-valid', revision: 1, title: 'Bad card', sharedFilterKeys: [] },
        ],
      },
    }).dashboardId
  } finally {
    store.close()
  }

  const response = await handleDashboardFragmentRequest(
    trustedRequest(`/api/analyst/ui/dashboard?dashboardId=${corruptDashboardId}`),
    catalogPath,
  )
  expect(response.status).toBe(200)
  const html = await response.text()
  expect(html).toContain('Revenue by region')
  expect(html).toContain('Bad card')
  expect(html).toContain('Analysis unavailable')
})

it('returns a trusted analysis fragment with its version header', async () => {
  const response = await handleAnalysisFragmentRequest(
    trustedRequest(`/api/analyst/ui/analysis?analysisId=${analysisId}`),
    join(directory, 'catalog.sqlite'),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('X-Analyst-Resource-Version')).toBe('1')
  expect(await response.text()).toContain('Revenue by region')
})

it('returns a trusted dashboard fragment with its version header', async () => {
  const response = await handleDashboardFragmentRequest(
    trustedRequest(`/api/analyst/ui/dashboard?dashboardId=${dashboardId}`),
    join(directory, 'catalog.sqlite'),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('X-Analyst-Resource-Version')).toBeTruthy()
  expect(await response.text()).toContain('Revenue')
})

it('rejects a stale dashboard pin with the current dashboard fragment', async () => {
  const response = await handleDashboardPinRequest(
    pinRequest(`/api/analyst/ui/dashboard/pin`, 'stale', { dashboardId, analysisId: 'ana_newpin' }),
    join(directory, 'catalog.sqlite'),
  )

  expect(response.status).toBe(409)
  expect(response.headers.get('X-Analyst-Resource-Version')).toBeTruthy()
  const html = await response.text()
  expect(html).toContain(`data-dashboard-id="${dashboardId}"`)
  expect(html).toContain('Revenue')
})

it('pins an analysis to a dashboard and advances the dashboard version', async () => {
  const catalogPath = join(directory, 'catalog.sqlite')
  const before = await handleDashboardFragmentRequest(
    trustedRequest(`/api/analyst/ui/dashboard?dashboardId=${dashboardId}`),
    catalogPath,
  )
  const expectedVersion = before.headers.get('X-Analyst-Resource-Version')!

  const response = await handleDashboardPinRequest(
    pinRequest(`/api/analyst/ui/dashboard/pin`, expectedVersion, { dashboardId, analysisId }),
    catalogPath,
  )

  expect(response.status).toBe(200)
  expect(response.headers.get('X-Analyst-Resource-Version')).not.toBe(expectedVersion)
  expect(await response.text()).toContain(`data-dashboard-id="${dashboardId}"`)
})

it('rejects an untrusted dashboard pin', async () => {
  const response = await handleDashboardPinRequest(
    pinRequest(
      `/api/analyst/ui/dashboard/pin`,
      '1',
      { dashboardId, analysisId },
      {
        'sec-fetch-site': 'cross-site',
      },
    ),
    join(directory, 'catalog.sqlite'),
  )
  expect(response.status).toBe(403)
})

it('rejects a dashboard pin with an invalid body', async () => {
  const response = await handleDashboardPinRequest(
    new Request(`http://localhost/api/analyst/ui/dashboard/pin`, {
      method: 'POST',
      headers: {
        host: 'localhost',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1, dashboardId, analysisId }),
    }),
    join(directory, 'catalog.sqlite'),
  )
  expect(response.status).toBe(400)
})

it('rejects a dashboard filter with an invalid body', async () => {
  const response = await handleDashboardFilterRequest(
    filterRequest(`/api/analyst/ui/dashboard/filter`, '1', {
      expectedVersion: '1',
      dashboardId,
      column: '',
      value: 'North',
    }),
    join(directory, 'catalog.sqlite'),
  )
  expect(response.status).toBe(400)
})

it('publishes a dashboard filter while disclosing unsupported slots', async () => {
  const catalogPath = join(directory, 'catalog.sqlite')
  const before = await handleDashboardFragmentRequest(
    trustedRequest(`/api/analyst/ui/dashboard?dashboardId=${dashboardId}`),
    catalogPath,
  )
  const expectedVersion = before.headers.get('X-Analyst-Resource-Version')!
  const response = await handleDashboardFilterRequest(
    filterRequest(`/api/analyst/ui/dashboard/filter`, expectedVersion, {
      expectedVersion,
      dashboardId,
      column: 'region',
      value: 'North',
    }),
    catalogPath,
  )
  expect(response.status).toBe(200)
  const html = await response.text()
  expect(html).toContain('unsupported')
  expect(html).toContain('Active filter:')
  expect(html).toContain('Scope: saved result rows')
  expect(html).toContain('Clear shared filter')

  const nextVersion = response.headers.get('X-Analyst-Resource-Version')!
  const cleared = await handleDashboardFilterRequest(
    filterRequest(`/api/analyst/ui/dashboard/filter`, nextVersion, {
      expectedVersion: nextVersion,
      dashboardId,
      operation: 'clear',
    }),
    catalogPath,
  )
  expect(cleared.status).toBe(200)
  expect(await cleared.text()).not.toContain('Active filter:')
  const store = new MetadataStore(catalogPath)
  try {
    expect(store.loadDashboard(dashboardId)?.activeFilter).toBeUndefined()
  } finally {
    store.close()
  }
})

it('maps dashboard slot filter keys and advances the dashboard version', async () => {
  const catalogPath = join(directory, 'catalog.sqlite')
  const before = await handleDashboardFragmentRequest(
    trustedRequest(`/api/analyst/ui/dashboard?dashboardId=${dashboardId}`),
    catalogPath,
  )
  const expectedVersion = before.headers.get('X-Analyst-Resource-Version')!
  const response = await handleDashboardFilterKeysRequest(
    postJson(`/api/analyst/ui/dashboard/map-keys`, {
      expectedVersion,
      dashboardId,
      analysisId,
      keys: ['region', 'segment'],
    }),
    catalogPath,
  )

  expect(response.status).toBe(200)
  expect(response.headers.get('X-Analyst-Resource-Version')).not.toBe(expectedVersion)
  expect(await response.text()).toContain('region')
  const store = new MetadataStore(catalogPath)
  try {
    expect(store.loadDashboard(dashboardId)?.layout.slots[0]?.sharedFilterKeys).toEqual([
      'region',
      'segment',
    ])
  } finally {
    store.close()
  }
})

it('rejects a stale dashboard slot filter mapping with the current fragment', async () => {
  const response = await handleDashboardFilterKeysRequest(
    postJson(`/api/analyst/ui/dashboard/map-keys`, {
      expectedVersion: 'stale',
      dashboardId,
      analysisId,
      keys: ['region'],
    }),
    join(directory, 'catalog.sqlite'),
  )

  expect(response.status).toBe(409)
  expect(response.headers.get('X-Analyst-Resource-Version')).toBeTruthy()
  const html = await response.text()
  expect(html).toContain(`data-dashboard-id="${dashboardId}"`)

  const store = new MetadataStore(join(directory, 'catalog.sqlite'))
  try {
    expect(store.loadDashboard(dashboardId)?.layout.slots[0]?.sharedFilterKeys).toEqual([])
  } finally {
    store.close()
  }
})

it('returns 404 when mapping filter keys onto an analysis that is not pinned', async () => {
  const catalogPath = join(directory, 'catalog.sqlite')
  const before = await handleDashboardFragmentRequest(
    trustedRequest(`/api/analyst/ui/dashboard?dashboardId=${dashboardId}`),
    catalogPath,
  )
  const response = await handleDashboardFilterKeysRequest(
    postJson(`/api/analyst/ui/dashboard/map-keys`, {
      expectedVersion: before.headers.get('X-Analyst-Resource-Version')!,
      dashboardId,
      analysisId: 'ana_notpinned00000000',
      keys: ['region'],
    }),
    catalogPath,
  )
  expect(response.status).toBe(404)
})

it('returns 400 for a malformed dashboard id instead of decoding it blindly', async () => {
  const catalogPath = join(directory, 'catalog.sqlite')
  const fragment = await handleDashboardFragmentRequest(
    trustedRequest('/api/analyst/ui/dashboard?dashboardId=not-a-dashboard'),
    catalogPath,
  )
  expect(fragment.status).toBe(400)

  // `%zz` is not a valid percent-encoding: a bare decodeURIComponent throws
  // here, so this must surface as a rejected id, never a 500.
  const badEncoding = await handleDashboardFilterKeysRequest(
    postJson(`/api/analyst/ui/dashboard/map-keys`, {
      expectedVersion: '1',
      dashboardId: '%zz',
      analysisId,
      keys: ['region'],
    }),
    catalogPath,
  )
  expect(badEncoding.status).toBe(400)

  const badPin = await handleDashboardPinRequest(
    pinRequest(`/api/analyst/ui/dashboard/pin`, '1', { dashboardId: '%zz', analysisId }),
    catalogPath,
  )
  expect(badPin.status).toBe(400)
})

it('does not leak workspace paths in an export failure body', async () => {
  const catalogPath = join(directory, 'catalog.sqlite')
  // Well-formed ids that pass validation, but no result/artifact file was
  // ever written — the export packer fails with a path-bearing `fs` error.
  const orphan = await saveAnalysisRevision(catalogPath, {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Missing files',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_missing1',
    chart: { mark: 'bar', title: 'Missing', x: 'region', y: 'sales' },
    artifactIds: ['art_missing1'],
  })

  const response = await handleAnalysisExportRequest(
    postJson(`/api/analyst/ui/analysis/export`, { analysisId: orphan.analysisId }),
    catalogPath,
  )

  expect(response.status).toBe(500)
  const body = await response.text()
  expect(body).not.toContain(directory)
  expect(body).toContain('[redacted]')
})

it('exports an analysis without bumping its revision', async () => {
  const catalogPath = join(directory, 'catalog.sqlite')
  const exportResultId = 'res_export1'
  const exportArtifactId = 'art_export1'
  const exportAnalysis = await saveAnalysisRevision(catalogPath, {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Export revenue',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: exportResultId,
    chart: { mark: 'bar', title: 'Export', x: 'region', y: 'sales' },
    artifactIds: [exportArtifactId],
  })
  await mkdir(join(directory, 'results'), { recursive: true })
  await mkdir(join(directory, 'artifacts'), { recursive: true })
  await writeFile(
    join(directory, 'results', `${exportResultId}.json`),
    JSON.stringify({
      resultId: exportResultId,
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      columns: [{ name: 'region', logicalType: 'VARCHAR' }],
      preview: [['North']],
      rows: [['North']],
      rowCount: 1,
      previewTruncated: false,
    }),
  )
  await writeFile(
    join(directory, 'artifacts', `${exportArtifactId}.json`),
    JSON.stringify({
      resultId: exportResultId,
      intent: exportAnalysis.chart,
      vegaLiteSpec: { mark: 'bar' },
    }),
  )
  await writeFile(
    join(directory, 'artifacts', `${exportArtifactId}.svg`),
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>',
  )

  const response = await handleAnalysisExportRequest(
    postJson(`/api/analyst/ui/analysis/export`, {
      analysisId: exportAnalysis.analysisId,
      template: 'comparison',
      expectedRevision: exportAnalysis.revision,
    }),
    catalogPath,
  )

  expect(response.status).toBe(200)
  expect(response.headers.get('X-Analyst-Resource-Version')).toBeNull()
  const fragment = await response.text()
  const filename = fragment.match(/file=(export_[^"]+\.html)/)?.[1]
  expect(filename).toBeDefined()
  const html = await readFile(join(directory, 'artifacts', filename!), 'utf8')
  expect(html).toContain('data-report-template="comparison"')
  const store = new MetadataStore(catalogPath)
  try {
    expect(store.loadAnalysisRevision(exportAnalysis.analysisId)?.revision).toBe(
      exportAnalysis.revision,
    )
  } finally {
    store.close()
  }
})

it('rejects unknown templates and stale visible revisions before exporting', async () => {
  const catalogPath = join(directory, 'catalog.sqlite')
  const invalid = await handleAnalysisExportRequest(
    postJson('/api/analyst/ui/analysis/export', { analysisId, template: '<script>' }),
    catalogPath,
  )
  expect(invalid.status).toBe(400)
  const stale = await handleAnalysisExportRequest(
    postJson('/api/analyst/ui/analysis/export', {
      analysisId,
      template: 'analytical-brief',
      expectedRevision: analysisRevision + 1,
    }),
    catalogPath,
  )
  expect(stale.status).toBe(409)
})

it('disables unmapped shared filters instead of accepting a guessed column name', async () => {
  const response = await handleDashboardFragmentRequest(
    new Request(`http://localhost/api/analyst/ui/dashboard?dashboardId=${dashboardId}`, {
      headers: { host: 'localhost', origin: 'http://localhost' },
    }),
    join(directory, 'catalog.sqlite'),
  )
  expect(response.status).toBe(200)
  const html = await response.text()
  expect(html).toContain('No mapped filter fields')
  expect(html).toContain('<button type="submit" disabled>Apply shared filter</button>')
  expect(html).not.toContain('<input name="column"')
})
