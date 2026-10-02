/**
 * Grade real dsh tool traces against held-out eval cases.
 * Pure grader — no model, no SQL execution (preview compare only).
 */
import {
  gradeChartIntent,
  previewContainsExpectedMeasures,
  previewMatchesExpected,
  type ChartGradeContext,
  type EvalCase,
} from './nl-eval.js'

export const CORE_DSH_LOOP_DATASET_IDS = ['superstore', 'online-retail', 'olist'] as const

export function coreDshLoopCases(cases: readonly EvalCase[]): EvalCase[] {
  const coreIds = new Set<string>(CORE_DSH_LOOP_DATASET_IDS)
  return cases.filter((testCase) => coreIds.has(testCase.datasetId))
}

/**
 * Release scoring is valid only for the frozen production corpus. Originally
 * 20 cases x 3 datasets (60 total); each of the three core datasets was
 * extended with 3 more cases (distribution/comparison/trend archetypes), re-freezing
 * this at 23 x 3 (69 total). The prior 60/60 production-loop live result in
 * the internal verification record was measured against the smaller 60-case corpus and
 * remains valid for that corpus; it is not automatically a claim about the
 * 9 newly added cases, which still need their own live run.
 */
export function assertCoreDshLoopCoverage(cases: readonly EvalCase[]): void {
  const counts = new Map<string, number>()
  const caseIds = new Set<string>()
  for (const testCase of cases) {
    counts.set(testCase.datasetId, (counts.get(testCase.datasetId) ?? 0) + 1)
    caseIds.add(testCase.id)
  }
  const exact =
    cases.length === 69 &&
    caseIds.size === cases.length &&
    counts.size === CORE_DSH_LOOP_DATASET_IDS.length &&
    CORE_DSH_LOOP_DATASET_IDS.every((datasetId) => counts.get(datasetId) === 23)
  if (!exact) {
    throw new Error(
      `Core dsh-loop coverage must be exactly 69 cases (23 each for ${CORE_DSH_LOOP_DATASET_IDS.join(', ')}); got ${JSON.stringify(Object.fromEntries(counts))}`,
    )
  }
}

export type DshLoopOutcome = 'answer' | 'clarify' | 'refuse' | 'error'

export interface DshLoopToolCall {
  name: string
  args: Record<string, unknown>
  result: unknown
}

/** Provider-reported, mutually exclusive usage buckets from dsh token-meter. */
export interface DshLoopTokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface DshLoopTrace {
  caseId: string
  question: string
  datasetId: string
  /** Count of analyst (user) messages, not internal tool rounds. */
  analystTurns: number
  toolCalls: DshLoopToolCall[]
  /** False means these are only the calls observed before a failed turn. */
  toolCallsComplete?: boolean
  outcome: DshLoopOutcome
  finalText?: string
  elapsedMs?: number
  /** Absent when the production session projection was unavailable. */
  tokenUsage?: DshLoopTokenUsage
  errorMessage?: string
}

export interface DshLoopCallCounts {
  observedToolCalls: number
  /** Direct `duckdb_query` executions only. */
  duckdbQueryCalls: number
  /** Composite current/baseline executions through `investigate_metric`. */
  investigateMetricCalls: number
  complete: boolean
}

export function countDshLoopCalls(trace: DshLoopTrace): DshLoopCallCounts {
  return {
    observedToolCalls: trace.toolCalls.length,
    duckdbQueryCalls: trace.toolCalls.filter((call) => call.name === 'duckdb_query').length,
    investigateMetricCalls: trace.toolCalls.filter((call) => call.name === 'investigate_metric')
      .length,
    complete: trace.toolCallsComplete ?? trace.outcome !== 'error',
  }
}

