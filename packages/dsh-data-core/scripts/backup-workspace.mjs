#!/usr/bin/env node
/**
 * Operator backup: copy catalog (+ WAL/SHM if present), results/, artifacts/,
 * and published dataset.duckdb files only. Does not copy staging DuckDB/WAL.
 *
 * Usage: node packages/dsh-data-core/scripts/backup-workspace.mjs <workspaceRoot> <backupDir>
 *
 * For a consistent snapshot, pause metadata writers / ingest before running.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const workspaceRootArg = process.argv[2]
const backupDirArg = process.argv[3]

if (!workspaceRootArg || !backupDirArg) {
  console.error('Usage: backup-workspace.mjs <workspaceRoot> <backupDir>')
  process.exit(2)
}

const workspaceRoot = resolve(workspaceRootArg)
const backupDir = resolve(backupDirArg)

console.error(
  'Note: pause catalog/ingest writers before backup for a consistent SQLite snapshot. ' +
    'Staging DuckDB/WAL is intentionally excluded; only published dataset.duckdb files are copied.',
)

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function ensureParent(filePath) {
  await mkdir(dirname(filePath), { recursive: true })
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

async function copyIntoBackup(absPath, relPath, files) {
  const dest = join(backupDir, relPath)
  await ensureParent(dest)
  await copyFile(absPath, dest)
  let sha256 = null
  if (basename(relPath) === 'catalog.sqlite') {
    sha256 = await sha256File(absPath)
  }
  files.push({
    relativePath: relPath.split(/[/\\]/).join('/'),
    bytes: (await stat(absPath)).size,
    sha256,
  })
}

async function copyTreeIfPresent(absDir, relBase, files) {
  if (!(await pathExists(absDir))) return
  const entries = await readdir(absDir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = join(absDir, entry.name)
    const rel = join(relBase, entry.name)
    if (entry.isDirectory()) {
      await copyTreeIfPresent(abs, rel, files)
    } else if (entry.isFile()) {
      await copyIntoBackup(abs, rel, files)
    }
  }
}

/**
 * Copy workspaces/<datasetId>/datasets/<versionId>/dataset.duckdb only.
 * Never staging/, sources/, or *.wal under staging.
 */
async function copyPublishedDatasets(files) {
  const workspacesDir = join(workspaceRoot, 'workspaces')
  if (!(await pathExists(workspacesDir))) return 0
  let datasetCount = 0
  const datasetIds = await readdir(workspacesDir, { withFileTypes: true })
  for (const datasetEntry of datasetIds) {
    if (!datasetEntry.isDirectory()) continue
    const datasetsDir = join(workspacesDir, datasetEntry.name, 'datasets')
    if (!(await pathExists(datasetsDir))) continue
    const versions = await readdir(datasetsDir, { withFileTypes: true })
    for (const versionEntry of versions) {
      if (!versionEntry.isDirectory()) continue
      const duckdbPath = join(datasetsDir, versionEntry.name, 'dataset.duckdb')
      if (!(await pathExists(duckdbPath))) continue
      const rel = join(
        'workspaces',
        datasetEntry.name,
        'datasets',
        versionEntry.name,
        'dataset.duckdb',
      )
      await copyIntoBackup(duckdbPath, rel, files)
      datasetCount += 1
    }
  }
  return datasetCount
}

if (await pathExists(backupDir)) {
  const existing = await readdir(backupDir)
  if (existing.length > 0) {
    console.error(`Backup directory is not empty: ${backupDir}`)
    process.exit(1)
  }
}

await mkdir(backupDir, { recursive: true })

const files = []
const catalogPath = join(workspaceRoot, 'catalog.sqlite')
if (!(await pathExists(catalogPath))) {
  console.error(`Missing catalog.sqlite under ${workspaceRoot}`)
  process.exit(1)
}

await copyIntoBackup(catalogPath, 'catalog.sqlite', files)
for (const suffix of ['-wal', '-shm']) {
  const side = `${catalogPath}${suffix}`
  if (await pathExists(side)) {
    await copyIntoBackup(side, `catalog.sqlite${suffix}`, files)
  }
}

await copyTreeIfPresent(join(workspaceRoot, 'results'), 'results', files)
await copyTreeIfPresent(join(workspaceRoot, 'artifacts'), 'artifacts', files)
const datasetCount = await copyPublishedDatasets(files)

const catalogEntry = files.find((entry) => entry.relativePath === 'catalog.sqlite')
const manifest = {
  createdAt: new Date().toISOString(),
  workspaceRoot,
  catalogSha256: catalogEntry?.sha256 ?? null,
  datasetCount,
  files: files.map((entry) => ({
    relativePath: entry.relativePath,
    bytes: entry.bytes,
    sha256: entry.sha256,
  })),
}

await writeFile(
  join(backupDir, 'backup-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)

console.log(
  JSON.stringify(
    {
      ok: true,
      backupDir,
      catalogSha256: manifest.catalogSha256,
      datasetCount,
      fileCount: files.length,
    },
    null,
    2,
  ),
)
