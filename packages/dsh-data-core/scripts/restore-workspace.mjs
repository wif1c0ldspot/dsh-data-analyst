#!/usr/bin/env node
/**
 * Operator restore: materialize a backup into a new empty destination directory.
 *
 * Usage: node packages/dsh-data-core/scripts/restore-workspace.mjs <backupDir> <destinationDir>
 *
 * Refuses to write into a non-empty destination. Does not promote over a live
 * workspace — restore beside production, then swap after verification.
 */
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const backupDirArg = process.argv[2]
const destinationArg = process.argv[3]

if (!backupDirArg || !destinationArg) {
  console.error('Usage: restore-workspace.mjs <backupDir> <destinationDir>')
  process.exit(2)
}

const backupDir = resolve(backupDirArg)
const destinationDir = resolve(destinationArg)

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

const manifestPath = join(backupDir, 'backup-manifest.json')
if (!(await pathExists(manifestPath))) {
  console.error(`Missing backup-manifest.json in ${backupDir}`)
  process.exit(1)
}

let manifest
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
} catch (error) {
  console.error(`Invalid backup-manifest.json: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

if (!manifest || !Array.isArray(manifest.files)) {
  console.error('backup-manifest.json must include a files array')
  process.exit(1)
}

if (await pathExists(destinationDir)) {
  const existing = await readdir(destinationDir)
  if (existing.length > 0) {
    console.error(`Destination is not empty (refuse restore): ${destinationDir}`)
    process.exit(1)
  }
} else {
  await mkdir(destinationDir, { recursive: true })
}

for (const entry of manifest.files) {
  const rel = entry.relativePath
  if (
    typeof rel !== 'string' ||
    rel.includes('..') ||
    rel.startsWith('/') ||
    rel.startsWith('\\')
  ) {
    console.error(`Refusing unsafe relativePath: ${String(rel)}`)
    process.exit(1)
  }
  const source = join(backupDir, rel)
  const dest = join(destinationDir, rel)
  if (!(await pathExists(source))) {
    console.error(`Missing backup file: ${rel}`)
    process.exit(1)
  }
  await ensureParent(dest)
  await copyFile(source, dest)
}

await writeFile(
  join(destinationDir, 'restore-receipt.json'),
  `${JSON.stringify(
    {
      restoredAt: new Date().toISOString(),
      fromBackup: backupDir,
      catalogSha256: manifest.catalogSha256 ?? null,
      datasetCount: manifest.datasetCount ?? null,
      fileCount: manifest.files.length,
    },
    null,
    2,
  )}\n`,
  'utf8',
)

console.log(
  JSON.stringify(
    {
      ok: true,
      destinationDir,
      catalogSha256: manifest.catalogSha256 ?? null,
      datasetCount: manifest.datasetCount ?? null,
      fileCount: manifest.files.length,
    },
    null,
    2,
  ),
)
