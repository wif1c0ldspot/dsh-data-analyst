#!/usr/bin/env node
/**
 * Operator ingest CLI: download (optional) → validate → stage → publish.
 * Never invoked with credentials from a model or analyst request. Usage:
 *   node packages/dsh-data-core/scripts/ingest-dataset.mjs superstore
 *   node packages/dsh-data-core/scripts/ingest-dataset.mjs superstore --skip-download
 *   node packages/dsh-data-core/scripts/ingest-dataset.mjs retail-fixture --archive path/to.zip
 */
import { mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import { runKaggleDownload } from '../../dsh-data-kaggle/dist/download-adapter.js'
import { downloadDestinationForSlug } from '../../dsh-data-kaggle/dist/download-job.js'
import { runFixedQuery } from '../../dsh-data-duckdb/dist/fixed-query.js'
import { runIngestFromArchive } from '../../dsh-data-duckdb/dist/ingest-pipeline.js'
import { openMetadataStore } from '../dist/catalog.js'
import { resolveReviewedSource } from '../dist/recipes/registry.js'
import { resolveWorkspacePaths } from '../dist/workspace-paths.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const recipeName = process.argv[2]
const args = new Set(process.argv.slice(3))
const skipDownload = args.has('--skip-download')
const archiveArgIndex = process.argv.indexOf('--archive')
const archiveOverride =
  archiveArgIndex >= 0 ? resolve(process.argv[archiveArgIndex + 1] ?? '') : undefined

const recipes = {
  superstore: {
    smokeSql:
      'SELECT region, round(SUM(sales), 2) AS revenue FROM orders GROUP BY region ORDER BY revenue DESC, region',
    expected: [
      ['West', '725457.82'],
      ['East', '678781.24'],
      ['Central', '501239.89'],
      ['South', '391721.91'],
    ],
  },
  'online-retail': {
    smokeSql:
      'SELECT country, COUNT(*) AS line_items FROM online_retail GROUP BY country ORDER BY line_items DESC, country LIMIT 5',
    expected: [
      ['United Kingdom', '981330'],
      ['EIRE', '17866'],
      ['Germany', '17624'],
      ['France', '14330'],
      ['Netherlands', '5140'],
    ],
  },
  olist: {
    smokeSql:
      "SELECT 'category_translation' AS table_id, COUNT(*) AS rows FROM category_translation UNION ALL SELECT 'customers', COUNT(*) FROM customers UNION ALL SELECT 'geolocation', COUNT(*) FROM geolocation UNION ALL SELECT 'order_items', COUNT(*) FROM order_items UNION ALL SELECT 'order_payments', COUNT(*) FROM order_payments UNION ALL SELECT 'order_reviews', COUNT(*) FROM order_reviews UNION ALL SELECT 'orders', COUNT(*) FROM orders UNION ALL SELECT 'products', COUNT(*) FROM products UNION ALL SELECT 'sellers', COUNT(*) FROM sellers ORDER BY table_id",
    expected: [
      ['category_translation', '71'],
      ['customers', '99441'],
      ['geolocation', '1000163'],
      ['order_items', '112650'],
      ['order_payments', '103886'],
      ['order_reviews', '100000'],
      ['orders', '99441'],
      ['products', '32951'],
      ['sellers', '3095'],
    ],
  },
  'retail-fixture': {
    smokeSql:
      'SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region ORDER BY revenue DESC, region',
    expected: [
      ['North', '80.00'],
      ['South', '50.00'],
    ],
  },
  'olist-mini': {
    smokeSql:
      'SELECT order_status, COUNT(*) AS orders FROM orders GROUP BY order_status ORDER BY orders DESC, order_status',
    expected: [
      ['delivered', '2'],
      ['canceled', '1'],
      ['shipped', '1'],
      ['unavailable', '1'],
    ],
  },
}

if (!recipeName || !(recipeName in recipes)) {
  console.error(
    'Usage: ingest-dataset.mjs <superstore|online-retail|olist|olist-mini|retail-fixture> [--skip-download] [--archive path.zip]',
  )
  process.exit(2)
}

const selected = recipes[/** @type {keyof typeof recipes} */ (recipeName)]
const pin = resolveReviewedSource(recipeName)
const workspace = resolveWorkspacePaths()
const workspaceDir = join(workspace.root, 'workspaces', pin.recipe.datasetId)
const catalogPath = workspace.catalogPath
const downloadDir = downloadDestinationForSlug(workspace.sourcesDir, pin.slug, pin.sourceVersion)
const kaggleExecutable = process.env.KAGGLE_EXECUTABLE
  ? resolve(process.env.KAGGLE_EXECUTABLE)
  : resolve(repoRoot, 'tools/kaggle-cli/.venv/bin/kaggle')

await mkdir(workspaceDir, { recursive: true })
await mkdir(downloadDir, { recursive: true })

{
  const store = openMetadataStore(catalogPath)
  store.close()
}

let archivePath = archiveOverride
if (!archivePath) {
  if (!skipDownload && pin.requiresDownload) {
    const startedAt = Date.now()
    const download = await runKaggleDownload(
      { slug: pin.slug, sourceVersion: pin.sourceVersion, destinationDir: downloadDir },
      { kaggleExecutable, timeoutMs: 10 * 60 * 1000 },
    )
    if (download.exitCode !== 0) {
      console.error(`kaggle download failed (${download.exitCode})`)
      console.error(download.stderr)
      process.exit(1)
    }
    console.error(
      `downloaded ${download.datasetRef} in ${Date.now() - startedAt}ms (sourceVersion=${download.sourceVersion})`,
    )
  }
  const entries = await readdir(downloadDir)
  const zipName = entries.find((name) => name.toLowerCase().endsWith('.zip'))
  if (!zipName) {
    console.error(`No .zip found under ${downloadDir}; download first or pass --archive`)
    process.exit(1)
  }
  archivePath = join(downloadDir, zipName)
}

const ingestAbort = new AbortController()
for (const event of ['SIGINT', 'SIGTERM']) {
  process.on(event, () => {
    ingestAbort.abort()
  })
}

const result = await runIngestFromArchive({
  archivePath,
  workspaceDir,
  catalogPath,
  recipe: pin.recipe,
  slug: pin.slug,
  sourceVersion: pin.sourceVersion,
  idempotencyKey: `${pin.recipe.datasetId}:${pin.sourceVersion}:${pin.recipe.recipeHash}`,
  signal: ingestAbort.signal,
})

const reader = await DuckDBInstance.create(result.datasetPath, {
  access_mode: 'READ_ONLY',
  enable_external_access: 'false',
})
const connection = await reader.connect()
let smoke
try {
  smoke = await runFixedQuery(connection, selected.smokeSql)
} finally {
  connection.closeSync()
  reader.closeSync()
}

const ok =
  JSON.stringify(smoke.rows) === JSON.stringify(selected.expected) &&
  result.tables.every((table) => table.rejectedRows === 0)

console.log(
  JSON.stringify(
    {
      ok,
      datasetId: result.datasetId,
      datasetVersionId: result.datasetVersionId,
      datasetPath: result.datasetPath,
      tables: result.tables,
      files: result.files,
      smoke: smoke.rows,
      expected: selected.expected,
    },
    null,
    2,
  ),
)
process.exit(ok ? 0 : 1)
