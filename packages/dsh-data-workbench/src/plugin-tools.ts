/**
 * Analyst persistence/export tools. Approval attribution uses the session
 * actor when present; models cannot set approved:true.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  listAnalysisRevisions,
  loadAnalysisRevision,
  saveAnalysisRevision,
} from 'dsh-data-core/analysis-store'
import { checkStudioAvailability } from './overview.js'
import {
  planDashboardFilters,
  stripFilterCaption,
  unwrapEqualityFilter,
  withFilterCaption,
} from 'dsh-data-core/dashboard-filters'
import { AnalysisRevisionConflictError, MetadataStore } from 'dsh-data-core/metadata-store'
import { loadStoredQueryResult } from 'dsh-data-core/stored-result'
import { resolveWorkspacePaths, type WorkspacePaths } from 'dsh-data-core/workspace-paths'
import type { AnalysisRevision, Dashboard, DashboardActiveFilter } from 'dsh-data-core/contracts'
import { ChartFeedbackIssueTypeSchema, ChartIntentSchema } from 'dsh-data-core/contracts'
import { renderObserve, type ObserveKind } from 'dsh-data-core/tool-observe'
import { DuckDBInstance } from '@duckdb/node-api'
import { authorizeQuery } from 'dsh-data-duckdb/sql-policy'
import { executeIsolatedQuery } from 'dsh-data-duckdb/query-worker'
import { createChartArtifact } from 'dsh-data-viz/chart-service'
import {
  assertArtifactMatchesResult,
  writeDashboardExportPack,
  writeExportPack,
} from './export-pack.js'
import { absolutizeReportDownloads, resolveAnalystPublicOrigin } from './public-origin.js'
import { commitStaged, discardStaged, rollbackPromoted } from './ui-staging.js'

function withRuntimeDownloadUrls<T extends { downloads: Record<string, string> }>(
  ctx: Context,
  pack: T,
): T {
  const webServer = ctx.get('webServer') as { port?: number } | undefined
  const origin = resolveAnalystPublicOrigin({ webServer })
  return {
    ...pack,
    downloads: absolutizeReportDownloads(pack.downloads, origin),
  }
}

/** Same simple-identifier boundary as query-filter's IDENT (see the AST-based policy rationale in "Why these choices" in docs/architecture.md). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Delimited, capped observe text — replaces a raw JSON dump. None of these
 * workbench results is query/schema/chart/ingest-shaped (they're saved
 * analyses, dashboards, and proposals), so they use the bounded `catalog`
 * kind, which passes its fields through capped rather than allowlisted.
 */
function observeRender(kind: ObserveKind) {
  return (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: renderObserve(kind, value).text },
  ]
}

function sessionActorId(exec: { session?: { user?: { id?: string } } } | unknown): string {
  if (!exec || typeof exec !== 'object') return 'analyst-session'
  const session = (exec as { session?: { user?: { id?: string } } }).session
  const id = session?.user?.id?.trim()
  return id || 'analyst-session'
}

/** A prepared (not-yet-persisted) revision draft, carrying the analysis
 * revision it was built against so the eventual metadata commit can detect a
 * concurrent write that superseded it (optimistic concurrency, see
 * `MetadataStore.publishDashboardFilter`). */
export type PreparedAnalysisRevision = AnalysisRevision & { expectedRevision?: number }

export interface ApplyDashboardFiltersResult {
  dashboardId: string
  applied: Array<{ analysisId: string; revision: number }>
  unsupported: Array<{ analysisId: string; reason: string }>
  preparedRevisions?: PreparedAnalysisRevision[]
  activeFilter?: DashboardActiveFilter
  dashboard?: Dashboard
}

/**
 * Apply one shared equality filter to every pinned slot that mapped the
 * given column. Each supported slot is re-authorized and re-executed
 * independently.
 *
 * A **policy violation** (the re-authorized SQL fails `authorizeQuery`) marks
 * just that slot unsupported and continues with its siblings because it is a
 * deterministic property of that slot's SQL (never claim an unsupported card
 * changed).
 *
 * An **execution failure** (the query runs but the isolated DuckDB adapter or
 * chart regeneration throws) aborts the entire shared-filter publish so the
 * caller can clean up staged output without exposing a partial result.
 *
 * Shared by `apply_dashboard_filters` and the workbench filter-bar POST
 * handler so there is exactly one execution path.
 */
