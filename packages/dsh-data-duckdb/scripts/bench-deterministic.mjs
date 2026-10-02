#!/usr/bin/env node
/**
 * Deterministic chart-path performance probe: N iterations of fixed
 * Superstore sales-by-region SQL (isolated worker) + createChartArtifact.
 * Target: p95 deterministic chart path < 1s (see docs/architecture.md).
 */
import { cpus, arch, platform } from 'node:os'
import { createChartArtifact } from '../../dsh-data-viz/dist/chart-service.js'
import { MetadataStore } from '../../dsh-data-core/dist/metadata-store.js'
import { getEffectiveSemantics } from '../../dsh-data-core/dist/semantics.js'
import { resolveWorkspacePaths } from '../../dsh-data-core/dist/workspace-paths.js'
import { GOLDEN_CASES } from '../dist/nl-eval.js'
import { executeIsolatedQuery } from '../dist/query-worker.js'

const N = Number(process.env.DSH_BENCH_N ?? 20)
const CHART_P95_TARGET_MS = 1000
const DATASET_ID = 'superstore'
const CASE = GOLDEN_CASES.find((c) => c.id === 'superstore-sales-by-region')
if (!CASE) throw new Error('missing golden case superstore-sales-by-region')

function percentile(samples, p) {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]
}

const workspace = resolveWorkspacePaths()
const store = new MetadataStore(workspace.catalogPath)
let manifest
let semantics
try {
  manifest = store.getCurrentDatasetVersion(DATASET_ID)
  semantics = getEffectiveSemantics(DATASET_ID, store)
} finally {
  store.close()
}

if (!manifest || !semantics) {
  console.error(
    JSON.stringify({
      ok: false,
      skipped: true,
      reason: `dataset "${DATASET_ID}" not published in ${workspace.root}`,
    }),
  )
  process.exit(2)
}

const queryMs = []
const chartMs = []

for (let i = 0; i < N; i++) {
  const q0 = performance.now()
  const summary = await executeIsolatedQuery({
    datasetPath: workspace.datasetFile(manifest.datasetVersionId, manifest.datasetId),
    datasetVersionId: manifest.datasetVersionId,
    semanticRevisionId: semantics.semanticRevisionId,
    sql: CASE.goldenSql,
    parameters: [],
    allowedTables: manifest.tables.map((table) => table.id),
    resultStoreDir: workspace.resultsDir,
  })
  queryMs.push(performance.now() - q0)

  const x = summary.columns[0]?.name
  const y = summary.columns[1]?.name
  if (!x || !y) {
    throw new Error(`expected two columns for chart; got ${JSON.stringify(summary.columns)}`)
  }

  const c0 = performance.now()
  await createChartArtifact({
    resultId: summary.resultId,
    intent: {
      mark: 'bar',
      title: CASE.question,
      x,
      y,
      sort: { field: y, direction: 'descending' },
    },
    resultStoreDir: workspace.resultsDir,
    artifactStoreDir: workspace.artifactsDir,
  })
  chartMs.push(performance.now() - c0)
}

const chartP95 = percentile(chartMs, 95)
const report = {
  ok: true,
  iterations: N,
  datasetId: DATASET_ID,
  datasetVersionId: manifest.datasetVersionId,
  semanticRevisionId: semantics.semanticRevisionId,
  sqlCaseId: CASE.id,
  timestamp: new Date().toISOString(),
  queryMs: {
    p50: percentile(queryMs, 50),
    p95: percentile(queryMs, 95),
    samples: queryMs.map((ms) => Math.round(ms * 100) / 100),
  },
  chartMs: {
    p50: percentile(chartMs, 50),
    p95: chartP95,
    samples: chartMs.map((ms) => Math.round(ms * 100) / 100),
  },
  target: {
    chartP95Ms: CHART_P95_TARGET_MS,
    chartPathPass: chartP95 !== null && chartP95 < CHART_P95_TARGET_MS,
  },
  hardware: {
    platform: platform(),
    arch: arch(),
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? null,
  },
  workspaceRoot: workspace.root,
}

console.log(JSON.stringify(report, null, 2))
process.exit(report.target.chartPathPass ? 0 : 1)
