/**
 * Correctness properties `POST /api/analyst/ui/dashboard/:id/filter`
 * (`handleDashboardFilterRequest`) must uphold:
 *
 * 1. Critical ordering — files must be promoted to their public paths
 *    *before* the one SQLite metadata transaction runs, so metadata never
 *    publishes a pointer to a file that does not exist.
 * 2. Partial promotion cleanup — a promotion failure must not leave a
 *    partially-committed state or dangling published metadata.
 * 3. Unsupported vs failure — a policy violation on one slot must be
 *    disclosed as unsupported without aborting an otherwise-successful
 *    sibling slot's atomic publish; a genuine execution failure must roll
 *    back the whole publish (including any sibling that individually
 *    succeeded).
 * 4. Cancellation — an aborted request must not publish anything and must
 *    not leave staged/promoted outputs behind.
 *
 * Mirrors dashboard-shared-filter.integration.test.ts's retail-fixture
 * ingest setup, but drives `handleDashboardFilterRequest` directly so each
 * failure mode can be induced deterministically.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { saveAnalysisRevision } from '../../dsh-data-core/src/analysis-store.js'
import { MetadataStore } from '../../dsh-data-core/src/metadata-store.js'
import { RETAIL_FIXTURE_RECIPE } from '../../dsh-data-core/src/recipes/retail-fixture.js'
import {
  resolveWorkspacePaths,
  type WorkspacePaths,
} from '../../dsh-data-core/src/workspace-paths.js'
import { runIngestFromArchive } from '../../dsh-data-duckdb/src/ingest-pipeline.js'
import { handleDashboardFilterRequest } from '../src/ui-routes.js'

const SEMANTIC_REVISION_ID = 'sem-retail-fixture-v1'

let directory: string
let workspace: WorkspacePaths
let dashboardId: string
let analysisAId: string // valid, mapped, will succeed
let analysisPolicyId: string // mapped, but its SQL fails policy (disallowed function)
let analysisExecId: string // mapped, but its SQL fails at execution (unknown column)

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

function filterRequest(
  expectedVersion: string,
  column = 'region',
  value = 'North',
  signal?: AbortSignal,
): Request {
  return new Request(`http://localhost/api/analyst/ui/dashboard/filter`, {
    method: 'POST',
    headers: {
      host: 'localhost',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ expectedVersion, dashboardId, column, value }),
    signal,
  })
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-wb-filter-atomic-'))
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
    idempotencyKey: 'workbench-filter-atomic-v1',
  })
  workspace = resolveWorkspacePaths(directory)

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
    resultId: 'res_card_a_seed',
    chart: { mark: 'bar', title: 'Revenue by region', x: 'region', y: 'revenue' },
    artifactIds: [],
  })
  analysisAId = savedA.analysisId

  // `stddev` is not on the authorized function allowlist (sql-policy.ts) —
  // re-authorizing this slot's filtered SQL always fails policy.
  const savedPolicy = await saveAnalysisRevision(workspace.catalogPath, {
    datasetVersionId,
    semanticRevisionId: SEMANTIC_REVISION_ID,
    question: 'Revenue spread by region',
    query: {
      datasetVersionId,
      semanticRevisionId: SEMANTIC_REVISION_ID,
      sql: 'SELECT region, STDDEV(amount) AS spread FROM retail GROUP BY region',
      parameters: [],
    },
    resultId: 'res_card_policy_seed',
    chart: { mark: 'bar', title: 'Revenue spread', x: 'region', y: 'spread' },
    artifactIds: [],
  })
  analysisPolicyId = savedPolicy.analysisId

  // `not_a_real_column` parses fine (policy does not check column existence)
  // but fails at query execution (DuckDB binder error).
  const savedExec = await saveAnalysisRevision(workspace.catalogPath, {
    datasetVersionId,
    semanticRevisionId: SEMANTIC_REVISION_ID,
    question: 'Bogus revenue by region',
    query: {
      datasetVersionId,
      semanticRevisionId: SEMANTIC_REVISION_ID,
      sql: 'SELECT region, SUM(not_a_real_column) AS revenue FROM retail GROUP BY region',
      parameters: [],
    },
    resultId: 'res_card_exec_seed',
    chart: { mark: 'bar', title: 'Bogus revenue', x: 'region', y: 'revenue' },
    artifactIds: [],
  })
  analysisExecId = savedExec.analysisId

  const store2 = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store2.saveDashboard({ title: 'Ops overview' })
    dashboardId = dashboard.dashboardId
    store2.pinAnalysisToDashboard(dashboardId, analysisAId, savedA.revision, 'Revenue by region')
    store2.pinAnalysisToDashboard(
      dashboardId,
      analysisPolicyId,
      savedPolicy.revision,
      'Revenue spread',
    )
    store2.pinAnalysisToDashboard(dashboardId, analysisExecId, savedExec.revision, 'Bogus revenue')
    store2.setDashboardSharedFilterKeys(dashboardId, analysisAId, ['region'])
    store2.setDashboardSharedFilterKeys(dashboardId, analysisPolicyId, ['region'])
    store2.setDashboardSharedFilterKeys(dashboardId, analysisExecId, ['region'])
  } finally {
    store2.close()
  }
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function currentDashboardVersion(): string {
  const store = new MetadataStore(workspace.catalogPath)
  try {
    return store.loadDashboard(dashboardId)!.updatedAt
  } finally {
    store.close()
  }
}

it("discloses a policy violation as unsupported without aborting a sibling slot's atomic publish", async () => {
  // Unpin the execution-failure slot for this test; only the policy-failure
  // slot and the valid slot remain, isolating the "unsupported" behavior
  // from the "execution failure -> full rollback" behavior.
  const store = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store.loadDashboard(dashboardId)!
    store.saveDashboard({
      dashboardId,
      title: dashboard.title,
      layout: {
        slots: dashboard.layout.slots.filter((slot) => slot.analysisId !== analysisExecId),
      },
    })
  } finally {
    store.close()
  }
  const expectedVersion = currentDashboardVersion()

  const response = await handleDashboardFilterRequest(
    filterRequest(expectedVersion),
    workspace.catalogPath,
  )

  expect(response.status).toBe(200)
  const html = await response.text()
  expect(html).toContain('unsupported')

  const store2 = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store2.loadDashboard(dashboardId)!
    const slotA = dashboard.layout.slots.find((s) => s.analysisId === analysisAId)
    const slotPolicy = dashboard.layout.slots.find((s) => s.analysisId === analysisPolicyId)
    expect(slotA?.revision).toBe(2) // supported slot published despite sibling policy failure
    expect(slotPolicy?.revision).toBe(1) // unsupported slot never receives a new revision
    const revisionA = store2.loadAnalysisRevision(analysisAId, 2)
    expect(revisionA).toBeDefined()
    // The staged publish must disclose the applied filter exactly the way
    // the persisted `saveAnalysisRevision` tool path does — a published card
    // never silently shows filtered numbers under its unfiltered question.
    expect(revisionA!.question).toBe('Revenue by region [filter region=North]')
    // ...and must not persist the transport-only fields that carried the
    // draft through staging into the stored manifest.
    expect(revisionA).not.toHaveProperty('expectedRevision')
    expect(revisionA).not.toHaveProperty('filter')
    // The promoted result file backing the new revision must actually exist
    // — metadata never points at a file that was not promoted.
    await expect(
      readFile(join(workspace.resultsDir, `${revisionA!.resultId}.json`), 'utf8'),
    ).resolves.toBeTruthy()
  } finally {
    store2.close()
  }
})

it('rolls back the whole publish on an execution failure, even for a sibling slot that individually succeeded', async () => {
  const store = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store.loadDashboard(dashboardId)!
    store.saveDashboard({
      dashboardId,
      title: dashboard.title,
      layout: {
        slots: dashboard.layout.slots.filter((slot) => slot.analysisId !== analysisPolicyId),
      },
    })
  } finally {
    store.close()
  }
  const expectedVersion = currentDashboardVersion()
  const resultsBefore = await listFiles(workspace.resultsDir)

  const response = await handleDashboardFilterRequest(
    filterRequest(expectedVersion),
    workspace.catalogPath,
  )

  expect(response.status).toBe(500)

  // Nothing published: dashboard version and every slot's revision are
  // exactly as they were before the request, including analysis A which
  // individually succeeded before the sibling's execution failure aborted
  // the whole publish.
  expect(currentDashboardVersion()).toBe(expectedVersion)
  const store2 = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store2.loadDashboard(dashboardId)!
    expect(dashboard.layout.slots.find((s) => s.analysisId === analysisAId)?.revision).toBe(1)
    expect(store2.loadAnalysisRevision(analysisAId, 2)).toBeUndefined()
  } finally {
    store2.close()
  }

  // No orphaned promoted result file and no leftover staging directory.
  expect(await listFiles(workspace.resultsDir)).toEqual(resultsBefore)
  expect(await listFiles(join(directory, '.ui-staging'))).toEqual([])
})

it('never commits metadata when file promotion fails, and rolls back any already-promoted file', async () => {
  const store = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store.loadDashboard(dashboardId)!
    store.saveDashboard({
      dashboardId,
      title: dashboard.title,
      layout: { slots: dashboard.layout.slots.filter((slot) => slot.analysisId === analysisAId) },
    })
  } finally {
    store.close()
  }
  const expectedVersion = currentDashboardVersion()

  // Block promotion deterministically: `resultsDir` does not exist yet (no
  // result has ever been physically written there), so replacing it with a
  // plain file makes `commitStaged`'s `mkdir(resultsDir, ...)` fail for
  // every file in that category, before any SQLite transaction runs.
  await writeFile(workspace.resultsDir, 'blocker')

  const response = await handleDashboardFilterRequest(
    filterRequest(expectedVersion),
    workspace.catalogPath,
  )

  expect(response.status).toBe(500)
  // Critical ordering: metadata must never publish when the files it would
  // point at failed to become publicly addressable.
  expect(currentDashboardVersion()).toBe(expectedVersion)
  const store2 = new MetadataStore(workspace.catalogPath)
  try {
    expect(store2.loadAnalysisRevision(analysisAId, 2)).toBeUndefined()
  } finally {
    store2.close()
  }
  // Staged work is fully cleaned up — no leftover `.ui-staging` directory.
  expect(await listFiles(join(directory, '.ui-staging'))).toEqual([])
})

it('does not publish when the request is aborted, and leaves no staged output behind', async () => {
  const store = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store.loadDashboard(dashboardId)!
    store.saveDashboard({
      dashboardId,
      title: dashboard.title,
      layout: { slots: dashboard.layout.slots.filter((slot) => slot.analysisId === analysisAId) },
    })
  } finally {
    store.close()
  }
  const expectedVersion = currentDashboardVersion()

  const controller = new AbortController()
  controller.abort()

  const response = await handleDashboardFilterRequest(
    filterRequest(expectedVersion, 'region', 'North', controller.signal),
    workspace.catalogPath,
  )

  expect(response.status).toBe(499)
  expect(currentDashboardVersion()).toBe(expectedVersion)
  const store2 = new MetadataStore(workspace.catalogPath)
  try {
    expect(store2.loadAnalysisRevision(analysisAId, 2)).toBeUndefined()
  } finally {
    store2.close()
  }
  expect(await listFiles(join(directory, '.ui-staging'))).toEqual([])
})
