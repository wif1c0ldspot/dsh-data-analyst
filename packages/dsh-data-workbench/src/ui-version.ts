import type { AnalysisRevision, Dashboard } from 'dsh-data-core/contracts'

/** Response header carrying the current revision token for a fragment resource. */
export const ANALYST_RESOURCE_VERSION_HEADER = 'X-Analyst-Resource-Version'

const FRAGMENT_RESPONSE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/** Build an authorized HTML fragment response with the resource version header. */
export function fragmentResponse(html: string, version: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      ...FRAGMENT_RESPONSE_HEADERS,
      [ANALYST_RESOURCE_VERSION_HEADER]: version,
    },
  })
}

/** Build a 409 conflict fragment; include the latest version when known. */
export function conflictFragmentResponse(html: string, version?: string): Response {
  const headers: Record<string, string> = { ...FRAGMENT_RESPONSE_HEADERS }
  if (version !== undefined) {
    headers[ANALYST_RESOURCE_VERSION_HEADER] = version
  }
  return new Response(html, { status: 409, headers })
}

/**
 * Read the client-supplied expected revision from a composition mutation POST.
 * Uses the JSON body field `expectedVersion` (cloned so route handlers can still
 * parse the body). Returns null when absent or invalid.
 */
export async function expectedVersionFromRequest(request: Request): Promise<string | null> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return null
  }
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return null
  }
  try {
    const body = (await request.clone().json()) as unknown
    if (!body || typeof body !== 'object') return null
    const value = (body as Record<string, unknown>).expectedVersion
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/** Dashboard optimistic-concurrency token derived from last metadata write time. */
export function dashboardResourceVersion(dashboard: Dashboard): string {
  return dashboard.updatedAt
}

/** Analysis optimistic-concurrency token derived from append-only revision counter. */
export function analysisResourceVersion(revision: AnalysisRevision): string {
  return String(revision.revision)
}
