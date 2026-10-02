import { readFile } from 'node:fs/promises'
import { ARTIFACT_ID_RE } from './chart-artifact-id.js'
import { resolveSafeChartArtifact } from './artifact-path.js'
import { createPngFromSvg } from './png-export.js'

const FORMATS = new Set(['svg', 'png', 'json'])

function headers(contentType: string, downloadName?: string): Headers {
  const result = new Headers({
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  if (downloadName) {
    result.set('content-disposition', `attachment; filename="${downloadName}"`)
  } else {
    result.set('content-disposition', 'inline')
  }
  return result
}

function empty(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Serve one chart artifact after Connection has already authenticated the
 * request. Query: `id=art_…`, `format=svg|png|json`, optional `download=1`.
 */
export async function handleChartArtifactRequest(
  request: Request,
  artifactsDir: string,
): Promise<Response> {
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    return empty(405, 'Method not allowed')
  }
  const url = new URL(request.url)
  const artifactId = url.searchParams.get('id') ?? ''
  const format = (url.searchParams.get('format') ?? 'svg').toLowerCase()
  const download = url.searchParams.get('download') === '1'
  if (!ARTIFACT_ID_RE.test(artifactId) || !FORMATS.has(format)) {
    return empty(400, 'Invalid artifact id or format')
  }
  const extension = format === 'png' ? 'svg' : (format as 'svg' | 'json')
  const path = resolveSafeChartArtifact(artifactsDir, artifactId, extension)
  if (!path) return empty(400, 'Invalid artifact path')
  try {
    if (format === 'json') {
      const body = await readFile(path)
      const hdrs = headers(
        'application/json; charset=utf-8',
        download ? `${artifactId}.json` : undefined,
      )
      if (method === 'HEAD') return new Response(null, { status: 200, headers: hdrs })
      return new Response(body.toString('utf8'), { status: 200, headers: hdrs })
    }
    const svg = await readFile(path, 'utf8')
    if (format === 'png') {
      const png = createPngFromSvg(svg)
      const hdrs = headers('image/png', download ? `${artifactId}.png` : undefined)
      hdrs.set('content-length', String(png.length))
      if (method === 'HEAD') return new Response(null, { status: 200, headers: hdrs })
      return new Response(Uint8Array.from(png), { status: 200, headers: hdrs })
    }
    const hdrs = headers('image/svg+xml; charset=utf-8', download ? `${artifactId}.svg` : undefined)
    if (method === 'HEAD') return new Response(null, { status: 200, headers: hdrs })
    return new Response(svg, { status: 200, headers: hdrs })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return empty(404, 'Missing artifact')
    }
    throw error
  }
}
