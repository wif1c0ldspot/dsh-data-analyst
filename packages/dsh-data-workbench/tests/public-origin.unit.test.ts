import { afterEach, expect, it } from 'vitest'
import { absolutizeReportDownloads, resolveAnalystPublicOrigin } from '../src/public-origin.js'

const relativeHtml = '/api/analyst/reports?file=export_0123456789abcdef0123456789abcdef.html'
const relativeZip = '/api/analyst/reports?file=export_0123456789abcdef0123456789abcdef.zip'

afterEach(() => {
  delete process.env.DSH_WEB_URL
})

it('resolves the public origin from the live webServer port', () => {
  expect(resolveAnalystPublicOrigin({ webServer: { port: 3088 } })).toBe('http://127.0.0.1:3088')
})

it('prefers DSH_WEB_URL when the runtime publishes one', () => {
  expect(
    resolveAnalystPublicOrigin({
      webServer: { port: 3088 },
      env: { DSH_WEB_URL: 'http://127.0.0.1:4090/' },
    }),
  ).toBe('http://127.0.0.1:4090')
})

it('returns undefined when no runtime origin is available', () => {
  expect(resolveAnalystPublicOrigin({ webServer: null, env: {} })).toBeUndefined()
  expect(resolveAnalystPublicOrigin({ webServer: { port: 0 }, env: {} })).toBeUndefined()
})

it('absolutizes relative report downloads against the runtime origin', () => {
  expect(
    absolutizeReportDownloads(
      { html: relativeHtml, zip: relativeZip, other: '/not-a-report' },
      'http://127.0.0.1:3088',
    ),
  ).toEqual({
    html: `http://127.0.0.1:3088${relativeHtml}`,
    zip: `http://127.0.0.1:3088${relativeZip}`,
    other: '/not-a-report',
  })
})

it('leaves downloads unchanged when origin is missing', () => {
  const downloads = { html: relativeHtml }
  expect(absolutizeReportDownloads(downloads, undefined)).toEqual(downloads)
})

it('accepts only relative or loopback-absolute report download URLs', async () => {
  const { isSafeReportDownloadUrl } = await import('../src/public-origin.js')
  expect(isSafeReportDownloadUrl(relativeHtml)).toBe(true)
  expect(isSafeReportDownloadUrl(`http://127.0.0.1:3088${relativeHtml}`)).toBe(true)
  expect(isSafeReportDownloadUrl(`http://localhost:3088${relativeHtml}`)).toBe(true)
  expect(isSafeReportDownloadUrl(`https://example.invalid${relativeHtml}`)).toBe(false)
  expect(isSafeReportDownloadUrl('javascript:alert(1)')).toBe(false)
})
