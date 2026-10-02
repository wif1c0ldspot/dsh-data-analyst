#!/usr/bin/env node
/**
 * One-shot diagnostic: boot dsh-base + dsh-web-app + closed production profile
 * (+ optional overlays) and print the exact pending/failed activation list.
 *
 * Usage:
 *   node scripts/diagnose-webapp-activation.mjs
 *   node scripts/diagnose-webapp-activation.mjs --with-nl
 *   node scripts/diagnose-webapp-activation.mjs --with-nl --with-product path/to/overlay.yml
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const args = new Set(process.argv.slice(2))

function patchPath(rel) {
  return join(root, rel)
}

function basePatchPath() {
  return require
    .resolve('@deepseek-ai/dsh-base/package.json')
    .replace(/package\.json$/, 'cordis.patch.yml')
}

function webPatchPath() {
  return require
    .resolve('@deepseek-ai/dsh-web-app/package.json')
    .replace(/package\.json$/, 'cordis.patch.yml')
}

const label = 'diagnose-webapp-activation'
const directory = await mkdtemp(join(tmpdir(), 'dsh-diagnose-webapp-'))
const home = join(directory, 'home')
await mkdir(home, { recursive: true })
process.env.DSH_HOME = home
const configPath = join(directory, 'cordis.yml')
await writeFile(configPath, '[]\n', 'utf8')

const paths = [basePatchPath(), webPatchPath(), patchPath('profiles/data-analyst/cordis.patch.yml')]
if (args.has('--with-nl')) {
  paths.push(patchPath('tests/fixtures/cordis-overlays/cordis.nl-session.candidate.patch.yml'))
}
const productIdx = process.argv.indexOf('--with-product')
if (productIdx >= 0 && process.argv[productIdx + 1]) {
  paths.push(join(root, process.argv[productIdx + 1]))
}

const patches = paths.flatMap((path) => loadOverlayPatches(label, path))

try {
  const ctx = await boot(label, configPath, patches, (hostCtx) => {
    provideCmdline(hostCtx, {
      args: ['--no-open', '--port', '0', '--host', '127.0.0.1'],
      exit: () => {},
    })
  })
  const names =
    ctx.tools
      ?.schemas()
      .map((t) => t.name)
      .sort() ?? []
  console.log('BOOT OK')
  console.log('host tools:', names.join(', '))
  await ctx.fiber.dispose()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.log('BOOT FAILED')
  console.log(message)
  process.exitCode = 1
} finally {
  await rm(directory, { recursive: true, force: true })
}
