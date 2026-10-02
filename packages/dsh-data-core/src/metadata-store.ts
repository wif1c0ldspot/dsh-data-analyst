/**
 * SQLite metadata coordinator for jobs, versions, reviews and saved analyses.
 * Coordinated mutations use `better-sqlite3` transactions; see
 * docs/architecture.md and
 * docs/contracts.md "Identity and persistence".
 */
import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  AnalysisRevision,
  ChartFeedback,
  ChartFeedbackIssueType,
  Dashboard,
  DashboardActiveFilter,
  DashboardLayout,
  DatasetManifest,
  Feedback,
  FeedbackKind,
  GrainCandidate,
  Id,
  JobStatus,
  LearningExample,
  MetricAggregation,
  RelationshipCandidate,
  ReviewStatus,
  SemanticAliasCandidate,
  StructureCandidate,
  StructureEvidence,
  WorkflowActor,
  WorkflowMilestoneType,
  WorkflowTrailEntry,
} from './contracts.js'
import { DashboardActiveFilterSchema, WorkflowTrailEntrySchema } from './contracts.js'
import { isValidJobTransition, runMigrations } from './migrations.js'
import type { WorkspaceSourcePin, WorkspaceSourcePinStatus } from './recipes/workspace-registry.js'
import type { IngestRecipe } from './recipes/types.js'

export class InvalidJobTransitionError extends Error {}
export class JobNotFoundError extends Error {}
export class DatasetVersionNotFoundError extends Error {}
export class AnalysisNotFoundError extends Error {}
export class AnalysisRevisionConflictError extends Error {}
export class DashboardNotFoundError extends Error {}
export class FeedbackNotFoundError extends Error {}
export class AliasCandidateNotFoundError extends Error {}
export class StructureCandidateNotFoundError extends Error {}
export class LearningExampleNotFoundError extends Error {}
export class WorkspaceSourcePinNotFoundError extends Error {}
export class WorkspaceSourcePinConflictError extends Error {}
export class ChartFeedbackNotFoundError extends Error {}

const GeneratedReportFileSchema = z
  .string()
  .regex(/^export_[a-f0-9]{32}(?:_(?:spec|analysis))?\.(?:html|svg|png|csv|json|zip)$/)
const AnalysisReportFilesSchema = z.strictObject({
  html: GeneratedReportFileSchema,
  svg: GeneratedReportFileSchema,
  csv: GeneratedReportFileSchema,
  png: GeneratedReportFileSchema,
  specification: GeneratedReportFileSchema,
  analysis: GeneratedReportFileSchema,
})
const DashboardReportFilesSchema = z.strictObject({
  html: GeneratedReportFileSchema,
  zip: GeneratedReportFileSchema,
})
const ReportSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('analysis'),
    analysisId: z.string().regex(/^ana_[a-z0-9]+$/i),
    revision: z.number().int().positive(),
    resultId: z.string().min(1).max(200),
    datasetVersionId: z.string().min(1).max(200),
    semanticRevisionId: z.string().min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal('dashboard'),
    dashboardId: z.string().regex(/^dash_[a-z0-9]+$/i),
    version: z.string().min(1).max(100),
    slots: z
      .array(
        z.strictObject({
          analysisId: z.string().regex(/^ana_[a-z0-9]+$/i),
          revision: z.number().int().positive(),
          resultId: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(100),
  }),
])

export type ReportSource = z.infer<typeof ReportSourceSchema>
export type ReportFiles =
  z.infer<typeof AnalysisReportFilesSchema> | z.infer<typeof DashboardReportFilesSchema>
export interface ReportExport {
  reportId: string
  title: string
  source: ReportSource
  files: ReportFiles
  createdAt: string
}

interface ReportExportRow {
  report_id: string
  title: string
  source_json: string
  files_json: string
  created_at: string
}

function parseReportExport(row: ReportExportRow): ReportExport {
  const source = ReportSourceSchema.parse(JSON.parse(row.source_json))
  const files = (
    source.kind === 'analysis' ? AnalysisReportFilesSchema : DashboardReportFilesSchema
  ).parse(JSON.parse(row.files_json))
  return {
    reportId: z
      .string()
      .regex(/^export_[a-f0-9]{32}$/)
      .parse(row.report_id),
    title: z.string().min(1).max(200).parse(row.title),
    source,
    files,
    createdAt: z.iso.datetime().parse(row.created_at),
  }
}

function nextDashboardUpdatedAt(current?: string): string {
  return new Date(
    current ? Math.max(Date.now(), Date.parse(current) + 1) : Date.now(),
  ).toISOString()
}

