import type { Context } from '@deepseek-ai/cordis'
import { listAnalysisRevisions } from 'dsh-data-core/analysis-store'
import { listPublishedDatasets } from 'dsh-data-core/catalog-query'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import type { StudioAvailabilityCheck } from 'dsh-data-core/contracts'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { isTrustedBrowserRequest } from './browser-trust.js'

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/**
 * Same-origin workspace overview for the right-sidebar "Data" tab: published
 * datasets, saved dashboards, and saved analyses. Compact metadata only — no
 * rows, SQL, or artifacts reach the browser here.
 */
export async function handleAnalystOverviewRequest(
  request: Request,
  catalogPath: string,
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
  if (!isTrustedBrowserRequest(request)) return json({ error: 'Same-origin request required' }, 403)

  const store = new MetadataStore(catalogPath)
  try {
    const analyses = await listAnalysisRevisions(catalogPath)
    return json({
      datasets: listPublishedDatasets(store).map((dataset) => ({
        datasetId: dataset.datasetId,
        sourceSlug: dataset.sourceSlug,
      })),
      dashboards: store.listDashboards().map((dashboard) => ({
        dashboardId: dashboard.dashboardId,
        title: dashboard.title,
        archived: dashboard.archived,
        slotCount: dashboard.layout.slots.length,
      })),
      analyses: analyses.map((analysis) => ({
        analysisId: analysis.analysisId,
        revision: analysis.revision,
        title: analysis.chart.title,
        question: analysis.question,
      })),
    })
  } finally {
    store.close()
  }
}

/**
 * Studio-availability check. Re-runs the exact same
 * catalog query {@link handleAnalystOverviewRequest} (`/api/analyst/overview`,
 * the route Studio's native sidebar selector reads) uses —
 * `listAnalysisRevisions`, deduplicated to one row per analysis at its
 * latest persisted revision — rather than trusting a prior `save_analysis`
 * return value. This is the "is this analysis actually retrievable via the
 * Studio overview route" check itself, not an inference from save success:
 * a revision can be persisted (in the catalog) yet momentarily not the
 * latest one this route would return, or an analysisId can simply not
 * exist, and both are reported here as `availableInStudio: false`.
 */
export async function checkStudioAvailability(
  catalogPath: string,
  analysisId: string,
  requestedRevision?: number,
): Promise<StudioAvailabilityCheck> {
  const analyses = await listAnalysisRevisions(catalogPath)
  const match = analyses.find((analysis) => analysis.analysisId === analysisId)
  const latestRevision = match ? match.revision : null
  const availableInStudio =
    match !== undefined && (requestedRevision === undefined || latestRevision === requestedRevision)
  const check: StudioAvailabilityCheck = {
    analysisId,
    requestedRevision: requestedRevision ?? null,
    latestRevision,
    availableInStudio,
    checkedVia: 'studio-overview-route',
    checkedAt: new Date().toISOString(),
  }
  // This is the same independently-observed check `check_studio_availability`
  // exposes to the model — record it as "studio opened" only
  // when the availability check actually confirms the revision is there,
  // never on a check that came back false, so the trail cannot claim Studio
  // opened something that in fact was not available.
  if (match && availableInStudio) {
    const store = new MetadataStore(catalogPath)
    try {
      store.recordWorkflowMilestone({
        milestone: 'studio_opened',
        actor: 'service',
        datasetVersionId: match.datasetVersionId,
        analysisId: match.analysisId,
        receiptId: `${match.analysisId}:${match.revision}`,
      })
    } finally {
      store.close()
    }
  }
  return check
}

export function registerAnalystOverview(ctx: Context): void {
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
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/overview',
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) =>
            handleAnalystOverviewRequest(request, resolveWorkspacePaths().catalogPath),
        }),
      'dsh-data-workbench: analyst workspace overview',
    )
  })
}
