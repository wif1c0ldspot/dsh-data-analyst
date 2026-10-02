/**
 * `publishDashboardFilter` must honor each prepared
 * revision's `expectedRevision` (the analysis revision the filtered draft
 * was built against) so a stale draft — prepared before a concurrent write
 * moved that analysis to a newer revision — cannot silently overwrite or pin
 * over it. A conflict must roll back the *whole* publish transaction,
 * including any other slot's revision insert in the same call, never a
 * partial set of slots.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { saveAnalysisRevision } from '../src/analysis-store.js'
import { AnalysisRevisionConflictError, MetadataStore } from '../src/metadata-store.js'
import type { AnalysisRevision } from '../src/contracts.js'

let directory: string
let catalogPath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-dashboard-filter-'))
  catalogPath = join(directory, 'catalog.sqlite')
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

function preparedDraft(
  analysis: AnalysisRevision,
  expectedRevision: number,
  resultId: string,
): AnalysisRevision & { expectedRevision: number } {
  return {
    contractVersion: 1,
    analysisId: analysis.analysisId,
    revision: 0,
    datasetVersionId: analysis.datasetVersionId,
    semanticRevisionId: analysis.semanticRevisionId,
    question: analysis.question,
    query: analysis.query,
    resultId,
    chart: analysis.chart,
    artifactIds: [],
    createdAt: new Date().toISOString(),
    expectedRevision,
  }
}

it('publishes prepared revisions and bumps the dashboard version atomically', async () => {
  const saved = await saveAnalysisRevision(catalogPath, {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Q',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_seed',
    chart: { mark: 'bar', title: 'T' },
    artifactIds: [],
  })
  const store = new MetadataStore(catalogPath)
  try {
    const dashboard = store.saveDashboard({
      title: 'D',
      layout: {
        slots: [
          { analysisId: saved.analysisId, revision: 1, title: 'T', sharedFilterKeys: ['region'] },
        ],
      },
    })
    const updated = store.publishDashboardFilter(dashboard.dashboardId, dashboard.updatedAt, [
      preparedDraft(saved, 1, 'res_filtered'),
    ])
    const slot = updated.layout.slots.find((s) => s.analysisId === saved.analysisId)
    expect(slot?.revision).toBe(2)
    const revision2 = store.loadAnalysisRevision(saved.analysisId, 2)
    expect(revision2?.resultId).toBe('res_filtered')
    // `expectedRevision` guards the insert; it is never part of the manifest.
    expect(revision2).not.toHaveProperty('expectedRevision')
  } finally {
    store.close()
  }
})

it('persists bounded active-filter metadata independently of dashboard presentation edits', async () => {
  const saved = await saveAnalysisRevision(catalogPath, {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'Q',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_seed',
    chart: { mark: 'bar', title: 'T' },
    artifactIds: [],
  })
  const store = new MetadataStore(catalogPath)
  try {
    const dashboard = store.saveDashboard({
      title: 'D',
      layout: {
        slots: [
          {
            analysisId: saved.analysisId,
            revision: 1,
            title: 'T',
            width: 2,
            sharedFilterKeys: ['region'],
          },
        ],
      },
    })
    const filtered = store.publishDashboardFilter(dashboard.dashboardId, dashboard.updatedAt, [], {
      column: 'region',
      value: 'North',
      scope: 'saved-result',
      appliedDashboardVersion: dashboard.updatedAt,
      cards: [{ analysisId: saved.analysisId, baseRevision: 1, status: 'unmapped' }],
    })
    expect(filtered.activeFilter?.value).toBe('North')
    store.renameDashboard(dashboard.dashboardId, 'Renamed')
    store.setDashboardArchived(dashboard.dashboardId, true)
    store.setDashboardSharedFilterKeys(dashboard.dashboardId, saved.analysisId, [
      'region',
      'segment',
    ])
    const reopened = store.loadDashboard(dashboard.dashboardId)!
    expect(reopened.activeFilter?.value).toBe('North')
    expect(reopened.layout.slots[0]).toMatchObject({
      width: 2,
      title: 'T',
      sharedFilterKeys: ['region', 'segment'],
    })
  } finally {
    store.close()
  }
})

it('advances the dashboard version for every mutation within the same millisecond', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-18T04:00:00.000Z'))
  const store = new MetadataStore(catalogPath)
  try {
    let dashboard = store.saveDashboard({ title: 'D' })
    const versions = [dashboard.updatedAt]
    const record = (next: typeof dashboard) => {
      dashboard = next
      versions.push(next.updatedAt)
    }

    record(store.saveDashboard({ dashboardId: dashboard.dashboardId, title: 'D2' }))
    record(
      store.updateDashboardLayout(dashboard.dashboardId, dashboard.updatedAt, dashboard.layout),
    )
    record(store.pinAnalysisToDashboard(dashboard.dashboardId, 'ana_abc123', 1, 'Card'))
    record(store.setDashboardSharedFilterKeys(dashboard.dashboardId, 'ana_abc123', ['region']))
    record(store.renameDashboard(dashboard.dashboardId, 'D3'))
    record(store.setDashboardArchived(dashboard.dashboardId, true))

    expect(versions).toEqual(
      [...versions].sort((left, right) => Date.parse(left) - Date.parse(right)),
    )
    expect(new Set(versions).size).toBe(versions.length)
  } finally {
    store.close()
  }
})

it('rejects a stale prepared revision and rolls back the whole publish, including sibling slots', async () => {
  const savedA = await saveAnalysisRevision(catalogPath, {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'A',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_a_seed',
    chart: { mark: 'bar', title: 'A' },
    artifactIds: [],
  })
  const savedB = await saveAnalysisRevision(catalogPath, {
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'B',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 2',
      parameters: [],
    },
    resultId: 'res_b_seed',
    chart: { mark: 'bar', title: 'B' },
    artifactIds: [],
  })

  const store = new MetadataStore(catalogPath)
  let dashboardId: string
  try {
    const dashboard = store.saveDashboard({
      title: 'D',
      layout: {
        slots: [
          { analysisId: savedA.analysisId, revision: 1, title: 'A', sharedFilterKeys: ['region'] },
          { analysisId: savedB.analysisId, revision: 1, title: 'B', sharedFilterKeys: ['region'] },
        ],
      },
    })
    dashboardId = dashboard.dashboardId
  } finally {
    store.close()
  }

  // A concurrent write (e.g. a correction, or a previous shared-filter apply)
  // moves analysis A to revision 2 *after* this filtered draft for A was
  // prepared against revision 1 — the draft below is now stale.
  await saveAnalysisRevision(catalogPath, {
    analysisId: savedA.analysisId,
    expectedRevision: 1,
    datasetVersionId: 'ds_1',
    semanticRevisionId: 'sem_1',
    question: 'A corrected',
    query: {
      datasetVersionId: 'ds_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 3',
      parameters: [],
    },
    resultId: 'res_a_concurrent',
    chart: { mark: 'bar', title: 'A' },
    artifactIds: [],
  })

  const store2 = new MetadataStore(catalogPath)
  try {
    const dashboardBefore = store2.loadDashboard(dashboardId)!
    expect(() =>
      store2.publishDashboardFilter(dashboardId, dashboardBefore.updatedAt, [
        preparedDraft(savedA, 1, 'res_a_filtered'), // stale: current max is 2
        preparedDraft(savedB, 1, 'res_b_filtered'), // otherwise valid sibling
      ]),
    ).toThrow(AnalysisRevisionConflictError)

    // Whole-transaction rollback: B must not have been published either,
    // even though its own expectedRevision was still current.
    const revisionsB = [1, 2, 3].map((revision) =>
      store2.loadAnalysisRevision(savedB.analysisId, revision),
    )
    expect(revisionsB.filter(Boolean)).toHaveLength(1)
    const dashboardAfter = store2.loadDashboard(dashboardId)!
    expect(dashboardAfter.updatedAt).toBe(dashboardBefore.updatedAt)
    const slotB = dashboardAfter.layout.slots.find((s) => s.analysisId === savedB.analysisId)
    expect(slotB?.revision).toBe(1)
  } finally {
    store2.close()
  }
})
