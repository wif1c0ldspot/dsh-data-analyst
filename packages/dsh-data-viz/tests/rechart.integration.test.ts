import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { loadAnalysisRevision, saveAnalysisRevision } from 'dsh-data-core/analysis-store'
import { handleAnalysisExportRequest } from '../../dsh-data-workbench/src/ui-routes.js'
import { allowedMarksForChart, handleChartRechartRequest } from '../src/rechart.js'

let directory: string
let previousWorkspace: string | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-rechart-'))
  previousWorkspace = process.env.DSH_DATA_WORKSPACE
  process.env.DSH_DATA_WORKSPACE = directory
  await mkdir(join(directory, 'results'), { recursive: true })
  await writeFile(
    join(directory, 'results', 'res_abc123.json'),
    JSON.stringify({
      resultId: 'res_abc123',
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT region, revenue FROM source',
      columns: [
        { name: 'region', logicalType: 'VARCHAR' },
        { name: 'revenue', logicalType: 'DECIMAL(18,2)' },
      ],
      rows: [
        ['West', '100.00'],
        ['East', '50.00'],
      ],
      preview: [
        ['West', '100.00'],
        ['East', '50.00'],
      ],
      rowCount: 2,
      previewTruncated: false,
      warnings: [],
    }),
    'utf8',
  )
})

afterEach(async () => {
  if (previousWorkspace === undefined) delete process.env.DSH_DATA_WORKSPACE
  else process.env.DSH_DATA_WORKSPACE = previousWorkspace
  await rm(directory, { recursive: true, force: true })
})

function rechartRequest(analysisId: string, expectedRevision: number, mark: string): Request {
  return new Request('http://localhost/api/analyst/charts/rechart', {
    method: 'POST',
    headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ analysisId, expectedRevision, mark }),
  })
}

it('offers KPI only for a known scalar result and shape marks with x+y', () => {
  expect(allowedMarksForChart({ mark: 'table', title: 'x' })).toEqual(['table'])
  expect(allowedMarksForChart({ mark: 'kpi', title: 'x', y: 'revenue' }, 1)).toContain('kpi')
  expect(allowedMarksForChart({ mark: 'kpi', title: 'x', y: 'revenue' }, 2)).not.toContain('kpi')
  expect(allowedMarksForChart({ mark: 'bar', title: 'x', x: 'region', y: 'revenue' })).toEqual([
    'table',
    'bar',
    'line',
    'point',
    'area',
  ])
})

it('recharts a saved analysis with a valid mark, reusing its result', async () => {
  const saved = await saveAnalysisRevision(join(directory, 'catalog.sqlite'), {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_abc123',
    chart: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    artifactIds: [],
  })

  const response = await handleChartRechartRequest(
    rechartRequest(saved.analysisId, saved.revision, 'line'),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { artifactId: string; resultId: string; revision: number }
  expect(body.artifactId).toMatch(/^art_/)
  expect(body).toMatchObject({ resultId: 'res_abc123', revision: 2 })
  await access(join(directory, 'artifacts', `${body.artifactId}.svg`))

  const reopened = await loadAnalysisRevision(join(directory, 'catalog.sqlite'), saved.analysisId)
  expect(reopened).toMatchObject({
    revision: 2,
    resultId: 'res_abc123',
    chart: { mark: 'line' },
    artifactIds: [body.artifactId],
  })

  const exportResponse = await handleAnalysisExportRequest(
    new Request('http://localhost/api/analyst/ui/analysis/export', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ analysisId: saved.analysisId }),
    }),
    join(directory, 'catalog.sqlite'),
  )
  expect(exportResponse.status).toBe(200)
  const specName = (await readdir(join(directory, 'artifacts'))).find((name) =>
    name.endsWith('_spec.json'),
  )
  expect(specName).toBeDefined()
  const specification = JSON.parse(
    await readFile(join(directory, 'artifacts', specName!), 'utf8'),
  ) as { artifactId: string; resultId: string; intent: { mark: string } }
  expect(specification).toMatchObject({
    artifactId: body.artifactId,
    resultId: 'res_abc123',
    intent: { mark: 'line' },
  })
})

