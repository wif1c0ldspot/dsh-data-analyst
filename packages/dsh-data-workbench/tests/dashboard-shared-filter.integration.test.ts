/**
 * POST /dashboard/:id/filter re-authorizes and re-queries every
 * pinned card that mapped the filter column, bumps its revision, and leaves
 * an unmapped card's "Shared filters unsupported" note untouched. Mirrors
 * workbench-dashboard.integration.test.ts's Origin trust pattern and
 * workbench-ask.integration.test.ts's retail-fixture ingest setup.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { saveAnalysisRevision } from '../../dsh-data-core/src/analysis-store.js'
import { applyEqualityFilter } from '../../dsh-data-core/src/query-filter.js'
import { MetadataStore } from '../../dsh-data-core/src/metadata-store.js'
import { RETAIL_FIXTURE_RECIPE } from '../../dsh-data-core/src/recipes/retail-fixture.js'
import {
  resolveWorkspacePaths,
  type WorkspacePaths,
} from '../../dsh-data-core/src/workspace-paths.js'
import { runIngestFromArchive } from '../../dsh-data-duckdb/src/ingest-pipeline.js'
import { createWorkbenchServer } from '../src/server.js'
import { clearDashboardSharedFilter } from '../src/plugin-tools.js'

const SEMANTIC_REVISION_ID = 'sem-retail-fixture-v1'

let directory: string
let workspace: WorkspacePaths
let server: ReturnType<typeof createWorkbenchServer>
let port: number
let dashboardId: string
let analysisAId: string
let analysisBId: string

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

function originHeaders(origin: string): Record<string, string> {
  return { 'content-type': 'application/x-www-form-urlencoded', Origin: origin }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-wb-filter-'))
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
    idempotencyKey: 'workbench-filter-v1',
  })
  workspace = resolveWorkspacePaths(directory)
  await mkdir(workspace.resultsDir, { recursive: true })
  await writeFile(
    join(workspace.resultsDir, 'res_cardaseed.json'),
    JSON.stringify({
      resultId: 'res_cardaseed',
      datasetVersionId: 'retail-fixture-v1-test',
      semanticRevisionId: SEMANTIC_REVISION_ID,
      sql: 'SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region',
      columns: [
        { name: 'region', logicalType: 'VARCHAR' },
        { name: 'revenue', logicalType: 'DOUBLE' },
      ],
      preview: [
        ['North', 30],
        ['South', 15],
      ],
      rows: [
        ['North', 30],
        ['South', 15],
      ],
      rowCount: 2,
      previewTruncated: false,
      warnings: [],
    }),
    'utf8',
  )

  const store = new MetadataStore(workspace.catalogPath)
  let datasetVersionId: string
  try {
    const manifest = store.getCurrentDatasetVersion('retail-fixture')
    if (!manifest) throw new Error('expected retail-fixture to publish for this test')
    datasetVersionId = manifest.datasetVersionId
  } finally {
    store.close()
  }

  const savedA = await saveAnalysisRevision(workspace.catalogPath, {
    datasetVersionId,
    semanticRevisionId: SEMANTIC_REVISION_ID,
    question: 'Revenue by region',
    query: {
      datasetVersionId,
      semanticRevisionId: SEMANTIC_REVISION_ID,
      sql: 'SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region ORDER BY revenue DESC, region',
      parameters: [],
    },
    resultId: 'res_cardaseed',
    chart: { mark: 'bar', title: 'Revenue by region', x: 'region', y: 'revenue' },
    // Seeded as if a chart was already rendered for the unfiltered result,
    // so filter tests can assert the *new* revision never reuses this id.
    artifactIds: ['art_seed_fake_for_test'],
  })
  analysisAId = savedA.analysisId

  const savedB = await saveAnalysisRevision(workspace.catalogPath, {
    datasetVersionId,
    semanticRevisionId: SEMANTIC_REVISION_ID,
    question: 'Orders by customer',
    query: {
      datasetVersionId,
      semanticRevisionId: SEMANTIC_REVISION_ID,
      sql: 'SELECT customer_id, COUNT(*) AS n FROM retail GROUP BY customer_id ORDER BY customer_id',
      parameters: [],
    },
    resultId: 'res_card_b_seed',
    chart: { mark: 'bar', title: 'Orders by customer', x: 'customer_id', y: 'n' },
    artifactIds: [],
  })
  analysisBId = savedB.analysisId

  const store2 = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store2.saveDashboard({ title: 'Ops overview' })
    dashboardId = dashboard.dashboardId
    store2.pinAnalysisToDashboard(dashboardId, analysisAId, savedA.revision, 'Revenue by region')
    store2.pinAnalysisToDashboard(dashboardId, analysisBId, savedB.revision, 'Orders by customer')
    // Card A maps "region"; Card B stays unmapped and must keep disclosing
    // shared filters as unsupported.
    store2.setDashboardSharedFilterKeys(dashboardId, analysisAId, ['region'])
  } finally {
    store2.close()
  }

  server = createWorkbenchServer({ workspace })
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

it('re-queries the mapped card and keeps the unmapped card disclosed as unsupported', async () => {
  const before = await fetch(`http://127.0.0.1:${port}/dashboard?id=${dashboardId}`)
  expect(before.status).toBe(200)
  expect(await before.text()).toMatch(/Shared filters unsupported/)

  const filterRes = await fetch(`http://127.0.0.1:${port}/dashboard/${dashboardId}/filter`, {
    method: 'POST',
    headers: originHeaders(`http://127.0.0.1:${port}`),
    body: new URLSearchParams({ column: 'region', value: 'North' }).toString(),
  })
  expect(filterRes.status).toBe(200)
  const html = await filterRes.text()
  // Card A's new revision/filter caption.
  expect(html).toContain('r2')
  expect(html).toMatch(/filter region=North/)
  // Card B is untouched and still discloses as unsupported.
  expect(html).toMatch(/Shared filters unsupported/)

  const store = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store.loadDashboard(dashboardId)
    const slotA = dashboard?.layout.slots.find((s) => s.analysisId === analysisAId)
    const slotB = dashboard?.layout.slots.find((s) => s.analysisId === analysisBId)
    expect(slotA?.revision).toBe(2)
    expect(slotB?.revision).toBe(1)
    const revisionA = store.loadAnalysisRevision(analysisAId, 2)
    expect(revisionA?.query.sql).toContain('_analysis_filter')
    expect(revisionA?.query.sql).toContain("'North'")
    const revisionB = store.loadAnalysisRevision(analysisBId)
    expect(revisionB?.revision).toBe(1)
  } finally {
    store.close()
  }
})

it('replaces rather than compounds a previously applied shared filter', async () => {
  const first = await fetch(`http://127.0.0.1:${port}/dashboard/${dashboardId}/filter`, {
    method: 'POST',
    headers: originHeaders(`http://127.0.0.1:${port}`),
    body: new URLSearchParams({ column: 'region', value: 'West' }).toString(),
  })
  expect(first.status).toBe(200)

  const second = await fetch(`http://127.0.0.1:${port}/dashboard/${dashboardId}/filter`, {
    method: 'POST',
    headers: originHeaders(`http://127.0.0.1:${port}`),
    body: new URLSearchParams({ column: 'region', value: 'East' }).toString(),
  })
  expect(second.status).toBe(200)

  const store = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store.loadDashboard(dashboardId)
    const slotA = dashboard?.layout.slots.find((s) => s.analysisId === analysisAId)
    expect(slotA?.revision).toBe(3)
    const revisionA = store.loadAnalysisRevision(analysisAId, 3)
    const sql = revisionA?.query.sql ?? ''
    // Exactly one wrapper — reapplying must rewrap the original base SQL,
    // not the already-filtered SQL from the previous apply.
    expect(sql.match(/WITH _analysis_filter AS/g)?.length ?? 0).toBe(1)
    expect(sql).toContain('East')
    expect(sql).not.toContain('West')
    // The caption must not compound either.
    expect(revisionA?.question).toContain('[filter region=East]')
    expect(revisionA?.question).not.toContain('West')
    expect(dashboard?.activeFilter?.column).toBe('region')
    expect(dashboard?.activeFilter?.value).toBe('East')
    expect(
      dashboard?.activeFilter?.cards.find((card) => card.analysisId === analysisAId),
    ).toMatchObject({ baseRevision: 1, status: 'changed', filteredRevision: 3 })
  } finally {
    store.close()
  }
})

it('clears to the exact base result while retaining chart and dashboard presentation', async () => {
  const filterRes = await fetch(`http://127.0.0.1:${port}/dashboard/${dashboardId}/filter`, {
    method: 'POST',
    headers: originHeaders(`http://127.0.0.1:${port}`),
    body: new URLSearchParams({ column: 'region', value: 'North' }).toString(),
  })
  expect(filterRes.status).toBe(200)

  const before = new MetadataStore(workspace.catalogPath)
  const filtered = before.loadAnalysisRevision(analysisAId, 2)!
  before.close()
  const styled = await saveAnalysisRevision(workspace.catalogPath, {
    analysisId: analysisAId,
    expectedRevision: filtered.revision,
    datasetVersionId: filtered.datasetVersionId,
    semanticRevisionId: filtered.semanticRevisionId,
    question: filtered.question,
    query: filtered.query,
    resultId: filtered.resultId,
    chart: { ...filtered.chart, title: 'Styled while filtered' },
    artifactIds: filtered.artifactIds,
  })
  const styleStore = new MetadataStore(workspace.catalogPath)
  styleStore.pinAnalysisToDashboard(dashboardId, analysisAId, styled.revision)
  const filteredDashboard = styleStore.loadDashboard(dashboardId)!
  styleStore.close()
  expect(filteredDashboard.activeFilter).toBeDefined()

  const cleared = await clearDashboardSharedFilter(
    workspace,
    dashboardId,
    filteredDashboard.updatedAt,
  )
  expect(cleared.dashboard?.activeFilter).toBeUndefined()

  const store = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store.loadDashboard(dashboardId)!
    const slotA = dashboard.layout.slots.find((slot) => slot.analysisId === analysisAId)!
    const slotB = dashboard.layout.slots.find((slot) => slot.analysisId === analysisBId)!
    const revision = store.loadAnalysisRevision(analysisAId, slotA.revision)!
    expect(revision.resultId).toBe('res_cardaseed')
    expect(revision.query.sql).not.toContain('_analysis_filter')
    expect(revision.chart.title).toBe('Styled while filtered')
    expect(revision.artifactIds).toHaveLength(1)
    expect(slotA.sharedFilterKeys).toEqual(['region'])
    expect(slotB.revision).toBe(1)
  } finally {
    store.close()
  }
})

it('requires clearing before changing the active shared-filter field', async () => {
  const first = await fetch(`http://127.0.0.1:${port}/dashboard/${dashboardId}/filter`, {
    method: 'POST',
    headers: originHeaders(`http://127.0.0.1:${port}`),
    body: new URLSearchParams({ column: 'region', value: 'North' }).toString(),
  })
  expect(first.status).toBe(200)
  const store = new MetadataStore(workspace.catalogPath)
  store.setDashboardSharedFilterKeys(dashboardId, analysisAId, ['region', 'category'])
  store.close()
  await expect(
    fetch(`http://127.0.0.1:${port}/dashboard/${dashboardId}/filter`, {
      method: 'POST',
      headers: originHeaders(`http://127.0.0.1:${port}`),
      body: new URLSearchParams({ column: 'category', value: 'Furniture' }).toString(),
    }).then(async (response) => ({ status: response.status, body: await response.text() })),
  ).resolves.toMatchObject({ body: expect.stringContaining('Clear the active region filter') })
})

it('keeps legacy filtered cards unsupported across repeated applies', async () => {
  const store = new MetadataStore(workspace.catalogPath)
  const datasetVersionId = store.getCurrentDatasetVersion('retail-fixture')!.datasetVersionId
  store.close()
  const legacy = await saveAnalysisRevision(workspace.catalogPath, {
    datasetVersionId,
    semanticRevisionId: SEMANTIC_REVISION_ID,
    question: 'Legacy [filter region=West]',
    query: {
      datasetVersionId,
      semanticRevisionId: SEMANTIC_REVISION_ID,
      sql: applyEqualityFilter('SELECT region FROM retail', 'region', 'West'),
      parameters: [],
    },
    resultId: 'res_legacyseed',
    chart: { mark: 'bar', title: 'Legacy', x: 'region', y: 'region' },
    artifactIds: [],
  })
  const pinStore = new MetadataStore(workspace.catalogPath)
  pinStore.pinAnalysisToDashboard(dashboardId, legacy.analysisId, legacy.revision, 'Legacy')
  pinStore.setDashboardSharedFilterKeys(dashboardId, legacy.analysisId, ['region'])
  pinStore.close()

  for (const value of ['North', 'East']) {
    const response = await fetch(`http://127.0.0.1:${port}/dashboard/${dashboardId}/filter`, {
      method: 'POST',
      headers: originHeaders(`http://127.0.0.1:${port}`),
      body: new URLSearchParams({ column: 'region', value }).toString(),
    })
    expect(response.status).toBe(200)
    const check = new MetadataStore(workspace.catalogPath)
    const current = check.loadDashboard(dashboardId)!
    expect(
      current.activeFilter?.cards.find((card) => card.analysisId === legacy.analysisId),
    ).toMatchObject({
      status: 'unsupported',
      reason: 'base-revision-unavailable',
    })
    expect(
      current.layout.slots.find((slot) => slot.analysisId === legacy.analysisId)?.revision,
    ).toBe(1)
    check.close()
  }
})

it('requires clear before reapplying after a filtered card mapping changes', async () => {
  const first = await fetch(`http://127.0.0.1:${port}/dashboard/${dashboardId}/filter`, {
    method: 'POST',
    headers: originHeaders(`http://127.0.0.1:${port}`),
    body: new URLSearchParams({ column: 'region', value: 'North' }).toString(),
  })
  expect(first.status).toBe(200)
  const store = new MetadataStore(workspace.catalogPath)
  store.setDashboardSharedFilterKeys(dashboardId, analysisAId, [])
  store.close()
  const second = await fetch(`http://127.0.0.1:${port}/dashboard/${dashboardId}/filter`, {
    method: 'POST',
    headers: originHeaders(`http://127.0.0.1:${port}`),
    body: new URLSearchParams({ column: 'region', value: 'East' }).toString(),
  })
  expect(await second.text()).toContain('Clear the active filter before changing mappings')
  const check = new MetadataStore(workspace.catalogPath)
  expect(check.loadDashboard(dashboardId)?.activeFilter?.value).toBe('North')
  check.close()
})

it('never carries the previous chart artifact onto a filtered revision', async () => {
  const filterRes = await fetch(`http://127.0.0.1:${port}/dashboard/${dashboardId}/filter`, {
    method: 'POST',
    headers: originHeaders(`http://127.0.0.1:${port}`),
    body: new URLSearchParams({ column: 'region', value: 'North' }).toString(),
  })
  expect(filterRes.status).toBe(200)
  const html = await filterRes.text()
  // The dashboard HTML must not embed the seeded (pre-filter) artifact as
  // if it were the filtered card's current chart.
  expect(html).not.toContain('art_seed_fake_for_test')

  const store = new MetadataStore(workspace.catalogPath)
  try {
    const revisionA = store.loadAnalysisRevision(analysisAId, 2)
    expect(revisionA?.artifactIds ?? []).not.toContain('art_seed_fake_for_test')
    if ((revisionA?.artifactIds.length ?? 0) > 0) {
      const artifactId = revisionA!.artifactIds[0]!
      const svg = await readFile(join(workspace.artifactsDir, `${artifactId}.svg`), 'utf8')
      expect(svg).toContain('<svg')
    }
  } finally {
    store.close()
  }
})

it('rewraps the pinned revision, not revision 1, when the pinned revision changed the SQL', async () => {
  const metaStore = new MetadataStore(workspace.catalogPath)
  let datasetVersionId: string
  try {
    const manifest = metaStore.getCurrentDatasetVersion('retail-fixture')
    if (!manifest) throw new Error('expected retail-fixture to publish for this test')
    datasetVersionId = manifest.datasetVersionId
  } finally {
    metaStore.close()
  }

  // Revision 1: base query. Revision 2: a legitimate SQL change (e.g. a
  // correction), not a filter wrap — pinned to the dashboard at revision 2.
  const revision1Sql = 'SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region'
  const savedC1 = await saveAnalysisRevision(workspace.catalogPath, {
    datasetVersionId,
    semanticRevisionId: SEMANTIC_REVISION_ID,
    question: 'Revenue by region (draft)',
    query: {
      datasetVersionId,
      semanticRevisionId: SEMANTIC_REVISION_ID,
      sql: revision1Sql,
      parameters: [],
    },
    resultId: 'res_card_c_seed_1',
    chart: { mark: 'bar', title: 'Revenue by region (draft)', x: 'region', y: 'revenue' },
    artifactIds: [],
  })
  const analysisCId = savedC1.analysisId
  const revision2Sql =
    'SELECT region, SUM(amount) AS revenue FROM retail WHERE amount > 0 GROUP BY region ORDER BY revenue DESC'
  const savedC2 = await saveAnalysisRevision(workspace.catalogPath, {
    analysisId: analysisCId,
    expectedRevision: savedC1.revision,
    datasetVersionId,
    semanticRevisionId: SEMANTIC_REVISION_ID,
    question: 'Revenue by region (corrected)',
    query: {
      datasetVersionId,
      semanticRevisionId: SEMANTIC_REVISION_ID,
      sql: revision2Sql,
      parameters: [],
    },
    resultId: 'res_card_c_seed_2',
    chart: { mark: 'bar', title: 'Revenue by region (corrected)', x: 'region', y: 'revenue' },
    artifactIds: [],
  })
  expect(savedC2.revision).toBe(2)

  const pinStore = new MetadataStore(workspace.catalogPath)
  try {
    pinStore.pinAnalysisToDashboard(
      dashboardId,
      analysisCId,
      savedC2.revision,
      'Revenue by region (corrected)',
    )
    pinStore.setDashboardSharedFilterKeys(dashboardId, analysisCId, ['region'])
  } finally {
    pinStore.close()
  }

  const filterRes = await fetch(`http://127.0.0.1:${port}/dashboard/${dashboardId}/filter`, {
    method: 'POST',
    headers: originHeaders(`http://127.0.0.1:${port}`),
    body: new URLSearchParams({ column: 'region', value: 'North' }).toString(),
  })
  expect(filterRes.status).toBe(200)

  const store = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store.loadDashboard(dashboardId)
    const slotC = dashboard?.layout.slots.find((s) => s.analysisId === analysisCId)
    expect(slotC?.revision).toBe(3)
    const revisionC = store.loadAnalysisRevision(analysisCId, 3)
    const sql = revisionC?.query.sql ?? ''
    // Wrapped exactly once, around revision 2's SQL — not revision 1's.
    expect(sql.match(/WITH _analysis_filter AS/g)?.length ?? 0).toBe(1)
    expect(sql).toContain(revision2Sql)
    expect(sql).not.toContain(revision1Sql)
  } finally {
    store.close()
  }
})

it('rejects cross-origin dashboard filter POST with 403', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/dashboard/${dashboardId}/filter`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Origin: 'http://evil.example',
    },
    body: new URLSearchParams({ column: 'region', value: 'North' }).toString(),
  })
  expect(res.status).toBe(403)

  const store = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store.loadDashboard(dashboardId)
    const slotA = dashboard?.layout.slots.find((s) => s.analysisId === analysisAId)
    expect(slotA?.revision).toBe(1)
  } finally {
    store.close()
  }
})
