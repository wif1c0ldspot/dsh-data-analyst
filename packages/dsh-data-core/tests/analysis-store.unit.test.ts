import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  listAnalysisRevisions,
  loadAnalysisRevision,
  saveAnalysisRevision,
} from '../src/analysis-store.js'
import { applyEqualityFilter } from '../src/query-filter.js'
import { MetadataStore } from '../src/metadata-store.js'

let directory: string
let catalogPath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-analysis-'))
  catalogPath = join(directory, 'catalog.sqlite')
  // Ensure migrations (including analysis_revisions) are applied.
  const store = new MetadataStore(catalogPath)
  store.close()
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('rejects unsafe filter column identifiers', () => {
  expect(() => applyEqualityFilter('SELECT 1 AS x', 'a; DROP', '1')).toThrow(/identifier/i)
  expect(applyEqualityFilter('SELECT region FROM orders', 'region', "O'Brien")).toContain(
    "O''Brien",
  )
})

it('saves, lists, and reloads analysis revisions via SQLite', async () => {
  const first = await saveAnalysisRevision(catalogPath, {
    datasetVersionId: 'superstore-v1-test',
    semanticRevisionId: 'sem-superstore-v1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'superstore-v1-test',
      semanticRevisionId: 'sem-superstore-v1',
      sql: 'SELECT region FROM orders',
      parameters: [],
    },
    resultId: 'res_abc',
    chart: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    artifactIds: ['art_abc'],
    filter: { column: 'region', value: 'West' },
  })
  expect(first.revision).toBe(1)
  expect(first.question).toContain('filter region=West')

  const second = await saveAnalysisRevision(catalogPath, {
    analysisId: first.analysisId,
    datasetVersionId: 'superstore-v1-test',
    semanticRevisionId: 'sem-superstore-v1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'superstore-v1-test',
      semanticRevisionId: 'sem-superstore-v1',
      sql: 'SELECT region FROM orders',
      parameters: [],
    },
    resultId: 'res_def',
    chart: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    artifactIds: ['art_def'],
  })
  expect(second.revision).toBe(2)
  expect(second.analysisId).toBe(first.analysisId)

  const listed = await listAnalysisRevisions(catalogPath)
  expect(listed).toHaveLength(1)
  expect(listed[0]!.revision).toBe(2)

  const loaded = await loadAnalysisRevision(catalogPath, first.analysisId)
  expect(loaded.resultId).toBe('res_def')

  // Append-only: prior revision row remains readable by explicit revision.
  const store = new MetadataStore(catalogPath)
  try {
    const rev1 = store.loadAnalysisRevision(first.analysisId, 1)
    expect(rev1?.resultId).toBe('res_abc')
    const rev2 = store.loadAnalysisRevision(first.analysisId, 2)
    expect(rev2?.resultId).toBe('res_def')
  } finally {
    store.close()
  }
})

it('rejects optimistic concurrency mismatch', async () => {
  const first = await saveAnalysisRevision(catalogPath, {
    datasetVersionId: 'superstore-v1-test',
    semanticRevisionId: 'sem-superstore-v1',
    question: 'Q',
    query: {
      datasetVersionId: 'superstore-v1-test',
      semanticRevisionId: 'sem-superstore-v1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_a',
    chart: { mark: 'bar', title: 'T' },
    artifactIds: [],
  })
  await expect(
    saveAnalysisRevision(catalogPath, {
      analysisId: first.analysisId,
      expectedRevision: 0,
      datasetVersionId: 'superstore-v1-test',
      semanticRevisionId: 'sem-superstore-v1',
      question: 'Q2',
      query: {
        datasetVersionId: 'superstore-v1-test',
        semanticRevisionId: 'sem-superstore-v1',
        sql: 'SELECT 2',
        parameters: [],
      },
      resultId: 'res_b',
      chart: { mark: 'bar', title: 'T' },
      artifactIds: [],
    }),
  ).rejects.toThrow(/revision|conflict/i)
})

it('records an "analysis persisted" workflow trail milestone on save', async () => {
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
    resultId: 'res_trail',
    chart: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    artifactIds: ['art_trail'],
  })

  const store = new MetadataStore(catalogPath)
  try {
    const trail = store.listWorkflowTrail({ analysisId: saved.analysisId })
    expect(trail).toHaveLength(1)
    expect(trail[0]).toMatchObject({
      milestone: 'analysis_persisted',
      actor: 'service',
      datasetVersionId: 'superstore-v1-test',
      analysisId: saved.analysisId,
      receiptId: `${saved.analysisId}:${saved.revision}`,
    })
  } finally {
    store.close()
  }
})