it('surfaces the specific compilation reason instead of one generic message', async () => {
  await writeFile(
    join(directory, 'results', 'res_unsafe.json'),
    JSON.stringify({
      resultId: 'res_unsafe',
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT id, revenue FROM source',
      columns: [
        { name: 'id', logicalType: 'BIGINT' },
        { name: 'revenue', logicalType: 'DECIMAL(18,2)' },
      ],
      rows: [['9007199254740993', '100.00']],
      preview: [['9007199254740993', '100.00']],
      rowCount: 1,
      previewTruncated: false,
      warnings: [],
    }),
    'utf8',
  )
  const saved = await saveAnalysisRevision(join(directory, 'catalog.sqlite'), {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Revenue by id',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_unsafe',
    chart: { mark: 'bar', title: 'Revenue', x: 'id', y: 'revenue' },
    artifactIds: [],
  })

  const response = await handleChartRechartRequest(
    rechartRequest(saved.analysisId, saved.revision, 'line'),
  )
  expect(response.status).toBe(422)
  const body = (await response.json()) as { error: string }
  expect(body.error).toContain('safe-integer range')
  expect(body.error).toContain('could not be rendered')
  expect(body.error).toContain('unchanged')

  // The failed rechart must not have advanced the saved revision.
  const reopened = await loadAnalysisRevision(join(directory, 'catalog.sqlite'), saved.analysisId)
  expect(reopened.revision).toBe(1)
})

it('rejects a mark not valid for the chart encodings', async () => {
  const saved = await saveAnalysisRevision(join(directory, 'catalog.sqlite'), {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Total revenue',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_abc123',
    chart: { mark: 'kpi', title: 'Revenue', y: 'revenue' },
    artifactIds: [],
  })

  const response = await handleChartRechartRequest(
    rechartRequest(saved.analysisId, saved.revision, 'heatmap'),
  )
  expect(response.status).toBe(400)
})

it('rejects a stale chart switch without creating another revision', async () => {
  const saved = await saveAnalysisRevision(join(directory, 'catalog.sqlite'), {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_abc123',
    chart: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    artifactIds: [],
  })
  const first = await handleChartRechartRequest(
    rechartRequest(saved.analysisId, saved.revision, 'line'),
  )
  expect(first.status).toBe(200)

  const stale = await handleChartRechartRequest(
    rechartRequest(saved.analysisId, saved.revision, 'area'),
  )
  expect(stale.status).toBe(409)
  expect(
    (await loadAnalysisRevision(join(directory, 'catalog.sqlite'), saved.analysisId)).revision,
  ).toBe(2)
})

it('requires same-origin intent', async () => {
  const saved = await saveAnalysisRevision(join(directory, 'catalog.sqlite'), {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_abc123',
    chart: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    artifactIds: [],
  })
  const crossOrigin = await handleChartRechartRequest(
    new Request('http://localhost/api/analyst/charts/rechart', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        analysisId: saved.analysisId,
        expectedRevision: saved.revision,
        mark: 'line',
      }),
    }),
  )
  expect(crossOrigin.status).toBe(403)
})

it('rejects a multirow result as a KPI without saving a revision', async () => {
  const saved = await saveAnalysisRevision(join(directory, 'catalog.sqlite'), {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Revenue',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_abc123',
    chart: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    artifactIds: [],
  })
  const response = await handleChartRechartRequest(rechartRequest(saved.analysisId, 1, 'kpi'))
  expect(response.status).toBe(400)
  expect(
    (await loadAnalysisRevision(join(directory, 'catalog.sqlite'), saved.analysisId)).revision,
  ).toBe(1)
})

