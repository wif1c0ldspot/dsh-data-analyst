#!/usr/bin/env node
/**
 * Narrative claim eval.
 *
 * Default: grade built-in synthetic baseline traces (CI-safe; not a live model run).
 * `--traces <file|dir>`: grade operator-supplied NarrativeTrace JSON.
 * `--live`: drive the pinned closed dsh composition via runDshLoopQuestions.
 *
 * Interpretation support stays pending unless claimAnnotations are present.
 * Do not treat component traces as a closed zero-unsupported-claims gate.
 *
 * Env:
 *   DSH_DATA_WORKSPACE     required for --live
 *   DEEPSEEK_API_KEY       required for --live
 *   DSH_NARRATIVE_REPORT   optional JSON report path
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  NARRATIVE_CASES,
  assertNarrativeCorpusCoverage,
  gradeNarrativeTrace,
  narrativeCaseById,
  summarizeNarrativeScores,
} from '../dist/narrative-eval.js'
import {
  DEFAULT_MAX_ANALYST_TURNS,
  DEFAULT_MAX_TOOL_CALLS_PER_TURN,
  assertProductionLoop,
  runDshLoopQuestions,
} from '../dist/dsh-loop-driver.js'

function parseArgs(argv) {
  const args = { live: false, traces: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--live') args.live = true
    else if (arg === '--traces') {
      args.traces = argv[i + 1]
      i += 1
    } else if (arg.startsWith('--traces=')) {
      args.traces = arg.slice('--traces='.length)
    }
  }
  return args
}

function loadTraces(tracesArg) {
  const target = resolve(tracesArg)
  if (!existsSync(target)) {
    console.error(`--traces path not found: ${target}`)
    process.exit(2)
  }
  const files = statSync(target).isDirectory()
    ? readdirSync(target)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => join(target, name))
    : [target]
  const traces = []
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    for (const trace of Array.isArray(parsed) ? parsed : [parsed]) traces.push(trace)
  }
  return traces
}

/** Synthetic baseline traces — not live model transcripts. */
function baselineFixtureTraces() {
  return NARRATIVE_CASES.map((testCase) => {
    const queryResult = {
      resultId: `res_${testCase.id}`,
      datasetVersionId: 'dv_retail_fixture',
      semanticRevisionId: 'sem_retail_fixture',
      preview: testCase.expectedPreview,
    }
    const toolCalls = [
      {
        name: 'duckdb_query',
        args: { datasetId: testCase.datasetId, sql: 'SELECT …', parameters: [] },
        result: queryResult,
      },
    ]
    if (testCase.requireCompletionReceipt) {
      toolCalls.push({
        name: 'export_analysis_report',
        args: {},
        result: { ready: true, downloads: ['report.html'], revision: 1 },
      })
    }

    const firstAnswerText =
      testCase.claimExpectation === 'unsupported'
        ? `Correct numbers. Withheld unsupported claim: ${testCase.unsupportedClaims[0] ?? 'unsupported'}`
        : `Supported finding: ${testCase.supportedClaims[0] ?? 'ok'}`

    const claimAnnotations =
      testCase.claimExpectation === 'unsupported'
        ? [
            {
              text:
                testCase.supportedClaims[0] ??
                'scoped factual summary without unsupported inference',
              supported: true,
              evidenceResultId: queryResult.resultId,
            },
          ]
        : [
            {
              text: testCase.supportedClaims[0] ?? 'supported claim',
              supported: true,
              evidenceResultId: queryResult.resultId,
            },
          ]

    return {
      caseId: testCase.id,
      question: testCase.question,
      datasetId: testCase.datasetId,
      analystTurns: 1,
      outcome: 'answer',
      firstAnswerText,
      refinementText: undefined,
      elapsedMs: 1,
      toolCalls,
      claimAnnotations,
    }
  })
}

/**
 * Known historical failure shapes from the internal verification record, recorded as
 * synthetic reproductions for the baseline (not live model output).
 */
function knownFailureReproductions() {
  const heavyTail = narrativeCaseById('narrative-heavy-tail-unsupported')
  const marginal = narrativeCaseById('narrative-marginal-vs-paired-unsupported')
  if (!heavyTail || !marginal) return []
  return [
    {
      label: 'credit-card-heavy-tail-from-mean-median',
      reproduced: true,
      note: 'heavy-tail inferred from mean/median despite correct numbers',
      caseId: heavyTail.id,
      claimAnnotations: [
        {
          text: 'Distribution is heavy-tailed because mean exceeds median',
          supported: false,
        },
      ],
    },
    {
      label: 'iris-marginal-to-joint-separation',
      reproduced: true,
      note: 'joint separation inferred from marginal ranges',
      caseId: marginal.id,
      claimAnnotations: [
        {
          text: 'Fields form separated clusters based on marginal ranges',
          supported: false,
        },
      ],
    },
  ]
}