export interface ImportJob {
  jobId: Id
  idempotencyKey: string
  slug: string
  sourceVersion: string | null
  status: JobStatus
  datasetVersionId: Id | null
  warnings: string[]
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateImportJobInput {
  idempotencyKey: string
  slug: string
  sourceVersion?: string
}

interface ImportJobRow {
  job_id: string
  idempotency_key: string
  slug: string
  source_version: string | null
  status: string
  dataset_version_id: string | null
  warnings_json: string
  error_message: string | null
  created_at: string
  updated_at: string
}

function rowToJob(row: ImportJobRow): ImportJob {
  return {
    jobId: row.job_id,
    idempotencyKey: row.idempotency_key,
    slug: row.slug,
    sourceVersion: row.source_version,
    status: row.status as JobStatus,
    datasetVersionId: row.dataset_version_id,
    warnings: JSON.parse(row.warnings_json) as string[],
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const TERMINAL_STATUSES: readonly JobStatus[] = ['ready', 'failed', 'cancelled']

/**
 * Change signal for the sidebar poll: a digest of every saved revision's identity.
 *
 * A count plus `max(created_at)` is not enough — a delete and a create inside the same
 * second leave both unchanged, and the sidebar then never refreshed a saved-view list
 * that had in fact changed. Exported so the sensitivity is unit-testable.
 */
export function analysisRevisionDigest(
  rows: ReadonlyArray<{ analysisId: string; revision: number; createdAt: string }>,
): string {
  return createHash('sha1')
    .update(rows.map((row) => `${row.analysisId}:${row.revision}:${row.createdAt}`).join('|'))
    .digest('hex')
    .slice(0, 12)
}

export class MetadataStore {
  private readonly db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    runMigrations(this.db)
  }

  recordReportExport(input: Omit<ReportExport, 'createdAt'>): ReportExport {
    const reportId = z
      .string()
      .regex(/^export_[a-f0-9]{32}$/)
      .parse(input.reportId)
    const title = z.string().trim().min(1).max(200).parse(input.title)
    const source = ReportSourceSchema.parse(input.source)
    const files = (
      source.kind === 'analysis' ? AnalysisReportFilesSchema : DashboardReportFilesSchema
    ).parse(input.files)
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO report_exports (report_id, title, source_json, files_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(reportId, title, JSON.stringify(source), JSON.stringify(files), createdAt)
    return { reportId, title, source, files, createdAt }
  }

  listReportExports(limit = 20): ReportExport[] {
    const bounded = z.number().int().min(1).max(100).parse(limit)
    const rows = this.db
      .prepare('SELECT * FROM report_exports ORDER BY created_at DESC, report_id DESC LIMIT ?')
      .all(bounded) as ReportExportRow[]
    return rows.map(parseReportExport)
  }

  /**
   * Idempotent job submission: a repeated call with the same key returns the
   * existing job untouched rather than creating a duplicate or overwriting
   * its current state (see "Data and approval flow" in docs/architecture.md).
   */
  createImportJob(input: CreateImportJobInput): ImportJob {
    const now = new Date().toISOString()
    const jobId = randomUUID()
    this.db
      .prepare(
        `INSERT INTO import_jobs
           (job_id, idempotency_key, slug, source_version, status, dataset_version_id, warnings_json, error_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', NULL, '[]', NULL, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(jobId, input.idempotencyKey, input.slug, input.sourceVersion ?? null, now, now)
    return this.getImportJobByIdempotencyKey(input.idempotencyKey)!
  }

  getImportJob(jobId: Id): ImportJob | undefined {
    const row = this.db.prepare('SELECT * FROM import_jobs WHERE job_id = ?').get(jobId) as
      ImportJobRow | undefined
    return row ? rowToJob(row) : undefined
  }

  getImportJobByIdempotencyKey(idempotencyKey: string): ImportJob | undefined {
    const row = this.db
      .prepare('SELECT * FROM import_jobs WHERE idempotency_key = ?')
      .get(idempotencyKey) as ImportJobRow | undefined
    return row ? rowToJob(row) : undefined
  }

  /** All import jobs, newest activity first. */
  listImportJobs(): ImportJob[] {
    const rows = this.db
      .prepare('SELECT * FROM import_jobs ORDER BY updated_at DESC, created_at DESC')
      .all() as ImportJobRow[]
    return rows.map(rowToJob)
  }

  /** Compact sidebar awareness; never loads recipes or schema into a polling response. */
  getAnalystReviewStatus() {
    const pending = this.db
      .prepare(
        `SELECT
      (SELECT count(*) FROM workspace_source_pins WHERE status = 'candidate') AS ingestion,
      (SELECT count(*) FROM semantic_alias_candidates WHERE status = 'candidate') AS semantic,
      (SELECT count(*) FROM semantic_structure_candidates WHERE status = 'candidate') AS structure,
      (SELECT count(*) FROM import_jobs j WHERE status = 'needs-input' AND EXISTS
        (SELECT 1 FROM json_each(j.warnings_json) w
         WHERE w.value LIKE 'Adaptation confirm required:%')) AS adaptations
    `,
      )
      .get() as { ingestion: number; semantic: number; structure: number; adaptations: number }
    const imports = this.db
      .prepare(
        `SELECT job_id AS jobId, slug, status, updated_at AS updatedAt
      FROM import_jobs ORDER BY updated_at DESC, job_id DESC LIMIT 5`,
      )
      .all() as Array<{ jobId: string; slug: string; status: JobStatus; updatedAt: string }>
    // Saving an analysis leaves `pending` untouched, so the sidebar poll had no
    // reason to refresh the saved-view list: a chart the agent saved stayed
    // invisible in Studio until the analyst clicked Refresh workspace (observed
    // live). Revision count plus latest create time gives that poll a change
    // signal for saves without shipping any analysis content.
    // The poll's change signal must survive a delete plus a create inside the same
    // second: a count and a max(created_at) are both unchanged by that, so the sidebar
    // never refreshed a saved-view list that had in fact changed. Hash the revision
    // identities instead — cheap, exact, and content-free.
    const revisionRows = this.db
      .prepare(
        `SELECT analysis_id AS analysisId, revision, created_at AS createdAt
         FROM analysis_revisions ORDER BY analysis_id, revision`,
      )
      .all() as Array<{ analysisId: string; revision: number; createdAt: string }>
    const analyses = {
      revisions: revisionRows.length,
      updatedAt: revisionRows.reduce((max, row) => (row.createdAt > max ? row.createdAt : max), ''),
      digest: analysisRevisionDigest(revisionRows),
    }
    return {
      pending: { ...pending, total: Object.values(pending).reduce((a, b) => a + b, 0) },
      imports,
      analyses,
    }
  }

  /**
   * Advance a job's status, enforcing the allowed-transition table so a
   * provider bug cannot silently resurrect a terminal job or skip a phase.
   * `datasetVersionId` is set only on the transition into `ready`.
   */
  updateImportJobStatus(
    jobId: Id,
    status: JobStatus,
    options: { datasetVersionId?: Id; warnings?: string[]; errorMessage?: string } = {},
  ): ImportJob {
    const current = this.getImportJob(jobId)
    if (current === undefined) throw new JobNotFoundError(`Import job ${jobId} does not exist`)
    if (!isValidJobTransition(current.status, status)) {
      throw new InvalidJobTransitionError(
        `Cannot transition import job from "${current.status}" to "${status}"`,
      )
    }
    const warnings = options.warnings ?? current.warnings
    this.db
      .prepare(
        `UPDATE import_jobs
         SET status = ?, dataset_version_id = ?, warnings_json = ?, error_message = ?, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(
        status,
        options.datasetVersionId ?? current.datasetVersionId,
        JSON.stringify(warnings),
        options.errorMessage ?? null,
        new Date().toISOString(),
        jobId,
      )
    return this.getImportJob(jobId)!
  }

  /** Jobs left in a non-terminal state, e.g. by a previous process crash. */
  listInterruptedImportJobs(): ImportJob[] {
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ')
    const rows = this.db
      .prepare(`SELECT * FROM import_jobs WHERE status NOT IN (${placeholders})`)
      .all(...TERMINAL_STATUSES) as ImportJobRow[]
    return rows.map(rowToJob)
  }

  /**
   * Crash recovery (see "Data and approval flow" in docs/architecture.md):
   * call once at coordinator startup. A job left mid-flight by a crash cannot be assumed to have
   * succeeded; it becomes `failed` with an explicit reason rather than
   * silently retained as if still in progress or, worse, treated as ready.
   */
  recoverInterruptedImportJobs(
    reason = 'Process restarted while this job was in progress',
  ): ImportJob[] {
    return this.listInterruptedImportJobs().map((job) => {
      // A terminal-adjacent status may not have `failed` as an explicitly
      // modeled transition from every state; recovery is a forced correction,
      // not a normal provider transition, so it writes directly.
      this.db
        .prepare(
          'UPDATE import_jobs SET status = ?, error_message = ?, updated_at = ? WHERE job_id = ?',
        )
        .run('failed', reason, new Date().toISOString(), job.jobId)
      return this.getImportJob(job.jobId)!
    })
  }

  /**
   * Atomically store an immutable manifest and flip the dataset's current-
   * version pointer in one transaction — the version row exists before any
   * reader can observe the pointer change, and a failure leaves the previous
   * pointer intact (the immutable-publication rationale in "Why these
   * choices" in docs/architecture.md).
   */
  publishDatasetVersion(manifest: DatasetManifest): void {
    const publish = this.db.transaction(() => {
      const now = new Date().toISOString()
      this.db
        .prepare(
          'INSERT INTO dataset_versions (dataset_version_id, dataset_id, manifest_json, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(manifest.datasetVersionId, manifest.datasetId, JSON.stringify(manifest), now)
      this.db
        .prepare(
          `INSERT INTO dataset_pointers (dataset_id, current_dataset_version_id, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(dataset_id) DO UPDATE SET current_dataset_version_id = excluded.current_dataset_version_id, updated_at = excluded.updated_at`,
        )
        .run(manifest.datasetId, manifest.datasetVersionId, now)
    })
    publish()
  }

  getDatasetVersion(datasetVersionId: Id): DatasetManifest | undefined {
    const row = this.db
      .prepare('SELECT manifest_json FROM dataset_versions WHERE dataset_version_id = ?')
      .get(datasetVersionId) as { manifest_json: string } | undefined
    return row ? (JSON.parse(row.manifest_json) as DatasetManifest) : undefined
  }

  getCurrentDatasetVersion(datasetId: Id): DatasetManifest | undefined {
    const row = this.db
      .prepare(
        `SELECT v.manifest_json AS manifest_json
         FROM dataset_pointers p JOIN dataset_versions v ON v.dataset_version_id = p.current_dataset_version_id
         WHERE p.dataset_id = ?`,
      )
      .get(datasetId) as { manifest_json: string } | undefined
    return row ? (JSON.parse(row.manifest_json) as DatasetManifest) : undefined
  }

  listDatasetVersions(datasetId: Id): DatasetManifest[] {
    const rows = this.db
      .prepare(
        'SELECT manifest_json FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at',
      )
      .all(datasetId) as { manifest_json: string }[]
    return rows.map((row) => JSON.parse(row.manifest_json) as DatasetManifest)
  }

  /** Current published pointer for every dataset (empty when none are ready). */
  listCurrentDatasetVersions(): DatasetManifest[] {
    const rows = this.db
      .prepare(
        `SELECT v.manifest_json AS manifest_json
         FROM dataset_pointers p
         JOIN dataset_versions v ON v.dataset_version_id = p.current_dataset_version_id
         ORDER BY p.dataset_id`,
      )
      .all() as { manifest_json: string }[]
    return rows.map((row) => JSON.parse(row.manifest_json) as DatasetManifest)
  }

  /**
   * Append-only analysis revisions (ADR 002). Never overwrites a prior
   * (analysis_id, revision) row. When `expectedRevision` is set, it must equal
   * the current max revision (or 0 for a new analysis).
   */
  saveAnalysisRevision(
    record: AnalysisRevision,
    options: { expectedRevision?: number } = {},
  ): AnalysisRevision {
    if (!/^ana_[a-z0-9]+$/i.test(record.analysisId)) {
      throw new Error(`Invalid analysis id "${record.analysisId}"`)
    }
    const save = this.db.transaction(() => {
      const current = this.db
        .prepare(
          'SELECT COALESCE(MAX(revision), 0) AS max_revision FROM analysis_revisions WHERE analysis_id = ?',
        )
        .get(record.analysisId) as { max_revision: number }
      const maxRevision = Number(current.max_revision)
      if (options.expectedRevision !== undefined && options.expectedRevision !== maxRevision) {
        throw new AnalysisRevisionConflictError(
          `Analysis revision conflict: expected ${options.expectedRevision}, current ${maxRevision}`,
        )
      }
      const nextRevision = maxRevision + 1
      const stored: AnalysisRevision = { ...record, revision: nextRevision }
      this.db
        .prepare(
          `INSERT INTO analysis_revisions (analysis_id, revision, manifest_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(stored.analysisId, stored.revision, JSON.stringify(stored), stored.createdAt)
      return stored
    })
    return save()
  }

  loadAnalysisRevision(analysisId: Id, revision?: number): AnalysisRevision | undefined {
    if (!/^ana_[a-z0-9]+$/i.test(analysisId)) {
      throw new Error(`Invalid analysis id "${analysisId}"`)
    }
    if (revision !== undefined) {
      const row = this.db
        .prepare(
          'SELECT manifest_json FROM analysis_revisions WHERE analysis_id = ? AND revision = ?',
        )
        .get(analysisId, revision) as { manifest_json: string } | undefined
      return row ? (JSON.parse(row.manifest_json) as AnalysisRevision) : undefined
    }
    const row = this.db
      .prepare(
        `SELECT manifest_json FROM analysis_revisions
         WHERE analysis_id = ?
         ORDER BY revision DESC
         LIMIT 1`,
      )
      .get(analysisId) as { manifest_json: string } | undefined
    return row ? (JSON.parse(row.manifest_json) as AnalysisRevision) : undefined
  }

  /** Latest revision per analysis id, newest first. */
  listAnalysisRevisions(): AnalysisRevision[] {
    const rows = this.db
      .prepare(
        `SELECT manifest_json FROM analysis_revisions ar
         WHERE revision = (
           SELECT MAX(revision) FROM analysis_revisions WHERE analysis_id = ar.analysis_id
         )
         ORDER BY created_at DESC`,
      )
      .all() as { manifest_json: string }[]
    return rows.map((row) => JSON.parse(row.manifest_json) as AnalysisRevision)
  }

  listAnalysisHistory(analysisId: Id, limit = 100): AnalysisRevision[] {
    return (
      this.db
        .prepare(
          'SELECT manifest_json FROM analysis_revisions WHERE analysis_id = ? ORDER BY revision DESC LIMIT ?',
        )
        .all(analysisId, limit) as { manifest_json: string }[]
    ).map((row) => JSON.parse(row.manifest_json) as AnalysisRevision)
  }

  /** Replace an explicitly reviewed layout in one optimistic transaction. */
  updateDashboardLayout(
    dashboardId: Id,
    expectedVersion: string,
    layout: DashboardLayout,
    title?: string,
  ): Dashboard {
    return this.db
      .transaction(() => {
        const current = this.loadDashboard(dashboardId)
        if (!current) throw new DashboardNotFoundError('Dashboard not found')
        if (current.updatedAt !== expectedVersion)
          throw new AnalysisRevisionConflictError('Dashboard changed; reload before applying')
        for (const slot of layout.slots) {
          if (!this.loadAnalysisRevision(slot.analysisId, slot.revision))
            throw new AnalysisNotFoundError('Pinned analysis revision not found')
        }
        const updatedAt = nextDashboardUpdatedAt(current.updatedAt)
        this.db
          .prepare(
            'UPDATE dashboards SET title = ?, layout_json = ?, updated_at = ? WHERE dashboard_id = ?',
          )
          .run(title ?? current.title, JSON.stringify(layout), updatedAt, dashboardId)
        return this.loadDashboard(dashboardId)!
      })
      .immediate()
  }

  saveDashboard(input: { title: string; layout?: DashboardLayout; dashboardId?: Id }): Dashboard {
    return this.db
      .transaction(() => {
        const dashboardId =
          input.dashboardId ?? `dash_${randomUUID().replace(/-/g, '').slice(0, 16)}`
        const layout = input.layout ?? { slots: [] }
        const existing = this.loadDashboard(dashboardId)
        const updatedAt = nextDashboardUpdatedAt(existing?.updatedAt)
        if (existing) {
          this.db
            .prepare(
              `UPDATE dashboards SET title = ?, layout_json = ?, updated_at = ? WHERE dashboard_id = ?`,
            )
            .run(input.title, JSON.stringify(layout), updatedAt, dashboardId)
          return this.loadDashboard(dashboardId)!
        }
        this.db
          .prepare(
            `INSERT INTO dashboards (dashboard_id, title, layout_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(dashboardId, input.title, JSON.stringify(layout), updatedAt, updatedAt)
        return this.loadDashboard(dashboardId)!
      })
      .immediate()
  }

  loadDashboard(dashboardId: Id): Dashboard | undefined {
    const row = this.db
      .prepare('SELECT * FROM dashboards WHERE dashboard_id = ?')
      .get(dashboardId) as DashboardRow | undefined
    return row ? rowToDashboard(row) : undefined
  }

  listDashboards(): Dashboard[] {
    const rows = this.db
      .prepare('SELECT * FROM dashboards ORDER BY updated_at DESC')
      .all() as DashboardRow[]
    return rows.map(rowToDashboard)
  }

  /** Rename a dashboard in place, preserving its pinned layout and archive flag. */
  renameDashboard(dashboardId: Id, title: string): Dashboard {
    return this.db
      .transaction(() => {
        const existing = this.loadDashboard(dashboardId)
        if (!existing) throw new DashboardNotFoundError(`Dashboard ${dashboardId} does not exist`)
        this.db
          .prepare('UPDATE dashboards SET title = ?, updated_at = ? WHERE dashboard_id = ?')
          .run(title, nextDashboardUpdatedAt(existing.updatedAt), dashboardId)
        return this.loadDashboard(dashboardId)!
      })
      .immediate()
  }

  /** Soft-delete (archive) or restore a dashboard; pinned analyses are untouched. */
  setDashboardArchived(dashboardId: Id, archived: boolean): Dashboard {
    return this.db
      .transaction(() => {
        const existing = this.loadDashboard(dashboardId)
        if (!existing) throw new DashboardNotFoundError(`Dashboard ${dashboardId} does not exist`)
        this.db
          .prepare('UPDATE dashboards SET archived = ?, updated_at = ? WHERE dashboard_id = ?')
          .run(archived ? 1 : 0, nextDashboardUpdatedAt(existing.updatedAt), dashboardId)
        return this.loadDashboard(dashboardId)!
      })
      .immediate()
  }

  /**
   * Pin a saved analysis revision into a dashboard slot. Re-pinning the same
   * analysisId updates that slot in place. New pins start with empty
   * sharedFilterKeys — unsupported shared filters are disclosed in the UI.
   */
  pinAnalysisToDashboard(
    dashboardId: Id,
    analysisId: Id,
    revision: number,
    title?: string,
  ): Dashboard {
    return this.db
      .transaction(() => {
        const current = this.loadDashboard(dashboardId)
        if (!current) throw new DashboardNotFoundError(`Dashboard ${dashboardId} does not exist`)
        const slots = [...current.layout.slots]
        const existingIndex = slots.findIndex((slot) => slot.analysisId === analysisId)
        const nextTitle = title ?? (existingIndex >= 0 ? slots[existingIndex]!.title : analysisId)
        const nextSlot = {
          ...(existingIndex >= 0 ? slots[existingIndex]! : {}),
          analysisId,
          revision,
          title: nextTitle,
          sharedFilterKeys: existingIndex >= 0 ? slots[existingIndex]!.sharedFilterKeys : [],
        }
        if (existingIndex >= 0) slots[existingIndex] = nextSlot
        else slots.push(nextSlot)
        return this.saveDashboard({
          dashboardId: current.dashboardId,
          title: current.title,
          layout: { slots },
        })
      })
      .immediate()
  }

  /**
   * Persist the shared-filter keys a single dashboard slot declares it can
   * accept. Updates only that slot's `sharedFilterKeys`; every
   * other slot's mapping, title and pinned revision are unchanged.
   */
  setDashboardSharedFilterKeys(dashboardId: Id, analysisId: Id, keys: string[]): Dashboard {
    return this.db
      .transaction(() => {
        const current = this.loadDashboard(dashboardId)
        if (!current) throw new DashboardNotFoundError(`Dashboard ${dashboardId} does not exist`)
        const slotIndex = current.layout.slots.findIndex((slot) => slot.analysisId === analysisId)
        if (slotIndex < 0) {
          throw new AnalysisNotFoundError(
            `Analysis "${analysisId}" is not pinned to dashboard "${dashboardId}"`,
          )
        }
        const slots = [...current.layout.slots]
        slots[slotIndex] = { ...slots[slotIndex]!, sharedFilterKeys: keys }
        return this.saveDashboard({
          dashboardId: current.dashboardId,
          title: current.title,
          layout: { slots },
        })
      })
      .immediate()
  }

  /**
   * Publish prepared shared-filter analysis revisions and the dashboard's
   * pointer update in one transaction. `expectedVersion` guards the
   * dashboard pointer; each `revision.expectedRevision` (the analysis
   * revision the prepared draft was built against, see
   * `applyDashboardSharedFilter`) guards the *individual analysis* row so a
   * stale filtered draft — prepared against an analysis revision that a
   * concurrent write has since superseded — cannot silently overwrite or pin
   * over that newer revision. Any conflict throws
   * `AnalysisRevisionConflictError` and rolls back the whole transaction,
   * including every other slot's revision insert in this same call: the
   * publish is all supported slots or none, never a partial set.
   */
  publishDashboardFilter(
    dashboardId: Id,
    expectedVersion: string,
    revisions: readonly (AnalysisRevision & { expectedRevision?: number })[],
    activeFilter?: DashboardActiveFilter | null,
  ): Dashboard {
    const publish = this.db.transaction(() => {
      const current = this.loadDashboard(dashboardId)
      if (!current) throw new DashboardNotFoundError(`Dashboard ${dashboardId} does not exist`)
      if (current.updatedAt !== expectedVersion) {
        throw new Error(
          `Dashboard version conflict: expected ${expectedVersion}, current ${current.updatedAt}`,
        )
      }
      const slots = current.layout.slots.map((slot) => {
        const revision = revisions.find((candidate) => candidate.analysisId === slot.analysisId)
        return revision ? { ...slot, revision: revision.revision } : slot
      })
      for (const revision of revisions) {
        const row = this.db
          .prepare(
            'SELECT COALESCE(MAX(revision), 0) AS max_revision FROM analysis_revisions WHERE analysis_id = ?',
          )
          .get(revision.analysisId) as { max_revision: number }
        const maxRevision = Number(row.max_revision)
        if (revision.expectedRevision !== undefined && revision.expectedRevision !== maxRevision) {
          throw new AnalysisRevisionConflictError(
            `Analysis revision conflict for "${revision.analysisId}": expected ${revision.expectedRevision}, current ${maxRevision}`,
          )
        }
        const nextRevision = maxRevision + 1
        // `expectedRevision` is transport for the guard above, not part of
        // the stored manifest — never let it pollute the persisted revision.
        const { expectedRevision: _guard, ...manifest } = revision
        const stored = { ...manifest, revision: nextRevision }
        this.db
          .prepare(
            `INSERT INTO analysis_revisions (analysis_id, revision, manifest_json, created_at)
           VALUES (?, ?, ?, ?)`,
          )
          .run(stored.analysisId, nextRevision, JSON.stringify(stored), stored.createdAt)
        const slot = slots.find((candidate) => candidate.analysisId === revision.analysisId)
        if (slot) slot.revision = nextRevision
      }
      const updatedAt = nextDashboardUpdatedAt(current.updatedAt)
      const nextActiveFilter =
        activeFilter === undefined
          ? current.activeFilter
          : activeFilter === null
            ? undefined
            : {
                ...activeFilter,
                appliedDashboardVersion: updatedAt,
                cards: activeFilter.cards.map((card) => {
                  const slot = slots.find((candidate) => candidate.analysisId === card.analysisId)
                  return card.status === 'changed' && slot
                    ? { ...card, filteredRevision: slot.revision }
                    : card
                }),
              }
      const activeFilterJson = nextActiveFilter ? JSON.stringify(nextActiveFilter) : null
      if (activeFilterJson && Buffer.byteLength(activeFilterJson, 'utf8') > 64 * 1024) {
        throw new Error('Dashboard active filter metadata exceeds 64 KiB')
      }
      if (nextActiveFilter) DashboardActiveFilterSchema.parse(nextActiveFilter)
      this.db
        .prepare(
          'UPDATE dashboards SET layout_json = ?, active_filter_json = ?, updated_at = ? WHERE dashboard_id = ?',
        )
        .run(JSON.stringify({ slots }), activeFilterJson, updatedAt, dashboardId)
      return this.loadDashboard(dashboardId)!
    })
    return publish()
  }

  createFeedback(input: {
    analysisId: Id
    analysisRevision: number
    kind: FeedbackKind
    actorId: Id
    comment: string
    status?: ReviewStatus
  }): Feedback {
    const feedbackId = `fb_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const createdAt = new Date().toISOString()
    const status = input.status ?? 'candidate'
    this.db
      .prepare(
        `INSERT INTO feedback
           (feedback_id, analysis_id, analysis_revision, kind, actor_id, status, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        feedbackId,
        input.analysisId,
        input.analysisRevision,
        input.kind,
        input.actorId,
        status,
        input.comment,
        createdAt,
      )
    return {
      feedbackId,
      analysisId: input.analysisId,
      analysisRevision: input.analysisRevision,
      kind: input.kind,
      actorId: input.actorId,
      status,
      comment: input.comment,
      createdAt,
    }
  }

  listFeedback(analysisId: Id): Feedback[] {
    const rows = this.db
      .prepare(`SELECT * FROM feedback WHERE analysis_id = ? ORDER BY created_at DESC`)
      .all(analysisId) as FeedbackRow[]
    return rows.map(rowToFeedback)
  }

  setFeedbackStatus(feedbackId: Id, status: 'approved' | 'revoked'): Feedback {
    const existing = this.db
      .prepare('SELECT * FROM feedback WHERE feedback_id = ?')
      .get(feedbackId) as FeedbackRow | undefined
    if (!existing) throw new FeedbackNotFoundError(`Feedback ${feedbackId} does not exist`)
    this.db.prepare('UPDATE feedback SET status = ? WHERE feedback_id = ?').run(status, feedbackId)
    return rowToFeedback({ ...existing, status })
  }

  /**
   * Persist a bounded
   * chart-layout-problem report. Callers (the `report_chart_issue` tool)
   * must independently confirm `artifactId`/`analysisId`/`analysisRevision`
   * reference a real, persisted analysis revision before calling this —
   * this method only stores the row. Always starts `status: 'candidate'`;
   * nothing here (or in any tool input) can set `'approved'`, and this
   * table is never read by `listCompatibleLearningExamples` (the approved
   * reusable-learning-evidence store), so a submission here can never
   * surface as retrievable learning evidence.
   */
  createChartFeedback(input: {
    artifactId: Id
    analysisId: Id
    analysisRevision: number
    issueType: ChartFeedbackIssueType
    notes?: string
    actorId: Id
  }): ChartFeedback {
    const feedbackId = `cfb_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO chart_feedback
           (feedback_id, artifact_id, analysis_id, analysis_revision, issue_type, notes,
            status, actor_id, created_at, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, NULL)`,
      )
      .run(
        feedbackId,
        input.artifactId,
        input.analysisId,
        input.analysisRevision,
        input.issueType,
        input.notes ?? null,
        input.actorId,
        createdAt,
      )
    return {
      feedbackId,
      artifactId: input.artifactId,
      analysisId: input.analysisId,
      analysisRevision: input.analysisRevision,
      issueType: input.issueType,
      ...(input.notes ? { notes: input.notes } : {}),
      status: 'candidate',
      actorId: input.actorId,
      createdAt,
      reviewedAt: null,
    }
  }

  listChartFeedback(
    filter: { analysisId?: Id; status?: ReviewStatus; limit?: number } = {},
  ): ChartFeedback[] {
    const limit = Math.max(0, Math.min(filter.limit ?? 50, 200))
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.analysisId) {
      conditions.push('analysis_id = ?')
      params.push(filter.analysisId)
    }
    if (filter.status) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM chart_feedback ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as ChartFeedbackRow[]
    return rows.map(rowToChartFeedback)
  }

  setChartFeedbackStatus(feedbackId: Id, status: 'approved' | 'revoked'): ChartFeedback {
    const existing = this.db
      .prepare('SELECT * FROM chart_feedback WHERE feedback_id = ?')
      .get(feedbackId) as ChartFeedbackRow | undefined
    if (!existing)
      throw new ChartFeedbackNotFoundError(`Chart feedback ${feedbackId} does not exist`)
    const reviewedAt = new Date().toISOString()
    this.db
      .prepare('UPDATE chart_feedback SET status = ?, reviewed_at = ? WHERE feedback_id = ?')
      .run(status, reviewedAt, feedbackId)
    return rowToChartFeedback({ ...existing, status, reviewed_at: reviewedAt })
  }

  createAliasCandidate(input: {
    datasetId: Id
    term: string
    expression: string
    description: string
    tableId: string
    actorId: Id
    aggregation?: MetricAggregation
    units?: string
    dateColumn?: string
    inclusion?: string
  }): SemanticAliasCandidate {
    const candidateId = `alias_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO semantic_alias_candidates
           (candidate_id, dataset_id, term, expression, description, table_id,
            aggregation, units, date_column, inclusion, status, actor_id, created_at, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, NULL)`,
      )
      .run(
        candidateId,
        input.datasetId,
        input.term,
        input.expression,
        input.description,
        input.tableId,
        input.aggregation ?? null,
        input.units ?? null,
        input.dateColumn ?? null,
        input.inclusion ?? null,
        input.actorId,
        createdAt,
      )
    return {
      candidateId,
      datasetId: input.datasetId,
      term: input.term,
      expression: input.expression,
      description: input.description,
      tableId: input.tableId,
      ...(input.aggregation ? { aggregation: input.aggregation } : {}),
      ...(input.units ? { units: input.units } : {}),
      ...(input.dateColumn ? { dateColumn: input.dateColumn } : {}),
      ...(input.inclusion ? { inclusion: input.inclusion } : {}),
      status: 'candidate',
      actorId: input.actorId,
      createdAt,
      reviewedAt: null,
    }
  }

  listAliasCandidates(datasetId?: Id, status?: ReviewStatus): SemanticAliasCandidate[] {
    let sql = 'SELECT * FROM semantic_alias_candidates WHERE 1=1'
    const params: string[] = []
    if (datasetId !== undefined) {
      sql += ' AND dataset_id = ?'
      params.push(datasetId)
    }
    if (status !== undefined) {
      sql += ' AND status = ?'
      params.push(status)
    }
    sql += ' ORDER BY created_at DESC'
    const rows = this.db.prepare(sql).all(...params) as AliasCandidateRow[]
    return rows.map(rowToAliasCandidate)
  }

  setAliasCandidateStatus(candidateId: Id, status: ReviewStatus): SemanticAliasCandidate {
    const existing = this.db
      .prepare('SELECT * FROM semantic_alias_candidates WHERE candidate_id = ?')
      .get(candidateId) as AliasCandidateRow | undefined
    if (!existing) {
      throw new AliasCandidateNotFoundError(`Alias candidate ${candidateId} does not exist`)
    }
    const reviewedAt = status === 'candidate' ? null : new Date().toISOString()
    this.db
      .prepare(
        'UPDATE semantic_alias_candidates SET status = ?, reviewed_at = ? WHERE candidate_id = ?',
      )
      .run(status, reviewedAt, candidateId)
    return rowToAliasCandidate({ ...existing, status, reviewed_at: reviewedAt })
  }

  createGrainCandidate(input: {
    datasetId: Id
    tableId: string
    primaryKey: string[]
    grainDescription: string
    evidence: StructureEvidence
    actorId: Id
  }): GrainCandidate {
    const candidateId = `grain_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO semantic_structure_candidates
           (candidate_id, dataset_id, kind, table_id, primary_key_json, grain_description,
            evidence_json, status, actor_id, created_at, reviewed_at)
         VALUES (?, ?, 'grain', ?, ?, ?, ?, 'candidate', ?, ?, NULL)`,
      )
      .run(
        candidateId,
        input.datasetId,
        input.tableId,
        JSON.stringify(input.primaryKey),
        input.grainDescription,
        JSON.stringify(input.evidence),
        input.actorId,
        createdAt,
      )
    return {
      candidateId,
      datasetId: input.datasetId,
      tableId: input.tableId,
      primaryKey: [...input.primaryKey],
      grainDescription: input.grainDescription,
      evidence: input.evidence,
      status: 'candidate',
      actorId: input.actorId,
      createdAt,
      reviewedAt: null,
    }
  }

  createRelationshipCandidate(input: {
    datasetId: Id
    fromTable: string
    toTable: string
    fromColumns: string[]
    toColumns: string[]
    cardinality: '1:1' | '1:n' | 'n:1' | 'n:n'
    evidence: StructureEvidence
    actorId: Id
  }): RelationshipCandidate {
    const candidateId = `rel_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO semantic_structure_candidates
           (candidate_id, dataset_id, kind, from_table, to_table, from_columns_json,
            to_columns_json, cardinality, evidence_json, status, actor_id, created_at, reviewed_at)
         VALUES (?, ?, 'relationship', ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, NULL)`,
      )
      .run(
        candidateId,
        input.datasetId,
        input.fromTable,
        input.toTable,
        JSON.stringify(input.fromColumns),
        JSON.stringify(input.toColumns),
        input.cardinality,
        JSON.stringify(input.evidence),
        input.actorId,
        createdAt,
      )
    return {
      candidateId,
      datasetId: input.datasetId,
      fromTable: input.fromTable,
      toTable: input.toTable,
      fromColumns: [...input.fromColumns],
      toColumns: [...input.toColumns],
      cardinality: input.cardinality,
      evidence: input.evidence,
      status: 'candidate',
      actorId: input.actorId,
      createdAt,
      reviewedAt: null,
    }
  }

  listStructureCandidates(datasetId?: Id, status?: ReviewStatus): StructureCandidate[] {
    let sql = 'SELECT * FROM semantic_structure_candidates WHERE 1=1'
    const params: string[] = []
    if (datasetId !== undefined) {
      sql += ' AND dataset_id = ?'
      params.push(datasetId)
    }
    if (status !== undefined) {
      sql += ' AND status = ?'
      params.push(status)
    }
    sql += ' ORDER BY created_at DESC'
    const rows = this.db.prepare(sql).all(...params) as StructureCandidateRow[]
    return rows.map(rowToStructureCandidate)
  }

  setStructureCandidateStatus(candidateId: Id, status: ReviewStatus): StructureCandidate {
    const existing = this.db
      .prepare('SELECT * FROM semantic_structure_candidates WHERE candidate_id = ?')
      .get(candidateId) as StructureCandidateRow | undefined
    if (!existing) {
      throw new StructureCandidateNotFoundError(`Structure candidate ${candidateId} does not exist`)
    }
    const reviewedAt = status === 'candidate' ? null : new Date().toISOString()
    this.db
      .prepare(
        'UPDATE semantic_structure_candidates SET status = ?, reviewed_at = ? WHERE candidate_id = ?',
      )
      .run(status, reviewedAt, candidateId)
    return rowToStructureCandidate({ ...existing, status, reviewed_at: reviewedAt })
  }

  createLearningExample(
    input: Omit<LearningExample, 'exampleId' | 'status' | 'createdAt' | 'reviewedAt'>,
  ): LearningExample {
    const exampleId = `learn_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO learning_examples
       (example_id, analysis_id, analysis_revision, dataset_id, dataset_version_id,
        schema_fingerprint, semantic_revision_id, question, corrected_sql, status,
        actor_id, created_at, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, NULL)`,
      )
      .run(
        exampleId,
        input.analysisId,
        input.analysisRevision,
        input.datasetId,
        input.datasetVersionId,
        input.schemaFingerprint,
        input.semanticRevisionId,
        input.question,
        input.correctedSql,
        input.actorId,
        createdAt,
      )
    return { ...input, exampleId, status: 'candidate', createdAt, reviewedAt: null }
  }

  listCompatibleLearningExamples(input: {
    datasetId: Id
    schemaFingerprint: string
    semanticRevisionId: Id
    limit?: number
  }): LearningExample[] {
    const limit = Math.max(0, Math.min(input.limit ?? 3, 10))
    const rows = this.db
      .prepare(
        `SELECT * FROM learning_examples
       WHERE dataset_id = ? AND schema_fingerprint = ? AND semantic_revision_id = ?
         AND status = 'approved'
       ORDER BY reviewed_at DESC, created_at DESC LIMIT ?`,
      )
      .all(
        input.datasetId,
        input.schemaFingerprint,
        input.semanticRevisionId,
        limit,
      ) as LearningExampleRow[]
    return rows.map(rowToLearningExample)
  }

  setLearningExampleStatus(exampleId: Id, status: ReviewStatus): LearningExample {
    const existing = this.db
      .prepare('SELECT * FROM learning_examples WHERE example_id = ?')
      .get(exampleId) as LearningExampleRow | undefined
    if (!existing)
      throw new LearningExampleNotFoundError(`Learning example ${exampleId} does not exist`)
    const reviewedAt = status === 'candidate' ? null : new Date().toISOString()
    this.db
      .prepare('UPDATE learning_examples SET status = ?, reviewed_at = ? WHERE example_id = ?')
      .run(status, reviewedAt, exampleId)
    return rowToLearningExample({ ...existing, status, reviewed_at: reviewedAt })
  }

  /**
   * Store an analyst-review candidate for a Kaggle tabular source proposed by
   * trusted code. Always starts `candidate`; models cannot pass `approved` —
   * see `preview_ingest_source`.
   */
  createWorkspaceSourcePin(input: {
    slug: string
    sourceVersion: string
    recipe: IngestRecipe
    actorId: Id
  }): WorkspaceSourcePin {
    const pinId = `pin_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO workspace_source_pins
           (pin_id, slug, source_version, recipe_json, status, actor_id, created_at, reviewed_at)
         VALUES (?, ?, ?, ?, 'candidate', ?, ?, NULL)`,
      )
      .run(
        pinId,
        input.slug,
        input.sourceVersion,
        JSON.stringify(input.recipe),
        input.actorId,
        createdAt,
      )
    return {
      pinId,
      revision: 1,
      slug: input.slug,
      sourceVersion: input.sourceVersion,
      recipe: input.recipe,
      status: 'candidate',
      actorId: input.actorId,
      createdAt,
      reviewedAt: null,
    }
  }

