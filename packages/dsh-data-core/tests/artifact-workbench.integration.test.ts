import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolveWorkspacePaths } from '../src/workspace-paths.js'

/** Same path rules as packages/dsh-data-core/scripts/artifact-workbench.mjs */
function resolveSafeArtifact(artifactsRoot: string, idOrFile: string): string | null {
  const base =
    idOrFile.endsWith('.svg') || idOrFile.endsWith('.json') ? idOrFile : `${idOrFile}.svg`
  if (base.includes('..') || base.includes('/') || base.includes('\\') || base.includes('\0')) {
    return null
  }
  const candidate = resolve(join(artifactsRoot, base))
  if (candidate !== artifactsRoot && !candidate.startsWith(artifactsRoot + sep)) return null
  return candidate
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-artifact-workbench-'))
  await mkdir(join(directory, 'artifacts'), { recursive: true })
  await writeFile(
    join(directory, 'artifacts', 'art_demo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><title>demo</title></svg>',
    'utf8',
  )
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('resolves workspace artifact paths and rejects traversal', () => {
  const workspace = resolveWorkspacePaths(directory)
  expect(resolveSafeArtifact(workspace.artifactsDir, 'art_demo.svg')).toBe(
    resolve(join(workspace.artifactsDir, 'art_demo.svg')),
  )
  expect(resolveSafeArtifact(workspace.artifactsDir, '../secrets.svg')).toBeNull()
  expect(resolveSafeArtifact(workspace.artifactsDir, 'foo/bar.svg')).toBeNull()
})

it('serves an SVG over loopback and rejects path escape', async () => {
  const artifactsDir = join(directory, 'artifacts')
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const match = url.pathname.match(/^\/artifact\/([^/]+)$/)
    if (!match) {
      res.writeHead(404)
      res.end()
      return
    }
    const path = resolveSafeArtifact(artifactsDir, decodeURIComponent(match[1]!))
    if (!path) {
      res.writeHead(400)
      res.end('bad')
      return
    }
    const body = await readFile(path)
    res.writeHead(200, { 'content-type': 'image/svg+xml' })
    res.end(body)
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  try {
    const ok = await fetch(`http://127.0.0.1:${address.port}/artifact/art_demo.svg`)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('<svg')
    const denied = await fetch(
      `http://127.0.0.1:${address.port}/artifact/${encodeURIComponent('../x.svg')}`,
    )
    expect(denied.status).toBe(400)
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    )
  }
})
