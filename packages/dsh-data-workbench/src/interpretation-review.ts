/**
 * Analyst review of generated interpretation bound to an analysis revision.
 * Approval is never accepted from model tool arguments — only this same-origin
 * browser route may set approved/rejected.
 */
import type { Context } from '@deepseek-ai/cordis'
import { saveAnalysisRevision, loadAnalysisRevision } from 'dsh-data-core/analysis-store'
import { AnalysisNotFoundError, AnalysisRevisionConflictError } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { isTrustedBrowserRequest } from './browser-trust.js'

const ANALYSIS_ID = /^ana_[a-z0-9]+$/i

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function parseStringList(value: unknown, max = 10): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, max)
  return items
}

export async function handleInterpretationReviewRequest(
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
  const {
    analysisId,
    expectedRevision,
    status,
    findings,
    caveats,
    nextSteps,
    // Intentionally ignored — clients cannot forge approval via this field.
    interpretationReview: _forgedReview,
    includeInterpretation: _forgedInclude,
  } = body as Record<string, unknown>

  if (typeof analysisId !== 'string' || !ANALYSIS_ID.test(analysisId)) {
    return json({ error: 'Invalid analysis id' }, 400)
  }
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    return json({ error: 'expectedRevision is required' }, 400)
  }
  if (status !== 'approved' && status !== 'rejected' && status !== 'unreviewed') {
    return json({ error: 'Invalid review status' }, 400)
  }

  try {
    const current = await loadAnalysisRevision(catalogPath, analysisId)
    if (current.revision !== expectedRevision) {
      return json(
        {
          error: `Analysis revision conflict: expected ${expectedRevision}, found ${current.revision}`,
        },
        409,
      )
    }

    const interpretation = {
      findings: parseStringList(findings) ?? current.interpretation?.findings,
      caveats: parseStringList(caveats) ?? current.interpretation?.caveats,
      nextSteps: parseStringList(nextSteps) ?? current.interpretation?.nextSteps,
    }

    const saved = await saveAnalysisRevision(catalogPath, {
      analysisId,
      expectedRevision,
      datasetVersionId: current.datasetVersionId,
      semanticRevisionId: current.semanticRevisionId,
      question: current.question,
      query: current.query,
      resultId: current.resultId,
      chart: current.chart,
      artifactIds: current.artifactIds,
      interpretation,
      interpretationReview: {
        status,
        resultId: current.resultId,
        reviewedAt: new Date().toISOString(),
      },
    })

    return json({
      analysisId: saved.analysisId,
      revision: saved.revision,
      resultId: saved.resultId,
      interpretationReview: saved.interpretationReview,
      interpretation: saved.interpretation,
    })
  } catch (error) {
    if (error instanceof AnalysisRevisionConflictError) {
      return json({ error: error.message }, 409)
    }
    if (error instanceof AnalysisNotFoundError) {
      return json({ error: error.message }, 404)
    }
    throw error
  }
}

export function registerInterpretationReview(ctx: Context): void {
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
          path: '/api/analyst/interpretation/review',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) =>
            handleInterpretationReviewRequest(request, resolveWorkspacePaths().catalogPath),
        }),
      'dsh-data-workbench: analyst interpretation review',
    )
  })
}