  getWorkspaceSourcePin(pinId: Id): WorkspaceSourcePin | undefined {
    const row = this.db
      .prepare('SELECT * FROM workspace_source_pins WHERE pin_id = ?')
      .get(pinId) as WorkspaceSourcePinRow | undefined
    return row ? rowToWorkspaceSourcePin(row) : undefined
  }

  /** All pins for a slug (case-insensitive), oldest first, or every pin when omitted. */
  listWorkspaceSourcePins(slug?: string): WorkspaceSourcePin[] {
    const rows = (
      slug === undefined
        ? this.db.prepare('SELECT * FROM workspace_source_pins ORDER BY created_at ASC').all()
        : this.db
            .prepare(
              'SELECT * FROM workspace_source_pins WHERE LOWER(slug) = LOWER(?) ORDER BY created_at ASC',
            )
            .all(slug)
    ) as WorkspaceSourcePinRow[]
    return rows.map(rowToWorkspaceSourcePin)
  }

  /** Authenticated analyst review action only — never set from a model tool argument. */
  setWorkspaceSourcePinStatus(
    pinId: Id,
    status: Exclude<WorkspaceSourcePinStatus, 'candidate'>,
    expectedRevision: number,
  ): WorkspaceSourcePin {
    return this.db
      .transaction(() => {
        const existing = this.getWorkspaceSourcePin(pinId)
        if (!existing)
          throw new WorkspaceSourcePinNotFoundError(`Workspace source pin ${pinId} does not exist`)
        if (
          !Number.isSafeInteger(expectedRevision) ||
          existing.revision !== expectedRevision ||
          (status === 'approved' && existing.status !== 'candidate')
        )
          throw new WorkspaceSourcePinConflictError(
            'Source proposal changed; reload before reviewing',
          )
        this.db
          .prepare(
            'UPDATE workspace_source_pins SET status = ?, reviewed_at = ?, revision = revision + 1 WHERE pin_id = ? AND revision = ?',
          )
          .run(status, new Date().toISOString(), pinId, expectedRevision)
        return this.getWorkspaceSourcePin(pinId)!
      })
      .immediate()
  }

