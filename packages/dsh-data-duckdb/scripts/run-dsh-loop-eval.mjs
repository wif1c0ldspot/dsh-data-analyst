#!/usr/bin/env node
/**
 * Core v1 dsh-loop eval driver (R4).
 *
 * Default (no `--live`): grades JSON `DshLoopTrace` fixtures from `--traces`
 * (a file or a directory of `*.json` files) through the same grader
 * (`gradeDshLoopTrace`). This is a CI-safe smoke path — it never
 * boots dsh or calls a model — and its report always carries
 * `"claim": "component-traces-only"` plus exit code 0, so CI can run it
 * without pretending a component-trace grade is the Core v1 number.
 *
 * `--live`: drives `runDshLoopQuestions` (packages/dsh-data-duckdb/src/dsh-loop-driver.ts)
 * against the exact 69-case core corpus (23 each for superstore,
 * online-retail and olist; see `dsh-loop-eval.ts`). A missing published core dataset blocks the run;
 * it is never skipped from the denominator. The resulting traces are graded
 * after passing through the closed dsh tool-dispatch pipeline. Exit code reflects the Core v1 gate:
 * sqlPassRate >= 0.8 AND chartPassRate >= 0.9 AND turnsPassRate >= 0.8 on the
 * runnable answerable set. A live run with zero chart-gradable cases
 * (chartPassRate === null) never satisfies the gate and exits 1 — an
 * untested chart claim is not a passing chart claim; only the non-live
 * component-traces path (which never claims Core v1) treats a null rate as
 * vacuously fine.
 *
 * Env:
 *   DSH_DATA_WORKSPACE       required; published dataset workspace root
 *   DEEPSEEK_API_KEY         required only when --live is set
 *   DSH_DSHLOOP_REPORT       optional; write the full JSON report here (else stdout)
 *   DSH_DSHLOOP_MAX_TURNS    optional; default 2 (Core v1 analyst-turn budget).
 *                            A non-finite or garbage value falls back to 2;
 *                            an explicit "0" or negative value is honored
 *                            as-is (the driver then calls the model zero
 *                            times, per finding #3).
 *   DSH_DSHLOOP_MAX_TOOL_CALLS  optional; default 12 (per analyst turn). A
 *                            non-finite, NaN, or non-positive value falls
 *                            back to 12 — it must never silently disable the
 *                            bound.
 *
 * Usage:
 *   node packages/dsh-data-duckdb/scripts/run-dsh-loop-eval.mjs --traces /tmp/traces.json
 *   DEEPSEEK_API_KEY=... node packages/dsh-data-duckdb/scripts/run-dsh-loop-eval.mjs --live
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MetadataStore } from '../../dsh-data-core/dist/metadata-store.js'
import { resolveWorkspacePaths } from '../../dsh-data-core/dist/workspace-paths.js'
import { HELD_OUT_CASES } from '../dist/nl-eval.js'
import {
  assertCoreDshLoopCoverage,
  countDshLoopCalls,
  coreDshLoopCases,
  gradeDshLoopTrace,
  summarizeDshLoopScores,
  summarizeDshLoopTelemetry,
} from '../dist/dsh-loop-eval.js'
import {
  DEFAULT_MAX_ANALYST_TURNS,
  DEFAULT_MAX_TOOL_CALLS_PER_TURN,
  assertProductionLoop,
  runDshLoopQuestions,
} from '../dist/dsh-loop-driver.js'

/**
 * Parse an optional env var as a number, falling back to `fallback` when the
 * variable is unset, empty, or does not parse to a finite number (including
 * NaN). Finite explicit values — including 0 or negative — are honored
 * as-is so an operator can deliberately request "call the model zero times".
 */
function parseNumericEnv(raw, fallback) {
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseArgs(argv) {
  const args = { live: false, traces: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--live') {
      args.live = true
    } else if (arg === '--traces') {
      args.traces = argv[i + 1]
      i += 1
    } else if (arg.startsWith('--traces=')) {
      args.traces = arg.slice('--traces='.length)
    }
  }
  return args
}

