/**
 * Resolve the analyst GUI origin so model-facing report download links are
 * absolute HTTP(S) URLs. dsh markdown rejects relative destinations, so chat
 * "Download HTML" buttons must use the live loopback origin rather than a
 * placeholder host.
 */

const REPORT_DOWNLOAD_PATH =
  /^\/api\/analyst\/reports\?file=export_[a-f0-9]{32}(?:_(?:spec|analysis))?\.(?:html|svg|png|csv|json|zip)$/

export interface AnalystPublicOriginSource {
  webServer?: { port?: number } | null
  env?: NodeJS.ProcessEnv
}

/** Canonical loopback origin for the running dsh web GUI, when known. */
export function resolveAnalystPublicOrigin(
  source: AnalystPublicOriginSource = {},
): string | undefined {
  const env = source.env ?? process.env
  const fromEnv = env.DSH_WEB_URL?.trim()
  if (fromEnv) {
    try {
      return new URL(fromEnv).origin
    } catch {
      // Ignore malformed runtime URLs and fall through to webServer.
    }
  }
  const port = source.webServer?.port
  if (typeof port === 'number' && Number.isFinite(port) && port > 0) {
    return `http://127.0.0.1:${Math.trunc(port)}`
  }
  return undefined
}

/** Prefix relative report download paths with the runtime origin when available. */
export function absolutizeReportDownloads(
  downloads: Record<string, string>,
  origin: string | undefined,
): Record<string, string> {
  if (!origin) return downloads
  const base = origin.replace(/\/$/, '')
  return Object.fromEntries(
    Object.entries(downloads).map(([format, url]) => {
      if (typeof url !== 'string' || !REPORT_DOWNLOAD_PATH.test(url)) {
        return [format, url]
      }
      return [format, `${base}${url}`]
    }),
  )
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

/** Relative or loopback-absolute report download URLs only. */
export function isSafeReportDownloadUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false
  if (url.startsWith('/')) return REPORT_DOWNLOAD_PATH.test(url)
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (!isLoopbackHostname(parsed.hostname)) return false
    return REPORT_DOWNLOAD_PATH.test(`${parsed.pathname}${parsed.search}`)
  } catch {
    return false
  }
}