  /** Only the exact candidate the analyst reviewed can be replaced. */
  setWorkspaceSourcePinRecipe(
    pinId: Id,
    recipe: IngestRecipe,
    expectedRevision: number,
  ): WorkspaceSourcePin {
    return this.db
      .transaction(() => {
        const existing = this.getWorkspaceSourcePin(pinId)
        if (!existing)
          throw new WorkspaceSourcePinNotFoundError(`Workspace source pin ${pinId} does not exist`)
        if (
          !Number.isSafeInteger(expectedRevision) ||
          existing.revision !== expectedRevision ||
          existing.status !== 'candidate'
        )
          throw new WorkspaceSourcePinConflictError('Source proposal changed; reload before saving')
        this.db
          .prepare(
            'UPDATE workspace_source_pins SET recipe_json = ?, revision = revision + 1 WHERE pin_id = ? AND revision = ?',
          )
          .run(JSON.stringify(recipe), pinId, expectedRevision)
        return this.getWorkspaceSourcePin(pinId)!
      })
      .immediate()
  }

  /**
   * Walkthrough observability: append a single compact milestone. `WorkflowTrailEntrySchema` (via
   * `.omit(...)` below) validates every field — including the bounded
   * identifier-shaped `receiptId` regex — before anything is written, so a
   * caller cannot persist a raw row, SVG, or credential-shaped string into
   * this table even by accident. Never overwrites or removes a prior entry.
   */
  recordWorkflowMilestone(input: {
    milestone: WorkflowMilestoneType
    actor: WorkflowActor
    datasetVersionId?: Id | null
    analysisId?: Id | null
    receiptId: string
  }): WorkflowTrailEntry {
    const recordedAt = new Date().toISOString()
    const entryId = `trail_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const candidate = WorkflowTrailEntrySchema.parse({
      entryId,
      milestone: input.milestone,
      actor: input.actor,
      datasetVersionId: input.datasetVersionId ?? null,
      analysisId: input.analysisId ?? null,
      receiptId: input.receiptId,
      recordedAt,
    })
    this.db
      .prepare(
        `INSERT INTO workflow_trail
           (entry_id, milestone, actor, dataset_version_id, analysis_id, receipt_id, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.entryId,
        candidate.milestone,
        candidate.actor,
        candidate.datasetVersionId,
        candidate.analysisId,
        candidate.receiptId,
        candidate.recordedAt,
      )
    return candidate
  }

