import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

it('ships an installable dsh bundle whose rows resolve through package exports', async () => {
  const root = resolve(import.meta.dirname, '..')
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
    name: string
    exports: Record<string, string>
    dsh: { bundle: { patch: string }; client: { platform: string } }
  }
  expect(manifest.name).toBe('dsh-data-analyst')
  expect(manifest.dsh.client.platform).toBe('web')
  const patches = loadOverlayPatches(
    'plugin-bundle-test',
    resolve(root, manifest.dsh.bundle.patch),
  ) as Array<{ insert?: Array<{ name?: string }> }>
  const names = patches.flatMap((patch) => patch.insert ?? []).map((row) => row.name)
  expect(names).toEqual([
    'dsh-data-analyst/duckdb',
    'dsh-data-analyst/kaggle',
    'dsh-data-analyst',
    'dsh-data-analyst/workbench',
  ])
  for (const subpath of ['.', './duckdb', './kaggle', './viz', './workbench', './client']) {
    expect(manifest.exports[subpath]).toBeTruthy()
  }
})
