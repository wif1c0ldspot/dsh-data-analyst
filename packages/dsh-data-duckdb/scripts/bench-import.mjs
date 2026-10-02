#!/usr/bin/env node
/**
 * Import throughput probe. Times fixture ingest → publish and
 * records elapsed + peak RSS. No network; uses tests/fixtures/retail.csv.
 *
 *   npm run bench:import
 */
import { createWriteStream } from 'node:fs'
import { cpus, freemem, totalmem } from 'node:os'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import * as yazl from 'yazl'
import { RETAIL_FIXTURE_RECIPE } from '../../dsh-data-core/dist/recipes/retail-fixture.js'
import { runIngestFromArchive } from '../dist/ingest-pipeline.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureCsvPath = join(repoRoot, 'tests/fixtures/retail.csv')
const directory = await mkdtemp(join(tmpdir(), 'dsh-bench-import-'))

async function buildArchive(destination) {
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(await readFile(fixtureCsvPath), 'retail.csv')
  const archivePath = join(destination, 'source.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return archivePath
}

const peak = { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed }
const sampler = setInterval(() => {
  const m = process.memoryUsage()
  peak.rss = Math.max(peak.rss, m.rss)
  peak.heapUsed = Math.max(peak.heapUsed, m.heapUsed)
}, 10)

try {
  const datasetWorkspace = join(directory, 'workspaces', 'retail-fixture')
  await mkdir(join(datasetWorkspace, 'sources'), { recursive: true })
  const archivePath = await buildArchive(directory)
  const archiveBytes = (await readFile(archivePath)).byteLength
  const csvBytes = (await readFile(fixtureCsvPath)).byteLength

  const started = performance.now()
  const result = await runIngestFromArchive({
    archivePath,
    workspaceDir: datasetWorkspace,
    catalogPath: join(directory, 'catalog.sqlite'),
    recipe: RETAIL_FIXTURE_RECIPE,
    slug: 'test/fixture-retail',
    sourceVersion: '1',
    idempotencyKey: `bench-import-${Date.now()}`,
  })
  const elapsedMs = performance.now() - started
  clearInterval(sampler)

  const rows = result.tables?.[0]?.rows ?? null
  const report = {
    ok: true,
    datasetId: result.datasetId ?? 'retail-fixture',
    datasetVersionId: result.datasetVersionId ?? null,
    elapsedMs,
    archiveBytes,
    csvBytes,
    rows,
    rowsPerSec: rows != null && elapsedMs > 0 ? rows / (elapsedMs / 1000) : null,
    peakRssBytes: peak.rss,
    peakHeapUsedBytes: peak.heapUsed,
    host: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model ?? null,
      totalMemBytes: totalmem(),
      freeMemBytes: freemem(),
    },
    timestamp: new Date().toISOString(),
  }
  console.log(JSON.stringify(report, null, 2))
  await writeFile('/tmp/dsh-bench-import.json', JSON.stringify(report, null, 2))
} catch (error) {
  clearInterval(sampler)
  console.error(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  )
  process.exitCode = 1
} finally {
  await rm(directory, { recursive: true, force: true })
}