export function summarizeDshLoopTelemetry(traces: readonly DshLoopTrace[]): {
  cases: number
  elapsedMeasuredCases: number
  summedQuestionElapsedMs: number
  observedToolCalls: number
  duckdbQueryCalls: number
  investigateMetricCalls: number
  completeCallCountCases: number
  incompleteCallCountCases: number
  tokenUsageMeasuredCases: number
  tokenUsageMissingCases: number
  tokenUsage: DshLoopTokenUsage
} {
  const tokenUsage: DshLoopTokenUsage = {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  let elapsedMeasuredCases = 0
  let summedQuestionElapsedMs = 0
  let observedToolCalls = 0
  let duckdbQueryCalls = 0
  let investigateMetricCalls = 0
  let completeCallCountCases = 0
  let tokenUsageMeasuredCases = 0

  for (const trace of traces) {
    if (trace.elapsedMs !== undefined) {
      elapsedMeasuredCases += 1
      summedQuestionElapsedMs += trace.elapsedMs
    }
    const counts = countDshLoopCalls(trace)
    observedToolCalls += counts.observedToolCalls
    duckdbQueryCalls += counts.duckdbQueryCalls
    investigateMetricCalls += counts.investigateMetricCalls
    if (counts.complete) completeCallCountCases += 1
    if (trace.tokenUsage !== undefined) {
      tokenUsageMeasuredCases += 1
      tokenUsage.uncachedInputTokens += trace.tokenUsage.uncachedInputTokens
      tokenUsage.outputTokens += trace.tokenUsage.outputTokens
      tokenUsage.cacheReadTokens += trace.tokenUsage.cacheReadTokens
      tokenUsage.cacheWriteTokens += trace.tokenUsage.cacheWriteTokens
    }
  }

  return {
    cases: traces.length,
    elapsedMeasuredCases,
    summedQuestionElapsedMs,
    observedToolCalls,
    duckdbQueryCalls,
    investigateMetricCalls,
    completeCallCountCases,
    incompleteCallCountCases: traces.length - completeCallCountCases,
    tokenUsageMeasuredCases,
    tokenUsageMissingCases: traces.length - tokenUsageMeasuredCases,
    tokenUsage,
  }
}

export interface DshLoopCaseScore {
  caseId: string
  datasetId: string
  sqlPass: boolean
  chartPass: boolean | null
  turnsPass: boolean
  analystTurns: number
  sql?: string
  chartIntent?: { mark: string; x?: string; y?: string }
  reason: string
}

function isToolError(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    (result as { error: unknown }).error !== undefined
  )
}

/**
 * Tool calls whose *result* can answer the analyst's question, i.e. carry a
 * `resultId`/`preview` a chart or SQL-correctness grade can be checked
 * against. `duckdb_query` is the primary/most common case; `find_top_n` and
 * `reconcile_totals` return the exact same `AuthorizedQuerySummary` shape
 * (see `queryObserveRender` reuse in plugin-tools.ts), and `investigate_metric`
 * returns a `{ current, baseline }` pair of that same shape (investigate.ts).
 * Before this fix, `gradeDshLoopTrace`/`extractChartIntent` only recognized
 * `duckdb_query`, so a case the model correctly answered via one of the other
 * three tools was graded `missing-query` (SQL) or lost its chart match
 * entirely, even when the chart/answer was genuinely correct.
 */
const ANSWER_TOOL_NAMES = [
  'duckdb_query',
  'find_top_n',
  'reconcile_totals',
  'investigate_metric',
] as const

function lastSuccessfulAnswerCall(trace: DshLoopTrace): DshLoopToolCall | undefined {
  for (let i = trace.toolCalls.length - 1; i >= 0; i--) {
    const call = trace.toolCalls[i]!
    if ((ANSWER_TOOL_NAMES as readonly string[]).includes(call.name) && !isToolError(call.result)) {
      return call
    }
  }
  return undefined
}

/**
 * Pull the plain column-name list out of an `AuthorizedQuerySummary`-shaped
 * `columns: Array<{ name, logicalType }>`, if present. Used to give the
 * chart grader the answer call's *actual* result columns (see
 * `chart-grader.ts`'s `reproducesRole`) instead of relying only on
 * name/alias lists.
 */
function resultColumnNames(value: unknown): readonly string[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const columns = (value as { columns?: unknown }).columns
  if (!Array.isArray(columns)) return undefined
  const names = columns
    .map((column) =>
      typeof column === 'object' && column !== null
        ? (column as { name?: unknown }).name
        : undefined,
    )
    .filter((name): name is string => typeof name === 'string')
  return names.length > 0 ? names : undefined
}