function loadTraces(tracesArg) {
  if (!tracesArg) return []
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

const args = parseArgs(process.argv.slice(2))

if (!process.env.DSH_DATA_WORKSPACE) {
  console.error('DSH_DATA_WORKSPACE is required (published dataset workspace root)')
  process.exit(2)
}

if (args.live && !process.env.DEEPSEEK_API_KEY) {
  console.error(
    '--live requires DEEPSEEK_API_KEY (the closed dsh-llm-deepseek adapter resolves it through the credentials seam, then the environment)',
  )
  process.exit(2)
}

const workspace = resolveWorkspacePaths()
const store = new MetadataStore(workspace.catalogPath)
const coreCases = coreDshLoopCases(HELD_OUT_CASES)
assertCoreDshLoopCoverage(coreCases)
let runnable
try {
  runnable = coreCases.filter((testCase) => store.getCurrentDatasetVersion(testCase.datasetId))
} finally {
  store.close()
}
const skipped = coreCases
  .filter((testCase) => !runnable.some((r) => r.id === testCase.id))
  .map((testCase) => ({
    id: testCase.id,
    datasetId: testCase.datasetId,
    reason: 'dataset not published',
  }))

let traces
let driver
let batchWallTimeMs

if (args.live) {
  if (runnable.length === 0) {
    console.error('No held-out datasets are published in this workspace')
    process.exit(2)
  }
  try {
    assertCoreDshLoopCoverage(runnable)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
  const maxAnalystTurns = parseNumericEnv(
    process.env.DSH_DSHLOOP_MAX_TURNS,
    DEFAULT_MAX_ANALYST_TURNS,
  )
  const maxToolCallsPerTurn = parseNumericEnv(
    process.env.DSH_DSHLOOP_MAX_TOOL_CALLS,
    DEFAULT_MAX_TOOL_CALLS_PER_TURN,
  )
  driver = {
    kind: 'closed-composition-tool-dispatch',
    module: 'dsh-data-duckdb/dsh-loop-driver.js#runDshLoopQuestions',
  }
  // Guard: the live driver's own kind label must never collapse into a
  // component-evidence generator name (nl-loop | http-sql | fixture).
  assertProductionLoop(driver.kind)
  const batchStartedAt = performance.now()
  traces = await runDshLoopQuestions({
    questions: runnable.map((testCase) => ({
      caseId: testCase.id,
      datasetId: testCase.datasetId,
      question: [
        testCase.question,
        'Return only the rows and measures requested. For a count or single total, return one scalar row. For top N, return exactly N rows. Stop exploring after a successful query answers the request.',
        ...(testCase.acceptableCharts
          ? ['Create an appropriate chart for the result before answering.']
          : []),
      ].join('\n\n'),
    })),
    maxAnalystTurns,
    maxToolCallsPerTurn,
  })
  batchWallTimeMs = performance.now() - batchStartedAt
} else {
  traces = loadTraces(args.traces)
  driver = { kind: 'component-traces', module: args.traces ? resolve(args.traces) : null }
}

const scores = []
for (const trace of traces) {
  const testCase = HELD_OUT_CASES.find((entry) => entry.id === trace.caseId)
  if (!testCase) {
    console.error(`Trace caseId "${trace.caseId}" does not match a HELD_OUT_CASES id; skipping`)
    continue
  }
  scores.push(gradeDshLoopTrace(trace, testCase))
}

const summary = summarizeDshLoopScores(scores)
const sqlPassRate = summary.sqlTotal === 0 ? null : summary.sqlPassed / summary.sqlTotal
const chartPassRate = summary.chartTotal === 0 ? null : summary.chartPassed / summary.chartTotal
const turnsPassRate = summary.turnsTotal === 0 ? null : summary.turnsPassed / summary.turnsTotal
const telemetrySummary = summarizeDshLoopTelemetry(traces)
const approvalInteractions = 0
const analystTurnsExcludingApprovals = traces.reduce(
  (total, trace) => total + trace.analystTurns,
  0,
)
const telemetryComplete =
  telemetrySummary.elapsedMeasuredCases === traces.length &&
  telemetrySummary.incompleteCallCountCases === 0 &&
  telemetrySummary.tokenUsageMissingCases === 0
const sqlOk = sqlPassRate !== null && sqlPassRate >= 0.8
const chartOk = chartPassRate !== null && chartPassRate >= 0.9
const turnsOk = turnsPassRate !== null && turnsPassRate >= 0.8
const accuracyGatePassed = sqlOk && chartOk && turnsOk
const releaseGatePassed = accuracyGatePassed && telemetryComplete

const report = {
  scores,
  ...(args.live ? { traces } : {}),
  summary: { ...summary, sqlPassRate, chartPassRate, turnsPassRate },
  telemetry: {
    ...telemetrySummary,
    perCase: traces.map((trace) => ({ caseId: trace.caseId, ...countDshLoopCalls(trace) })),
    ...(batchWallTimeMs === undefined ? {} : { batchWallTimeMs }),
    analystTurnsExcludingApprovals,
    approvalInteractions,
    analystTurnsIncludingApprovals: analystTurnsExcludingApprovals + approvalInteractions,
    complete: telemetryComplete,
  },
  driver,
  skipped,
  ...(args.live ? { accuracyGatePassed, telemetryComplete, releaseGatePassed } : {}),
  ...(args.live ? {} : { claim: 'component-traces-only' }),
}

const reportPath = process.env.DSH_DSHLOOP_REPORT
if (reportPath) {
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ reportPath, summary: report.summary, driver, skipped }, null, 2))
} else {
  console.log(JSON.stringify(report, null, 2))
}

if (!args.live) {
  // Component-traces-only path never fakes the Core v1 gate.
  process.exit(0)
}

// A live run makes the Core v1 claim, so a null (zero chart-gradable cases)
// rate must NOT pass — unlike the non-live component-traces path, which
// never reaches this branch (see the `!args.live` early exit above).
const exitCode = releaseGatePassed ? 0 : 1
if (exitCode !== 0) {
  console.error(
    JSON.stringify({
      exitCode,
      sqlOk,
      chartOk,
      turnsOk,
      accuracyGatePassed,
      telemetryComplete,
      releaseGatePassed,
      sqlPassRate,
      chartPassRate,
      turnsPassRate,
    }),
  )
}
process.exit(exitCode)
