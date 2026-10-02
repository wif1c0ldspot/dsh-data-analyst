import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it, afterEach, beforeEach } from 'vitest'
import type { DatasetManifest } from '../src/contracts.js'
import {
  DatasetVersionNotFoundError,
  InvalidJobTransitionError,
  JobNotFoundError,
  MetadataStore,
  WorkspaceSourcePinNotFoundError,
} from '../src/metadata-store.js'
import { MIGRATIONS, runMigrations } from '../src/migrations.js'
import type { IngestRecipe } from '../src/recipes/types.js'

let directory: string
let dbPath: string
let store: MetadataStore

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-metadata-store-test-'))
  dbPath = join(directory, 'catalog.sqlite')
  store = new MetadataStore(dbPath)
})

afterEach(async () => {
  store.close()
  await rm(directory, { recursive: true, force: true })
})

function manifest(overrides: Partial<DatasetManifest> = {}): DatasetManifest {
  return {
    contractVersion: 1,
    datasetId: 'superstore',
    datasetVersionId: 'superstore-v1',
    source: {
      slug: 'vivek468/superstore-dataset-final',
      version: '1',
      url: 'https://www.kaggle.com/datasets/vivek468/superstore-dataset-final',
      retrievedAt: '2026-09-13T00:00:00.000Z',
      license: 'CC0',
    },
    files: [{ name: 'Sample - Superstore.csv', sha256: 'abc123', bytes: 1024, format: 'csv' }],
    recipeHash: 'recipe-v1',
    importerVersion: '0.1.0',
    tables: [{ id: 'orders', sourceFile: 'Sample - Superstore.csv', rows: 9994, rejectedRows: 0 }],
    ...overrides,
  }
}

it('applying migrations twice is a no-op (idempotent)', () => {
  // store's constructor already ran them once; run again directly.
  const raw = new Database(dbPath)
  expect(() => runMigrations(raw)).not.toThrow()
  const versions = raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
    version: number
  }[]
  expect(versions.map((row) => row.version)).toEqual(
    MIGRATIONS.map((migration) => migration.version),
  )
  raw.close()
})

it('creates a queued job and reuses the same job for a repeated idempotency key', () => {
  const first = store.createImportJob({
    idempotencyKey: 'key-1',
    slug: 'vivek468/superstore-dataset-final',
  })
  expect(first.status).toBe('queued')
  expect(first.datasetVersionId).toBeNull()

  const second = store.createImportJob({
    idempotencyKey: 'key-1',
    slug: 'vivek468/superstore-dataset-final',
  })
  expect(second.jobId).toBe(first.jobId) // reused, not duplicated.

  const third = store.createImportJob({
    idempotencyKey: 'key-2',
    slug: 'vivek468/superstore-dataset-final',
  })
  expect(third.jobId).not.toBe(first.jobId)
})

it('advances a job through its lifecycle and rejects an invalid transition', () => {
  const job = store.createImportJob({ idempotencyKey: 'key-lifecycle', slug: 'owner/dataset' })
  store.updateImportJobStatus(job.jobId, 'downloading')
  store.updateImportJobStatus(job.jobId, 'validating')
  store.updateImportJobStatus(job.jobId, 'loading')
  store.updateImportJobStatus(job.jobId, 'profiling')
  const ready = store.updateImportJobStatus(job.jobId, 'ready', {
    datasetVersionId: 'superstore-v1',
  })
  expect(ready.status).toBe('ready')
  expect(ready.datasetVersionId).toBe('superstore-v1')

  // A ready job is terminal: even re-queuing is rejected, not silently accepted.
  expect(() => store.updateImportJobStatus(job.jobId, 'queued')).toThrow(InvalidJobTransitionError)
})

it('rejects skipping a phase (queued straight to ready)', () => {
  const job = store.createImportJob({ idempotencyKey: 'key-skip', slug: 'owner/dataset' })
  expect(() => store.updateImportJobStatus(job.jobId, 'ready')).toThrow(InvalidJobTransitionError)
})

it('throws for an unknown job id rather than silently no-op-ing', () => {
  expect(() => store.updateImportJobStatus('does-not-exist', 'downloading')).toThrow(
    JobNotFoundError,
  )
  expect(store.getImportJob('does-not-exist')).toBeUndefined()
})

