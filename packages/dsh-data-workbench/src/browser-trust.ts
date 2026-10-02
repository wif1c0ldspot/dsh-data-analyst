/**
 * CSRF / browser-intent trust for authenticated same-origin dsh routes.
 * This is the single source of truth for that policy; `server.ts`'s
 * `isTrustedStateChangingRequest` adapts Node's `IncomingMessage` headers to
 * the WHATWG `Request` shape this file expects and delegates to it, so the
 * test-only HTMX workbench enforces the exact same rule rather than a second,
 * independently-maintained copy of it.
 *
 * Why Origin may be absent: Chromium often omits `Origin` on same-origin GET
 * `fetch()`. Requiring Origin then permanently blocks truncated ingest-recipe
 * toolviews from loading the full candidate, so Approve never appears.
 */

function isLoopbackHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith('[') && host.includes(']')) {
    host = host.slice(1, host.indexOf(']'))
  } else {
    const colon = host.lastIndexOf(':')
    if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
      host = host.slice(0, colon)
    }
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function isTrustedBrowserRequest(request: Request): boolean {
  const hostHeader = request.headers.get('host')
  if (!hostHeader) return false
  const host = hostHeader.split(',')[0]!.trim().toLowerCase()

  const originHeader = request.headers.get('origin')
  if (originHeader) {
    try {
      const originHost = new URL(originHeader).host.toLowerCase()
      if (originHost === host) return true
      return isLoopbackHost(originHost) && isLoopbackHost(host)
    } catch {
      return false
    }
  }

  const site = request.headers.get('sec-fetch-site')
  if (site === 'cross-site') return false
  if (site === 'same-origin' || site === 'none') return true
  return isLoopbackHost(host)
}