async function prepareDashboardSharedFilter(
  workspace: WorkspacePaths,
  dashboardId: string,
  filter: { column: string; value: string },
  options: {
    resultStoreDir?: string
    artifactStoreDir?: string
    signal?: AbortSignal
  } = {},
): Promise<ApplyDashboardFiltersResult> {
  const store = new MetadataStore(workspace.catalogPath)
  try {
    const dashboard = store.loadDashboard(dashboardId)
    if (!dashboard) throw new Error(`Unknown dashboard "${dashboardId}"`)
    if (dashboard.activeFilter && dashboard.activeFilter.column !== filter.column) {
      throw new AnalysisRevisionConflictError(
        `Clear the active ${dashboard.activeFilter.column} filter before applying ${filter.column}`,
      )
    }

    // `analysesById` holds each slot's *current pinned* revision — the
    // source of dataset/semantic ids, chart intent, SQL, and question. A
    // pinned revision may itself be several revisions past revision 1 for a
    // legitimate reason (e.g. a corrected query), so it — never a hardcoded
    // revision 1 — is what a first filter builds on. Repeated applies use the
    // exact base revision recorded in trusted active-filter metadata. A legacy
    // wrapper without that metadata is withheld because its base is unknown.
    const currentById = new Map<string, AnalysisRevision>()
    const analysesById = new Map<string, AnalysisRevision>()
    const legacyBaseUnavailable = new Set<string>()
    for (const slot of dashboard.layout.slots) {
      const current = store.loadAnalysisRevision(slot.analysisId, slot.revision)
      if (!current) continue
      currentById.set(slot.analysisId, current)
      const prior = dashboard.activeFilter?.cards.find(
        (card) => card.analysisId === slot.analysisId,
      )
      if (prior?.status === 'changed' && !slot.sharedFilterKeys.includes(filter.column)) {
        throw new AnalysisRevisionConflictError(
          'Clear the active filter before changing mappings on a filtered card',
        )
      }
      if (prior?.status === 'unsupported' && prior.reason === 'base-revision-unavailable') {
        legacyBaseUnavailable.add(slot.analysisId)
        continue
      }
      const filtered = prior?.filteredRevision
        ? store.loadAnalysisRevision(slot.analysisId, prior.filteredRevision)
        : undefined
      if (prior?.status === 'changed' && (!filtered || !sameDataProvenance(current, filtered))) {
        throw new AnalysisRevisionConflictError(
          `Analysis "${slot.analysisId}" changed its query or result; clear or restore it before reapplying`,
        )
      }
      const base =
        prior?.status === 'changed'
          ? store.loadAnalysisRevision(slot.analysisId, prior.baseRevision)
          : undefined
      if (base) analysesById.set(slot.analysisId, base)
      else if (unwrapEqualityFilter(current.query.sql) !== current.query.sql) {
        legacyBaseUnavailable.add(slot.analysisId)
        continue
      } else analysesById.set(slot.analysisId, current)
    }
    const sqlByAnalysis = new Map(
      [...analysesById.entries()].map(([analysisId, analysis]) => [analysisId, analysis.query.sql]),
    )
    const plans = planDashboardFilters(dashboard.layout.slots, sqlByAnalysis, filter)

    const applied: Array<{ analysisId: string; revision: number }> = []
    const unsupported: Array<{ analysisId: string; reason: string }> = []
    const preparedRevisions: PreparedAnalysisRevision[] = []
    const result: ApplyDashboardFiltersResult = {
      dashboardId: dashboard.dashboardId,
      applied,
      unsupported,
      preparedRevisions,
    }

    for (const plan of plans) {
      if (legacyBaseUnavailable.has(plan.analysisId)) {
        unsupported.push({ analysisId: plan.analysisId, reason: 'base-revision-unavailable' })
        continue
      }
      if (!plan.supported || !plan.nextSql) {
        unsupported.push({ analysisId: plan.analysisId, reason: plan.reason ?? 'unsupported' })
        continue
      }
      const analysis = analysesById.get(plan.analysisId)
      if (!analysis) {
        unsupported.push({ analysisId: plan.analysisId, reason: 'base-revision-unavailable' })
        continue
      }
      const manifest = store.getDatasetVersion(analysis.datasetVersionId)
      if (!manifest) {
        unsupported.push({ analysisId: plan.analysisId, reason: 'dataset-version-not-found' })
        continue
      }
      const allowedTables = manifest.tables.map((table) => table.id)

      const policyDb = await DuckDBInstance.create(':memory:')
      const policyConnection = await policyDb.connect()
      try {
        await authorizeQuery(policyConnection, plan.nextSql, { allowedTables })
      } catch (error) {
        // Policy denials are disclosed as unsupported; runtime failures below
        // abort the staged publish.
        unsupported.push({
          analysisId: plan.analysisId,
          reason: error instanceof Error ? error.message : String(error),
        })
        continue
      } finally {
        policyConnection.closeSync()
        policyDb.closeSync()
      }

      const summary = await executeIsolatedQuery({
        datasetPath: workspace.datasetFile(manifest.datasetVersionId, manifest.datasetId),
        datasetVersionId: analysis.datasetVersionId,
        semanticRevisionId: analysis.semanticRevisionId,
        sql: plan.nextSql,
        parameters: analysis.query.parameters,
        allowedTables,
        resultStoreDir: options.resultStoreDir ?? workspace.resultsDir,
        signal: options.signal,
      })
      // Never carry the previous revision's artifactIds onto this one — a
      // filtered card must not render the pre-filter chart as if it were
      // current. If the prior revision had a rendered chart, regenerate a
      // fresh artifact for the new (filtered) resultId using the same
      // chart intent; otherwise there is nothing to regenerate.
      const presentation = currentById.get(plan.analysisId) ?? analysis
      let artifactIds: string[] = []
      if (presentation.artifactIds.length > 0) {
        const chartArtifact = await createChartArtifact({
          resultId: summary.resultId,
          intent: presentation.chart,
          resultStoreDir: options.resultStoreDir ?? workspace.resultsDir,
          artifactStoreDir: options.artifactStoreDir ?? workspace.artifactsDir,
        })
        artifactIds = [chartArtifact.artifactId]
      }
      const draft = {
        contractVersion: 1 as const,
        analysisId: analysis.analysisId,
        expectedRevision: plan.revision,
        datasetVersionId: analysis.datasetVersionId,
        semanticRevisionId: analysis.semanticRevisionId,
        question: stripFilterCaption(presentation.question),
        query: {
          datasetVersionId: analysis.datasetVersionId,
          semanticRevisionId: analysis.semanticRevisionId,
          sql: plan.nextSql,
          parameters: analysis.query.parameters,
        },
        resultId: summary.resultId,
        chart: presentation.chart,
        artifactIds,
        filter,
      }
      const { filter: _filterInput, ...persistedDraft } = draft
      preparedRevisions.push({
        ...persistedDraft,
        question: withFilterCaption(persistedDraft.question, filter),
        revision: 0,
        createdAt: new Date().toISOString(),
      })
      applied.push({ analysisId: analysis.analysisId, revision: plan.revision + 1 })
    }
    result.activeFilter = {
      column: filter.column,
      value: filter.value,
      scope: 'saved-result',
      appliedDashboardVersion: dashboard.updatedAt,
      cards: dashboard.layout.slots.map((slot) => {
        const base = analysesById.get(slot.analysisId) ?? currentById.get(slot.analysisId)
        const changed = applied.find((item) => item.analysisId === slot.analysisId)
        const failure = unsupported.find((item) => item.analysisId === slot.analysisId)
        return {
          analysisId: slot.analysisId,
          baseRevision: base?.revision ?? slot.revision,
          status: changed
            ? ('changed' as const)
            : failure?.reason === 'no-shared-filter-keys' || failure?.reason === 'column-not-mapped'
              ? ('unmapped' as const)
              : ('unsupported' as const),
          ...(changed ? { filteredRevision: changed.revision } : {}),
          ...(failure ? { reason: failure.reason } : {}),
        }
      }),
    }
    return result
  } finally {
    store.close()
  }
}