it('recovers interrupted jobs as failed, distinguishing them from a successful ready job', () => {
  const stuck = store.createImportJob({ idempotencyKey: 'key-stuck', slug: 'owner/dataset' })
  store.updateImportJobStatus(stuck.jobId, 'downloading')
  store.updateImportJobStatus(stuck.jobId, 'validating') // left here, simulating a crash.

  const finished = store.createImportJob({ idempotencyKey: 'key-finished', slug: 'owner/dataset' })
  store.updateImportJobStatus(finished.jobId, 'downloading')
  store.updateImportJobStatus(finished.jobId, 'validating')
  store.updateImportJobStatus(finished.jobId, 'loading')
  store.updateImportJobStatus(finished.jobId, 'profiling')
  store.updateImportJobStatus(finished.jobId, 'ready', { datasetVersionId: 'v1' })

  const recovered = store.recoverInterruptedImportJobs('simulated crash')
  expect(recovered).toHaveLength(1)
  expect(recovered[0]?.jobId).toBe(stuck.jobId)
  expect(recovered[0]?.status).toBe('failed')
  expect(recovered[0]?.errorMessage).toBe('simulated crash')

  // The already-ready job is untouched by recovery.
  expect(store.getImportJob(finished.jobId)?.status).toBe('ready')
  expect(store.listInterruptedImportJobs()).toEqual([])
})