/**
 * Extract the `{ resultId, preview, resultColumns }` this answer-producing
 * call's result represents, normalizing across the four tool shapes above.
 * For `investigate_metric`, which returns a `current`/`baseline` pair, the
 * `current`-period result is treated as "the answer" — it is the query that
 * corresponds to the analyst's actual question (e.g. "why did revenue drop
 * this quarter" grades against the current quarter's result), while
 * `baseline` exists only as the comparison denominator, never the thing being
 * charted or preview-matched.
 */
function answerEvidenceFromCall(
  call: DshLoopToolCall,
): { resultId?: string; preview?: unknown; resultColumns?: readonly string[] } | undefined {
  const result = call.result
  if (typeof result !== 'object' || result === null) return undefined
  if (call.name === 'investigate_metric') {
    const current = (result as { current?: unknown }).current
    if (typeof current !== 'object' || current === null) return undefined
    const resultId = (current as { resultId?: unknown }).resultId
    const preview = (current as { preview?: unknown }).preview
    const resultColumns = resultColumnNames(current)
    return {
      ...(typeof resultId === 'string' ? { resultId } : {}),
      ...('preview' in (current as object) ? { preview } : {}),
      ...(resultColumns !== undefined ? { resultColumns } : {}),
    }
  }
  const resultId = (result as { resultId?: unknown }).resultId
  const preview = (result as { preview?: unknown }).preview
  const resultColumns = resultColumnNames(result)
  return {
    ...(typeof resultId === 'string' ? { resultId } : {}),
    ...('preview' in (result as object) ? { preview } : {}),
    ...(resultColumns !== undefined ? { resultColumns } : {}),
  }
}

/**
 * Build the chart grader's value-confirmation evidence from the case's own
 * expected result and the answer call's actual preview: the reviewed
 * `expectedPreview`'s first column is the dimension's expected values and
 * its last column is the measure's expected values (the golden's own
 * `SELECT dimension, ..., agg(...) AS measure` convention — see the
 * reconciliation cases, whose golden is `source, total` long-form, and the
 * top-n cases, whose golden carries an extra middle column that is neither
 * role). `columnValues` transposes the actual answer preview into
 * per-column arrays, keyed by the real result column names, so
 * `chart-grader.ts`'s `reproducesRole` can confirm a bound column actually
 * carries a role's expected values instead of inferring identity from where
 * the column sits. Returns `undefined` pieces (not corpus knowledge) when
 * either side of the evidence is unavailable, exactly like the
 * `resultColumns`-only context did before this changed.
 */
function buildChartGradeContext(
  testCase: EvalCase,
  resultColumns: readonly string[] | undefined,
  preview: unknown,
): ChartGradeContext | undefined {
  if (resultColumns === undefined) return undefined
  const expectedPreview = testCase.expectedPreview
  const roleValues =
    expectedPreview.length > 0
      ? {
          dimension: expectedPreview.map((row) => row[0]),
          measure: expectedPreview.map((row) => row[row.length - 1]),
        }
      : undefined

  let columnValues: Record<string, readonly unknown[]> | undefined
  if (Array.isArray(preview)) {
    columnValues = {}
    for (let column = 0; column < resultColumns.length; column++) {
      const columnName = resultColumns[column]!
      columnValues[columnName] = (preview as readonly unknown[][]).map((row) => row?.[column])
    }
  }

  return {
    resultColumns,
    ...(roleValues !== undefined ? { roleValues } : {}),
    ...(columnValues !== undefined ? { columnValues } : {}),
  }
}

export function extractQuerySql(trace: DshLoopTrace): string | undefined {
  const call = lastSuccessfulAnswerCall(trace)
  if (!call) return undefined
  // Only duckdb_query/investigate_metric carry a model-authored SQL string
  // in their args (find_top_n/reconcile_totals are structured-recipe calls
  // with no raw SQL text); sql stays undefined for those, same as before.
  const sql = call.name === 'investigate_metric' ? call.args.sqlCurrent : call.args.sql
  return typeof sql === 'string' ? sql : undefined
}

