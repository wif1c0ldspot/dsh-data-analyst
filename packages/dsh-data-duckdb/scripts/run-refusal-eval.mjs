#!/usr/bin/env node
/**
 * Clarification/refusal corpus (Core v1 DoD minima).
 * Default: grade deterministic ask-path classifier (`policy`).
 * DSH_NL_GENERATOR=http: also grade model clarify|refuse labels.
 * DSH_NL_GENERATOR=corpus: print corpus only (no grading).
 */
import { getWorkspaceBaseSemantics } from '../../dsh-data-core/dist/semantics.js'
import { CLARIFICATION_CASES, HELD_OUT_CASES, REFUSAL_CASES } from '../dist/nl-eval.js'
import { classifyAnalystQuestion } from '../dist/question-intent.js'
import { resolveHttpClarifyRefuseGeneratorFromEnv } from '../dist/sql-generators.js'

const counts = {
  clarify: CLARIFICATION_CASES.filter((c) => c.expected === 'clarify').length,
  refuse: CLARIFICATION_CASES.filter((c) => c.expected === 'refuse').length,
}

const base = {
  count: CLARIFICATION_CASES.length,
  counts,
  aliasSame: REFUSAL_CASES === CLARIFICATION_CASES,
  cases: CLARIFICATION_CASES,
}

const knownDatasetIds = [...new Set(HELD_OUT_CASES.map((testCase) => testCase.datasetId))]

const mode = (process.env.DSH_NL_GENERATOR ?? 'policy').toLowerCase()
if (mode === 'corpus') {
  console.log(JSON.stringify({ mode: 'corpus', ...base }, null, 2))
  process.exit(0)
}

if (mode === 'policy' || mode === 'fixture' || mode === 'echo') {
  const results = CLARIFICATION_CASES.map((testCase) => {
    const actual = classifyAnalystQuestion(testCase.question, {
      datasetId: testCase.datasetId,
      knownDatasetIds,
      semantics:
        testCase.datasetId === undefined
          ? undefined
          : getWorkspaceBaseSemantics(testCase.datasetId),
    })
    const ok = actual === testCase.expected
    return {
      id: testCase.id,
      ok,
      expected: testCase.expected,
      actual,
      question: testCase.question,
      error: ok ? undefined : `expected ${testCase.expected}, got ${actual}`,
    }
  })
  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  const report = {
    mode: 'policy',
    ...base,
    graded: results.length,
    passed,
    failed,
    passRate: results.length === 0 ? null : passed / results.length,
    results,
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(failed === 0 ? 0 : 1)
}

if (mode !== 'http') {
  console.error(`Unsupported DSH_NL_GENERATOR="${mode}". Use policy (default), corpus, or http.`)
  process.exit(2)
}

const generator = resolveHttpClarifyRefuseGeneratorFromEnv()
if (!generator) {
  console.error('DSH_NL_GENERATOR=http but clarify/refuse generator unresolved')
  process.exit(2)
}

const results = []
for (const testCase of CLARIFICATION_CASES) {
  process.stderr.write(
    `[refusal ${results.length + 1}/${CLARIFICATION_CASES.length}] ${testCase.id}\n`,
  )
  try {
    const actual = await generator.classify({ question: testCase.question })
    const ok = actual === testCase.expected
    results.push({
      id: testCase.id,
      ok,
      expected: testCase.expected,
      actual,
      question: testCase.question,
      error: ok ? undefined : `expected ${testCase.expected}, got ${actual}`,
    })
  } catch (error) {
    results.push({
      id: testCase.id,
      ok: false,
      expected: testCase.expected,
      question: testCase.question,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
const report = {
  mode: 'http',
  ...base,
  graded: results.length,
  passed,
  failed,
  passRate: results.length === 0 ? null : passed / results.length,
  results,
}
console.log(JSON.stringify(report, null, 2))
process.exit(failed === 0 ? 0 : 1)
