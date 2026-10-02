import { handleReviewDraftRequest } from './review-draft.js'
import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { ChartFormatSchema, ChartIntentSchema } from 'dsh-data-core/contracts'
import { MetadataStore, AnalysisRevisionConflictError } from 'dsh-data-core/metadata-store'
import { getDatasetSchemaSlice } from 'dsh-data-core/catalog-query'
import { saveAnalysisRevision } from 'dsh-data-core/analysis-store'
import { loadStoredQueryResult } from 'dsh-data-core/stored-result'
import { dashboardSlotTitle } from './dashboard-slot-title.js'
import { deriveResultEvidence } from 'dsh-data-core/result-evidence'
import { resolveWorkspacePaths, type WorkspacePaths } from 'dsh-data-core/workspace-paths'
import { executeIsolatedQuery } from 'dsh-data-duckdb/query-worker'
import { createChartArtifact } from 'dsh-data-viz/chart-service'
import { isTrustedBrowserRequest } from './browser-trust.js'
import { compileStudioDefinition, describeFilter, StudioApplySchema } from './studio-definition.js'
import { readStudioDefinition, saveStudioDefinition, withStudioState } from './studio-state.js'
import { resolveSafeArtifact } from './artifact-path.js'

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })
const stateSchema = z
  .strictObject({
    sessionId: z.string().min(1).max(200),
    analysisId: z
      .string()
      .regex(/^ana_[a-z0-9]+$/i)
      .nullable()
      .optional(),
    datasetId: z.string().max(200).nullable().optional(),
    draft: z
      .union([
        StudioApplySchema.safeExtend({ title: z.string().max(200) }),
        z.strictObject({
          analysisId: z.string().regex(/^ana_[a-z0-9]+$/i),
          expectedRevision: z.number().int().positive(),
          title: z.string().max(200),
          presentation: z.strictObject({
            mark: ChartIntentSchema.shape.mark,
            format: ChartFormatSchema.optional(),
          }),
        }),
      ])
      .nullable()
      .optional(),
  })
  .superRefine((state, ctx) => {
    if (state.draft && (state.draft.analysisId ?? null) !== (state.analysisId ?? null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['draft', 'analysisId'],
        message: 'Draft must belong to the selected analysis',
      })
    }
  })

