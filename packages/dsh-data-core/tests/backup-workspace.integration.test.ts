/**
 * Backup → restore round-trip on a tiny temp workspace (catalog, result,
 * artifact, published dataset path). Staging must not be copied.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'

const scriptsDir = fileURLToPath(new URL('../scripts', import.meta.url))
const backupScript = join(scriptsDir, 'backup-workspace.mjs')
const restoreScript = join(scriptsDir, 'restore-workspace.mjs')

let workspaceDir: string
let backupDir: string
let restoreDir: string

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'dsh-ws-'))
  backupDir = await mkdtemp(join(tmpdir(), 'dsh-bak-'))
  restoreDir = join(tmpdir(), `dsh-rst-${Date.now()}-${Math.random().toString(16).slice(2)}`)

  await writeFile(join(workspaceDir, 'catalog.sqlite'), Buffer.from('sqlite-fake-catalog-v1'))
  await writeFile(join(workspaceDir, 'catalog.sqlite-wal'), Buffer.from('wal'))
  await mkdir(join(workspaceDir, 'results'), { recursive: true })
  await writeFile(join(workspaceDir, 'results', 'res_demo.json'), '{"ok":true}\n', 'utf8')
  await mkdir(join(workspaceDir, 'artifacts'), { recursive: true })
  await writeFile(join(workspaceDir, 'artifacts', 'art_demo.svg'), '<svg/>\n', 'utf8')

  const published = join(
    workspaceDir,
    'workspaces',
    'retail-fixture',
    'datasets',
    'retail-fixture-v1',
  )
  await mkdir(published, { recursive: true })
  await writeFile(join(published, 'dataset.duckdb'), Buffer.from('duckdb-published'))

  const staging = join(workspaceDir, 'workspaces', 'retail-fixture', 'staging')
  await mkdir(staging, { recursive: true })
  await writeFile(join(staging, 'staging.duckdb'), Buffer.from('duckdb-staging-secret'))
  await writeFile(join(staging, 'staging.duckdb.wal'), Buffer.from('staging-wal'))
})

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true })
  await rm(backupDir, { recursive: true, force: true })
  await rm(restoreDir, { recursive: true, force: true })
})

function runNode(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  })
}

it('backs up catalog/results/artifacts/published datasets and restores to empty dir', async () => {
  const backup = runNode(backupScript, [workspaceDir, backupDir])
  expect(backup.status, backup.stderr + backup.stdout).toBe(0)

  const manifest = JSON.parse(await readFile(join(backupDir, 'backup-manifest.json'), 'utf8')) as {
    catalogSha256: string
    datasetCount: number
    files: Array<{ relativePath: string; sha256: string | null }>
  }
  const expectedCatalogSha = createHash('sha256')
    .update(Buffer.from('sqlite-fake-catalog-v1'))
    .digest('hex')
  expect(manifest.catalogSha256).toBe(expectedCatalogSha)
  expect(manifest.datasetCount).toBe(1)
  expect(manifest.files.map((f) => f.relativePath).sort()).toEqual(
    [
      'artifacts/art_demo.svg',
      'catalog.sqlite',
      'catalog.sqlite-wal',
      'results/res_demo.json',
      'workspaces/retail-fixture/datasets/retail-fixture-v1/dataset.duckdb',
    ].sort(),
  )
  expect(manifest.files.some((f) => f.relativePath.includes('staging'))).toBe(false)

  const restore = runNode(restoreScript, [backupDir, restoreDir])
  expect(restore.status, restore.stderr + restore.stdout).toBe(0)

  expect(await readFile(join(restoreDir, 'catalog.sqlite'))).toEqual(
    Buffer.from('sqlite-fake-catalog-v1'),
  )
  expect(await readFile(join(restoreDir, 'results', 'res_demo.json'), 'utf8')).toContain('"ok"')
  expect(await readFile(join(restoreDir, 'artifacts', 'art_demo.svg'), 'utf8')).toContain('<svg')
  expect(
    await readFile(
      join(
        restoreDir,
        'workspaces',
        'retail-fixture',
        'datasets',
        'retail-fixture-v1',
        'dataset.duckdb',
      ),
    ),
  ).toEqual(Buffer.from('duckdb-published'))

  await expect(readdir(join(restoreDir, 'workspaces', 'retail-fixture'))).resolves.toEqual([
    'datasets',
  ])

  const refuse = runNode(restoreScript, [backupDir, restoreDir])
  expect(refuse.status).not.toBe(0)
  expect(refuse.stderr).toMatch(/not empty/i)
})
