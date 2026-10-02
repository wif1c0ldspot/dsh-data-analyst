import type { Context } from '@deepseek-ai/cordis'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'

const EXAMPLE_ID = /^learn_[a-f0-9]{16}$/

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })
}

export async function handleLearningReviewRequest(
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
  const { exampleId, status } = body as Record<string, unknown>
  if (typeof exampleId !== 'string' || !EXAMPLE_ID.test(exampleId)) {
    return json({ error: 'Invalid example id' }, 400)
  }
  if (status !== 'approved' && status !== 'revoked') {
    return json({ error: 'Invalid review status' }, 400)
  }
  const store = new MetadataStore(catalogPath)
  try {
    const reviewed = store.setLearningExampleStatus(exampleId, status)
    return json({
      exampleId: reviewed.exampleId,
      analysisId: reviewed.analysisId,
      status: reviewed.status,
      reviewedAt: reviewed.reviewedAt,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'LearningExampleNotFoundError') {
      return json({ error: error.message }, 404)
    }
    throw error
  } finally {
    store.close()
  }
}

export function registerLearningReview(ctx: Context): void {
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
          path: '/api/analyst/learning/review',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) =>
            handleLearningReviewRequest(request, resolveWorkspacePaths().catalogPath),
        }),
      'dsh-data-workbench: analyst learning review',
    )
  })
}
