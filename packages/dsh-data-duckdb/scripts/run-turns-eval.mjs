#!/usr/bin/env node
/**
 * Measure analyst-turn budget on held-out cases (Core DoD ≤2 turns).
 * Fixture generator: every successful answer is 1 turn. HTTP: same when the
 * first generate→query succeeds (no repair loop yet).
 *
 *   DSH_DATA_WORKSPACE=datasets/dev npm run eval:turns
 *   DSH_NL_GENERATOR=http ... npm run eval:turns
 */
import { MetadataStore } from '../../dsh-data-core/dist/metadata-store.js'
import { resolveWorkspacePaths } from '../../dsh-data-core/dist/workspace-paths.js'
import { HELD_OUT_CASES } from '../dist/nl-eval.js'
import { runAnalystQuestion } from '../dist/nl-loop.js'
import { createOracleSqlGenerator, resolveHttpSqlGeneratorFromEnv } from '../dist/sql-generators.js'

const workspace = resolveWorkspacePaths()
const store = new MetadataStore(workspace.catalogPath)
let runnable
try {
  runnable = HELD_OUT_CASES.filter((c) => store.getCurrentDatasetVersion(c.datasetId))
} finally {
  store.close()
}
const limit = Number(process.env.HELD_OUT_LIMIT ?? '0')
if (Number.isFinite(limit) && limit > 0) runnable = runnable.slice(0, limit)

const mode = (process.env.DSH_NL_GENERATOR ?? 'oracle').toLowerCase()
const generator =
  mode === 'http' ? resolveHttpSqlGeneratorFromEnv() : createOracleSqlGenerator(runnable)

if (!generator) {
  console.error('No SQL generator resolved (use oracle default or DSH_NL_GENERATOR=http)')
  process.exit(2)
}

const results = []
for (const testCase of runnable) {
  process.stderr.write(`[turns ${results.length + 1}/${runnable.length}] ${testCase.id}\n`)
  try {
    const answer = await runAnalystQuestion({
      workspace,
      datasetId: testCase.datasetId,
      question: testCase.question,
      generator,
      priorTurns: 0,
    })
    if (answer.kind !== 'answer') {
      results.push({
        id: testCase.id,
        ok: false,
        analystTurns: answer.analystTurns,
        turnsRemaining: answer.turnsRemaining,
        error: `expected answer, got ${answer.kind}`,
      })
      continue
    }
    const withinBudget = answer.analystTurns <= 2
    results.push({
      id: testCase.id,
      ok: withinBudget,
      analystTurns: answer.analystTurns,
      turnsRemaining: answer.turnsRemaining,
      error: withinBudget ? undefined : `turns ${answer.analystTurns} > 2`,
    })
  } catch (error) {
    results.push({
      id: testCase.id,
      ok: false,
      analystTurns: null,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const graded = results.length
const passed = results.filter((r) => r.ok).length
const withinOne = results.filter((r) => r.analystTurns === 1).length
const report = {
  mode: mode === 'http' ? 'http' : 'oracle',
  graded,
  passed,
  failed: graded - passed,
  passRate: graded === 0 ? null : passed / graded,
  answeredInOneTurn: withinOne,
  oneTurnRate: graded === 0 ? null : withinOne / graded,
  maxAnalystTurnsAllowed: 2,
  results,
}
console.log(JSON.stringify(report, null, 2))
process.exit(passed === graded ? 0 : 1)
