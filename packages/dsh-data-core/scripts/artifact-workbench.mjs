#!/usr/bin/env node
/**
 * Loopback artifact workbench: an interim fallback surface.
 * Serves already-authorized SVG artifacts from the operator workspace over
 * 127.0.0.1 only — no auth yet, no model-authored HTML, no path escape outside
 * the artifacts directory. Not a substitute for the dsh client plugin spike;
 * it proves downloadable/visible charts exist before that seam is closed.
 *
 *   node packages/dsh-data-core/scripts/artifact-workbench.mjs
 */
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { resolveWorkspacePaths } from '../dist/workspace-paths.js'

const workspace = resolveWorkspacePaths()
const artifactsRoot = resolve(workspace.artifactsDir)
const host = process.env.DSH_ARTIFACT_BIND ?? '127.0.0.1'
const port = Number(process.env.DSH_ARTIFACT_PORT ?? 8787)

function safeArtifactPath(idOrFile) {
  const base =
    idOrFile.endsWith('.svg') || idOrFile.endsWith('.json') ? idOrFile : `${idOrFile}.svg`
  if (base.includes('..') || base.includes('/') || base.includes('\\') || base.includes('\0')) {
    return null
  }
  const candidate = resolve(join(artifactsRoot, base))
  if (candidate !== artifactsRoot && !candidate.startsWith(artifactsRoot + sep)) return null
  return candidate
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const entries = await readdir(artifactsRoot).catch(() => [])
      const svgs = entries
        .filter((name) => name.endsWith('.svg'))
        .sort()
        .reverse()
      const list = svgs
        .map(
          (name) =>
            `<li><a href="/artifact/${encodeURIComponent(name)}">${name}</a> · <a href="/download/${encodeURIComponent(name)}">download</a></li>`,
        )
        .join('\n')
      const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>dsh-data-analyst artifacts</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;margin:2rem;max-width:52rem;line-height:1.45}
h1{font-size:1.25rem}code{font-size:.9em}ul{padding-left:1.2rem}</style></head>
<body>
<h1>Artifact workbench (loopback)</h1>
<p>Serving <code>${artifactsRoot}</code> on <code>http://${host}:${port}</code>. This is the ADR 001 interim surface — not the dsh client plugin.</p>
<ul>${list || '<li>No SVG artifacts yet. Run a make_chart tool call first.</li>'}</ul>
</body></html>`
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
      return
    }

    const download = url.pathname.match(/^\/download\/([^/]+)$/)
    const view = url.pathname.match(/^\/artifact\/([^/]+)$/)
    const match = download ?? view
    if (!match) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    const path = safeArtifactPath(decodeURIComponent(match[1]))
    if (!path) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Invalid artifact id')
      return
    }
    const info = await stat(path)
    if (!info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Missing artifact')
      return
    }
    const type =
      extname(path) === '.svg'
        ? 'image/svg+xml; charset=utf-8'
        : extname(path) === '.json'
          ? 'application/json; charset=utf-8'
          : 'application/octet-stream'
    /** @type {Record<string, string>} */
    const headers = {
      'content-type': type,
      'content-length': String(info.size),
      'cache-control': 'no-store',
    }
    if (download) {
      headers['content-disposition'] = `attachment; filename="${path.split(sep).pop()}"`
    }
    res.writeHead(200, headers)
    createReadStream(path).pipe(res)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(error instanceof Error ? error.message : String(error))
  }
})

server.listen(port, host, () => {
  console.log(`Artifact workbench listening on http://${host}:${port}/`)
  console.log(`Artifacts root: ${artifactsRoot}`)
})
