#!/usr/bin/env node
/**
 * Held-out Core v1 eval path.
 * - Default: grade reviewed goldenSql for HELD_OUT_CASES (reference correctness)
 *   plus chart appropriateness for cases with acceptableCharts (reference intents).
 * - DSH_NL_GENERATOR=http: also grade model-generated SQL and model chart intents
 *   via the same harness. Chart corpus intents remain reported separately when
 *   model chart grading runs.
 * - DSH_NL_GENERATOR=oracle: maps questions to reviewed goldenSql (harness wiring
 *   only — generatedPassRate is NOT a Core v1 model score).
 * Unpublished datasets are skipped (not scored) so a Core-only workspace can run
 * without retail-fixture, and CI can publish only the synthetic slice.
 */
import { writeFileSync } from 'node:fs'
import { MetadataStore } from '../../dsh-data-core/dist/metadata-store.js'
import { formatRecipeSchemaSummary } from '../../dsh-data-core/dist/recipes/index.js'
import { getEffectiveSemantics } from '../../dsh-data-core/dist/semantics.js'
import { resolveWorkspacePaths } from '../../dsh-data-core/dist/workspace-paths.js'
import {
  HELD_OUT_CASES,
  runChartAppropriatenessEval,
  runGeneratedSqlEval,
  runGoldenEval,
} from '../dist/nl-eval.js'
import {
  getHttpTokenUsage,
  resetHttpTokenUsage,
  resolveHttpChartIntentGeneratorFromEnv,
  resolveHttpSqlGeneratorFromEnv,
} from '../dist/sql-generators.js'

resetHttpTokenUsage()
const workspace = resolveWorkspacePaths()
const store = new MetadataStore(workspace.catalogPath)
let runnable
try {
  runnable = HELD_OUT_CASES.filter((testCase) => store.getCurrentDatasetVersion(testCase.datasetId))
} finally {
  store.close()
}

const limitRaw = process.env.HELD_OUT_LIMIT
if (limitRaw) {
  const limit = Number(limitRaw)
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error(`Invalid HELD_OUT_LIMIT=${limitRaw}`)
    process.exit(2)
  }
  runnable = runnable.slice(0, limit)
}

const skipped = HELD_OUT_CASES.filter(
  (testCase) => !runnable.some((r) => r.id === testCase.id),
).map((testCase) => ({
  id: testCase.id,
  datasetId: testCase.datasetId,
  reason: 'dataset not published',
}))

if (runnable.length === 0) {
  console.error('No held-out datasets are published in this workspace')
  process.exit(2)
}

const reference = process.env.HELD_OUT_SKIP_REFERENCE === '1' ? null : await runGoldenEval(runnable)
const chartReference =
  process.env.HELD_OUT_SKIP_REFERENCE === '1' ? null : await runChartAppropriatenessEval(runnable)
const mode = (process.env.DSH_NL_GENERATOR ?? 'reference').toLowerCase()
const skipModelSql = process.env.HELD_OUT_SKIP_MODEL_SQL === '1'

let generated = null
let chartModel = null
if (mode === 'http') {
  if (!skipModelSql) {
    const generator = resolveHttpSqlGeneratorFromEnv()
    if (!generator) {
      console.error('DSH_NL_GENERATOR=http but no generator resolved')
      process.exit(2)
    }
    generated = await runGeneratedSqlEval(runnable, generator)
  }
  const chartGenerator = resolveHttpChartIntentGeneratorFromEnv()
  if (chartGenerator) {
    const meta = new MetadataStore(workspace.catalogPath)
    try {
      const chartCases = runnable.filter((c) => c.acceptableCharts && c.acceptableCharts.length > 0)
      process.stderr.write(`[heldout chart] grading ${chartCases.length} model chart intents\n`)
      chartModel = await runChartAppropriatenessEval(runnable, {
        intentForCase: async (testCase) => {
          const semantics = getEffectiveSemantics(testCase.datasetId, meta)
          const schemaSummary =
            formatRecipeSchemaSummary(testCase.datasetId, semantics?.aliases ?? []) ??
            `dataset=${testCase.datasetId}`
          // Pace local Ollama; concurrent/rapid calls often surface as bare "fetch failed".
          await new Promise((resolve) => setTimeout(resolve, 250))
          try {
            return await chartGenerator.generateChartIntent({
              question: testCase.question,
              datasetId: testCase.datasetId,
              schemaSummary,
            })
          } catch (error) {
            const cause =
              error instanceof Error && 'cause' in error && error.cause
                ? ` cause=${String(error.cause)}`
                : ''
            throw new Error(`${error instanceof Error ? error.message : String(error)}${cause}`)
          }
        },
      })
    } finally {
      meta.close()
    }
  }
} else if (mode === 'oracle') {
  // Harness wiring only — maps questions to reviewed goldenSql. Not a Core v1 model score.
  const { createOracleSqlGenerator } = await import('../dist/sql-generators.js')
  generated = await runGeneratedSqlEval(runnable, createOracleSqlGenerator(runnable))
}

const byDataset = Object.fromEntries(
  [...new Set(runnable.map((c) => c.datasetId))].map((datasetId) => [
    datasetId,
    runnable.filter((c) => c.datasetId === datasetId).length,
  ]),
)

const report = {
  mode,
  skipped,
  skipModelSql,
  reference,
  chart: chartReference,
  chartModel,
  generated,
  heldOutCount: HELD_OUT_CASES.length,
  runnableCount: runnable.length,
  byDataset,
  chartCaseCount: chartReference?.graded ?? chartModel?.graded ?? 0,
  referencePassRate:
    !reference || reference.results.length === 0
      ? null
      : reference.passed / reference.results.length,
  chartPassRate: chartReference?.passRate ?? null,
  chartModelPassRate: chartModel?.passRate ?? null,
  generatedPassRate:
    !generated || generated.results.length === 0
      ? null
      : generated.passed / generated.results.length,
  httpTokenUsage: getHttpTokenUsage(),
}

const reportPath = process.env.DSH_HELDOUT_REPORT ?? '/tmp/dsh-heldout-report.json'
writeFileSync(reportPath, JSON.stringify(report, null, 2))
console.log(
  JSON.stringify(
    {
      reportPath,
      runnableCount: report.runnableCount,
      referencePassRate: report.referencePassRate,
      chartPassRate: report.chartPassRate,
      generatedPassRate: report.generatedPassRate,
      chartModelPassRate: report.chartModelPassRate,
      httpTokenUsage: report.httpTokenUsage,
    },
    null,
    2,
  ),
)
// Full detail remains on disk; avoid truncating huge JSON in terminal captures.
if (process.env.DSH_HELDOUT_PRINT_FULL === '1') {
  console.log(JSON.stringify(report, null, 2))
}

const referenceOk = !reference || reference.failed === 0
const chartOk = !chartReference || chartReference.failed === 0
const generatedOk = generated ? generated.failed === 0 : true
const chartModelOk = chartModel ? chartModel.passRate !== null && chartModel.passRate >= 0.9 : true
// Model chart gate (≥90%) is part of Core DoD when chartModel is present.
const exitCode = referenceOk && chartOk && generatedOk && chartModelOk ? 0 : 1
if (exitCode !== 0) {
  console.error(
    JSON.stringify({
      exitCode,
      referenceOk,
      chartOk,
      generatedOk,
      chartModelOk,
      generatedPassRate: report.generatedPassRate,
      chartModelPassRate: report.chartModelPassRate,
      httpTokenUsage: report.httpTokenUsage,
    }),
  )
}
process.exit(exitCode)
