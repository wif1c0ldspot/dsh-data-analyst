#!/usr/bin/env node
// Operator CLI (not a model tool): runs one real kaggle_download through the
// same fixed-argv adapter the tool will eventually call, then reports a
// manifest-shaped summary (source, files, sha256, bytes) as local evidence.
// Requires operator-configured Kaggle credentials (~/.kaggle); never invoked
// with credentials from a model or analyst request. Usage:
//   node packages/dsh-data-kaggle/scripts/download-smoke.mjs <owner/slug> <version> [destDir]
import { createHash } from 'node:crypto'
import { readdir, readFile, mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runKaggleDownload } from '../dist/download-adapter.js'

const slug = process.argv[2]
const sourceVersion = process.argv[3]
if (!slug || !sourceVersion) {
  console.error('Usage: download-smoke.mjs <owner/slug> <version> [destDir]')
  process.exit(2)
}
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const destinationDir = resolve(
  repoRoot,
  process.argv[4] ?? `datasets/dev/sources/${slug.replace('/', '__')}`,
)
const kaggleExecutable = resolve(repoRoot, 'tools/kaggle-cli/.venv/bin/kaggle')

await mkdir(destinationDir, { recursive: true })

const startedAt = Date.now()
const result = await runKaggleDownload(
  { slug, sourceVersion, destinationDir },
  { kaggleExecutable, timeoutMs: 10 * 60 * 1000 },
)
const elapsedMs = Date.now() - startedAt

if (result.exitCode !== 0) {
  console.error(`kaggle datasets download exited ${result.exitCode}`)
  console.error(result.stderr)
  process.exit(1)
}

const entries = await readdir(destinationDir)
const files = []
for (const name of entries) {
  const path = join(destinationDir, name)
  const info = await stat(path)
  if (!info.isFile()) continue
  const bytes = await readFile(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  files.push({ name, bytes: info.size, sha256 })
}

console.log(
  JSON.stringify(
    {
      source: {
        slug,
        version: result.sourceVersion,
        datasetRef: result.datasetRef,
        retrievedAt: new Date(startedAt).toISOString(),
        elapsedMs,
      },
      destinationDir,
      files,
    },
    null,
    2,
  ),
)