  /**
   * Chronological (oldest first) milestones for one dataset version and/or
   * analysis id. Omitting both filters returns the most recent entries across
   * the whole workspace, bounded by `limit` (default 200, capped at 500).
   */
  listWorkflowTrail(
    filter: { datasetVersionId?: Id; analysisId?: Id; limit?: number } = {},
  ): WorkflowTrailEntry[] {
    const bounded = Math.max(1, Math.min(Math.trunc(filter.limit ?? 200) || 200, 500))
    let sql = 'SELECT * FROM workflow_trail WHERE 1=1'
    const params: string[] = []
    if (filter.datasetVersionId !== undefined) {
      sql += ' AND dataset_version_id = ?'
      params.push(filter.datasetVersionId)
    }
    if (filter.analysisId !== undefined) {
      sql += ' AND analysis_id = ?'
      params.push(filter.analysisId)
    }
    // `rowid` (SQLite's implicit insertion-order key), not `entry_id`, breaks
    // a `recorded_at` tie deterministically in insertion order — two
    // milestones recorded within the same millisecond (e.g. preview
    // proposed/analyst approved in a fast test or a fast analyst click)
    // must not sort by their random entry id.
    sql += ' ORDER BY recorded_at ASC, rowid ASC LIMIT ?'
    const rows = this.db.prepare(sql).all(...params, bounded) as WorkflowTrailRow[]
    return rows.map(rowToWorkflowTrailEntry)
  }

