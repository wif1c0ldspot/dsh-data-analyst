/**
 * Regression test for the client-face identity mismatch (docs/implementation.md,
 * "Client bundle build step" 2026-09-20 correction).
 *
 * `packages/dsh-data-viz/client.js` hardcodes `id: 'dsh-data-analyst'` and its own
 * contract comment says the registration id "MUST be the package name
 * (`dsh-data-analyst`)": a mismatched id is never materialized by the browser's
 * `__ModuleLoader__`. Two invariants keep that true:
 *   1. Exactly one package.json in this repo declares a `dsh.client` face for
 *      any given physical client bundle file (no duplicate owners to disagree
 *      about the id).
 *   2. For a real boot, the module-graph entry id that serves a client file
 *      equals the `id` literal the file itself declares.
 *
 * Before the fix: `packages/dsh-data-viz/package.json` also declared
 * `dsh.client` + `exports['./client']` for the same `client.js`, and the
 * `DSH_DATA_PRODUCT_COMPOSITION=webapp` dev-boot composition's loader row
 * pointed straight into `packages/dsh-data-viz/dist/index.js` — client-face
 * discovery walks up to the *nearest* ancestor `package.json`, found
 * `dsh-data-viz`'s (not root's), and served the entry under id `dsh-data-viz`
 * while the file itself registered `dsh-data-analyst`: invariant 1 and 2 both
 * failed. Reproduced live in a browser as "Failed to load plugins — ... loaded
 * without registering \"dsh-data-viz\" via `__ModuleLoader__.load`".
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { expect, it } from 'vitest'
import {
  analystSurfacePackageNames,
  installClosedAnalystPreset,
  linkPackagesForPresetMount,
  resolveProductCompositionPatchPaths,
} from '../scripts/product-composition.mjs'

const root = resolve(import.meta.dirname, '..')

interface DshClientManifest {
  name: string
  dsh?: { client?: { platform?: string } }
  exports?: Record<string, unknown>
}

function clientExportRel(manifest: DshClientManifest): string | undefined {
  const value = manifest.exports?.['./client']
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    for (const candidate of Object.values(value as Record<string, unknown>)) {
      if (typeof candidate === 'string') return candidate
    }
  }
  return undefined
}

it('declares each dsh.client face from exactly one package.json', async () => {
  const packageNames = await readdir(join(root, 'packages'))
  const candidateDirs = [root, ...packageNames.map((name) => join(root, 'packages', name))]

  const owners = new Map<string, string[]>() // resolved client file -> declaring package names
  for (const dir of candidateDirs) {
    let raw: string
    try {
      raw = await readFile(join(dir, 'package.json'), 'utf8')
    } catch {
      continue
    }
    const manifest = JSON.parse(raw) as DshClientManifest
    if (manifest.dsh?.client?.platform !== 'web') continue
    const rel = clientExportRel(manifest)
    expect(rel, `${manifest.name} declares dsh.client but no exports['./client']`).toBeTruthy()
    const resolved = resolve(dir, rel!)
    const list = owners.get(resolved) ?? []
    list.push(manifest.name)
    owners.set(resolved, list)
  }

  expect(owners.size).toBeGreaterThan(0)
  for (const [file, names] of owners) {
    expect(names, `${file} must be declared by exactly one package.json`).toHaveLength(1)
  }

  // The specific file this bug involved must still exist and be owned by root only.
  const vizClientPath = resolve(root, 'packages/dsh-data-viz/client.js')
  expect(owners.get(vizClientPath)).toEqual(['dsh-data-analyst'])
})

it('materializes the webapp dev-boot composition client entry under its declared id', async () => {
  const label = 'client-face-identity-test'
  const directory = await mkdtemp(join(tmpdir(), 'dsh-client-face-identity-'))
  const home = join(directory, 'home')
  await mkdir(home, { recursive: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, '[]\n', 'utf8')

  try {
    await installClosedAnalystPreset(home)
    await linkPackagesForPresetMount(directory, await analystSurfacePackageNames())

    const patchPaths = resolveProductCompositionPatchPaths({ forceProduct: true })
    const patches = patchPaths.flatMap((path) => loadOverlayPatches(label, path))

    const ctx = await boot(label, configPath, patches, (hostCtx) => {
      provideCmdline(hostCtx, {
        args: ['--no-open', '--port', '0', '--host', '127.0.0.1'],
        exit: () => {},
      })
    })

    try {
      const clientModules = ctx.get('clientModules') as {
        graph(): { entries?: Array<{ id: string }> } | Array<{ id: string }>
        clientPath(id: string): string | undefined
      }
      const graph = clientModules.graph()
      const entries = Array.isArray(graph) ? graph : (graph.entries ?? [])
      expect(entries.length).toBeGreaterThan(0)

      const vizClientPath = resolve(root, 'packages/dsh-data-viz/client.js')
      const matches = entries.filter((entry) => {
        const p = clientModules.clientPath(entry.id)
        return p !== undefined && resolve(p) === vizClientPath
      })
      expect(
        matches,
        'exactly one graph entry must serve packages/dsh-data-viz/client.js',
      ).toHaveLength(1)

      const entry = matches[0]!
      const source = await readFile(vizClientPath, 'utf8')
      const declaredId = source.match(/id:\s*'([^']+)'/)?.[1]
      expect(declaredId).toBeTruthy()
      expect(entry.id, 'loader entry name must equal the id the client module registers').toBe(
        declaredId,
      )
      expect(entry.id).toBe('dsh-data-analyst')
    } finally {
      await ctx.fiber.dispose()
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
