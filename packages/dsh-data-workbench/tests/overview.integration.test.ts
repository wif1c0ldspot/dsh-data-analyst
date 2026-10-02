import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { saveAnalysisRevision } from 'dsh-data-core/analysis-store'
import type { DatasetManifest } from 'dsh-data-core/contracts'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { checkStudioAvailability, handleAnalystOverviewRequest } from '../src/overview.js'

let directory: string
let catalogPath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-overview-'))
  catalogPath = join(directory, 'catalog.sqlite')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('returns the workspace overview and requires same-origin intent', async () => {
  const store = new MetadataStore(catalogPath)
  try {
    const manifest: DatasetManifest = {
      contractVersion: 1,
      datasetId: 'retail',
      datasetVersionId: 'retail-v1',
      source: {
        slug: 'test/retail',
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
    store.saveDashboard({ title: 'Quarterly review' })
  } finally {
    store.close()
  }
  await saveAnalysisRevision(catalogPath, {
    datasetVersionId: 'retail-v1',
    semanticRevisionId: 'sem-retail-v1',
    question:
      'Revenue by region. ' + 'Use the approved metric and retain source caveats. '.repeat(10),
    query: {
      datasetVersionId: 'retail-v1',
      semanticRevisionId: 'sem-retail-v1',
      sql: 'SELECT region FROM orders',
      parameters: [],
    },
    resultId: 'res_overview',
    chart: { mark: 'table', title: 'Revenue by region' },
    artifactIds: [],
  })

  const crossOrigin = await handleAnalystOverviewRequest(
    new Request('http://localhost/api/analyst/overview', {
      headers: { host: 'localhost', origin: 'http://evil.example' },
    }),
    catalogPath,
  )
  expect(crossOrigin.status).toBe(403)

  const response = await handleAnalystOverviewRequest(
    new Request('http://localhost/api/analyst/overview', {
      headers: { host: 'localhost', origin: 'http://localhost' },
    }),
    catalogPath,
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    datasets: Array<{ datasetId: string }>
    dashboards: Array<{ title: string }>
    analyses: Array<{ question: string; title: string }>
  }
  expect(body.datasets.map((d) => d.datasetId)).toContain('retail')
  expect(body.dashboards.map((d) => d.title)).toContain('Quarterly review')
  expect(body.analyses[0]!.title).toBe('Revenue by region')
  expect(body.analyses[0]!.question).toContain('Use the approved metric and retain source caveats.')
  expect(body.analyses[0]!.question.length).toBeGreaterThan(400)
})

it('lists the latest revision of a saved analysis exactly once (no duplicate entries)', async () => {
  const store = new MetadataStore(catalogPath)
  try {
    const manifest: DatasetManifest = {
      contractVersion: 1,
      datasetId: 'retail',
      datasetVersionId: 'retail-v1',
      source: {
        slug: 'test/retail',
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

  // First persisted revision — this is the "save_analysis just returned
  // persisted: true" moment the Studio selector needs to reflect.
  const first = await saveAnalysisRevision(catalogPath, {
    datasetVersionId: 'retail-v1',
    semanticRevisionId: 'sem-retail-v1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'retail-v1',
      semanticRevisionId: 'sem-retail-v1',
      sql: 'SELECT region FROM orders',
      parameters: [],
    },
    resultId: 'res_overview_1',
    chart: { mark: 'table', title: 'Revenue by region' },
    artifactIds: [],
  })

  const afterFirstSave = await handleAnalystOverviewRequest(
    new Request('http://localhost/api/analyst/overview', {
      headers: { host: 'localhost', origin: 'http://localhost' },
    }),
    catalogPath,
  )
  const firstBody = (await afterFirstSave.json()) as {
    analyses: Array<{ analysisId: string; revision: number }>
  }
  expect(firstBody.analyses.filter((a) => a.analysisId === first.analysisId)).toHaveLength(1)
  expect(firstBody.analyses.find((a) => a.analysisId === first.analysisId)?.revision).toBe(1)

  // A second revision of the same analysis (e.g. a corrected chart or SQL)
  // must replace, not duplicate, the selector entry.
  await saveAnalysisRevision(catalogPath, {
    analysisId: first.analysisId,
    expectedRevision: 1,
    datasetVersionId: 'retail-v1',
    semanticRevisionId: 'sem-retail-v1',
    question: 'Revenue by region (corrected)',
    query: {
      datasetVersionId: 'retail-v1',
      semanticRevisionId: 'sem-retail-v1',
      sql: 'SELECT region, revenue FROM orders',
      parameters: [],
    },
    resultId: 'res_overview_2',
    chart: { mark: 'table', title: 'Revenue by region (corrected)' },
    artifactIds: [],
  })

  const afterSecondSave = await handleAnalystOverviewRequest(
    new Request('http://localhost/api/analyst/overview', {
      headers: { host: 'localhost', origin: 'http://localhost' },
    }),
    catalogPath,
  )
  const secondBody = (await afterSecondSave.json()) as {
    analyses: Array<{ analysisId: string; revision: number; title: string }>
  }
  const matching = secondBody.analyses.filter((a) => a.analysisId === first.analysisId)
  expect(matching).toHaveLength(1)
  expect(matching[0]!.revision).toBe(2)
  expect(matching[0]!.title).toBe('Revenue by region (corrected)')
})

/**
 * `checkStudioAvailability` is the independently observed
 * "Available in Studio" state — a fresh re-query of the same catalog data
 * path `/api/analyst/overview` reads, never an inference from
 * `save_analysis`'s `persisted: true`. These tests prove it actually
 * distinguishes "persisted" from "retrievable via the overview route",
 * including the case a caller only learns about from a real check: an
 * unknown analysisId, and a stale revision number after a newer one was
 * saved.
 */
it('checkStudioAvailability reports false for an analysisId the overview route has never heard of', async () => {
  const result = await checkStudioAvailability(catalogPath, 'analysis_never_saved')
  expect(result).toEqual({
    analysisId: 'analysis_never_saved',
    requestedRevision: null,
    latestRevision: null,
    availableInStudio: false,
    checkedVia: 'studio-overview-route',
    checkedAt: expect.any(String),
  })
})

it('checkStudioAvailability reports true only once the exact revision is the overview route latest', async () => {
  const store = new MetadataStore(catalogPath)
  try {
    const manifest: DatasetManifest = {
      contractVersion: 1,
      datasetId: 'retail',
      datasetVersionId: 'retail-v1',
      source: {
        slug: 'test/retail',
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
    datasetVersionId: 'retail-v1',
    semanticRevisionId: 'sem-retail-v1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'retail-v1',
      semanticRevisionId: 'sem-retail-v1',
      sql: 'SELECT region FROM orders',
      parameters: [],
    },
    resultId: 'res_availability_1',
    chart: { mark: 'table', title: 'Revenue by region' },
    artifactIds: [],
  })

  // Immediately after a successful save_analysis, an independent check
  // against the overview route's own data confirms availability — this is
  // not simply trusting the save call's `persisted: true`.
  const afterFirstSave = await checkStudioAvailability(catalogPath, saved.analysisId, 1)
  expect(afterFirstSave.availableInStudio).toBe(true)
  expect(afterFirstSave.latestRevision).toBe(1)
  expect(afterFirstSave.checkedVia).toBe('studio-overview-route')

  await saveAnalysisRevision(catalogPath, {
    analysisId: saved.analysisId,
    expectedRevision: 1,
    datasetVersionId: 'retail-v1',
    semanticRevisionId: 'sem-retail-v1',
    question: 'Revenue by region (corrected)',
    query: {
      datasetVersionId: 'retail-v1',
      semanticRevisionId: 'sem-retail-v1',
      sql: 'SELECT region, revenue FROM orders',
      parameters: [],
    },
    resultId: 'res_availability_2',
    chart: { mark: 'table', title: 'Revenue by region (corrected)' },
    artifactIds: [],
  })

  // Revision 1 is no longer the overview route's latest for this analysis —
  // a caller that only remembers the old revision number is told so, rather
  // than getting a stale "available" answer.
  const staleRevisionCheck = await checkStudioAvailability(catalogPath, saved.analysisId, 1)
  expect(staleRevisionCheck.availableInStudio).toBe(false)
  expect(staleRevisionCheck.latestRevision).toBe(2)

  const latestCheck = await checkStudioAvailability(catalogPath, saved.analysisId, 2)
  expect(latestCheck.availableInStudio).toBe(true)

  const omittedRevisionCheck = await checkStudioAvailability(catalogPath, saved.analysisId)
  expect(omittedRevisionCheck.availableInStudio).toBe(true)
  expect(omittedRevisionCheck.requestedRevision).toBeNull()
})

it('records a "studio opened" workflow trail milestone only when availability is actually confirmed', async () => {
  const store = new MetadataStore(catalogPath)
  try {
    const manifest: DatasetManifest = {
      contractVersion: 1,
      datasetId: 'retail2',
      datasetVersionId: 'retail2-v1',
      source: {
        slug: 'test/retail2',
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
    datasetVersionId: 'retail2-v1',
    semanticRevisionId: 'sem-retail2-v1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'retail2-v1',
      semanticRevisionId: 'sem-retail2-v1',
      sql: 'SELECT region FROM orders',
      parameters: [],
    },
    resultId: 'res_trail_studio',
    chart: { mark: 'table', title: 'Revenue by region' },
    artifactIds: [],
  })

  // A check against a stale/nonexistent revision must not fabricate a
  // "studio opened" milestone.
  await checkStudioAvailability(catalogPath, saved.analysisId, 99)
  const afterFailedCheck = new MetadataStore(catalogPath)
  expect(
    afterFailedCheck
      .listWorkflowTrail({ analysisId: saved.analysisId })
      .filter((entry) => entry.milestone === 'studio_opened'),
  ).toHaveLength(0)
  afterFailedCheck.close()

  await checkStudioAvailability(catalogPath, saved.analysisId, 1)
  const afterSuccess = new MetadataStore(catalogPath)
  const trail = afterSuccess.listWorkflowTrail({ analysisId: saved.analysisId })
  afterSuccess.close()

  // analysis_persisted (from save_analysis) then studio_opened (from the
  // successful check), in that order.
  expect(trail.map((entry) => entry.milestone)).toEqual(['analysis_persisted', 'studio_opened'])
  expect(trail[1]).toMatchObject({
    milestone: 'studio_opened',
    actor: 'service',
    datasetVersionId: 'retail2-v1',
    analysisId: saved.analysisId,
    receiptId: `${saved.analysisId}:1`,
  })
})