export async function applyDashboardSharedFilter(
  workspace: WorkspacePaths,
  dashboardId: string,
  filter: { column: string; value: string },
  options: { expectedVersion?: string; signal?: AbortSignal } = {},
): Promise<ApplyDashboardFiltersResult> {
  const stageRoot = join(workspace.root, '.ui-staging', randomUUID())
  let promotedPaths: string[] = []
  try {
    const store = new MetadataStore(workspace.catalogPath)
    const dashboard = store.loadDashboard(dashboardId)
    store.close()
    if (!dashboard) throw new Error(`Unknown dashboard "${dashboardId}"`)
    const expectedVersion = options.expectedVersion ?? dashboard.updatedAt
    const prepared = await prepareDashboardSharedFilter(workspace, dashboardId, filter, {
      resultStoreDir: join(stageRoot, '.private', 'results'),
      artifactStoreDir: join(stageRoot, '.private', 'artifacts'),
      signal: options.signal,
    })
    if (options.signal?.aborted) throw new Error('Request aborted')
    promotedPaths = await commitStaged(stageRoot, {
      results: workspace.resultsDir,
      artifacts: workspace.artifactsDir,
    })
    if (options.signal?.aborted) throw new Error('Request aborted')
    const publisher = new MetadataStore(workspace.catalogPath)
    try {
      const updated = publisher.publishDashboardFilter(
        dashboardId,
        expectedVersion,
        prepared.preparedRevisions ?? [],
        prepared.activeFilter,
      )
      const { preparedRevisions: _preparedRevisions, ...receipt } = prepared
      return { ...receipt, dashboard: updated }
    } finally {
      publisher.close()
    }
  } catch (error) {
    await discardStaged(stageRoot)
    if (promotedPaths.length) await rollbackPromoted(promotedPaths)
    throw error
  }
}

function sameDataProvenance(left: AnalysisRevision, right: AnalysisRevision): boolean {
  return (
    left.datasetVersionId === right.datasetVersionId &&
    left.semanticRevisionId === right.semanticRevisionId &&
    left.resultId === right.resultId &&
    JSON.stringify(left.query) === JSON.stringify(right.query)
  )
}

export async function clearDashboardSharedFilter(
  workspace: WorkspacePaths,
  dashboardId: string,
  expectedVersion: string,
  signal?: AbortSignal,
): Promise<ApplyDashboardFiltersResult> {
  const stageRoot = join(workspace.root, '.ui-staging', randomUUID())
  let promotedPaths: string[] = []
  let reader: MetadataStore | undefined
  try {
    const store = new MetadataStore(workspace.catalogPath)
    reader = store
    const dashboard = store.loadDashboard(dashboardId)
    if (!dashboard) {
      throw new Error(`Unknown dashboard "${dashboardId}"`)
    }
    if (dashboard.updatedAt !== expectedVersion) {
      throw new Error(
        `Dashboard version conflict: expected ${expectedVersion}, current ${dashboard.updatedAt}`,
      )
    }
    if (!dashboard.activeFilter) {
      throw new Error('No trusted active dashboard filter is available to clear')
    }
    const revisions: PreparedAnalysisRevision[] = []
    for (const state of dashboard.activeFilter.cards.filter((card) => card.status === 'changed')) {
      if (signal?.aborted) throw new Error('Request aborted')
      const slot = dashboard.layout.slots.find(
        (candidate) => candidate.analysisId === state.analysisId,
      )
      if (!slot) continue
      const base = store.loadAnalysisRevision(state.analysisId, state.baseRevision)
      const filtered = state.filteredRevision
        ? store.loadAnalysisRevision(state.analysisId, state.filteredRevision)
        : undefined
      const current = store.loadAnalysisRevision(state.analysisId, slot.revision)
      if (!base || !filtered || !current || !sameDataProvenance(current, filtered)) {
        throw new AnalysisRevisionConflictError(
          `Analysis "${state.analysisId}" changed its query or result; restore and re-pin from history`,
        )
      }
      let artifactIds: string[] = []
      if (current.artifactIds.length > 0) {
        const artifact = await createChartArtifact({
          resultId: base.resultId,
          intent: current.chart,
          resultStoreDir: workspace.resultsDir,
          artifactStoreDir: join(stageRoot, '.private', 'artifacts'),
        })
        artifactIds = [artifact.artifactId]
      }
      revisions.push({
        contractVersion: 1,
        analysisId: state.analysisId,
        revision: 0,
        expectedRevision: slot.revision,
        datasetVersionId: base.datasetVersionId,
        semanticRevisionId: base.semanticRevisionId,
        question: stripFilterCaption(current.question),
        query: base.query,
        resultId: base.resultId,
        chart: current.chart,
        artifactIds,
        createdAt: new Date().toISOString(),
      })
    }
    store.close()
    reader = undefined
    if (signal?.aborted) throw new Error('Request aborted')
    promotedPaths = await commitStaged(stageRoot, {
      artifacts: workspace.artifactsDir,
      results: workspace.resultsDir,
    })
    if (signal?.aborted) throw new Error('Request aborted')
    const publisher = new MetadataStore(workspace.catalogPath)
    try {
      const updated = publisher.publishDashboardFilter(
        dashboardId,
        expectedVersion,
        revisions,
        null,
      )
      return {
        dashboardId,
        applied: revisions.map((revision) => ({
          analysisId: revision.analysisId,
          revision: revision.expectedRevision! + 1,
        })),
        unsupported: [],
        dashboard: updated,
      }
    } finally {
      publisher.close()
    }
  } catch (error) {
    reader?.close()
    await discardStaged(stageRoot)
    if (promotedPaths.length) await rollbackPromoted(promotedPaths)
    throw error
  }
}

