import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { resolveSafeArtifact } from './artifact-path.js'

const FILE = /^export_[a-f0-9]{32}(?:_(?:spec|analysis))?\.(html|svg|png|csv|json|zip)$/
const MIME: Record<string, string> = {
  html: 'text/html',
  svg: 'image/svg+xml',
  png: 'image/png',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
}

/** Connection authenticates before this route. Only server-created export names. */
export async function handleReportRequest(
  request: Request,
  artifactsDir: string,
): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const params = new URL(request.url).searchParams
  const file = params.get('file') ?? ''
  const preview = params.get('preview') === '1'
  const match = FILE.exec(file)
  const path = match ? resolveSafeArtifact(artifactsDir, file) : null
  if (preview && match?.[1] !== 'html')
    return new Response('Only HTML reports support preview', { status: 400 })
  if (!path) return new Response('Invalid report', { status: 400 })
  try {
    const bytes = await readFile(path)
    return new Response(request.method === 'HEAD' ? null : Uint8Array.from(bytes), {
      headers: {
        'content-type': MIME[match![1]!]!,
        'content-disposition': ` ${preview ? 'inline' : 'attachment'}; filename="${file}"`.trim(),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      },
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return new Response(null, { status: 404 })
    throw error
  }
}

export function registerReportFetch(ctx: Context): void {
  ctx.inject(['connection'], (webCtx) => {
    const connection = Reflect.get(webCtx, 'connection') as {
      fetch: {
        register: (route: {
          path: string
          methods: readonly ['GET', 'HEAD']
          requestBody: 'buffered'
          fetch: (request: Request) => Promise<Response>
        }) => () => Promise<void>
      }
    }
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/reports',
          methods: ['GET', 'HEAD'],
          requestBody: 'buffered',
          fetch: (request) => handleReportRequest(request, resolveWorkspacePaths().artifactsDir),
        }),
      'dsh-data-workbench: report downloads',
    )
  })
}
