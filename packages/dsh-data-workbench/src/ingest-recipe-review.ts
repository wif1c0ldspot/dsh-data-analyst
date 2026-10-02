import type { Context } from '@deepseek-ai/cordis'
import {
  MetadataStore,
  WorkspaceSourcePinConflictError,
  WorkspaceSourcePinNotFoundError,
} from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { isTrustedBrowserRequest } from './browser-trust.js'

const PIN_ID = /^pin_[a-f0-9]{16}$/

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
 * Authenticated dsh route for the human review action shown in the
 * preview_ingest_source proposal toolview (same same-origin
 * pattern as `alias-review.ts` / `learning-review.ts`). Only an analyst
 * approval here — never a model-set `approved` argument — lets
 * `ingest_dataset` resolve and publish a generic workspace pin.
 */
export async function handleIngestRecipeReviewRequest(
  request: Request,
  catalogPath: string,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!isTrustedBrowserRequest(request)) {
    return json({ error: 'Same-origin request required' }, 403)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400)
  const { pinId, status, expectedRevision } = body as Record<string, unknown>
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1
  )
    return json({ error: 'expectedRevision is required' }, 400)
  if (typeof pinId !== 'string' || !PIN_ID.test(pinId)) {
    return json({ error: 'Invalid pin id' }, 400)
  }
  if (status !== 'approved' && status !== 'revoked') {
    return json({ error: 'Invalid review status' }, 400)
  }

  const store = new MetadataStore(catalogPath)
  try {
    const reviewed = store.setWorkspaceSourcePinStatus(pinId, status, expectedRevision)
    if (status === 'approved') {
      // The only place `analyst_approved` is ever recorded — this
      // authenticated, same-origin Studio review route, never a model tool
      // argument — so the milestone is structurally distinguishable from an
      // agent's `preview_ingest_source` suggestion (`actor: 'agent'`).
      store.recordWorkflowMilestone({
        milestone: 'analyst_approved',
        actor: 'analyst-ui',
        datasetVersionId: reviewed.recipe.datasetId,
        receiptId: reviewed.pinId,
      })
    }
    return json({
      pinId: reviewed.pinId,
      revision: reviewed.revision,
      slug: reviewed.slug,
      sourceVersion: reviewed.sourceVersion,
      datasetId: reviewed.recipe.datasetId,
      status: reviewed.status,
      reviewedAt: reviewed.reviewedAt,
    })
  } catch (error) {
    if (error instanceof WorkspaceSourcePinConflictError) return json({ error: error.message }, 409)
    if (error instanceof WorkspaceSourcePinNotFoundError) {
      return json({ error: error.message }, 404)
    }
    throw error
  } finally {
    store.close()
  }
}

/**
 * Authenticated GET route that returns the full stored candidate for one
 * workspace source pin — proposed tables/columns plus the labelled
 * publisher-supplied description and column dictionary (see
 * `dsh-data-kaggle/publisher-metadata`).
 * `renderObserve`'s
 * `catalog` kind caps every model-facing observation at 8 KiB and can drop
 * `tables` under `warnings: ["truncated"]` when a proposal has many
 * tables/columns — the toolview must not let an analyst approve a proposal
 * it never actually saw. This route lets the toolview load the untruncated
 * `tables` straight from the stored recipe (never re-derived from the
 * model's truncated observation) before showing Approve/Reject. Same
 * same-origin check as the POST review route; no session/login auth is
 * added here, matching the rest of this module.
 */
export async function handleIngestRecipeGetRequest(
  request: Request,
  catalogPath: string,
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
  if (!isTrustedBrowserRequest(request)) {
    return json({ error: 'Same-origin request required' }, 403)
  }

  const pinId = new URL(request.url).searchParams.get('pinId') ?? ''
  if (!PIN_ID.test(pinId)) {
    return json({ error: 'Invalid pin id' }, 400)
  }

  const store = new MetadataStore(catalogPath)
  try {
    const pin = store.getWorkspaceSourcePin(pinId)
    if (!pin) {
      return json({ error: `Workspace source pin ${pinId} does not exist` }, 404)
    }
    return json({
      pinId: pin.pinId,
      revision: pin.revision,
      slug: pin.slug,
      sourceVersion: pin.sourceVersion,
      sourceUrl: pin.recipe.sourceUrl,
      observedLicense: pin.recipe.license,
      reviewedAt: pin.reviewedAt,
      datasetId: pin.recipe.datasetId,
      status: pin.status,
      loadStrategy: pin.recipe.loadStrategy ?? 'typed_recipe',
      tables: pin.recipe.tables,
      // Full (unbounded) publisher-supplied block: the publisher's own wording
      // stays available for analyst review even when the model observation had
      // to bound it. Still labelled `publisher-supplied`/`unverified` per entry
      // — this route never turns publisher text into a definition.
      publisherSupplied: pin.recipe.publisherSupplied ?? null,
    })
  } finally {
    store.close()
  }
}

export function registerIngestRecipeReview(ctx: Context): void {
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
          path: '/api/analyst/ingest-recipes/review',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) =>
            handleIngestRecipeReviewRequest(request, resolveWorkspacePaths().catalogPath),
        }),
      'dsh-data-workbench: analyst ingest recipe review',
    )
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/ingest-recipes',
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) =>
            handleIngestRecipeGetRequest(request, resolveWorkspacePaths().catalogPath),
        }),
      'dsh-data-workbench: analyst ingest recipe full candidate fetch',
    )
  })
}