  close(): void {
    this.db.close()
  }
}

interface DashboardRow {
  dashboard_id: string
  title: string
  layout_json: string
  active_filter_json: string | null
  archived: number
  created_at: string
  updated_at: string
}

interface FeedbackRow {
  feedback_id: string
  analysis_id: string
  analysis_revision: number
  kind: string
  actor_id: string
  status: string
  comment: string
  created_at: string
}

interface ChartFeedbackRow {
  feedback_id: string
  artifact_id: string
  analysis_id: string
  analysis_revision: number
  issue_type: string
  notes: string | null
  status: string
  actor_id: string
  created_at: string
  reviewed_at: string | null
}

interface AliasCandidateRow {
  candidate_id: string
  dataset_id: string
  term: string
  expression: string
  description: string
  table_id: string
  aggregation: string | null
  units: string | null
  date_column: string | null
  inclusion: string | null
  status: string
  actor_id: string
  created_at: string
  reviewed_at: string | null
}

interface StructureCandidateRow {
  candidate_id: string
  dataset_id: string
  kind: string
  table_id: string | null
  primary_key_json: string | null
  grain_description: string | null
  from_table: string | null
  to_table: string | null
  from_columns_json: string | null
  to_columns_json: string | null
  cardinality: string | null
  evidence_json: string
  status: string
  actor_id: string
  created_at: string
  reviewed_at: string | null
}