it('lists all import jobs ordered by updated_at descending', async () => {
  const first = store.createImportJob({ idempotencyKey: 'list-1', slug: 'owner/one' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = store.createImportJob({ idempotencyKey: 'list-2', slug: 'owner/two' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  store.updateImportJobStatus(first.jobId, 'downloading')
  const listed = store.listImportJobs()
  expect(listed).toHaveLength(2)
  expect(listed.map((job) => job.jobId)).toEqual([first.jobId, second.jobId])
  expect(listed.find((job) => job.jobId === first.jobId)?.status).toBe('downloading')
  expect(listed.find((job) => job.jobId === second.jobId)?.slug).toBe('owner/two')
})

it('publishes a dataset version atomically and exposes it as the current pointer', () => {
  expect(store.getCurrentDatasetVersion('superstore')).toBeUndefined()
  store.publishDatasetVersion(manifest())
  const current = store.getCurrentDatasetVersion('superstore')
  expect(current?.datasetVersionId).toBe('superstore-v1')
  expect(current?.tables[0]?.rows).toBe(9994)
})

it('a later published version replaces the current pointer without losing the older version', () => {
  store.publishDatasetVersion(manifest())
  store.publishDatasetVersion(
    manifest({ datasetVersionId: 'superstore-v2', source: { ...manifest().source, version: '2' } }),
  )
  expect(store.getCurrentDatasetVersion('superstore')?.datasetVersionId).toBe('superstore-v2')
  expect(store.getDatasetVersion('superstore-v1')?.datasetVersionId).toBe('superstore-v1')
  expect(
    store.listDatasetVersions('superstore').map((version) => version.datasetVersionId),
  ).toEqual(['superstore-v1', 'superstore-v2'])
})

it('a repeated ready import request reuses an identical ready version rather than re-publishing', () => {
  const job = store.createImportJob({
    idempotencyKey: 'same-request',
    slug: 'vivek468/superstore-dataset-final',
  })
  store.updateImportJobStatus(job.jobId, 'downloading')
  store.updateImportJobStatus(job.jobId, 'validating')
  store.updateImportJobStatus(job.jobId, 'loading')
  store.updateImportJobStatus(job.jobId, 'profiling')
  store.updateImportJobStatus(job.jobId, 'ready', { datasetVersionId: 'superstore-v1' })
  store.publishDatasetVersion(manifest())

  // A repeated request with the same idempotency key returns the same ready
  // job/version rather than creating a second job or a duplicate version row.
  const repeated = store.createImportJob({
    idempotencyKey: 'same-request',
    slug: 'vivek468/superstore-dataset-final',
  })
  expect(repeated.jobId).toBe(job.jobId)
  expect(repeated.status).toBe('ready')
  expect(store.listDatasetVersions('superstore')).toHaveLength(1)
})

it('surfaces a missing dataset version explicitly instead of returning an empty manifest', () => {
  expect(store.getDatasetVersion('does-not-exist')).toBeUndefined()
  // DatasetVersionNotFoundError is exported for callers that want to throw
  // rather than handle undefined; the store itself returns undefined so
  // callers choose the failure mode (e.g. a 404 vs a "not yet imported" state).
  expect(DatasetVersionNotFoundError).toBeDefined()
})

it('reopening the database after closing preserves published versions and job history', () => {
  store.publishDatasetVersion(manifest())
  const job = store.createImportJob({ idempotencyKey: 'persisted', slug: 'owner/dataset' })
  store.close()

  // Reassign before asserting so the shared afterEach closes this instance,
  // not the already-closed one.
  store = new MetadataStore(dbPath)
  expect(store.getCurrentDatasetVersion('superstore')?.datasetVersionId).toBe('superstore-v1')
  expect(store.getImportJob(job.jobId)?.idempotencyKey).toBe('persisted')
})

it('persists bounded report provenance across reopening and rejects unknown metadata', () => {
  const report = store.recordReportExport({
    reportId: 'export_0123456789abcdef0123456789abcdef',
    title: 'Hourly demand',
    source: {
      kind: 'analysis',
      analysisId: 'ana_123',
      revision: 2,
      resultId: 'res_123',
      datasetVersionId: 'bike-v1',
      semanticRevisionId: 'bike-sem-v1',
    },
    files: {
      html: 'export_0123456789abcdef0123456789abcdef.html',
      svg: 'export_0123456789abcdef0123456789abcdef.svg',
      csv: 'export_0123456789abcdef0123456789abcdef.csv',
      png: 'export_0123456789abcdef0123456789abcdef.png',
      specification: 'export_0123456789abcdef0123456789abcdef_spec.json',
      analysis: 'export_0123456789abcdef0123456789abcdef_analysis.json',
    },
  })
  expect(report.source).toMatchObject({ analysisId: 'ana_123', revision: 2 })
  store.close()
  store = new MetadataStore(dbPath)
  expect(store.listReportExports()).toEqual([report])
  expect(() =>
    store.recordReportExport({
      ...report,
      source: { ...report.source, untrusted: true } as never,
    }),
  ).toThrow()
})

it('applies migrations for dashboards, feedback, aliases, and learning examples', () => {
  const raw = new Database(dbPath)
  const tables = raw
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('dashboards', 'feedback', 'learning_examples', 'semantic_alias_candidates') ORDER BY name`,
    )
    .all() as { name: string }[]
  expect(tables.map((row) => row.name)).toEqual([
    'dashboards',
    'feedback',
    'learning_examples',
    'semantic_alias_candidates',
  ])
  const versions = raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
    version: number
  }[]
  expect(versions.map((row) => row.version)).toContain(4)
  raw.close()
})

it('applies the workspace_source_pins migration (version 5)', () => {
  const raw = new Database(dbPath)
  const tables = raw
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_source_pins'`,
    )
    .all() as { name: string }[]
  expect(tables).toHaveLength(1)
  const versions = raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
    version: number
  }[]
  expect(versions.map((row) => row.version)).toContain(5)
  raw.close()
})

it('retrieves only approved schema- and semantics-compatible SQL corrections', () => {
  const base = {
    analysisId: 'ana_abc123',
    analysisRevision: 1,
    datasetId: 'superstore',
    datasetVersionId: 'superstore-v1',
    schemaFingerprint: 'recipe-v1',
    semanticRevisionId: 'sem-superstore-v1',
    question: 'Sales by region',
    correctedSql: 'SELECT region, SUM(sales) AS sales FROM orders GROUP BY region',
    actorId: 'analyst-1',
  }
  const candidate = store.createLearningExample(base)
  expect(
    store.listCompatibleLearningExamples({
      datasetId: 'superstore',
      schemaFingerprint: 'recipe-v1',
      semanticRevisionId: 'sem-superstore-v1',
    }),
  ).toEqual([])

  store.setLearningExampleStatus(candidate.exampleId, 'approved')
  expect(
    store.listCompatibleLearningExamples({
      datasetId: 'superstore',
      schemaFingerprint: 'recipe-v1',
      semanticRevisionId: 'sem-superstore-v1',
    }),
  ).toEqual([expect.objectContaining({ exampleId: candidate.exampleId, status: 'approved' })])
  expect(
    store.listCompatibleLearningExamples({
      datasetId: 'superstore',
      schemaFingerprint: 'recipe-v2',
      semanticRevisionId: 'sem-superstore-v1',
    }),
  ).toEqual([])

  store.setLearningExampleStatus(candidate.exampleId, 'revoked')
  expect(
    store.listCompatibleLearningExamples({
      datasetId: 'superstore',
      schemaFingerprint: 'recipe-v1',
      semanticRevisionId: 'sem-superstore-v1',
    }),
  ).toEqual([])
})

it('saves, lists, loads, and pins analyses to dashboards', () => {
  const created = store.saveDashboard({
    title: 'Ops overview',
    layout: { slots: [] },
  })
  expect(created.dashboardId).toMatch(/^dash_/)
  expect(created.title).toBe('Ops overview')
  expect(created.layout.slots).toEqual([])

  const pinned = store.pinAnalysisToDashboard(created.dashboardId, 'ana_abc123', 1, 'West revenue')
  expect(pinned.layout.slots).toHaveLength(1)
  expect(pinned.layout.slots[0]).toEqual({
    analysisId: 'ana_abc123',
    revision: 1,
    title: 'West revenue',
    sharedFilterKeys: [],
  })

  store.saveDashboard({
    dashboardId: created.dashboardId,
    title: created.title,
    layout: { slots: [{ ...pinned.layout.slots[0]!, width: 2, sharedFilterKeys: ['region'] }] },
  })
  // Re-pinning replaces the revision while retaining analyst layout and mappings.
  const pinnedAgain = store.pinAnalysisToDashboard(created.dashboardId, 'ana_abc123', 2)
  expect(pinnedAgain.layout.slots).toHaveLength(1)
  expect(pinnedAgain.layout.slots[0]?.revision).toBe(2)
  expect(pinnedAgain.layout.slots[0]?.title).toBe('West revenue')
  expect(pinnedAgain.layout.slots[0]?.width).toBe(2)
  expect(pinnedAgain.layout.slots[0]?.sharedFilterKeys).toEqual(['region'])

  store.pinAnalysisToDashboard(created.dashboardId, 'ana_def456', 1, 'East revenue')
  const loaded = store.loadDashboard(created.dashboardId)
  expect(loaded?.layout.slots).toHaveLength(2)

  const listed = store.listDashboards()
  expect(listed.map((d) => d.dashboardId)).toContain(created.dashboardId)
})

it('renames and soft-deletes dashboards without touching pinned analyses', () => {
  const created = store.saveDashboard({ title: 'Ops overview' })
  store.pinAnalysisToDashboard(created.dashboardId, 'ana_abc123', 1, 'West revenue')

  const renamed = store.renameDashboard(created.dashboardId, 'Renamed ops')
  expect(renamed.title).toBe('Renamed ops')
  expect(renamed.layout.slots).toHaveLength(1) // layout preserved by rename
  expect(renamed.archived).toBe(false)

  const archived = store.setDashboardArchived(created.dashboardId, true)
  expect(archived.archived).toBe(true)
  expect(archived.layout.slots).toHaveLength(1) // layout preserved by archive

  // Archived dashboards stay listed (recoverable) and flagged.
  const listed = store.listDashboards().find((d) => d.dashboardId === created.dashboardId)
  expect(listed?.archived).toBe(true)

  const restored = store.setDashboardArchived(created.dashboardId, false)
  expect(restored.archived).toBe(false)

  expect(() => store.renameDashboard('dash_missing', 'x')).toThrow(/does not exist/)
  expect(() => store.setDashboardArchived('dash_missing', true)).toThrow(/does not exist/)
})

it('creates feedback, lists by analysis, and updates approval status', () => {
  const feedback = store.createFeedback({
    analysisId: 'ana_abc123',
    analysisRevision: 1,
    kind: 'vote',
    actorId: 'operator-local',
    comment: 'Looks right',
  })
  expect(feedback.feedbackId).toMatch(/^fb_/)
  expect(feedback.status).toBe('candidate')
  expect(feedback.kind).toBe('vote')

  store.createFeedback({
    analysisId: 'ana_abc123',
    analysisRevision: 1,
    kind: 'preference',
    actorId: 'operator-local',
    comment: 'Prefer bar chart',
    status: 'candidate',
  })
  store.createFeedback({
    analysisId: 'ana_other',
    analysisRevision: 1,
    kind: 'sql-correction',
    actorId: 'operator-local',
    comment: 'Use SUM(sales)',
  })

  const listed = store.listFeedback('ana_abc123')
  expect(listed).toHaveLength(2)

  const approved = store.setFeedbackStatus(feedback.feedbackId, 'approved')
  expect(approved.status).toBe('approved')
  const revoked = store.setFeedbackStatus(feedback.feedbackId, 'revoked')
  expect(revoked.status).toBe('revoked')
})

it('creates alias candidates, lists with filters, and records review status without mutating code semantics', () => {
  const candidate = store.createAliasCandidate({
    datasetId: 'superstore',
    term: 'margin',
    expression: 'SUM(profit) / NULLIF(SUM(sales), 0)',
    description: 'Profit margin ratio',
    tableId: 'orders',
    actorId: 'operator-local',
  })
  expect(candidate.candidateId).toMatch(/^alias_/)
  expect(candidate.status).toBe('candidate')
  expect(candidate.reviewedAt).toBeNull()

  store.createAliasCandidate({
    datasetId: 'olist',
    term: 'ticket',
    expression: 'AVG(price)',
    description: 'Average item price',
    tableId: 'order_items',
    actorId: 'operator-local',
  })

  expect(store.listAliasCandidates()).toHaveLength(2)
  expect(store.listAliasCandidates('superstore')).toHaveLength(1)
  expect(store.listAliasCandidates(undefined, 'candidate')).toHaveLength(2)

  const approved = store.setAliasCandidateStatus(candidate.candidateId, 'approved')
  expect(approved.status).toBe('approved')
  expect(approved.reviewedAt).toMatch(/^\d{4}-/)
  expect(store.listAliasCandidates('superstore', 'approved')).toHaveLength(1)
  expect(store.listAliasCandidates(undefined, 'candidate')).toHaveLength(1)

  // Approval overlays runtime semantics via getEffectiveSemantics (candidate/revoked never apply).
  expect(store.listAliasCandidates('superstore', 'approved')[0]?.term).toBe('margin')
})

it('persists structured metric fields on alias candidates and round-trips them', () => {
  const candidate = store.createAliasCandidate({
    datasetId: 'superstore',
    term: 'net_sales',
    expression: 'SUM(sales)',
    description: 'Gross sales excluding returns',
    tableId: 'orders',
    aggregation: 'sum',
    units: 'USD',
    dateColumn: 'order_date',
    inclusion: 'exclude returned rows',
    actorId: 'operator-local',
  })
  expect(candidate).toMatchObject({
    aggregation: 'sum',
    units: 'USD',
    dateColumn: 'order_date',
    inclusion: 'exclude returned rows',
  })

  const loaded = store.listAliasCandidates('superstore', 'candidate')[0]
  expect(loaded).toMatchObject({
    aggregation: 'sum',
    units: 'USD',
    dateColumn: 'order_date',
    inclusion: 'exclude returned rows',
  })

  // Legacy candidates without structured fields stay clean.
  const legacy = store.createAliasCandidate({
    datasetId: 'olist',
    term: 'ticket',
    expression: 'AVG(price)',
    description: 'Average item price',
    tableId: 'order_items',
    actorId: 'operator-local',
  })
  expect(legacy.aggregation).toBeUndefined()
  expect(legacy.units).toBeUndefined()
})

function genericRecipe(overrides: Partial<IngestRecipe> = {}): IngestRecipe {
  return {
    datasetId: 'generic_widgets',
    recipeHash: 'workspace-csv-v1-abc123',
    importerVersion: '0.1.0',
    license: null,
    sourceUrl: 'https://www.kaggle.com/datasets/someone/widgets',
    tables: [
      {
        sourceFile: 'widgets.csv',
        tableId: 'widgets',
        columns: [{ name: 'region', sourceName: 'Region', type: 'VARCHAR' }],
      },
    ],
    ...overrides,
  }
}

it('creates a candidate workspace source pin attributed to the actor, never pre-approved', () => {
  const pin = store.createWorkspaceSourcePin({
    slug: 'someone/widgets',
    sourceVersion: '1',
    recipe: genericRecipe(),
    actorId: 'analyst-session',
  })
  expect(pin.pinId).toMatch(/^pin_/)
  expect(pin.status).toBe('candidate')
  expect(pin.reviewedAt).toBeNull()
  expect(pin.actorId).toBe('analyst-session')
  expect(store.getWorkspaceSourcePin(pin.pinId)).toEqual(pin)
})

it('lists workspace source pins by slug case-insensitively and leaves others out', () => {
  store.createWorkspaceSourcePin({
    slug: 'someone/widgets',
    sourceVersion: '1',
    recipe: genericRecipe(),
    actorId: 'analyst-session',
  })
  store.createWorkspaceSourcePin({
    slug: 'other/gadgets',
    sourceVersion: '1',
    recipe: genericRecipe({ datasetId: 'generic_gadgets' }),
    actorId: 'analyst-session',
  })

  expect(store.listWorkspaceSourcePins()).toHaveLength(2)
  const bySlug = store.listWorkspaceSourcePins('Someone/Widgets')
  expect(bySlug).toHaveLength(1)
  expect(bySlug[0]?.slug).toBe('someone/widgets')
})

it('approves and revokes a workspace source pin, recording reviewedAt', () => {
  const pin = store.createWorkspaceSourcePin({
    slug: 'someone/widgets',
    sourceVersion: '1',
    recipe: genericRecipe(),
    actorId: 'analyst-session',
  })
  const approved = store.setWorkspaceSourcePinStatus(
    pin.pinId,
    'approved',
    store.getWorkspaceSourcePin(pin.pinId)?.revision ?? 1,
  )
  expect(approved.status).toBe('approved')
  expect(approved.reviewedAt).toMatch(/^\d{4}-/)

  const revoked = store.setWorkspaceSourcePinStatus(
    pin.pinId,
    'revoked',
    store.getWorkspaceSourcePin(pin.pinId)?.revision ?? 1,
  )
  expect(revoked.status).toBe('revoked')
})

it('throws for an unknown workspace source pin id instead of silently no-op-ing', () => {
  expect(() =>
    store.setWorkspaceSourcePinStatus(
      'pin_doesnotexist0000',
      'approved',
      store.getWorkspaceSourcePin('pin_doesnotexist0000')?.revision ?? 1,
    ),
  ).toThrow(WorkspaceSourcePinNotFoundError)
  expect(store.getWorkspaceSourcePin('pin_doesnotexist0000')).toBeUndefined()
})

it('allows creating a workspace source pin whose recipe.datasetId matches a former Core id', () => {
  const pin = store.createWorkspaceSourcePin({
    slug: 'other/superstore',
    sourceVersion: '1',
    recipe: genericRecipe({ datasetId: 'superstore' }),
    actorId: 'analyst-session',
  })
  expect(pin.recipe.datasetId).toBe('superstore')
  expect(store.listWorkspaceSourcePins()).toHaveLength(1)
})

it('migrates existing source pins to revision one without changing reviewed data', () => {
  const legacyPath = join(directory, 'legacy.sqlite')
  const legacy = new Database(legacyPath)
  legacy.exec(
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  )
  for (const migration of MIGRATIONS.filter((item) => item.version < 11)) {
    legacy.exec(migration.up)
    legacy
      .prepare('INSERT INTO schema_migrations VALUES (?,?,?)')
      .run(migration.version, migration.name, '2026-01-01')
  }
  legacy
    .prepare(
      'INSERT INTO workspace_source_pins (pin_id,slug,source_version,recipe_json,status,actor_id,created_at,reviewed_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(
      'pin_0000000000000001',
      'someone/widgets',
      '1',
      JSON.stringify(genericRecipe()),
      'approved',
      'analyst',
      '2026-01-01',
      '2026-01-01',
    )
  legacy.close()
  const migrated = new MetadataStore(legacyPath)
  try {
    expect(migrated.getWorkspaceSourcePin('pin_0000000000000001')).toMatchObject({
      revision: 1,
      status: 'approved',
      recipe: genericRecipe(),
    })
  } finally {
    migrated.close()
  }
})

it('requires matching source revisions across independent metadata connections', () => {
  const pin = store.createWorkspaceSourcePin({
    slug: 'someone/widgets',
    sourceVersion: '1',
    recipe: genericRecipe(),
    actorId: 'analyst',
  })
  const other = new MetadataStore(dbPath)
  try {
    const updated = other.setWorkspaceSourcePinRecipe(
      pin.pinId,
      genericRecipe({ recipeHash: 'new' }),
      pin.revision,
    )
    expect(() =>
      store.setWorkspaceSourcePinRecipe(pin.pinId, genericRecipe(), pin.revision),
    ).toThrow('changed')
    expect(() => store.setWorkspaceSourcePinStatus(pin.pinId, 'approved', pin.revision)).toThrow(
      'changed',
    )
    expect(
      store.setWorkspaceSourcePinStatus(pin.pinId, 'approved', updated.revision),
    ).toMatchObject({ revision: 3, status: 'approved' })
  } finally {
    other.close()
  }
})

it('applies the workflow_trail migration (version 12)', () => {
  const raw = new Database(dbPath)
  const versions = raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
    version: number
  }[]
  raw.close()
  expect(versions.map((row) => row.version)).toContain(12)
})

it('records a workflow milestone with actor, timestamp, dataset version and a bounded receipt id', () => {
  const entry = store.recordWorkflowMilestone({
    milestone: 'dataset_published',
    actor: 'service',
    datasetVersionId: 'superstore-v1',
    receiptId: 'superstore-v1',
  })
  expect(entry).toMatchObject({
    milestone: 'dataset_published',
    actor: 'service',
    datasetVersionId: 'superstore-v1',
    analysisId: null,
    receiptId: 'superstore-v1',
  })
  expect(entry.entryId).toMatch(/^trail_[a-f0-9]{16}$/)
  expect(() => new Date(entry.recordedAt).toISOString()).not.toThrow()
})

it('lists workflow trail entries chronologically, scoped by dataset version and analysis id', () => {
  store.recordWorkflowMilestone({
    milestone: 'preview_proposed',
    actor: 'agent',
    datasetVersionId: 'food-ordering',
    receiptId: 'pin_0000000000000001',
  })
  store.recordWorkflowMilestone({
    milestone: 'analyst_approved',
    actor: 'analyst-ui',
    datasetVersionId: 'food-ordering',
    receiptId: 'pin_0000000000000001',
  })
  store.recordWorkflowMilestone({
    milestone: 'dataset_published',
    actor: 'service',
    datasetVersionId: 'food-ordering-v1',
    receiptId: 'food-ordering-v1',
  })
  store.recordWorkflowMilestone({
    milestone: 'analysis_persisted',
    actor: 'service',
    datasetVersionId: 'unrelated-dataset',
    analysisId: 'ana_0000000000000001',
    receiptId: 'ana_0000000000000001:1',
  })

  const byDataset = store.listWorkflowTrail({ datasetVersionId: 'food-ordering' })
  expect(byDataset.map((entry) => entry.milestone)).toEqual([
    'preview_proposed',
    'analyst_approved',
  ])
  // UI approval is distinguishable from the agent's own proposal.
  expect(byDataset[0]!.actor).toBe('agent')
  expect(byDataset[1]!.actor).toBe('analyst-ui')

  const byAnalysis = store.listWorkflowTrail({ analysisId: 'ana_0000000000000001' })
  expect(byAnalysis).toHaveLength(1)
  expect(byAnalysis[0]!.milestone).toBe('analysis_persisted')
})

it('survives reload — the workflow trail is persisted in SQLite, not in-memory state', () => {
  store.recordWorkflowMilestone({
    milestone: 'chart_rendered',
    actor: 'service',
    datasetVersionId: 'food-ordering-v1',
    receiptId: 'art_0000000000000001',
  })
  store.close()

  const reopened = new MetadataStore(dbPath)
  try {
    const trail = reopened.listWorkflowTrail({ datasetVersionId: 'food-ordering-v1' })
    expect(trail).toHaveLength(1)
    expect(trail[0]).toMatchObject({
      milestone: 'chart_rendered',
      receiptId: 'art_0000000000000001',
    })
  } finally {
    reopened.close()
    store = new MetadataStore(dbPath) // afterEach() closes `store` unconditionally
  }
})

it('rejects a receipt id shaped like raw row data or a credential string', () => {
  expect(() =>
    store.recordWorkflowMilestone({
      milestone: 'query_completed',
      actor: 'service',
      datasetVersionId: 'food-ordering-v1',
      receiptId: 'password=hunter2',
    }),
  ).toThrow()
  expect(() =>
    store.recordWorkflowMilestone({
      milestone: 'query_completed',
      actor: 'service',
      datasetVersionId: 'food-ordering-v1',
      receiptId: '{"ssn": "123-45-6789", "email": "x@y.com"}',
    }),
  ).toThrow()
  expect(store.listWorkflowTrail({ datasetVersionId: 'food-ordering-v1' })).toHaveLength(0)
})
