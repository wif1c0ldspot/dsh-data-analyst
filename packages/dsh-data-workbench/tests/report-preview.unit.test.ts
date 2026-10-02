import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { handleReportRequest } from '../src/report-fetch.js'

it('previews only generated HTML with the same restrictive sandbox and keeps downloads attached', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'report-preview-'))
  const file = 'export_0123456789abcdef0123456789abcdef.html'
  try {
    await writeFile(join(directory, file), '<h1>Report</h1>')
    const preview = await handleReportRequest(
      new Request(`http://localhost/api/analyst/reports?file=${file}&preview=1`),
      directory,
    )
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-disposition')).toMatch(/^inline;/)
    expect(preview.headers.get('content-security-policy')).toContain("sandbox; default-src 'none'")
    expect(await preview.text()).toBe('<h1>Report</h1>')
    const download = await handleReportRequest(
      new Request(`http://localhost/api/analyst/reports?file=${file}`),
      directory,
    )
    expect(download.headers.get('content-disposition')).toMatch(/^attachment;/)
    const invalid = await handleReportRequest(
      new Request(
        `http://localhost/api/analyst/reports?file=${file.replace('.html', '.svg')}&preview=1`,
      ),
      directory,
    )
    expect(invalid.status).toBe(400)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('downloads a generated dashboard ZIP without treating it as an SVG basename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'report-zip-'))
  const file = 'export_0123456789abcdef0123456789abcdef.zip'
  try {
    await writeFile(join(directory, file), Buffer.from('PK\u0003\u0004fixture'))
    const response = await handleReportRequest(
      new Request(`http://localhost/api/analyst/reports?file=${file}`),
      directory,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('PK\u0003\u0004fixture')
    expect(
      (
        await handleReportRequest(
          new Request(`http://localhost/api/analyst/reports?file=${file}&preview=1`),
          directory,
        )
      ).status,
    ).toBe(400)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