it('changes only a title without replacing the stored result or query', async () => {
  const saved = await saveAnalysisRevision(join(directory, 'catalog.sqlite'), {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Revenue [filter region=West]',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_abc123',
    chart: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    artifactIds: [],
  })
  const response = await handleChartRechartRequest(
    new Request('http://localhost/api/analyst/charts/rechart', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        analysisId: saved.analysisId,
        expectedRevision: 1,
        title: 'Regional revenue',
        format: { decimals: 2, yLabel: 'Revenue', palette: 'colorblind' },
      }),
    }),
  )
  expect(response.status).toBe(200)
  const current = await loadAnalysisRevision(join(directory, 'catalog.sqlite'), saved.analysisId)
  expect(current).toMatchObject({
    revision: 2,
    resultId: saved.resultId,
    query: saved.query,
    question: saved.question,
    chart: {
      mark: 'bar',
      title: 'Regional revenue',
      format: { decimals: 2, yLabel: 'Revenue', palette: 'colorblind' },
    },
  })
})

/**
 * Studio can probe a
 * different delivery-width profile through the rechart route (reusing the
 * same authorized result) without that probe alone mutating the saved
 * analysis — only an explicit, non-preview rechart advances the revision.
 */
it('renders a preview at a different delivery profile without advancing the saved analysis revision', async () => {
  const saved = await saveAnalysisRevision(join(directory, 'catalog.sqlite'), {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_abc123',
    chart: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    artifactIds: [],
  })

  const response = await handleChartRechartRequest(
    new Request('http://localhost/api/analyst/charts/rechart', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        analysisId: saved.analysisId,
        expectedRevision: saved.revision,
        deliveryProfile: 'sidebar-wide',
        preview: true,
      }),
    }),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    artifactId: string
    revision: number
    preview: boolean
  }
  expect(body.artifactId).toMatch(/^art_/)
  expect(body.preview).toBe(true)
  // The preview still produced a real, readable artifact...
  await access(join(directory, 'artifacts', `${body.artifactId}.svg`))
  // ...but the saved analysis was never touched: still revision 1, no new
  // artifact reference.
  expect(body.revision).toBe(1)
  const reopened = await loadAnalysisRevision(join(directory, 'catalog.sqlite'), saved.analysisId)
  expect(reopened.revision).toBe(1)
  expect(reopened.artifactIds).toEqual([])
})

it('rejects a delivery profile that is not one of the named enum values', async () => {
  const saved = await saveAnalysisRevision(join(directory, 'catalog.sqlite'), {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_abc123',
    chart: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    artifactIds: [],
  })
  const response = await handleChartRechartRequest(
    new Request('http://localhost/api/analyst/charts/rechart', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        analysisId: saved.analysisId,
        expectedRevision: saved.revision,
        deliveryProfile: '2000px',
      }),
    }),
  )
  expect(response.status).toBe(400)
})

it('an explicit (non-preview) rechart at a delivery profile still persists as a new revision', async () => {
  const saved = await saveAnalysisRevision(join(directory, 'catalog.sqlite'), {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_abc123',
    chart: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    artifactIds: [],
  })
  const response = await handleChartRechartRequest(
    new Request('http://localhost/api/analyst/charts/rechart', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        analysisId: saved.analysisId,
        expectedRevision: saved.revision,
        deliveryProfile: 'export',
      }),
    }),
  )
  expect(response.status).toBe(200)
  const reopened = await loadAnalysisRevision(join(directory, 'catalog.sqlite'), saved.analysisId)
  expect(reopened.revision).toBe(2)
})

it('does not offer marks incompatible with retained layer or stack settings', () => {
  expect(
    allowedMarksForChart({
      mark: 'line',
      title: 'Comparison',
      x: 'month',
      y: 'actual',
      y2: 'target',
    }),
  ).not.toContain('bar')
  expect(
    allowedMarksForChart({
      mark: 'bar',
      title: 'Share',
      x: 'month',
      y: 'actual',
      series: 'region',
      stack: 'normalize',
    }),
  ).not.toContain('line')
})
