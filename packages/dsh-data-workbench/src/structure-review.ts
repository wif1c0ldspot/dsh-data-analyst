import type { Context } from '@deepseek-ai/cordis'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'

const CANDIDATE_ID = /^(?:grain|rel)_[a-f0-9]{16}$/

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin')
  const requestHost = request.headers.get('host') ?? new URL(request.url).host
  let originHost = ''
  try {
    originHost = origin ? new URL(origin).host : ''
  } catch {
    // Invalid origins fail the comparison below.
  }
  return originHost !== '' && originHost === requestHost
}

/** Authenticated same-origin route for analyst review of grain/relationship candidates. */
export async function handleStructureReviewRequest(
  request: Request,
  catalogPath: string,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!isSameOriginRequest(request)) return json({ error: 'Same-origin request required' }, 403)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400)
  const { candidateId, status } = body as Record<string, unknown>
  if (typeof candidateId !== 'string' || !CANDIDATE_ID.test(candidateId)) {
    return json({ error: 'Invalid candidate id' }, 400)
  }
  if (status !== 'approved' && status !== 'revoked') {
    return json({ error: 'Invalid review status' }, 400)
  }

  const store = new MetadataStore(catalogPath)
  try {
    const reviewed = store.setStructureCandidateStatus(candidateId, status)
    return json({
      candidateId: reviewed.candidateId,
      datasetId: reviewed.datasetId,
      status: reviewed.status,
      reviewedAt: reviewed.reviewedAt,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'StructureCandidateNotFoundError') {
      return json({ error: error.message }, 404)
    }
    throw error
  } finally {
    store.close()
  }
}

export function registerStructureReview(ctx: Context): void {
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
          path: '/api/analyst/structure/review',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) =>
            handleStructureReviewRequest(request, resolveWorkspacePaths().catalogPath),
        }),
      'dsh-data-workbench: analyst structure review',
    )
  })
}