const args = parseArgs(process.argv.slice(2))
assertNarrativeCorpusCoverage(NARRATIVE_CASES)

let traces
let driver
let batchWallTimeMs
let claim = 'synthetic-baseline-traces'

if (args.live) {
  if (!process.env.DSH_DATA_WORKSPACE) {
    console.error('DSH_DATA_WORKSPACE is required for --live')
    process.exit(2)
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('--live requires DEEPSEEK_API_KEY')
    process.exit(2)
  }
  claim = 'live-closed-composition'
  driver = {
    kind: 'closed-composition-tool-dispatch',
    module: 'dsh-data-duckdb/dsh-loop-driver.js#runDshLoopQuestions',
  }
  assertProductionLoop(driver.kind)
  const started = performance.now()
  const liveTraces = await runDshLoopQuestions({
    questions: NARRATIVE_CASES.map((testCase) => ({
      caseId: testCase.id,
      datasetId: testCase.datasetId,
      question: [
        testCase.question,
        'Ground every numeric claim in a query or recipe result with explicit scope.',
        'Do not infer heavy tails from mean/median alone, or joint structure from marginal ranges alone.',
        'Completion claims require a service receipt.',
      ].join('\n\n'),
    })),
    maxAnalystTurns: Number(process.env.DSH_DSHLOOP_MAX_TURNS) || DEFAULT_MAX_ANALYST_TURNS,
    maxToolCallsPerTurn:
      Number(process.env.DSH_DSHLOOP_MAX_TOOL_CALLS) || DEFAULT_MAX_TOOL_CALLS_PER_TURN,
  })
  batchWallTimeMs = performance.now() - started
  // Live traces lack claimAnnotations until human review — interpretation stays pending.
  // Persist full traces (answers + tool receipts) so operators can annotate and regrade.
  traces = liveTraces.map((trace) => ({
    ...trace,
    firstAnswerText: trace.finalText,
  }))
} else if (args.traces) {
  claim = 'component-traces-only'
  traces = loadTraces(args.traces)
  driver = { kind: 'component-traces', module: resolve(args.traces) }
} else {
  traces = baselineFixtureTraces()
  driver = { kind: 'synthetic-baseline', module: 'narrative-eval.js#baselineFixtureTraces' }
}

const scores = []
for (const trace of traces) {
  const testCase = narrativeCaseById(trace.caseId)
  if (!testCase) {
    console.error(`Unknown narrative caseId "${trace.caseId}"; skipping`)
    continue
  }
  scores.push(gradeNarrativeTrace(trace, testCase))
}

const summary = summarizeNarrativeScores(scores)
const knownFailures = knownFailureReproductions()
const report = {
  claim,
  driver,
  corpusSize: NARRATIVE_CASES.length,
  graded: scores.length,
  summary,
  knownFailures,
  batchWallTimeMs: batchWallTimeMs ?? null,
  scores,
  traces,
  cases: NARRATIVE_CASES.map((testCase) => ({
    id: testCase.id,
    category: testCase.category,
    claimExpectation: testCase.claimExpectation,
    humanRubric: testCase.humanRubric,
    supportedClaims: testCase.supportedClaims,
    unsupportedClaims: testCase.unsupportedClaims,
  })),
}

const reportPath = process.env.DSH_NARRATIVE_REPORT
if (reportPath) {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}
console.log(JSON.stringify(report, null, 2))

// Synthetic/component paths exit 0 when the corpus grades cleanly on deterministic axes.
// Live runs with pending interpretation do not close the zero-unsupported-claims gate.
const deterministicOk =
  summary.sqlPassed === summary.cases &&
  summary.provenancePassed === summary.cases &&
  (claim === 'live-closed-composition' || summary.interpretationFailed === 0)

if (claim === 'live-closed-composition') {
  // Live gate stays open until human annotations yield zero unsupported failures.
  const liveOk =
    summary.sqlPassed === summary.cases &&
    summary.provenancePassed === summary.cases &&
    (summary.interpretationPending === summary.cases ||
      (summary.interpretationFailed === 0 && summary.unsupportedClaimFailures === 0))
  process.exit(liveOk ? 0 : 1)
}
process.exit(deterministicOk ? 0 : 1)
