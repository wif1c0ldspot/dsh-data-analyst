import type { Context } from '@deepseek-ai/cordis'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'

const CANDIDATE_ID = /^alias_[a-f0-9]{16}$/
const MAX_BATCH_REVIEW = 100

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

/** Authenticated dsh route for the human review action shown in the proposal toolview. */
export async function handleAliasReviewRequest(
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
    const reviewed = store.setAliasCandidateStatus(candidateId, status)
    return json({
      candidateId: reviewed.candidateId,
      datasetId: reviewed.datasetId,
      term: reviewed.term,
      status: reviewed.status,
      reviewedAt: reviewed.reviewedAt,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AliasCandidateNotFoundError') {
      return json({ error: error.message }, 404)
    }
    throw error
  } finally {
    store.close()
  }
}

/** Same-origin batch review: approve or reject multiple alias candidates at once. */
export async function handleAliasBatchReviewRequest(
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
  const { candidateIds, status } = body as Record<string, unknown>
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
    return json({ error: 'candidateIds must be a non-empty array' }, 400)
  }
  if (candidateIds.length > MAX_BATCH_REVIEW) {
    return json({ error: `At most ${MAX_BATCH_REVIEW} candidates per review` }, 400)
  }
  for (const id of candidateIds) {
    if (typeof id !== 'string' || !CANDIDATE_ID.test(id)) {
      return json({ error: 'Invalid candidate id' }, 400)
    }
  }
  if (status !== 'approved' && status !== 'revoked') {
    return json({ error: 'Invalid review status' }, 400)
  }

  const store = new MetadataStore(catalogPath)
  try {
    const reviewed: Array<{ candidateId: string; term: string; status: string }> = []
    const failed: Array<{ candidateId: string; error: string }> = []
    for (const candidateId of candidateIds) {
      try {
        const result = store.setAliasCandidateStatus(candidateId, status)
        reviewed.push({ candidateId: result.candidateId, term: result.term, status: result.status })
      } catch (error) {
        if (error instanceof Error && error.name === 'AliasCandidateNotFoundError') {
          failed.push({ candidateId, error: error.message })
        } else {
          throw error
        }
      }
    }
    return json({ reviewed, failed })
  } finally {
    store.close()
  }
}

export function registerAliasReview(ctx: Context): void {
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
          path: '/api/analyst/aliases/review',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) =>
            handleAliasReviewRequest(request, resolveWorkspacePaths().catalogPath),
        }),
      'dsh-data-workbench: analyst alias review',
    )
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/aliases/review-batch',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) =>
            handleAliasBatchReviewRequest(request, resolveWorkspacePaths().catalogPath),
        }),
      'dsh-data-workbench: analyst batch alias review',
    )
  })
}
