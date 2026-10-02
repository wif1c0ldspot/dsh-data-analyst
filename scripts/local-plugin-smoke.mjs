#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const patchPath = resolve(root, manifest.dsh?.bundle?.patch ?? '')
const patches = loadOverlayPatches('dsh-data-analyst-local-plugin-smoke', patchPath)
const inserted = patches
  .flatMap((patch) => (Array.isArray(patch.insert) ? patch.insert : []))
  .map((row) => row.name)

const expected = [
  'dsh-data-analyst/duckdb',
  'dsh-data-analyst/kaggle',
  'dsh-data-analyst',
  'dsh-data-analyst/workbench',
]
for (const name of expected) {
  if (!inserted.includes(name)) throw new Error(`Bundle patch does not insert ${name}`)
  const loaded = await import(name)
  if (typeof loaded.apply !== 'function') throw new Error(`${name} does not export apply()`)
}

console.log(JSON.stringify({ ok: true, package: manifest.name, patchPath, plugins: expected }))
