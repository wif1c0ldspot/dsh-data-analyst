import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  AnalysisNotFoundError,
  AnalysisRevisionConflictError,
  DashboardNotFoundError,
  MetadataStore,
} from 'dsh-data-core/metadata-store'
import { ReportTemplateSchema } from 'dsh-data-core/report-template'
import { interpretationApprovedForExport } from 'dsh-data-core/interpretation-review'
import { redactErrorMessage } from 'dsh-data-core/tool-observe'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import {
  analysisResourceVersion,
  conflictFragmentResponse,
  dashboardResourceVersion,
  expectedVersionFromRequest,
  fragmentResponse,
} from './ui-version.js'
import { isTrustedBrowserRequest } from './browser-trust.js'
import {
  renderAnalysisFragment,
  renderDashboardFragment,
  renderExportFragment,
} from './ui-fragments.js'
import { applyDashboardSharedFilter, clearDashboardSharedFilter } from './plugin-tools.js'
import { writeExportPack, writeDashboardExportPack } from './export-pack.js'

class RequestAbortedError extends Error {
  constructor() {
    super('Request aborted')
  }
}

const ANALYSIS_ID = /^ana_[a-z0-9]+$/i
const DASHBOARD_ID = /^dash_[a-z0-9]+$/i

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Any absolute POSIX path of two or more segments, wherever it is rooted. */
const ABSOLUTE_PATH = /(?:\/[\w.@+-]+){2,}\/?/g

function failureResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  return errorResponse(redactErrorMessage(message).replace(ABSOLUTE_PATH, '[redacted]'), 500)
}

/**
 * dsh `connection.fetch.register` matches **exact** pathnames only (no
 * `:param` templates). Resource ids therefore travel as query params on GETs
 * and JSON fields on POSTs.
 */
function queryParam(request: Request, name: string): string {
  const value = new URL(request.url).searchParams.get(name)
  if (value === null) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.clone().json()) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    return body as Record<string, unknown>
  } catch {
    return null
  }
}

async function requireCatalog(catalogPath: string): Promise<Response | undefined> {
  try {
    await access(catalogPath)
    return undefined
  } catch {
    return errorResponse('Analyst workspace is unavailable', 404)
  }
}

function dashboardCards(
  store: MetadataStore,
  dashboard: ReturnType<MetadataStore['loadDashboard']>,
) {
  if (!dashboard) return []
  return dashboard.layout.slots.flatMap((slot) => {
    try {
      const analysis = store.loadAnalysisRevision(slot.analysisId, slot.revision)
      return analysis ? [analysis] : []
    } catch {
      return []
    }
  })
}

export async function handleAnalysisFragmentRequest(
  request: Request,
  catalogPath: string,
): Promise<Response> {
  if (request.method !== 'GET') return errorResponse('Method not allowed', 405)
  if (!isTrustedBrowserRequest(request)) return errorResponse('Same-origin request required', 403)
  const id = queryParam(request, 'analysisId')
  if (!ANALYSIS_ID.test(id)) return errorResponse('Invalid analysis id', 400)
  const unavailable = await requireCatalog(catalogPath)
  if (unavailable) return unavailable
  const store = new MetadataStore(catalogPath)
  try {
    const analysis = store.loadAnalysisRevision(id)
    if (!analysis) return errorResponse(`Analysis ${id} does not exist`, 404)
    const version = analysisResourceVersion(analysis)
    return fragmentResponse(renderAnalysisFragment(analysis, version), version)
  } finally {
    store.close()
  }
}

export async function handleDashboardFragmentRequest(
  request: Request,
  catalogPath: string,
): Promise<Response> {
  if (request.method !== 'GET') return errorResponse('Method not allowed', 405)
  if (!isTrustedBrowserRequest(request)) return errorResponse('Same-origin request required', 403)
  const id = queryParam(request, 'dashboardId')
  if (!DASHBOARD_ID.test(id)) return errorResponse('Invalid dashboard id', 400)
  const unavailable = await requireCatalog(catalogPath)
  if (unavailable) return unavailable
  const store = new MetadataStore(catalogPath)
  try {
    const dashboard = store.loadDashboard(id)
    if (!dashboard) return errorResponse(`Dashboard ${id} does not exist`, 404)
    const version = dashboardResourceVersion(dashboard)
    return fragmentResponse(
      renderDashboardFragment(
        dashboard,
        dashboardCards(store, dashboard),
        version,
        [],
        queryParam(request, 'studio') === 'true',
      ),
      version,
    )
  } finally {
    store.close()
  }
}