export async function handleStudioRequest(
  request: Request,
  workspace: WorkspacePaths = resolveWorkspacePaths(),
): Promise<Response> {
  if (!isTrustedBrowserRequest(request)) return json({ error: 'Same-origin request required' }, 403)
  const url = new URL(request.url)
  const route = url.pathname.split('/').at(-1)
  if (route === 'review-draft') return handleReviewDraftRequest(request, workspace)
  const expectedMethod = ['apply', 'restore'].includes(route ?? '')
    ? 'POST'
    : ['state', 'dashboard'].includes(route ?? '')
      ? request.method
      : 'GET'
  if (request.method !== expectedMethod || !['GET', 'POST'].includes(request.method))
    return json({ error: 'Method not allowed' }, 405)
  const store = new MetadataStore(workspace.catalogPath)
  const statePath = join(workspace.root, 'studio.sqlite')
  try {
    if (route === 'review-status') return json(store.getAnalystReviewStatus())
    if (route === 'reports') {
      const reports = await Promise.all(
        store.listReportExports(30).map(async (report) => {
          const entries = Object.entries(report.files)
          const available: Record<string, string> = {}
          const missingFiles: string[] = []
          for (const [format, file] of entries) {
            const path = resolveSafeArtifact(workspace.artifactsDir, file)
            try {
              if (!path) throw new Error('invalid')
              await access(path)
              available[format] = `/api/analyst/reports?file=${encodeURIComponent(file)}`
            } catch {
              missingFiles.push(format)
            }
          }
          return {
            reportId: report.reportId,
            title: report.title,
            source: report.source,
            createdAt: report.createdAt,
            downloads: available,
            missingFiles,
            openUrl: available.html ? `${available.html}&preview=1` : null,
          }
        }),
      )
      return json({ reports })
    }
    if (route === 'history') {
      const analysisId = z
        .string()
        .regex(/^ana_[a-z0-9]+$/i)
        .parse(url.searchParams.get('analysisId'))
      const revisions = store.listAnalysisHistory(analysisId)
      if (!revisions.length) return json({ error: 'Analysis not found' }, 404)
      return json({
        analysisId,
        currentRevision: revisions[0]!.revision,
        revisions: revisions.map((a) => ({
          revision: a.revision,
          question: a.question,
          createdAt: a.createdAt,
          mark: a.chart.mark,
          resultId: a.resultId,
        })),
      })
    }
    if (route === 'restore') {
      const input = z
        .strictObject({
          analysisId: z.string().regex(/^ana_[a-z0-9]+$/i),
          expectedRevision: z.number().int().positive(),
          revision: z.number().int().positive(),
        })
        .parse(await request.json())
      const current = store.loadAnalysisRevision(input.analysisId)
      const previous = store.loadAnalysisRevision(input.analysisId, input.revision)
      if (!current || !previous) return json({ error: 'Analysis revision not found' }, 404)
      if (current.revision !== input.expectedRevision)
        return json({ error: 'Analysis changed; reload before restoring' }, 409)
      if (input.revision >= current.revision)
        return json({ error: 'Choose an earlier revision' }, 400)
      const restored = store.saveAnalysisRevision(
        { ...previous, revision: 0, createdAt: new Date().toISOString() },
        { expectedRevision: input.expectedRevision },
      )
      let definition = readStudioDefinition(statePath, input.analysisId, input.revision)
      for (let revision = input.revision - 1; !definition && revision >= 1; revision--) {
        if (store.loadAnalysisRevision(input.analysisId, revision)?.resultId !== previous.resultId)
          break
        definition = readStudioDefinition(statePath, input.analysisId, revision)
      }
      if (definition)
        saveStudioDefinition(statePath, input.analysisId, restored.revision, {
          ...definition,
          mark: previous.chart.mark as typeof definition.mark,
          format: previous.chart.format,
        })
      return json({
        analysisId: restored.analysisId,
        revision: restored.revision,
        resultId: restored.resultId,
      })
    }
    if (route === 'inbox') {
      return json({
        ingestion: store.listWorkspaceSourcePins().filter((pin) => pin.status === 'candidate'),
        adaptations: store
          .listImportJobs()
          .filter(
            (job) =>
              job.status === 'needs-input' &&
              job.warnings.some((warning) => warning.startsWith('Adaptation confirm required:')),
          )
          .map((job) => ({
            jobId: job.jobId,
            slug: job.slug,
            status: job.status,
            materialityReasons: job.warnings,
          })),
        semantic: store.listAliasCandidates(undefined, 'candidate'),
        structure: store.listStructureCandidates(undefined, 'candidate'),
      })
    }
    if (route === 'dashboard') {
      let dashboard
      if (request.method === 'POST') {
        const input = z
          .strictObject({
            dashboardId: z.string().regex(/^dash_[a-z0-9]+$/i),
            expectedVersion: z.string().min(1),
            title: z.string().trim().min(1).max(200).optional(),
            slots: z
              .array(
                z.strictObject({
                  analysisId: z.string().regex(/^ana_[a-z0-9]+$/i),
                  revision: z.number().int().positive(),
                  width: z.union([z.literal(1), z.literal(2)]).optional(),
                  title: z.string().trim().min(1).max(200).optional(),
                  sharedFilterKeys: z.array(z.string().min(1).max(200)).max(100).optional(),
                }),
              )
              .max(100),
          })
          .parse(await request.json())
        const current = store.loadDashboard(input.dashboardId)
        if (!current) return json({ error: 'Dashboard not found' }, 404)
        if (new Set(input.slots.map((slot) => slot.analysisId)).size !== input.slots.length)
          return json({ error: 'Each analysis can appear only once' }, 400)
        const slots = input.slots.map((slot) => {
          const analysis = store.loadAnalysisRevision(slot.analysisId, slot.revision)
          if (!analysis) throw new Error('Choose an existing analysis revision')
          const prior = current.layout.slots.find((item) => item.analysisId === slot.analysisId)
          return {
            ...slot,
            title: slot.title ?? prior?.title ?? analysis.chart.title ?? analysis.question,
            sharedFilterKeys: slot.sharedFilterKeys ?? prior?.sharedFilterKeys ?? [],
          }
        })
        dashboard = store.updateDashboardLayout(
          input.dashboardId,
          input.expectedVersion,
          { slots },
          input.title,
        )
      } else {
        const dashboardId = z
          .string()
          .regex(/^dash_[a-z0-9]+$/i)
          .parse(url.searchParams.get('dashboardId'))
        dashboard = store.loadDashboard(dashboardId)
      }
      if (!dashboard) return json({ error: 'Dashboard not found' }, 404)
      return json({
        dashboard,
        slots: await Promise.all(
          dashboard.layout.slots.map(async (slot) => {
            const pinned = store.loadAnalysisRevision(slot.analysisId, slot.revision)
            let filterFields: string[] = []
            let filterWarning: string | undefined
            try {
              const result = pinned
                ? await loadStoredQueryResult(workspace.resultsDir, pinned.resultId)
                : null
              if (
                pinned &&
                result &&
                (result.datasetVersionId !== pinned.datasetVersionId ||
                  result.semanticRevisionId !== pinned.semanticRevisionId)
              )
                throw new Error('Result binding mismatch')
              filterFields = result?.columns.map((column) => column.name) ?? []
            } catch {
              filterWarning =
                'Result fields unavailable. Reopen this analysis before changing filter mappings.'
            }
            return {
              ...slot,
              title: dashboardSlotTitle(slot, pinned),
              chartTitle: pinned?.chart.title,
              latestRevision: store.loadAnalysisRevision(slot.analysisId)?.revision,
              artifactIds: pinned?.artifactIds ?? [],
              filterFields,
              ...(filterWarning ? { filterWarning } : {}),
            }
          }),
        ),
      })
    }
    if (route === 'schema') {
      const datasetId = z.string().min(1).max(200).parse(url.searchParams.get('datasetId'))
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .parse(url.searchParams.get('offset') ?? 0)
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .parse(url.searchParams.get('limit') ?? 100)
      const table = z
        .string()
        .min(1)
        .max(200)
        .optional()
        .parse(url.searchParams.get('table') ?? undefined)
      return json(
        getDatasetSchemaSlice(store, datasetId, {
          offset,
          limit,
          ...(table ? { tables: [table] } : {}),
        }),
      )
    }
    if (route === 'state') {
      if (request.method === 'POST') {
        const state = stateSchema.parse(await request.json())
        withStudioState(statePath, (db) =>
          db
            .prepare('INSERT OR REPLACE INTO studio_state (id, body) VALUES (?, ?)')
            .run(state.sessionId, JSON.stringify(state)),
        )
        return json({ saved: true })
      }
      const sessionId = z.string().min(1).max(200).parse(url.searchParams.get('sessionId'))
      const row = withStudioState(
        statePath,
        (db) =>
          db.prepare('SELECT body FROM studio_state WHERE id = ?').get(sessionId) as
            { body: string } | undefined,
      )
      return json(
        row
          ? (JSON.parse(row.body) as unknown)
          : { sessionId, analysisId: null, datasetId: null, draft: null },
      )
    }
    if (route === 'analysis') {
      const analysisId = z
        .string()
        .regex(/^ana_[a-z0-9]+$/i)
        .parse(url.searchParams.get('analysisId'))
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .parse(url.searchParams.get('offset') ?? 0)
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .parse(url.searchParams.get('limit') ?? 100)
      const analysis = store.loadAnalysisRevision(analysisId)
      if (!analysis) return json({ error: 'Analysis not found' }, 404)
      const result = await loadStoredQueryResult(workspace.resultsDir, analysis.resultId)
      if (
        result.datasetVersionId !== analysis.datasetVersionId ||
        result.semanticRevisionId !== analysis.semanticRevisionId
      )
        throw new Error('Result binding mismatch')
      const rows = result.rows ?? (!result.previewTruncated ? result.preview : [])
      const manifest = store.getDatasetVersion(analysis.datasetVersionId)
      let definition = readStudioDefinition(statePath, analysisId, analysis.revision)
      if (!definition) {
        for (let revision = analysis.revision - 1; revision >= 1; revision--) {
          const previous = store.loadAnalysisRevision(analysisId, revision)
          if (previous?.resultId !== analysis.resultId) break
          definition = readStudioDefinition(statePath, analysisId, revision)
          if (definition) {
            definition = {
              ...definition,
              mark: analysis.chart.mark as typeof definition.mark,
              format: analysis.chart.format,
            }
            break
          }
        }
      }
      return json({
        analysis,
        datasetId: manifest?.datasetId,
        source: manifest?.source,
        definition,
        result: {
          columns: result.columns,
          rows: rows.slice(offset, offset + limit),
          rowCount: result.rowCount,
          offset,
          nextOffset: offset + limit < rows.length ? offset + limit : null,
        },
        evidence: deriveResultEvidence(result, {
          analysisId,
          revision: analysis.revision,
          filter:
            definition?.filters.map((filter) => describeFilter(filter)).join('; ') || undefined,
        }),
      })
    }
    if (route === 'apply') {
      const input = StudioApplySchema.parse(await request.json())
      const schema = getDatasetSchemaSlice(store, input.definition.datasetId)
      const compiled = compileStudioDefinition(input.definition, schema, input.title)
      if (input.analysisId) {
        const current = store.loadAnalysisRevision(input.analysisId)
        if (!current) return json({ error: 'Analysis not found' }, 404)
        if (current.revision !== input.expectedRevision)
          return json({ error: 'Analysis changed; reload before applying' }, 409)
        if (
          current.datasetVersionId !== compiled.query.datasetVersionId ||
          current.semanticRevisionId !== compiled.query.semanticRevisionId
        )
          return json(
            { error: 'Create a new analysis for a different dataset or semantic version' },
            409,
          )
      }
      const result = await executeIsolatedQuery({
        ...compiled.query,
        datasetPath: workspace.datasetFile(schema.datasetVersionId, schema.datasetId),
        allowedTables: [input.definition.table],
        resultStoreDir: workspace.resultsDir,
        maxResultRows: 10_000,
        maxResultBytes: 8_000_000,
        timeoutMs: 30_000,
        signal: request.signal,
      })
      const artifact = await createChartArtifact({
        resultId: result.resultId,
        intent: compiled.chart,
        resultStoreDir: workspace.resultsDir,
        artifactStoreDir: workspace.artifactsDir,
        signal: request.signal,
      })
      if (request.signal.aborted) return json({ error: 'Request cancelled' }, 499)
      const analysis = await saveAnalysisRevision(workspace.catalogPath, {
        analysisId: input.analysisId,
        expectedRevision: input.expectedRevision,
        ...compiled.query,
        question: input.definition.filters.length
          ? `${input.title} — Population: ${input.definition.filters.map((filter) => describeFilter(filter)).join('; ')}`
          : input.title,
        query: compiled.query,
        resultId: result.resultId,
        chart: compiled.chart,
        artifactIds: [artifact.artifactId],
      })
      saveStudioDefinition(statePath, analysis.analysisId, analysis.revision, input.definition)
      return json({
        analysisId: analysis.analysisId,
        revision: analysis.revision,
        resultId: result.resultId,
      })
    }
    return json({ error: 'Unknown Studio route' }, 404)
  } catch (error) {
    if (error instanceof AnalysisRevisionConflictError)
      return json(
        {
          error:
            route === 'dashboard'
              ? 'Dashboard changed; reload before applying'
              : 'Analysis changed; reload before applying',
        },
        409,
      )
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return json({ error: 'Invalid Studio request' }, 400)
    // Avoid leaking operator paths or SQL worker details to the browser.
    const message = error instanceof Error ? error.message : ''
    const safe =
      /^(Unknown column:|This aggregation|Choose a|A series|KPI requires|Time grain|Dataset or semantic)/.test(
        message,
      )
    return json(
      {
        error: safe
          ? message
          : 'Studio request could not be completed. Check the selected dataset and fields.',
      },
      400,
    )
  } finally {
    store.close()
  }
}

export function registerStudioRoutes(ctx: Context): void {
  ctx.inject(['connection'], (webCtx) => {
    const connection = Reflect.get(webCtx, 'connection') as {
      fetch: {
        register: (route: {
          path: string
          methods: readonly string[]
          requestBody: 'buffered'
          fetch: (request: Request) => Promise<Response>
        }) => () => Promise<void>
      }
    }
    for (const [route, methods] of [
      ['schema', ['GET']],
      ['review-draft', ['GET', 'POST']],
      ['history', ['GET']],
      ['restore', ['POST']],
      ['inbox', ['GET']],
      ['review-status', ['GET']],
      ['reports', ['GET']],
      ['dashboard', ['GET', 'POST']],
      ['analysis', ['GET']],
      ['apply', ['POST']],
      ['state', ['GET', 'POST']],
    ] as const) {
      webCtx.effect(
        () =>
          connection.fetch.register({
            path: `/api/analyst/studio/${route}`,
            methods,
            requestBody: 'buffered',
            fetch: (request) => handleStudioRequest(request),
          }),
        `dsh-data-workbench: Studio ${route}`,
      )
    }
  })
}
