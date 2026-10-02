import { DuckDBInstance } from '@duckdb/node-api'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { saveAnalysisRevision } from 'dsh-data-core/analysis-store'
import { resolveWorkspacePaths, type WorkspacePaths } from 'dsh-data-core/workspace-paths'
import { handleStudioRequest } from '../src/studio-routes.js'
import { saveStudioDefinition } from '../src/studio-state.js'
import type { StudioDefinition } from '../src/studio-definition.js'
let workspace: WorkspacePaths
beforeEach(async () => {
  workspace = resolveWorkspacePaths(await mkdtemp(join(tmpdir(), 'studio-test-')))
})
afterEach(async () => {
  await rm(workspace.root, { recursive: true, force: true })
})
function request(route: string, body?: unknown) {
  return new Request(`http://localhost/api/analyst/studio/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { origin: 'http://localhost', host: 'localhost', 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}
it('requires same-origin for reads and persists bounded session state across connections', async () => {
  expect(
    (
      await handleStudioRequest(
        new Request('http://localhost/api/analyst/studio/state?sessionId=a'),
        workspace,
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await handleStudioRequest(
        request('state', { sessionId: 'one', analysisId: 'ana_abc' }),
        workspace,
      )
    ).status,
  ).toBe(200)
  expect(
    await (await handleStudioRequest(request('state?sessionId=one'), workspace)).json(),
  ).toEqual({ sessionId: 'one', analysisId: 'ana_abc' })
  expect(
    await (await handleStudioRequest(request('state?sessionId=two'), workspace)).json(),
  ).toMatchObject({ analysisId: null })
  expect(
    (
      await handleStudioRequest(
        request('state', { sessionId: 'one', draft: { sql: 'SELECT 1' } }),
        workspace,
      )
    ).status,
  ).toBe(400)
})

it('lists workspace-scoped report snapshots and discloses missing required artifacts', async () => {
  const reportId = 'export_0123456789abcdef0123456789abcdef'
  const html = `${reportId}.html`
  const zip = `${reportId}.zip`
  const store = new MetadataStore(workspace.catalogPath)
  store.recordReportExport({
    reportId,
    title: 'Quarterly review',
    source: {
      kind: 'dashboard',
      dashboardId: 'dash_123',
      version: '2026-09-18T00:00:00.000Z',
      slots: [{ analysisId: 'ana_123', revision: 2, resultId: 'res_123' }],
    },
    files: { html, zip },
  })
  store.close()
  await mkdir(workspace.artifactsDir, { recursive: true })
  await writeFile(join(workspace.artifactsDir, html), '<h1>Quarterly review</h1>')
  await writeFile(join(workspace.artifactsDir, zip), 'PK')

  const complete = await (await handleStudioRequest(request('reports'), workspace)).json()
  expect(complete.reports[0]).toMatchObject({
    reportId,
    missingFiles: [],
    openUrl: `/api/analyst/reports?file=${html}&preview=1`,
    downloads: {
      html: `/api/analyst/reports?file=${html}`,
      zip: `/api/analyst/reports?file=${zip}`,
    },
  })

  const other = resolveWorkspacePaths(await mkdtemp(join(tmpdir(), 'studio-other-')))
  try {
    expect(await (await handleStudioRequest(request('reports'), other)).json()).toEqual({
      reports: [],
    })
  } finally {
    await rm(other.root, { recursive: true, force: true })
  }

  await unlink(join(workspace.artifactsDir, html))
  await unlink(join(workspace.artifactsDir, zip))
  const incomplete = await (await handleStudioRequest(request('reports'), workspace)).json()
  expect(incomplete.reports[0]).toMatchObject({
    downloads: {},
    missingFiles: ['html', 'zip'],
    openUrl: null,
  })
})
it('pages exact rows beyond model preview and inherits a definition only across unchanged results', async () => {
  await mkdir(workspace.resultsDir)
  const query = {
    datasetVersionId: 'v1',
    semanticRevisionId: 's1',
    sql: 'SELECT 1',
    parameters: [],
  }
  await writeFile(
    join(workspace.resultsDir, 'res_page.json'),
    JSON.stringify({
      ...query,
      resultId: 'res_page',
      columns: [{ name: 'value', logicalType: 'INTEGER' }],
      rows: Array.from({ length: 48 }, (_, i) => [i]),
      preview: [[0]],
      previewTruncated: true,
      rowCount: 48,
    }),
  )
  const saved = await saveAnalysisRevision(workspace.catalogPath, {
    ...query,
    question: 'Rows',
    query,
    resultId: 'res_page',
    chart: { mark: 'table', title: 'Rows' },
    artifactIds: [],
  })
  const definition: StudioDefinition = {
    datasetId: 'bike',
    datasetVersionId: 'v1',
    semanticRevisionId: 's1',
    table: 'hour',
    measure: { aggregation: 'count' },
    filters: [],
    mark: 'table',
  }
  saveStudioDefinition(
    join(workspace.root, 'studio.sqlite'),
    saved.analysisId,
    saved.revision,
    definition,
  )
  await saveAnalysisRevision(workspace.catalogPath, {
    analysisId: saved.analysisId,
    expectedRevision: 1,
    ...query,
    question: 'Rows',
    query,
    resultId: 'res_page',
    chart: {
      mark: 'kpi',
      title: 'Rows',
      y: 'value',
      format: { decimals: 2, palette: 'colorblind' },
    },
    artifactIds: [],
  })
  const response = await handleStudioRequest(
    request(`analysis?analysisId=${saved.analysisId}&offset=40&limit=5`),
    workspace,
  )
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.result.rows).toEqual([[40], [41], [42], [43], [44]])
  expect(body.result.nextOffset).toBe(45)
  expect(body.definition.mark).toBe('kpi')
  expect(body.definition.format).toEqual({ decimals: 2, palette: 'colorblind' })
  expect(body.evidence.facts[0].maximum).toBe(47)
  expect(
    (
      await handleStudioRequest(
        request(`analysis?analysisId=${saved.analysisId}&limit=10000`),
        workspace,
      )
    ).status,
  ).toBe(400)
})

it('runs one controlled population query and rejects a stale edit before publishing', async () => {
  const store = new MetadataStore(workspace.catalogPath)
  store.publishDatasetVersion({
    contractVersion: 1,
    datasetId: 'retail-fixture',
    datasetVersionId: 'retail-v1',
    source: {
      slug: 'test/retail',
      version: '1',
      url: 'https://example.invalid',
      retrievedAt: new Date().toISOString(),
      license: null,
    },
    files: [],
    recipeHash: 'fixture',
    importerVersion: '1',
    tables: [{ id: 'retail', sourceFile: 'retail.csv', rows: 3, rejectedRows: 0 }],
  })
  store.close()
  const path = workspace.datasetFile('retail-v1', 'retail-fixture')
  await mkdir(join(path, '..'), { recursive: true })
  const db = await DuckDBInstance.create(path)
  const connection = await db.connect()
  await connection.run(
    "CREATE TABLE retail (region VARCHAR, amount DECIMAL(18,2)); INSERT INTO retail VALUES ('West', 10), ('West', 30), ('East', 100)",
  )
  connection.closeSync()
  db.closeSync()
  const schema = await (
    await handleStudioRequest(request('schema?datasetId=retail-fixture'), workspace)
  ).json()
  const page = await (
    await handleStudioRequest(
      request('schema?datasetId=retail-fixture&offset=1&limit=2&table=retail'),
      workspace,
    )
  ).json()
  expect(page.tables[0].columns.map((column: { name: string }) => column.name)).toEqual([
    'customer_id',
    'order_date',
  ])
  expect(page.nextOffset).toBe(3)
  const input = {
    title: 'Observed mean',
    definition: {
      datasetId: 'retail-fixture',
      datasetVersionId: 'retail-v1',
      semanticRevisionId: schema.semanticRevisionId,
      table: 'retail',
      measure: { aggregation: 'avg', column: 'amount' },
      groupBy: { column: 'region' },
      filters: [{ column: 'region', value: 'West' }],
      mark: 'bar',
    },
  }
  expect(
    (
      await handleStudioRequest(
        request('state', { sessionId: 'draft', draft: { ...input, title: '' } }),
        workspace,
      )
    ).status,
  ).toBe(200)
  const response = await handleStudioRequest(request('apply', input), workspace)
  expect(response.status).toBe(200)
  const saved = await response.json()
  const loaded = await (
    await handleStudioRequest(request(`analysis?analysisId=${saved.analysisId}`), workspace)
  ).json()
  expect(loaded.result.rows).toEqual([['West', 20]])
  expect(loaded.analysis.question).toContain('region = West')
  expect(loaded.definition.filters).toEqual([{ column: 'region', value: 'West' }])
  expect(
    (
      await handleStudioRequest(
        request('apply', { ...input, analysisId: saved.analysisId, expectedRevision: 99 }),
        workspace,
      )
    ).status,
  ).toBe(409)
})

it('range/multi-value population filters run end-to-end through policy and DuckDB, excluding NULLs and honoring inclusive date boundaries', async () => {
  const store = new MetadataStore(workspace.catalogPath)
  store.publishDatasetVersion({
    contractVersion: 1,
    datasetId: 'retail-fixture',
    datasetVersionId: 'retail-v1',
    source: {
      slug: 'test/retail',
      version: '1',
      url: 'https://example.invalid',
      retrievedAt: new Date().toISOString(),
      license: null,
    },
    files: [],
    recipeHash: 'fixture',
    importerVersion: '1',
    tables: [{ id: 'retail', sourceFile: 'retail.csv', rows: 4, rejectedRows: 0 }],
  })
  store.close()
  const path = workspace.datasetFile('retail-v1', 'retail-fixture')
  await mkdir(join(path, '..'), { recursive: true })
  const db = await DuckDBInstance.create(path)
  const connection = await db.connect()
  await connection.run(
    `CREATE TABLE retail (line_id VARCHAR, customer_id VARCHAR, order_date DATE, region VARCHAR, amount DECIMAL(18,2));
     INSERT INTO retail VALUES
       ('L1', 'C1', '2024-01-05', 'West', 10),
       ('L2', 'C2', '2024-01-31', 'East', 25),
       ('L3', 'C3', '2024-02-01', 'West', NULL),
       ('L4', 'C4', '2024-01-15', NULL, 40)`,
  )
  connection.closeSync()
  db.closeSync()
  const schema = await (
    await handleStudioRequest(request('schema?datasetId=retail-fixture'), workspace)
  ).json()
  const base = {
    datasetId: 'retail-fixture',
    datasetVersionId: 'retail-v1',
    semanticRevisionId: schema.semanticRevisionId,
    table: 'retail',
    measure: { aggregation: 'count' as const },
    mark: 'kpi' as const,
  }
  const run = async (filters: unknown) => {
    const response = await handleStudioRequest(
      request('apply', { title: 'Filtered count', definition: { ...base, filters } }),
      workspace,
    )
    expect(response.status).toBe(200)
    const saved = await response.json()
    const loaded = await (
      await handleStudioRequest(request(`analysis?analysisId=${saved.analysisId}`), workspace)
    ).json()
    return loaded.result.rows[0][0]
  }
  // Range on a nullable numeric column: id1(10) and id2(25) are inside
  // [10, 25]; id3's NULL amount and id4's out-of-range 40 are both excluded,
  // and NULL exclusion (not "include NULLs") is the intentional behavior —
  // the same behavior the pre-existing eq filter already had.
  // COUNT(*) is BIGINT, encoded as a decimal string (architecture.md's
  // result-encoding boundary), hence the string comparisons below.
  expect(await run([{ column: 'amount', op: 'range', min: 10, max: 25 }])).toBe('2')
  // Multi-value on a nullable categorical column: id1 and id3 are 'West',
  // id2 is 'East'; id4's NULL region is excluded even though it is not
  // being tested against a value that would otherwise not match.
  expect(await run([{ column: 'region', op: 'in', values: ['West', 'East'] }])).toBe('3')
  // Inclusive date upper boundary: id2's order_date is exactly the upper
  // bound (2024-01-31) and must be included, not off-by-one excluded.
  expect(await run([{ column: 'order_date', op: 'range', max: '2024-01-31' }])).toBe('3')
  // Clearing filters fully resets to the unfiltered, all-source-rows state.
  expect(await run([])).toBe('4')
})

it('restores an earlier revision append-only and rejects stale restores', async () => {
  const query = {
    datasetVersionId: 'v1',
    semanticRevisionId: 's1',
    sql: 'SELECT 1',
    parameters: [],
  }
  const first = await saveAnalysisRevision(workspace.catalogPath, {
    ...query,
    query,
    question: 'Original',
    resultId: 'res_original',
    chart: { mark: 'table', title: 'Original' },
    artifactIds: ['art_original'],
  })
  await saveAnalysisRevision(workspace.catalogPath, {
    ...query,
    query,
    analysisId: first.analysisId,
    expectedRevision: 1,
    question: 'Edited',
    resultId: 'res_edited',
    chart: { mark: 'table', title: 'Edited' },
    artifactIds: ['art_edited'],
  })
  const restored = await handleStudioRequest(
    request('restore', { analysisId: first.analysisId, expectedRevision: 2, revision: 1 }),
    workspace,
  )
  expect(restored.status).toBe(200)
  expect(await restored.json()).toMatchObject({ revision: 3, resultId: 'res_original' })
  const store = new MetadataStore(workspace.catalogPath)
  expect(store.loadAnalysisRevision(first.analysisId, 2)?.resultId).toBe('res_edited')
  expect(store.loadAnalysisRevision(first.analysisId)?.artifactIds).toEqual(['art_original'])
  store.close()
  expect(
    (
      await handleStudioRequest(
        request('restore', { analysisId: first.analysisId, expectedRevision: 2, revision: 1 }),
        workspace,
      )
    ).status,
  ).toBe(409)
  const history = await (
    await handleStudioRequest(request(`history?analysisId=${first.analysisId}`), workspace)
  ).json()
  expect(history.revisions.map((revision: { revision: number }) => revision.revision)).toEqual([
    3, 2, 1,
  ])
})

it('updates dashboard order, width and explicit pins atomically with stale-write protection', async () => {
  const query = {
    datasetVersionId: 'v1',
    semanticRevisionId: 's1',
    sql: 'SELECT 1',
    parameters: [],
  }
  const base = {
    ...query,
    query,
    question: 'Full analytical context and source caveats. '.repeat(12),
    resultId: 'res_original',
    chart: { mark: 'table' as const, title: 'Original' },
    artifactIds: ['art_original'],
  }
  const a = await saveAnalysisRevision(workspace.catalogPath, base)
  const b = await saveAnalysisRevision(workspace.catalogPath, base)
  await saveAnalysisRevision(workspace.catalogPath, {
    ...base,
    analysisId: a.analysisId,
    expectedRevision: 1,
  })
  const store = new MetadataStore(workspace.catalogPath)
  const dashboard = store.saveDashboard({
    title: 'Board',
    layout: {
      slots: [a, b].map((item) => ({
        analysisId: item.analysisId,
        revision: 1,
        title: item.question,
        sharedFilterKeys: [],
      })),
    },
  })
  store.close()
  const slots = [
    { analysisId: b.analysisId, revision: 1, width: 2 },
    { analysisId: a.analysisId, revision: 2, width: 1 },
  ]
  const edit = { dashboardId: dashboard.dashboardId, expectedVersion: dashboard.updatedAt, slots }
  const updated = await handleStudioRequest(request('dashboard', edit), workspace)
  expect(updated.status).toBe(200)
  const body = await updated.json()
  expect(body.slots.map((slot: { analysisId: string }) => slot.analysisId)).toEqual([
    b.analysisId,
    a.analysisId,
  ])
  expect(body.slots[0].width).toBe(2)
  expect(body.slots[0].title).toBe('Original')
  expect(body.slots[0].chartTitle).toBe('Original')
  expect(body.slots[0].filterFields).toEqual([])
  expect(body.slots[0].filterWarning).toContain('Result fields unavailable')
  expect(body.dashboard.updatedAt).not.toBe(dashboard.updatedAt)
  expect((await handleStudioRequest(request('dashboard', edit), workspace)).status).toBe(409)
  expect(
    (
      await handleStudioRequest(
        request('dashboard', {
          ...edit,
          expectedVersion: body.dashboard.updatedAt,
          slots: [...slots, { analysisId: 'ana_missing', revision: 1 }],
        }),
        workspace,
      )
    ).status,
  ).toBe(400)
  await mkdir(workspace.resultsDir, { recursive: true })
  await writeFile(
    join(workspace.resultsDir, 'res_original.json'),
    JSON.stringify({
      ...query,
      columns: [{ name: 'region', logicalType: 'VARCHAR' }],
      rows: [['North']],
      rowCount: 1,
    }),
  )
  const reopened = await (
    await handleStudioRequest(request(`dashboard?dashboardId=${dashboard.dashboardId}`), workspace)
  ).json()
  expect(reopened.dashboard).toEqual(body.dashboard)
  expect(reopened.slots[0].filterFields).toEqual(['region'])
  expect(reopened.slots[0].filterWarning).toBeUndefined()
})

it('keeps only pending review items in the inbox and reflects external analyst review', async () => {
  const store = new MetadataStore(workspace.catalogPath)
  const input = {
    datasetId: 'bike',
    term: 'Rides',
    expression: 'cnt',
    description: 'Total observed rides',
    tableId: 'hour',
    actorId: 'agent',
  }
  const pending = store.createAliasCandidate(input)
  const approved = store.createAliasCandidate({ ...input, term: 'Approved rides' })
  store.setAliasCandidateStatus(approved.candidateId, 'approved')
  store.close()
  const first = await (await handleStudioRequest(request('inbox'), workspace)).json()
  expect(first.semantic.map((item: { candidateId: string }) => item.candidateId)).toEqual([
    pending.candidateId,
  ])
  const reviewer = new MetadataStore(workspace.catalogPath)
  reviewer.setAliasCandidateStatus(pending.candidateId, 'revoked')
  reviewer.close()
  expect(await (await handleStudioRequest(request('inbox'), workspace)).json()).toEqual({
    ingestion: [],
    adaptations: [],
    semantic: [],
    structure: [],
  })
})

it('lists only materiality confirmations as adaptation reviews', async () => {
  const store = new MetadataStore(workspace.catalogPath)
  const pending = store.createImportJob({ idempotencyKey: 'adapt-review', slug: 'owner/data' })
  const other = store.createImportJob({ idempotencyKey: 'other-review', slug: 'owner/other' })
  for (const job of [pending, other]) store.updateImportJobStatus(job.jobId, 'downloading')
  store.updateImportJobStatus(pending.jobId, 'needs-input', {
    warnings: ['Adaptation confirm required: date cast failed'],
  })
  store.updateImportJobStatus(other.jobId, 'needs-input', { warnings: ['Download needs input'] })
  store.close()
  const inbox = await (await handleStudioRequest(request('inbox'), workspace)).json()
  expect(inbox.adaptations).toEqual([
    {
      jobId: pending.jobId,
      slug: 'owner/data',
      status: 'needs-input',
      materialityReasons: ['Adaptation confirm required: date cast failed'],
    },
  ])
})

it('returns bounded review status without recipes, warnings or revoked candidates', async () => {
  const store = new MetadataStore(workspace.catalogPath)
  const candidate = store.createAliasCandidate({
    datasetId: 'fixture',
    term: 'events',
    expression: 'count(*)',
    description: 'Event rows',
    tableId: 'events',
    actorId: 'analyst',
  })
  for (let i = 0; i < 8; i++) {
    const job = store.createImportJob({ idempotencyKey: `status-${i}`, slug: `owner/data-${i}` })
    store.updateImportJobStatus(job.jobId, 'downloading')
    store.updateImportJobStatus(job.jobId, 'needs-input', {
      warnings: [i === 0 ? 'Adaptation confirm required: cast loss' : 'Download needs input'],
    })
  }
  store.close()
  const response = await handleStudioRequest(request('review-status'), workspace)
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.pending).toEqual({
    ingestion: 0,
    semantic: 1,
    structure: 0,
    adaptations: 1,
    total: 2,
  })
  expect(body.imports).toHaveLength(5)
  for (const item of body.imports)
    expect(Object.keys(item).sort()).toEqual(['jobId', 'slug', 'status', 'updatedAt'])
  const reviewer = new MetadataStore(workspace.catalogPath)
  reviewer.setAliasCandidateStatus(candidate.candidateId, 'revoked')
  reviewer.close()
  expect(
    (await (await handleStudioRequest(request('review-status'), workspace)).json()).pending.total,
  ).toBe(1)
  expect(
    (
      await handleStudioRequest(
        new Request('http://localhost/api/analyst/studio/review-status'),
        workspace,
      )
    ).status,
  ).toBe(403)
  expect((await handleStudioRequest(request('review-status', {}), workspace)).status).toBe(405)
})

it('persists bounded SQL presentation drafts and rejects executable colours', async () => {
  const draft = {
    analysisId: 'ana_abc',
    expectedRevision: 2,
    title: 'Annual events',
    presentation: { mark: 'bar', format: { color: '#0072B2', xTicks: 'year' } },
  }
  expect(
    (
      await handleStudioRequest(
        request('state', { sessionId: 'style', analysisId: 'ana_abc', draft }),
        workspace,
      )
    ).status,
  ).toBe(200)
  expect(
    await (await handleStudioRequest(request('state?sessionId=style'), workspace)).json(),
  ).toMatchObject({ draft })
  draft.presentation.format.color = 'url(https://example.invalid/tracker)'
  expect(
    (await handleStudioRequest(request('state', { sessionId: 'style', draft }), workspace)).status,
  ).toBe(400)
  expect(
    (await (await handleStudioRequest(request('state?sessionId=style'), workspace)).json()).draft
      .presentation.format.color,
  ).toBe('#0072B2')
})

it('rejects session state binding a presentation draft to another selected analysis', async () => {
  const draft = {
    analysisId: 'ana_original',
    expectedRevision: 1,
    title: 'Draft',
    presentation: { mark: 'bar', format: { color: '#123456' } },
  }
  const response = await handleStudioRequest(
    request('state', { sessionId: 'identity', analysisId: 'ana_other', draft }),
    workspace,
  )
  expect(response.status).toBe(400)
  expect(
    (await (await handleStudioRequest(request('state?sessionId=identity'), workspace)).json())
      .draft,
  ).toBeNull()
})