export async function handleDashboardPinRequest(
  request: Request,
  catalogPath: string,
): Promise<Response> {
  if (request.method !== 'POST') return errorResponse('Method not allowed', 405)
  if (!isTrustedBrowserRequest(request)) return errorResponse('Same-origin request required', 403)
  const expectedVersion = await expectedVersionFromRequest(request)
  if (!expectedVersion) return errorResponse('expectedVersion is required', 400)
  const body = await jsonBody(request)
  if (!body) return errorResponse('Invalid JSON body', 400)
  const dashboardId = typeof body.dashboardId === 'string' ? body.dashboardId : ''
  const analysisId = typeof body.analysisId === 'string' ? body.analysisId : ''
  if (!DASHBOARD_ID.test(dashboardId) || !ANALYSIS_ID.test(analysisId)) {
    return errorResponse('Invalid resource id', 400)
  }
  const unavailable = await requireCatalog(catalogPath)
  if (unavailable) return unavailable

  const store = new MetadataStore(catalogPath)
  try {
    const dashboard = store.loadDashboard(dashboardId)
    if (!dashboard) return errorResponse(`Dashboard ${dashboardId} does not exist`, 404)
    const currentVersion = dashboardResourceVersion(dashboard)
    const currentFragment = () =>
      renderDashboardFragment(dashboard, dashboardCards(store, dashboard), currentVersion)
    if (expectedVersion !== currentVersion) {
      return conflictFragmentResponse(currentFragment(), currentVersion)
    }
    const analysis = store.loadAnalysisRevision(analysisId)
    if (!analysis) return errorResponse(`Analysis ${analysisId} does not exist`, 404)
    const updated = store.pinAnalysisToDashboard(
      dashboardId,
      analysis.analysisId,
      analysis.revision,
      analysis.question,
    )
    const version = dashboardResourceVersion(updated)
    return fragmentResponse(
      renderDashboardFragment(updated, dashboardCards(store, updated), version),
      version,
    )
  } finally {
    store.close()
  }
}

export async function handleDashboardFilterRequest(
  request: Request,
  catalogPath: string,
): Promise<Response> {
  if (request.method !== 'POST') return errorResponse('Method not allowed', 405)
  if (!isTrustedBrowserRequest(request)) return errorResponse('Same-origin request required', 403)
  const expectedVersion = await expectedVersionFromRequest(request)
  if (!expectedVersion) return errorResponse('expectedVersion is required', 400)
  const body = await jsonBody(request)
  if (!body) return errorResponse('Invalid JSON body', 400)
  const dashboardId = typeof body.dashboardId === 'string' ? body.dashboardId : ''
  if (!DASHBOARD_ID.test(dashboardId)) return errorResponse('Invalid dashboard id', 400)
  const operation = body.operation === 'clear' ? 'clear' : 'apply'
  const { column, value } = body
  if (
    operation === 'apply' &&
    (typeof column !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column) ||
      typeof value !== 'string' ||
      value.length === 0)
  ) {
    return errorResponse('column and value are required', 400)
  }
  const unavailable = await requireCatalog(catalogPath)
  if (unavailable) return unavailable

  const store = new MetadataStore(catalogPath)
  try {
    const dashboard = store.loadDashboard(dashboardId)
    if (!dashboard) return errorResponse(`Dashboard ${dashboardId} does not exist`, 404)
    const currentVersion = dashboardResourceVersion(dashboard)
    if (expectedVersion !== currentVersion) {
      return conflictFragmentResponse(
        renderDashboardFragment(dashboard, dashboardCards(store, dashboard), currentVersion),
        currentVersion,
      )
    }
    const workspaceRoot = dirname(catalogPath)
    const workspace = {
      root: workspaceRoot,
      catalogPath,
      resultsDir: join(workspaceRoot, 'results'),
      artifactsDir: join(workspaceRoot, 'artifacts'),
      analysesDir: join(workspaceRoot, 'analyses'),
      sourcesDir: join(workspaceRoot, 'sources'),
      datasetFile: (datasetVersionId: string, datasetId: string) =>
        join(
          workspaceRoot,
          'workspaces',
          datasetId,
          'datasets',
          datasetVersionId,
          'dataset.duckdb',
        ),
    }
    if (request.signal.aborted) throw new RequestAbortedError()
    const prepared =
      operation === 'clear'
        ? await clearDashboardSharedFilter(workspace, dashboardId, expectedVersion, request.signal)
        : await applyDashboardSharedFilter(
            workspace,
            dashboardId,
            { column: String(column), value: String(value) },
            { expectedVersion, signal: request.signal },
          )
    const updated = prepared.dashboard!
    const version = dashboardResourceVersion(updated)
    return fragmentResponse(
      renderDashboardFragment(
        updated,
        dashboardCards(store, updated),
        version,
        prepared.unsupported,
      ),
      version,
    )
  } catch (error) {
    if (
      (error instanceof Error && error.message.includes('version conflict')) ||
      error instanceof AnalysisRevisionConflictError
    ) {
      const current = store.loadDashboard(dashboardId)
      if (current) {
        const version = dashboardResourceVersion(current)
        return conflictFragmentResponse(
          renderDashboardFragment(current, dashboardCards(store, current), version),
          version,
        )
      }
    }
    if (error instanceof RequestAbortedError || request.signal.aborted) {
      return errorResponse('Request aborted', 499)
    }
    return failureResponse(error)
  } finally {
    store.close()
  }
}

