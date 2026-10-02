#!/usr/bin/env node
/**
 * Warm NL latency probe (Core DoD C5). Times HTTP SQL generations against
 * published held-out questions. Does not grade correctness.
 *
 * Example:
 *   DSH_DATA_WORKSPACE=datasets/dev \
 *   DSH_NL_GENERATOR=http DSH_NL_API_BASE=http://127.0.0.1:11434/v1 \
 *   DSH_NL_API_KEY=ollama DSH_NL_MODEL=qwen3:8b \
 *   BENCH_NL_LIMIT=5 npm run bench:nl
 */
import { MetadataStore } from '../../dsh-data-core/dist/metadata-store.js'
import { formatRecipeSchemaSummary } from '../../dsh-data-core/dist/recipes/index.js'
import { getEffectiveSemantics } from '../../dsh-data-core/dist/semantics.js'
import { resolveWorkspacePaths } from '../../dsh-data-core/dist/workspace-paths.js'
import { HELD_OUT_CASES } from '../dist/nl-eval.js'
import { resolveHttpSqlGeneratorFromEnv } from '../dist/sql-generators.js'

const generator = resolveHttpSqlGeneratorFromEnv()
if (!generator) {
  console.error('Set DSH_NL_GENERATOR=http with API base/key/model')
  process.exit(2)
}

const workspace = resolveWorkspacePaths()
const store = new MetadataStore(workspace.catalogPath)
let cases
try {
  cases = HELD_OUT_CASES.filter((c) => store.getCurrentDatasetVersion(c.datasetId))
} finally {
  store.close()
}
const limit = Number(process.env.BENCH_NL_LIMIT ?? '5')
cases = cases.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 5)
if (cases.length === 0) {
  console.error('No published held-out datasets')
  process.exit(2)
}

const meta = new MetadataStore(workspace.catalogPath)
const samples = []
try {
  for (const testCase of cases) {
    const semantics = getEffectiveSemantics(testCase.datasetId, meta)
    const schemaSummary =
      formatRecipeSchemaSummary(testCase.datasetId, semantics?.aliases ?? []) ?? testCase.datasetId
    const started = performance.now()
    let ok = true
    let error
    try {
      await generator.generateSql({
        question: testCase.question,
        datasetId: testCase.datasetId,
        schemaSummary,
      })
    } catch (err) {
      ok = false
      error = err instanceof Error ? err.message : String(err)
    }
    const ms = performance.now() - started
    samples.push({ id: testCase.id, ok, ms, error })
    process.stderr.write(`[bench:nl] ${testCase.id} ${ms.toFixed(0)}ms ok=${ok}\n`)
  }
} finally {
  meta.close()
}

const times = samples
  .filter((s) => s.ok)
  .map((s) => s.ms)
  .sort((a, b) => a - b)
function percentile(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx]
}

const report = {
  model: process.env.DSH_NL_MODEL ?? null,
  apiBase: process.env.DSH_NL_API_BASE ?? null,
  sampleCount: samples.length,
  successCount: times.length,
  p50Ms: percentile(times, 50),
  p95Ms: percentile(times, 95),
  maxMs: times.length ? times[times.length - 1] : null,
  warmNlTargetMs: 30_000,
  warmNlTargetMet: percentile(times, 95) == null ? null : percentile(times, 95) < 30_000,
  samples,
}
console.log(JSON.stringify(report, null, 2))
process.exit(times.length === samples.length ? 0 : 1)