/**
 * Local structural stand-in for a JSON value (not imported from
 * `@deepseek-ai/dsh-util-values`, which is not a declared dependency here).
 * Used by tools whose strict `output.schema` declares a loose array of
 * objects, so a typed service result narrows at the tool boundary instead of
 * escaping the schema with `as never`.
 */
type JsonLikeValue =
  null | boolean | number | string | JsonLikeValue[] | { [key: string]: JsonLikeValue }

export function registerWorkbenchAnalystTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'list_pending_metrics',
      description:
        'List metric/alias definition candidates awaiting analyst approval, with their formulas and table scope. The analyst approves or rejects them (individually or in batch) from the tool card; models cannot approve.',
      parameters: {
        datasetId: { type: 'string', description: 'Restrict to one published dataset id.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      execute(args) {
        const workspace = resolveWorkspacePaths()
        const store = new MetadataStore(workspace.catalogPath)
        try {
          const candidates = store.listAliasCandidates(
            args.datasetId ? String(args.datasetId) : undefined,
            'candidate',
          )
          return {
            candidates: candidates.map((candidate) => ({
              candidateId: candidate.candidateId,
              datasetId: candidate.datasetId,
              term: candidate.term,
              expression: candidate.expression,
              description: candidate.description,
              tableId: candidate.tableId,
              status: candidate.status,
            })),
          } as never
        } finally {
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'propose_metric',
      description:
        'Record a semantic alias candidate for analyst review, optionally with structured aggregation, units, date column, and inclusion rules. Does not approve the definition; approval is an authenticated analyst action.',
      parameters: {
        datasetId: { type: 'string', required: true },
        term: { type: 'string', required: true },
        expression: { type: 'string', required: true },
        description: { type: 'string', required: true },
        tableId: { type: 'string', required: true },
        aggregation: {
          type: 'string',
          description:
            'Structured aggregation intent: sum, avg, count, min, max, or count_distinct.',
        },
        units: { type: 'string', description: 'Display/currency unit (e.g. USD, count, days).' },
        dateColumn: {
          type: 'string',
          description: 'Date/calendar column the measure is sliced by.',
        },
        inclusion: { type: 'string', description: 'Human-reviewed inclusion/exclusion rule.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      execute(args, exec) {
        if ('approved' in args) {
          throw new Error('Models cannot approve semantic aliases')
        }
        const workspace = resolveWorkspacePaths()
        const store = new MetadataStore(workspace.catalogPath)
        try {
          const published = store.getCurrentDatasetVersion(String(args.datasetId))
          if (!published) throw new Error(`No published dataset "${String(args.datasetId)}"`)
          const aggregation = args.aggregation ? String(args.aggregation) : undefined
          const candidate = store.createAliasCandidate({
            datasetId: published.datasetId,
            term: String(args.term),
            expression: String(args.expression),
            description: String(args.description),
            tableId: String(args.tableId),
            ...(aggregation === 'sum' ||
            aggregation === 'avg' ||
            aggregation === 'count' ||
            aggregation === 'min' ||
            aggregation === 'max' ||
            aggregation === 'count_distinct'
              ? { aggregation }
              : {}),
            ...(args.units ? { units: String(args.units) } : {}),
            ...(args.dateColumn ? { dateColumn: String(args.dateColumn) } : {}),
            ...(args.inclusion ? { inclusion: String(args.inclusion) } : {}),
            actorId: sessionActorId(exec),
          })
          return {
            proposalId: candidate.candidateId,
            datasetId: candidate.datasetId,
            term: candidate.term,
            expression: candidate.expression,
            description: candidate.description,
            tableId: candidate.tableId,
            ...(candidate.aggregation ? { aggregation: candidate.aggregation } : {}),
            ...(candidate.units ? { units: candidate.units } : {}),
            ...(candidate.dateColumn ? { dateColumn: candidate.dateColumn } : {}),
            ...(candidate.inclusion ? { inclusion: candidate.inclusion } : {}),
            status: candidate.status,
            actorId: candidate.actorId,
          } as never
        } finally {
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'propose_sql_correction',
      description:
        'Submit a corrected SQL candidate for an existing saved analysis. It is parser-validated but remains inactive until the analyst approves it in the UI.',
      parameters: {
        analysisId: { type: 'string', required: true },
        revision: { type: 'number' },
        correctedSql: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      async execute(args, exec) {
        if ('approved' in args) throw new Error('Models cannot approve SQL corrections')
        const workspace = resolveWorkspacePaths()
        const store = new MetadataStore(workspace.catalogPath)
        const policyDb = await DuckDBInstance.create(':memory:')
        const connection = await policyDb.connect()
        try {
          const revision = args.revision === undefined ? undefined : Number(args.revision)
          const analysis = store.loadAnalysisRevision(String(args.analysisId), revision)
          if (!analysis) throw new Error(`Unknown analysis "${String(args.analysisId)}"`)
          const manifest = store.getDatasetVersion(analysis.datasetVersionId)
          if (!manifest) throw new Error(`Unknown dataset version "${analysis.datasetVersionId}"`)
          const correctedSql = String(args.correctedSql)
          await authorizeQuery(connection, correctedSql, {
            allowedTables: manifest.tables.map((table) => table.id),
          })
          const example = store.createLearningExample({
            analysisId: analysis.analysisId,
            analysisRevision: analysis.revision,
            datasetId: manifest.datasetId,
            datasetVersionId: manifest.datasetVersionId,
            schemaFingerprint: manifest.recipeHash,
            semanticRevisionId: analysis.semanticRevisionId,
            question: analysis.question,
            correctedSql,
            actorId: sessionActorId(exec),
          })
          return {
            proposalId: example.exampleId,
            analysisId: example.analysisId,
            question: example.question,
            correctedSql: example.correctedSql,
            status: example.status,
          } as never
        } finally {
          connection.closeSync()
          policyDb.closeSync()
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'save_analysis',
      description:
        'Save an analysis revision bound to an authorized result and optional chart artifact. Treat persisted: true plus the returned revision as the completion receipt.',
      parameters: {
        resultId: { type: 'string', required: true },
        question: { type: 'string', required: true },
        artifactId: { type: 'string' },
        analysisId: { type: 'string' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            persisted: { type: 'boolean', required: true },
            analysisId: { type: 'string', required: true },
            revision: { type: 'number', required: true },
            datasetVersionId: { type: 'string', required: true },
            semanticRevisionId: { type: 'string', required: true },
            resultId: { type: 'string', required: true },
          },
        },
        render: observeRender('catalog'),
      },
      async execute(args) {
        const workspace = resolveWorkspacePaths()
        const stored = await loadStoredQueryResult(workspace.resultsDir, String(args.resultId))
        const artifactId = args.artifactId ? String(args.artifactId) : undefined
        const chart = artifactId
          ? ChartIntentSchema.parse(
              (
                await assertArtifactMatchesResult(
                  workspace.artifactsDir,
                  artifactId,
                  String(args.resultId),
                )
              ).intent,
            )
          : { mark: 'table' as const, title: String(args.question) }
        const saved = await saveAnalysisRevision(workspace.catalogPath, {
          analysisId: args.analysisId ? String(args.analysisId) : undefined,
          datasetVersionId: stored.datasetVersionId,
          semanticRevisionId: stored.semanticRevisionId,
          question: String(args.question),
          query: {
            datasetVersionId: stored.datasetVersionId,
            semanticRevisionId: stored.semanticRevisionId,
            sql: stored.sql,
            parameters: [],
          },
          resultId: stored.resultId ?? String(args.resultId),
          chart,
          artifactIds: artifactId ? [artifactId] : [],
        })
        return {
          persisted: true,
          analysisId: saved.analysisId,
          revision: saved.revision,
          datasetVersionId: saved.datasetVersionId,
          semanticRevisionId: saved.semanticRevisionId,
          resultId: saved.resultId,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'list_analyses',
      description:
        'List compact metadata for the latest revision of each saved analysis so an analyst can reopen one without remembering internal IDs.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            analyses: {
              type: 'array',
              required: true,
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
        render: observeRender('catalog'),
      },
      async execute() {
        const workspace = resolveWorkspacePaths()
        const analyses = await listAnalysisRevisions(workspace.catalogPath)
        return {
          analyses: analyses.map((analysis) => ({
            analysisId: analysis.analysisId,
            revision: analysis.revision,
            question: analysis.question,
            datasetVersionId: analysis.datasetVersionId,
            semanticRevisionId: analysis.semanticRevisionId,
            resultId: analysis.resultId,
            mark: analysis.chart.mark,
            createdAt: analysis.createdAt,
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'get_analysis',
      description: 'Load a compact saved analysis revision (ids, SQL, chart intent; no raw rows).',
      parameters: {
        analysisId: { type: 'string', required: true },
        revision: { type: 'number', description: 'Omit for the latest saved revision.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            analysisId: { type: 'string', required: true },
            revision: { type: 'number', required: true },
            datasetVersionId: { type: 'string', required: true },
            semanticRevisionId: { type: 'string', required: true },
            question: { type: 'string', required: true },
            sql: { type: 'json', required: true },
            resultId: { type: 'string', required: true },
            chart: { type: 'object', required: true, additionalProperties: true },
            artifactIds: {
              type: 'array',
              required: true,
              items: { type: 'string' },
            },
          },
        },
        render: observeRender('catalog'),
        // IDs only — the dsh client toolview reads SQL from the model observe text.
        presentationMeta: (args, value) => ({
          analysisId: String(args.analysisId),
          revision: (value as { revision: number }).revision,
        }),
      },
      async execute(args) {
        const workspace = resolveWorkspacePaths()
        const revision = args.revision === undefined ? undefined : Number(args.revision)
        if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
          throw new Error('revision must be a positive integer')
        }
        const loaded = await loadAnalysisRevision(
          workspace.catalogPath,
          String(args.analysisId),
          revision,
        )
        return {
          analysisId: loaded.analysisId,
          revision: loaded.revision,
          datasetVersionId: loaded.datasetVersionId,
          semanticRevisionId: loaded.semanticRevisionId,
          question: loaded.question,
          sql: loaded.query.sql,
          resultId: loaded.resultId,
          chart: loaded.chart,
          artifactIds: loaded.artifactIds,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'check_studio_availability',
      description:
        'Independently check whether a saved analysis revision is actually retrievable via the Studio overview route (the same query the native sidebar selector reads), instead of assuming availability from a prior save_analysis success. Returns availableInStudio computed here, server-side; no input sets it directly.',
      parameters: {
        analysisId: { type: 'string', required: true },
        revision: {
          type: 'number',
          description: 'Omit to check whether any revision is the current latest.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            analysisId: { type: 'string', required: true },
            requestedRevision: { type: 'json', required: true },
            latestRevision: { type: 'json', required: true },
            availableInStudio: { type: 'boolean', required: true },
            checkedVia: { type: 'string', required: true },
            checkedAt: { type: 'string', required: true },
          },
        },
        render: observeRender('catalog'),
      },
      async execute(args) {
        const workspace = resolveWorkspacePaths()
        const revision = args.revision === undefined ? undefined : Number(args.revision)
        if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
          throw new Error('revision must be a positive integer')
        }
        return await checkStudioAvailability(
          workspace.catalogPath,
          String(args.analysisId),
          revision,
        )
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'get_workflow_trail',
      description:
        'List the compact, append-only walkthrough milestones (preview proposed, analyst approved, dataset published, query completed, chart rendered, analysis persisted, Studio opened) for a dataset version and/or saved analysis, oldest first. Each entry is identifiers, an actor (agent/service/analyst-ui) and a timestamp only — never rows, SQL or SVG. Pass datasetVersionId and/or analysisId to scope the trail; omit both for the most recent workspace-wide entries.',
      parameters: {
        datasetVersionId: { type: 'string' },
        analysisId: { type: 'string' },
        limit: { type: 'number', description: 'Bounded 1-500, default 200.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            trail: {
              type: 'array',
              required: true,
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
        render: observeRender('catalog'),
      },
      async execute(args) {
        const workspace = resolveWorkspacePaths()
        const store = new MetadataStore(workspace.catalogPath)
        try {
          const trail = store.listWorkflowTrail({
            datasetVersionId: args.datasetVersionId ? String(args.datasetVersionId) : undefined,
            analysisId: args.analysisId ? String(args.analysisId) : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          })
          return { trail: trail as unknown as Record<string, JsonLikeValue>[] }
        } finally {
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'report_chart_issue',
      description:
        'File a bounded "chart layout problem" report against a specific artifact and persisted analysis revision (overlap, clipping, unreadable-legend, wrong-orientation, excess-whitespace only — no free-form issue type). Both the artifactId and the analysisId/revision must reference a real, already-persisted analysis revision that actually carries that artifact. Always creates a candidate row for later analyst review; never approves anything and never creates reusable learning evidence by itself.',
      parameters: {
        artifactId: { type: 'string', required: true },
        analysisId: { type: 'string', required: true },
        revision: { type: 'number', required: true },
        issueType: {
          type: 'string',
          required: true,
          description:
            'overlap | clipping | unreadable-legend | wrong-orientation | excess-whitespace',
        },
        notes: { type: 'string', description: 'Optional free-text detail, max 1000 chars.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      async execute(args, exec) {
        if ('status' in args || 'approved' in args) {
          throw new Error('Models cannot set chart feedback status')
        }
        const parsedIssue = ChartFeedbackIssueTypeSchema.safeParse(args.issueType)
        if (!parsedIssue.success) {
          throw new Error(
            'issueType must be one of: overlap, clipping, unreadable-legend, wrong-orientation, excess-whitespace',
          )
        }
        const revision = Number(args.revision)
        if (!Number.isInteger(revision) || revision < 1) {
          throw new Error('revision must be a positive integer')
        }
        const workspace = resolveWorkspacePaths()
        const analysisId = String(args.analysisId)
        const artifactId = String(args.artifactId)
        // Existence + relationship check, not just schema shape: the
        // revision must actually exist, and the artifact must actually be
        // one this persisted revision carries.
        const analysis = await loadAnalysisRevision(workspace.catalogPath, analysisId, revision)
        if (!analysis.artifactIds.includes(artifactId)) {
          throw new Error(
            `Artifact "${artifactId}" is not attached to analysis "${analysisId}" revision ${revision}`,
          )
        }
        const notes = args.notes === undefined ? undefined : String(args.notes)
        const store = new MetadataStore(workspace.catalogPath)
        try {
          const feedback = store.createChartFeedback({
            artifactId,
            analysisId: analysis.analysisId,
            analysisRevision: analysis.revision,
            issueType: parsedIssue.data,
            ...(notes ? { notes } : {}),
            actorId: sessionActorId(exec),
          })
          return {
            feedbackId: feedback.feedbackId,
            artifactId: feedback.artifactId,
            analysisId: feedback.analysisId,
            analysisRevision: feedback.analysisRevision,
            issueType: feedback.issueType,
            status: feedback.status,
            createdAt: feedback.createdAt,
          } as never
        } finally {
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'list_chart_feedback',
      description:
        'List filed chart-layout-problem reports (report_chart_issue) so an analyst or reviewer can see what is pending. Optionally scope to one analysisId and/or review status (candidate/approved/revoked); a report_chart_issue submission always starts candidate.',
      parameters: {
        analysisId: { type: 'string' },
        status: { type: 'string', description: 'candidate | approved | revoked' },
        limit: { type: 'number', description: 'Bounded 1-200, default 50.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      execute(args) {
        const status = args.status === undefined ? undefined : String(args.status)
        if (status && !['candidate', 'approved', 'revoked'].includes(status)) {
          throw new Error('status must be one of: candidate, approved, revoked')
        }
        const workspace = resolveWorkspacePaths()
        const store = new MetadataStore(workspace.catalogPath)
        try {
          const feedback = store.listChartFeedback({
            analysisId: args.analysisId ? String(args.analysisId) : undefined,
            status: status as 'candidate' | 'approved' | 'revoked' | undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          })
          return {
            feedback: feedback.map((entry) => ({
              feedbackId: entry.feedbackId,
              artifactId: entry.artifactId,
              analysisId: entry.analysisId,
              analysisRevision: entry.analysisRevision,
              issueType: entry.issueType,
              ...(entry.notes ? { notes: entry.notes } : {}),
              status: entry.status,
              createdAt: entry.createdAt,
              reviewedAt: entry.reviewedAt,
            })),
          } as never
        } finally {
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'list_dashboards',
      description:
        'List saved dashboards with compact slot metadata so an analyst can reopen one by title.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      execute() {
        const workspace = resolveWorkspacePaths()
        const store = new MetadataStore(workspace.catalogPath)
        try {
          return {
            dashboards: store.listDashboards().map((dashboard) => ({
              dashboardId: dashboard.dashboardId,
              title: dashboard.title,
              slotCount: dashboard.layout.slots.length,
              archived: dashboard.archived,
              updatedAt: dashboard.updatedAt,
            })),
          } as never
        } finally {
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'get_dashboard',
      description:
        'Load a saved dashboard and its pinned analysis revisions. Returns compact metadata without result rows.',
      parameters: {
        dashboardId: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      execute(args) {
        const workspace = resolveWorkspacePaths()
        const store = new MetadataStore(workspace.catalogPath)
        try {
          const dashboard = store.loadDashboard(String(args.dashboardId))
          if (!dashboard) throw new Error(`Unknown dashboard "${String(args.dashboardId)}"`)
          return {
            dashboardId: dashboard.dashboardId,
            title: dashboard.title,
            archived: dashboard.archived,
            updatedAt: dashboard.updatedAt,
            slots: dashboard.layout.slots.map((slot) => {
              const analysis = store.loadAnalysisRevision(slot.analysisId, slot.revision)
              return {
                ...slot,
                datasetVersionId: analysis?.datasetVersionId,
                semanticRevisionId: analysis?.semanticRevisionId,
                resultId: analysis?.resultId,
                chart: analysis?.chart,
                artifactIds: analysis?.artifactIds ?? [],
              }
            }),
          } as never
        } finally {
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'create_dashboard',
      description:
        'Create an empty dashboard with a title. Pin saved analyses to it with add_to_dashboard. Treat persisted: true plus slotCount as the completion receipt.',
      parameters: {
        title: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      execute(args) {
        const workspace = resolveWorkspacePaths()
        const store = new MetadataStore(workspace.catalogPath)
        try {
          const dashboard = store.saveDashboard({ title: String(args.title) })
          return {
            persisted: true,
            dashboardId: dashboard.dashboardId,
            title: dashboard.title,
            slotCount: dashboard.layout.slots.length,
            slots: dashboard.layout.slots,
            archived: dashboard.archived,
          } as never
        } finally {
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rename_dashboard',
      description:
        'Rename a saved dashboard in place, preserving its pinned cards and archive flag.',
      parameters: {
        dashboardId: { type: 'string', required: true },
        title: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      execute(args) {
        const workspace = resolveWorkspacePaths()
        const store = new MetadataStore(workspace.catalogPath)
        try {
          const dashboard = store.renameDashboard(String(args.dashboardId), String(args.title))
          return {
            dashboardId: dashboard.dashboardId,
            title: dashboard.title,
            archived: dashboard.archived,
          } as never
        } finally {
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'delete_dashboard',
      description:
        'Archive (soft-delete) a saved dashboard. Pinned analyses are preserved; use restore_dashboard to recover it.',
      parameters: {
        dashboardId: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      execute(args) {
        const workspace = resolveWorkspacePaths()
        const store = new MetadataStore(workspace.catalogPath)
        try {
          const dashboard = store.setDashboardArchived(String(args.dashboardId), true)
          return {
            dashboardId: dashboard.dashboardId,
            title: dashboard.title,
            archived: dashboard.archived,
          } as never
        } finally {
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'restore_dashboard',
      description: 'Restore an archived dashboard.',
      parameters: {
        dashboardId: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      execute(args) {
        const workspace = resolveWorkspacePaths()
        const store = new MetadataStore(workspace.catalogPath)
        try {
          const dashboard = store.setDashboardArchived(String(args.dashboardId), false)
          return {
            dashboardId: dashboard.dashboardId,
            title: dashboard.title,
            archived: dashboard.archived,
          } as never
        } finally {
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'add_to_dashboard',
      description:
        'Pin a saved analysis onto a dashboard, creating a dashboard if needed. Treat persisted: true plus slotCount as the completion receipt.',
      parameters: {
        analysisId: { type: 'string', required: true },
        title: { type: 'string' },
        dashboardId: { type: 'string' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      execute(args) {
        const workspace = resolveWorkspacePaths()
        const store = new MetadataStore(workspace.catalogPath)
        try {
          const analysis = store.loadAnalysisRevision(String(args.analysisId))
          if (!analysis) throw new Error(`Unknown analysis "${String(args.analysisId)}"`)
          const existingId = args.dashboardId ? String(args.dashboardId) : undefined
          const dashboard = existingId
            ? store.loadDashboard(existingId)
            : store.saveDashboard({
                title: args.title ? String(args.title) : 'Analyst dashboard',
              })
          if (!dashboard) throw new Error(`Unknown dashboard "${existingId}"`)
          const existingSlot = dashboard.layout.slots.some(
            (slot) => slot.analysisId === analysis.analysisId,
          )
          const pinned = store.pinAnalysisToDashboard(
            dashboard.dashboardId,
            analysis.analysisId,
            analysis.revision,
            existingSlot ? undefined : analysis.chart.title,
          )
          return {
            persisted: true,
            dashboardId: pinned.dashboardId,
            title: pinned.title,
            slotCount: pinned.layout.slots.length,
            slots: pinned.layout.slots,
          } as never
        } finally {
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'export_report',
      description:
        'Export the selected immutable result as offline HTML, PNG, CSV, and specification JSON bound to the chart artifact. Treat ready: true plus downloads as the completion receipt. downloads are absolute loopback URLs for the live dsh web origin — paste them into Markdown links as returned; do not invent hosts.',
      parameters: {
        resultId: { type: 'string', required: true },
        artifactId: { type: 'string', required: true },
        title: { type: 'string' },
        analysisId: { type: 'string' },
        findings: { type: 'array', items: { type: 'string' } },
        caveats: { type: 'array', items: { type: 'string' } },
        nextSteps: { type: 'array', items: { type: 'string' } },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      async execute(args) {
        const workspace = resolveWorkspacePaths()
        const pack = await writeExportPack({
          workspace,
          resultId: String(args.resultId),
          artifactId: String(args.artifactId),
          title: args.title ? String(args.title) : undefined,
          analysisId: args.analysisId ? String(args.analysisId) : undefined,
          narrative: {
            // Model-supplied findings are generated interpretation only — never
            // auto-approved. Shareable reports default to facts-only.
            findings: Array.isArray(args.findings) ? args.findings.map(String) : undefined,
            caveats: Array.isArray(args.caveats) ? args.caveats.map(String) : undefined,
            nextSteps: Array.isArray(args.nextSteps) ? args.nextSteps.map(String) : undefined,
            includeInterpretation: false,
            interpretationReview: { status: 'unreviewed' },
          },
        })
        return { ready: true, ...withRuntimeDownloadUrls(ctx, pack) } as never
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'export_dashboard',
      description:
        'Compose the dashboard current at execution time into an offline HTML management report (title + optional executive summary + one chart/table section per pinned card) plus a downloadable ZIP stakeholder pack. Call get_dashboard immediately before export when writing narrative about current cards or filter mappings. Reuses already-rendered artifacts; no server is needed to open the result. Treat ready: true plus downloads, slotCount, and captured slots as the authoritative completion receipt; older conversation receipts are historical. downloads are absolute loopback URLs for the live dsh web origin — paste them into Markdown links as returned; do not invent hosts.',
      parameters: {
        dashboardId: { type: 'string', required: true },
        title: { type: 'string', description: 'Report title; defaults to the dashboard title.' },
        summary: {
          type: 'string',
          description:
            'Executive summary prose shown at the top of the report. Write concise, number-backed conclusions; do not invent figures.',
        },
        kpis: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', required: true },
              value: { type: 'string', required: true },
              note: { type: 'string' },
            },
          },
        },
        findings: { type: 'array', items: { type: 'string' } },
        caveats: { type: 'array', items: { type: 'string' } },
        nextSteps: { type: 'array', items: { type: 'string' } },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      async execute(args) {
        const workspace = resolveWorkspacePaths()
        const pack = await writeDashboardExportPack({
          workspace,
          dashboardId: String(args.dashboardId),
          title: args.title ? String(args.title) : undefined,
          summary: args.summary ? String(args.summary) : undefined,
          kpis: Array.isArray(args.kpis)
            ? (args.kpis as Array<{ label?: string; value?: string; note?: string }>).map(
                (kpi) => ({
                  label: String(kpi.label ?? ''),
                  value: String(kpi.value ?? ''),
                  note: kpi.note ? String(kpi.note) : undefined,
                }),
              )
            : undefined,
          narrative: {
            findings: Array.isArray(args.findings) ? args.findings.map(String) : undefined,
            caveats: Array.isArray(args.caveats) ? args.caveats.map(String) : undefined,
            nextSteps: Array.isArray(args.nextSteps) ? args.nextSteps.map(String) : undefined,
            includeInterpretation: false,
            interpretationReview: { status: 'unreviewed' },
          },
        })
        return { ready: true, ...withRuntimeDownloadUrls(ctx, pack) } as never
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'map_dashboard_filters',
      description:
        'Declare which shared-filter columns a pinned dashboard slot accepts. A card with no mapped keys keeps disclosing shared filters as unsupported instead of silently ignoring them.',
      parameters: {
        dashboardId: { type: 'string', required: true },
        analysisId: { type: 'string', required: true },
        keys: { type: 'array', required: true, items: { type: 'string' } },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      execute(args) {
        const keys = Array.isArray(args.keys) ? args.keys.map((key) => String(key)) : []
        for (const key of keys) {
          if (!IDENT.test(key)) {
            throw new Error(`Shared filter key must be a simple identifier (got "${key}")`)
          }
        }
        const workspace = resolveWorkspacePaths()
        const store = new MetadataStore(workspace.catalogPath)
        try {
          const dashboardId = String(args.dashboardId)
          const analysisId = String(args.analysisId)
          const dashboard = store.setDashboardSharedFilterKeys(dashboardId, analysisId, keys)
          const slot = dashboard.layout.slots.find((s) => s.analysisId === analysisId)
          return {
            dashboardId: dashboard.dashboardId,
            analysisId,
            sharedFilterKeys: slot?.sharedFilterKeys ?? [],
          } as never
        } finally {
          store.close()
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'apply_dashboard_filters',
      description:
        'Apply one shared equality filter across a dashboard by re-authorizing and re-querying every card that mapped the column. Returns which cards actually changed and which stayed unsupported; an unsupported card never changes.',
      parameters: {
        dashboardId: { type: 'string', required: true },
        column: { type: 'string', required: true },
        value: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: observeRender('catalog'),
      },
      async execute(args) {
        const workspace = resolveWorkspacePaths()
        return (await applyDashboardSharedFilter(workspace, String(args.dashboardId), {
          column: String(args.column),
          value: String(args.value),
        })) as never
      },
    }),
  )
}