export async function handleDashboardFilterKeysRequest(
  request: Request,
  catalogPath: string,
): Promise<Response> {
  if (request.method !== 'POST') return errorResponse('Method not allowed', 405)
  if (!isTrustedBrowserRequest(request)) return errorResponse('Same-origin request required', 403)
  const expectedVersion = await expectedVersionFromRequest(request)
  if (!expectedVersion) return errorResponse('expectedVersion is required', 400)
  const body = await jsonBody(request)
  if (!body) return errorResponse('Invalid JSON body', 400)
  const dashboardId = typeof body.dashboardId === 'string' ? body.dashboardId : ''
  const analysisId = typeof body.analysisId === 'string' ? body.analysisId : ''
  if (!DASHBOARD_ID.test(dashboardId) || !ANALYSIS_ID.test(analysisId)) {
    return errorResponse('Invalid resource id', 400)
  }
  const keys = Array.isArray(body.keys) ? body.keys : null
  if (
    !keys ||
    keys.some((key) => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
  ) {
    return errorResponse('keys must contain simple identifiers', 400)
  }
  const unavailable = await requireCatalog(catalogPath)
  if (unavailable) return unavailable
  const store = new MetadataStore(catalogPath)
  try {
    const dashboard = store.loadDashboard(dashboardId)
    if (!dashboard) return errorResponse(`Dashboard ${dashboardId} does not exist`, 404)
    const currentVersion = dashboardResourceVersion(dashboard)
    if (expectedVersion !== currentVersion) {
      return conflictFragmentResponse(
        renderDashboardFragment(dashboard, dashboardCards(store, dashboard), currentVersion),
        currentVersion,
      )
    }
    const updated = store.setDashboardSharedFilterKeys(dashboardId, analysisId, keys as string[])
    const version = dashboardResourceVersion(updated)
    return fragmentResponse(
      renderDashboardFragment(updated, dashboardCards(store, updated), version),
      version,
    )
  } catch (error) {
    if (error instanceof AnalysisNotFoundError || error instanceof DashboardNotFoundError) {
      return errorResponse(error.message, 404)
    }
    return failureResponse(error)
  } finally {
    store.close()
  }
}

export async function handleAnalysisExportRequest(
  request: Request,
  catalogPath: string,
): Promise<Response> {
  if (request.method !== 'POST') return errorResponse('Method not allowed', 405)
  if (!isTrustedBrowserRequest(request)) return errorResponse('Same-origin request required', 403)
  let body: Record<string, unknown> = {}
  if ((request.headers.get('content-type') ?? '').includes('application/json')) {
    const parsed = await jsonBody(request)
    if (!parsed) return errorResponse('Invalid JSON body', 400)
    body = parsed
  }
  const analysisId = typeof body.analysisId === 'string' ? body.analysisId : ''
  if (!ANALYSIS_ID.test(analysisId)) return errorResponse('Invalid analysis id', 400)
  const title = typeof body.title === 'string' ? body.title : undefined
  const parsedTemplate = ReportTemplateSchema.safeParse(body.template ?? 'analytical-brief')
  if (!parsedTemplate.success) return errorResponse('Invalid report template', 400)
  if (
    body.expectedRevision !== undefined &&
    (!Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 1)
  )
    return errorResponse('Invalid expected revision', 400)
  const unavailable = await requireCatalog(catalogPath)
  if (unavailable) return unavailable
  const store = new MetadataStore(catalogPath)
  try {
    const analysis = store.loadAnalysisRevision(analysisId)
    if (!analysis) return errorResponse(`Analysis ${analysisId} does not exist`, 404)
    if (body.expectedRevision !== undefined && body.expectedRevision !== analysis.revision)
      return errorResponse('Analysis changed; refresh before exporting', 409)
    const workspace = resolveWorkspacePaths(dirname(catalogPath))
    const wantInterpretation =
      body.includeInterpretation === true ||
      body.includeInterpretation === 1 ||
      body.includeInterpretation === '1'
    const approved = interpretationApprovedForExport(analysis)
    const pack = await writeExportPack({
      template: parsedTemplate.data,
      workspace,
      resultId: analysis.resultId,
      artifactId: analysis.artifactIds[0] ?? '',
      title,
      question: analysis.question,
      analysisId: analysis.analysisId,
      narrative:
        wantInterpretation && approved
          ? {
              findings: analysis.interpretation?.findings,
              caveats: analysis.interpretation?.caveats,
              nextSteps: analysis.interpretation?.nextSteps,
              includeInterpretation: true,
              interpretationReview: {
                status: 'approved',
                analysisId: analysis.analysisId,
                analysisRevision: analysis.revision,
                reviewedAt: analysis.interpretationReview?.reviewedAt,
              },
            }
          : analysis.interpretation
            ? {
                findings: analysis.interpretation.findings,
                caveats: analysis.interpretation.caveats,
                nextSteps: analysis.interpretation.nextSteps,
                includeInterpretation: false,
                interpretationReview: {
                  status: analysis.interpretationReview?.status ?? 'unreviewed',
                  analysisId: analysis.analysisId,
                  analysisRevision: analysis.revision,
                },
              }
            : undefined,
    })
    return new Response(renderExportFragment(pack), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (error) {
    return failureResponse(error)
  } finally {
    store.close()
  }
}

export async function handleDashboardExportRequest(
  request: Request,
  catalogPath: string,
): Promise<Response> {
  if (request.method !== 'POST') return errorResponse('Method not allowed', 405)
  if (!isTrustedBrowserRequest(request)) return errorResponse('Same-origin request required', 403)
  const body = await jsonBody(request)
  if (!body || typeof body.dashboardId !== 'string' || !DASHBOARD_ID.test(body.dashboardId))
    return errorResponse('Invalid dashboard id', 400)
  const template = ReportTemplateSchema.safeParse(body.template ?? 'analytical-brief')
  if (!template.success) return errorResponse('Invalid report template', 400)
  const unavailable = await requireCatalog(catalogPath)
  if (unavailable) return unavailable
  const store = new MetadataStore(catalogPath)
  try {
    const dashboard = store.loadDashboard(body.dashboardId)
    if (!dashboard) return errorResponse('Dashboard not found', 404)
    const expected = typeof body.expectedVersion === 'string' ? body.expectedVersion : null
    if (expected !== dashboardResourceVersion(dashboard))
      return conflictFragmentResponse('Dashboard changed; refresh before exporting')
    const wantInterpretation =
      body.includeInterpretation === true ||
      body.includeInterpretation === 1 ||
      body.includeInterpretation === '1'
    const pack = await writeDashboardExportPack({
      workspace: resolveWorkspacePaths(dirname(catalogPath)),
      dashboardId: body.dashboardId,
      expectedVersion: expected!,
      template: template.data,
      title: typeof body.title === 'string' ? body.title : undefined,
      // Generated interpretation ships only on an explicit analyst opt-in here
      // *and* per-revision approval, checked in writeDashboardExportPack.
      ...(wantInterpretation ? { narrative: { includeInterpretation: true } } : {}),
    })
    return new Response(renderExportFragment(pack), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (error) {
    return failureResponse(error)
  } finally {
    store.close()
  }
}

export function registerAnalystUiRoutes(ctx: Context): void {
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
    if (!connection?.fetch?.register) return
    const catalog = () => resolveWorkspacePaths().catalogPath
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/ui/analysis',
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) => handleAnalysisFragmentRequest(request, catalog()),
        }),
      'dsh-data-workbench: analyst analysis UI fragment',
    )
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/ui/dashboard',
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) => handleDashboardFragmentRequest(request, catalog()),
        }),
      'dsh-data-workbench: analyst dashboard UI fragment',
    )
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/ui/dashboard/pin',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleDashboardPinRequest(request, catalog()),
        }),
      'dsh-data-workbench: analyst dashboard pin UI mutation',
    )
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/ui/dashboard/filter',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleDashboardFilterRequest(request, catalog()),
        }),
      'dsh-data-workbench: analyst dashboard filter UI mutation',
    )
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/ui/dashboard/map-keys',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleDashboardFilterKeysRequest(request, catalog()),
        }),
      'dsh-data-workbench: analyst dashboard filter mapping UI mutation',
    )
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/ui/dashboard/export',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleDashboardExportRequest(request, catalog()),
        }),
      'dsh-data-workbench: dashboard report export',
    )
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/ui/analysis/export',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleAnalysisExportRequest(request, catalog()),
        }),
      'dsh-data-workbench: analyst analysis export UI mutation',
    )
  })
}