export function extractChartIntent(
  trace: DshLoopTrace,
): { mark: string; x?: string; y?: string } | undefined {
  const answerCall = lastSuccessfulAnswerCall(trace)
  const answerResultId = answerCall ? answerEvidenceFromCall(answerCall)?.resultId : undefined
  if (answerResultId === undefined) return undefined

  for (let i = trace.toolCalls.length - 1; i >= 0; i--) {
    const call = trace.toolCalls[i]!
    if (call.name !== 'make_chart') continue
    if (call.args.resultId !== answerResultId) continue
    if (
      isToolError(call.result) ||
      typeof call.result !== 'object' ||
      call.result === null ||
      typeof (call.result as { artifactId?: unknown }).artifactId !== 'string' ||
      (call.result as { artifactId: string }).artifactId.trim().length === 0
    ) {
      continue
    }
    const intent = call.args.intent
    if (typeof intent !== 'object' || intent === null) return undefined
    const { mark, x, y } = intent as { mark?: unknown; x?: unknown; y?: unknown }
    if (typeof mark !== 'string') return undefined
    return {
      mark,
      ...(typeof x === 'string' ? { x } : {}),
      ...(typeof y === 'string' ? { y } : {}),
    }
  }
  return undefined
}

export function gradeDshLoopTrace(trace: DshLoopTrace, testCase: EvalCase): DshLoopCaseScore {
  const sql = extractQuerySql(trace)
  const chartIntent = extractChartIntent(trace)
  const turnsPass = trace.outcome === 'answer' && trace.analystTurns <= 2

  let sqlPass = false
  let reason: string

  if (trace.outcome === 'clarify' || trace.outcome === 'refuse') {
    reason = trace.outcome
  } else {
    const answerCall = lastSuccessfulAnswerCall(trace)
    if (!answerCall) {
      // 'missing-query' now means "no successful call to any of the four
      // answer-producing tools", not just duckdb_query specifically.
      reason = 'missing-query'
    } else {
      const preview = answerEvidenceFromCall(answerCall)?.preview
      if (!Array.isArray(preview)) {
        reason = 'missing-preview'
      } else if (
        // Exact shape first: the common case's behavior is unchanged. Only
        // when that fails do we fall back to the measure-only subset match,
        // which accepts a differently-shaped-but-substantively-correct
        // result (see previewContainsExpectedMeasures's doc comment).
        previewMatchesExpected(preview as unknown[][], testCase.expectedPreview) ||
        previewContainsExpectedMeasures(preview as unknown[][], testCase.expectedPreview)
      ) {
        sqlPass = true
        reason = 'ok'
      } else {
        reason = 'preview-mismatch'
      }
    }
  }

  let chartPass: boolean | null = null
  if (testCase.acceptableCharts !== undefined) {
    // Re-derive the answer call's actual result columns and preview values
    // (not just the column names) so the grader can confirm a chart axis's
    // role *by value*, not only by name/alias or column position — see
    // `chart-grader.ts`'s `reproducesRole` and `buildChartGradeContext`.
    const answerCall = lastSuccessfulAnswerCall(trace)
    const answerEvidence = answerCall ? answerEvidenceFromCall(answerCall) : undefined
    const chartContext = buildChartGradeContext(
      testCase,
      answerEvidence?.resultColumns,
      answerEvidence?.preview,
    )
    chartPass =
      chartIntent !== undefined &&
      gradeChartIntent(chartIntent, testCase.acceptableCharts, chartContext)
  }

  return {
    caseId: testCase.id,
    datasetId: testCase.datasetId,
    sqlPass,
    chartPass,
    turnsPass,
    analystTurns: trace.analystTurns,
    ...(sql !== undefined ? { sql } : {}),
    ...(chartIntent !== undefined ? { chartIntent } : {}),
    reason,
  }
}

export function summarizeDshLoopScores(scores: readonly DshLoopCaseScore[]): {
  sqlPassed: number
  sqlTotal: number
  chartPassed: number
  chartTotal: number
  turnsPassed: number
  turnsTotal: number
} {
  let sqlPassed = 0
  let chartPassed = 0
  let chartTotal = 0
  let turnsPassed = 0

  for (const score of scores) {
    if (score.sqlPass) sqlPassed++
    if (score.chartPass !== null) {
      chartTotal++
      if (score.chartPass) chartPassed++
    }
    if (score.turnsPass) turnsPassed++
  }

  return {
    sqlPassed,
    sqlTotal: scores.length,
    chartPassed,
    chartTotal,
    turnsPassed,
    turnsTotal: scores.length,
  }
}