interface LearningExampleRow {
  example_id: string
  analysis_id: string
  analysis_revision: number
  dataset_id: string
  dataset_version_id: string
  schema_fingerprint: string
  semantic_revision_id: string
  question: string
  corrected_sql: string
  status: string
  actor_id: string
  created_at: string
  reviewed_at: string | null
}

interface WorkspaceSourcePinRow {
  revision: number
  pin_id: string
  slug: string
  source_version: string
  recipe_json: string
  status: string
  actor_id: string
  created_at: string
  reviewed_at: string | null
}

function rowToDashboard(row: DashboardRow): Dashboard {
  const activeFilter = row.active_filter_json
    ? DashboardActiveFilterSchema.parse(JSON.parse(row.active_filter_json) as unknown)
    : undefined
  return {
    dashboardId: row.dashboard_id,
    title: row.title,
    layout: JSON.parse(row.layout_json) as DashboardLayout,
    ...(activeFilter ? { activeFilter } : {}),
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToFeedback(row: FeedbackRow): Feedback {
  return {
    feedbackId: row.feedback_id,
    analysisId: row.analysis_id,
    analysisRevision: row.analysis_revision,
    kind: row.kind as FeedbackKind,
    actorId: row.actor_id,
    status: row.status as ReviewStatus,
    comment: row.comment,
    createdAt: row.created_at,
  }
}

function rowToChartFeedback(row: ChartFeedbackRow): ChartFeedback {
  return {
    feedbackId: row.feedback_id,
    artifactId: row.artifact_id,
    analysisId: row.analysis_id,
    analysisRevision: row.analysis_revision,
    issueType: row.issue_type as ChartFeedbackIssueType,
    ...(row.notes ? { notes: row.notes } : {}),
    status: row.status as ReviewStatus,
    actorId: row.actor_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  }
}

function rowToAliasCandidate(row: AliasCandidateRow): SemanticAliasCandidate {
  return {
    candidateId: row.candidate_id,
    datasetId: row.dataset_id,
    term: row.term,
    expression: row.expression,
    description: row.description,
    tableId: row.table_id,
    ...(row.aggregation ? { aggregation: row.aggregation as MetricAggregation } : {}),
    ...(row.units ? { units: row.units } : {}),
    ...(row.date_column ? { dateColumn: row.date_column } : {}),
    ...(row.inclusion ? { inclusion: row.inclusion } : {}),
    status: row.status as ReviewStatus,
    actorId: row.actor_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  }
}

function rowToStructureCandidate(row: StructureCandidateRow): StructureCandidate {
  const evidence = (JSON.parse(row.evidence_json) ?? {}) as StructureEvidence
  if (row.kind === 'relationship') {
    return {
      candidateId: row.candidate_id,
      datasetId: row.dataset_id,
      fromTable: row.from_table ?? '',
      toTable: row.to_table ?? '',
      fromColumns: (JSON.parse(row.from_columns_json ?? '[]') ?? []) as string[],
      toColumns: (JSON.parse(row.to_columns_json ?? '[]') ?? []) as string[],
      cardinality: (row.cardinality ?? 'n:n') as '1:1' | '1:n' | 'n:1' | 'n:n',
      evidence,
      status: row.status as ReviewStatus,
      actorId: row.actor_id,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
    }
  }
  return {
    candidateId: row.candidate_id,
    datasetId: row.dataset_id,
    tableId: row.table_id ?? '',
    primaryKey: (JSON.parse(row.primary_key_json ?? '[]') ?? []) as string[],
    grainDescription: row.grain_description ?? '',
    evidence,
    status: row.status as ReviewStatus,
    actorId: row.actor_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  }
}

function rowToLearningExample(row: LearningExampleRow): LearningExample {
  return {
    exampleId: row.example_id,
    analysisId: row.analysis_id,
    analysisRevision: row.analysis_revision,
    datasetId: row.dataset_id,
    datasetVersionId: row.dataset_version_id,
    schemaFingerprint: row.schema_fingerprint,
    semanticRevisionId: row.semantic_revision_id,
    question: row.question,
    correctedSql: row.corrected_sql,
    status: row.status as ReviewStatus,
    actorId: row.actor_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  }
}

interface WorkflowTrailRow {
  entry_id: string
  milestone: string
  actor: string
  dataset_version_id: string | null
  analysis_id: string | null
  receipt_id: string
  recorded_at: string
}

function rowToWorkflowTrailEntry(row: WorkflowTrailRow): WorkflowTrailEntry {
  return {
    entryId: row.entry_id,
    milestone: row.milestone as WorkflowMilestoneType,
    actor: row.actor as WorkflowActor,
    datasetVersionId: row.dataset_version_id,
    analysisId: row.analysis_id,
    receiptId: row.receipt_id,
    recordedAt: row.recorded_at,
  }
}

function rowToWorkspaceSourcePin(row: WorkspaceSourcePinRow): WorkspaceSourcePin {
  return {
    pinId: row.pin_id,
    revision: row.revision,
    slug: row.slug,
    sourceVersion: row.source_version,
    recipe: JSON.parse(row.recipe_json) as IngestRecipe,
    status: row.status as WorkspaceSourcePinStatus,
    actorId: row.actor_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  }
}
