import type { Context } from '@deepseek-ai/cordis'
import { ChartFeedbackNotFoundError, MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'

const FEEDBACK_ID = /^cfb_[a-f0-9]{16}$/

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })
}

/**
 * Authenticated
 * same-origin analyst review action for a `report_chart_issue` submission
 * — the only place a chart-feedback row can move to `'approved'`. Mirrors
 * `learning-review.ts` / `ingest-recipe-review.ts`'s same-origin pattern.
 * Approving here never writes to `learning_examples` (the approved
 * reusable-learning-evidence store); it only advances this feedback row's
 * own status, matching the Learning v1.1 approval boundary in
 * docs/implementation.md item 1.
 */
export async function handleChartFeedbackReviewRequest(
  request: Request,
  catalogPath: string,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const origin = request.headers.get('origin')
  const requestHost = request.headers.get('host') ?? new URL(request.url).host
  let originHost = ''
  try {
    originHost = origin ? new URL(origin).host : ''
  } catch {
    // Invalid origins fail closed below.
  }
  if (!originHost || originHost !== requestHost) {
    return json({ error: 'Same-origin request required' }, 403)
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400)
  const { feedbackId, status } = body as Record<string, unknown>
  if (typeof feedbackId !== 'string' || !FEEDBACK_ID.test(feedbackId)) {
    return json({ error: 'Invalid feedback id' }, 400)
  }
  if (status !== 'approved' && status !== 'revoked') {
    return json({ error: 'Invalid review status' }, 400)
  }
  const store = new MetadataStore(catalogPath)
  try {
    const reviewed = store.setChartFeedbackStatus(feedbackId, status)
    return json({
      feedbackId: reviewed.feedbackId,
      artifactId: reviewed.artifactId,
      analysisId: reviewed.analysisId,
      analysisRevision: reviewed.analysisRevision,
      issueType: reviewed.issueType,
      status: reviewed.status,
      reviewedAt: reviewed.reviewedAt,
    })
  } catch (error) {
    if (error instanceof ChartFeedbackNotFoundError) {
      return json({ error: error.message }, 404)
    }
    throw error
  } finally {
    store.close()
  }
}

export function registerChartFeedbackReview(ctx: Context): void {
  ctx.inject(['connection'], (webCtx) => {
    const connection = Reflect.get(webCtx, 'connection') as {
      fetch: {
        register: (route: {
          path: string
          methods: readonly ['POST']
          requestBody: 'buffered'
          fetch: (request: Request) => Promise<Response>
        }) => () => Promise<void>
      }
    }
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/chart-feedback/review',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) =>
            handleChartFeedbackReviewRequest(request, resolveWorkspacePaths().catalogPath),
        }),
      'dsh-data-workbench: analyst chart feedback review',
    )
  })
}
