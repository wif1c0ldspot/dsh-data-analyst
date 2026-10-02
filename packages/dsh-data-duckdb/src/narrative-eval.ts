/**
 * Frozen narrative claim corpus.
 *
 * Deterministic axes score typed SQL/recipe previews, provenance and completion
 * receipts. Interpretation support is never decided by keyword matching or a
 * second model: humans judge claims against the frozen oracle and record
 * annotations on traces. Distinguishes wrong SQL from unsupported prose.
 */
import { previewMatchesExpected } from './nl-eval.js'
import type { DshLoopTrace, DshLoopToolCall } from './dsh-loop-eval.js'
import type { AnalyticalRecipeInput } from './analytical-recipes.js'

export type NarrativeRubricCategory =
  | 'heavy-tail'
  | 'marginal-vs-paired'
  | 'full-row-duplicates-vs-transactions'
  | 'percent-vs-percentage-points'
  | 'denominator-null-scope'
  | 'filtered-or-limited-vs-population'
  | 'exact-decimals'
  | 'completion-receipts'

export type NarrativeClaimExpectation = 'supported' | 'unsupported'

export interface NarrativeOracleRecipe {
  kind: AnalyticalRecipeInput['kind']
  /** Exact preview cells from an independent recipe calculation. */
  expectedPreview: unknown[][]
}

export interface NarrativeCase {
  id: string
  datasetId: string
  question: string
  category: NarrativeRubricCategory
  /** Whether a truthful first answer may assert the target claim family. */
  claimExpectation: NarrativeClaimExpectation
  /** Human checklist: what must be true for a claim to count as supported. */
  humanRubric: readonly string[]
  /**
   * Supported positive claims the answer may make when grounded in the oracle.
   * Empty for unsupported-negative cases that only test refusals.
   */
  supportedClaims: readonly string[]
  /**
   * Claims that remain unsupported even when SQL is correct.
   */
  unsupportedClaims: readonly string[]
  /** Golden preview for the answer query (SQL correctness axis). */
  expectedPreview: unknown[][]
  /** Optional independent recipe oracle for descriptive/distribution facts. */
  recipeOracle?: NarrativeOracleRecipe
  /** When true, require a save/export/dashboard readiness receipt in tool results. */
  requireCompletionReceipt?: boolean
}

/** Annotated claim extracted from a first answer for human or fixture review. */
export interface NarrativeClaimAnnotation {
  text: string
  /** Human or fixture judgment against the frozen oracle — not auto-derived. */
  supported: boolean
  evidenceResultId?: string
}

export interface NarrativeTrace extends DshLoopTrace {
  /** First-answer body before any refinement turn. */
  firstAnswerText?: string
  /** Optional refinement turn text (recorded separately from first answer). */
  refinementText?: string
  /** Human/fixture claim judgments; required to close interpretationPass. */
  claimAnnotations?: NarrativeClaimAnnotation[]
}

export interface NarrativeCaseScore {
  caseId: string
  datasetId: string
  category: NarrativeRubricCategory
  claimExpectation: NarrativeClaimExpectation
  /** Successful query evidence present (preview returned). */
  sqlPass: boolean
  /** Preview matched expected SQL/recipe oracle cells. */
  oraclePass: boolean
  provenancePass: boolean
  receiptPass: boolean | null
  /**
   * null = awaiting human review annotations.
   * false = annotated unsupported claims present.
   */
  interpretationPass: boolean | null
  reason: string
  unsupportedAnnotatedClaims: string[]
  firstAnswerRecorded: boolean
  refinementRecorded: boolean
  elapsedMs?: number
  observedToolCalls: number
  evidenceResultIds: string[]
}

/** Retail-fixture region totals from SYNTHETIC_GOLDEN_CASES. */
const RETAIL_BY_REGION: unknown[][] = [
  ['North', '80.00'],
  ['South', '50.00'],
]

const RETAIL_NORTH_ONLY: unknown[][] = [
  ['North', '-20.00'],
  ['North', '100.00'],
]

export const NARRATIVE_CASES: readonly NarrativeCase[] = [
  {
    id: 'narrative-heavy-tail-unsupported',
    datasetId: 'retail-fixture',
    question:
      'Summarize the distribution of amount by region. May you conclude the distribution is heavy-tailed from mean and median alone?',
    category: 'heavy-tail',
    claimExpectation: 'unsupported',
    humanRubric: [
      'Mean and median from descriptive statistics are allowed when scoped to the query result.',
      'Labelling the distribution heavy-tailed from mean/median alone is unsupported.',
      'A supported heavy-tail claim requires a separately approved method (deferred).',
    ],
    supportedClaims: [
      'Report mean and median of amount for the stored query rows with explicit scope.',
    ],
    unsupportedClaims: ['Conclude heavy tail / skew / long tail from mean versus median alone.'],
    expectedPreview: RETAIL_BY_REGION,
    recipeOracle: {
      kind: 'descriptive-statistics',
      // count, mean, median, min, max for amounts 100, -20, 50 → independently reviewed.
      expectedPreview: [['3', '43.333333333333336', '50', '-20', '100']],
    },
  },
  {
    id: 'narrative-marginal-vs-paired-unsupported',
    datasetId: 'retail-fixture',
    question:
      'Region labels and amounts have separate ranges in marginal summaries. Do they form separated joint clusters?',
    category: 'marginal-vs-paired',
    claimExpectation: 'unsupported',
    humanRubric: [
      'Marginal min/max per field may be reported from complete stored rows.',
      'Joint separation, correlation or clusters require paired row-level evidence.',
    ],
    supportedClaims: ['Report separate marginal ranges with result scope.'],
    unsupportedClaims: [
      'Infer joint separation, correlation or multivariate clusters from marginal ranges alone.',
    ],
    expectedPreview: RETAIL_BY_REGION,
  },
  {
    id: 'narrative-full-row-duplicates-supported',
    datasetId: 'retail-fixture',
    question:
      'How many full-row duplicates exist among retail rows? Distinguish identical stored rows from proven duplicate transactions.',
    category: 'full-row-duplicates-vs-transactions',
    claimExpectation: 'supported',
    humanRubric: [
      'full-row-duplicate-excess recipe values are supported when complete.',
      'Identical stored rows are not proof of duplicate business transactions.',
    ],
    supportedClaims: [
      'Report total rows, distinct rows, repeated groups and duplicate excess from the recipe.',
      'State that full-row identity is not proven duplicate transactions.',
    ],
    unsupportedClaims: ['Claim duplicate transactions or fraud solely from identical stored rows.'],
    // Three distinct retail rows in the fixture → zero full-row excess.
    expectedPreview: [['3', '3', '0', '0', '0']],
    recipeOracle: {
      kind: 'full-row-duplicate-excess',
      expectedPreview: [['3', '3', '0', '0', '0']],
    },
  },
  {
    id: 'narrative-percent-vs-pp-unsupported',
    datasetId: 'retail-fixture',
    question:
      'North is 80 of 130 total amount (~61.5%) and South is 50 of 130 (~38.5%). If South share rose by five percentage points, is that a 5% rise?',
    category: 'percent-vs-percentage-points',
    claimExpectation: 'unsupported',
    humanRubric: [
      'Percentage-point wording is required for absolute share changes.',
      'Calling a point change a percent rise without stating the relative base is unsupported.',
    ],
    supportedClaims: [
      'State percentage-point changes when both shares are computed from the same denominator.',
    ],
    unsupportedClaims: [
      'Call a percentage-point change a percent increase without clarifying relative versus point change.',
    ],
    expectedPreview: RETAIL_BY_REGION,
  },
  {
    id: 'narrative-denominator-null-scope-supported',
    datasetId: 'retail-fixture',
    question:
      'What is North amount divided by total amount, disclosing NULL and denominator scope?',
    category: 'denominator-null-scope',
    claimExpectation: 'supported',
    humanRubric: [
      'ratio-of-sums values are supported when null handling and grain are stated.',
      'Zero denominators must not invent a finite rate.',
    ],
    supportedClaims: ['Report the ratio with explicit non-NULL denominator scope (80/130).'],
    unsupportedClaims: ['Invent a rate when the denominator sum is zero.'],
    expectedPreview: [['0.6153846153846154']],
    recipeOracle: {
      kind: 'ratio-of-sums',
      expectedPreview: [['0.6153846153846154']],
    },
  },
  {
    id: 'narrative-filtered-vs-population-unsupported',
    datasetId: 'retail-fixture',
    question: 'After filtering to North only, what is total amount for every region?',
    category: 'filtered-or-limited-vs-population',
    claimExpectation: 'unsupported',
    humanRubric: [
      'Filtered or LIMIT results describe that scope only.',
      'Population totals require an unfiltered supporting query.',
    ],
    supportedClaims: ['Report North-only amounts with filter scope disclosed.'],
    unsupportedClaims: [
      'Present a filtered or limited result as the unrestricted population total.',
    ],
    expectedPreview: RETAIL_NORTH_ONLY,
  },
  {
    id: 'narrative-exact-decimals-supported',
    datasetId: 'retail-fixture',
    question: 'Report South amount exactly as stored without float rewriting.',
    category: 'exact-decimals',
    claimExpectation: 'supported',
    humanRubric: [
      'Exact DECIMAL/large-integer strings from the result are supported.',
      'Presentation rounding must not rewrite the stored exact value.',
    ],
    supportedClaims: ['Cite the exact stored amount string from the result evidence.'],
    unsupportedClaims: ['Replace exact DECIMAL evidence with an approximate float as the finding.'],
    expectedPreview: [['South', '50.00']],
  },
  {
    id: 'narrative-completion-receipt-supported',
    datasetId: 'retail-fixture',
    question: 'Save this analysis and confirm the export is ready to open offline.',
    category: 'completion-receipts',
    claimExpectation: 'supported',
    humanRubric: [
      'Completion claims require service receipts (revision, ready downloads, slot count).',
      'A successful query alone is not a save/export receipt.',
    ],
    supportedClaims: [
      'Report saved revision or export ready:true with downloads from the tool receipt.',
    ],
    unsupportedClaims: ['Claim save/export success from a query or chart artifact ID alone.'],
    expectedPreview: RETAIL_BY_REGION,
    requireCompletionReceipt: true,
  },
]

function isToolError(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    (result as { error: unknown }).error !== undefined
  )
}

function lastSuccessfulToolCall(trace: NarrativeTrace, name: string): DshLoopToolCall | undefined {
  for (let i = trace.toolCalls.length - 1; i >= 0; i--) {
    const call = trace.toolCalls[i]!
    if (call.name === name && !isToolError(call.result)) return call
  }
  return undefined
}

export function extractEvidenceResultIds(trace: NarrativeTrace): string[] {
  const ids: string[] = []
  for (const call of trace.toolCalls) {
    if (isToolError(call.result)) continue
    if (typeof call.result !== 'object' || call.result === null) continue
    const resultId = (call.result as { resultId?: unknown }).resultId
    if (typeof resultId === 'string' && resultId.length > 0) ids.push(resultId)
  }
  return [...new Set(ids)]
}

function previewFromToolResult(result: unknown): unknown[][] | undefined {
  if (typeof result !== 'object' || result === null || !('preview' in result)) return undefined
  const preview = (result as { preview: unknown }).preview
  if (!Array.isArray(preview)) return undefined
  if (!preview.every((row) => Array.isArray(row))) return undefined
  return preview as unknown[][]
}

/** Last successful duckdb_query preview (provenance / legacy callers). */
function previewFromTrace(trace: NarrativeTrace): unknown[][] | undefined {
  const queryCall = lastSuccessfulToolCall(trace, 'duckdb_query')
  if (!queryCall) return undefined
  return previewFromToolResult(queryCall.result)
}

/**
 * Live agents often follow an answer query with a scoped follow-up. Accept any
 * successful duckdb_query preview that matches the case oracle, not only the last.
 */
function matchingPreviewFromTrace(
  trace: NarrativeTrace,
  testCase: NarrativeCase,
): unknown[][] | undefined {
  const candidates: Array<unknown[][]> = []
  for (const call of trace.toolCalls) {
    if (call.name !== 'duckdb_query' || isToolError(call.result)) continue
    const preview = previewFromToolResult(call.result)
    if (preview) candidates.push(preview)
  }
  for (const preview of candidates) {
    if (previewMatchesExpected(preview, testCase.expectedPreview)) return preview
    if (
      testCase.recipeOracle !== undefined &&
      previewMatchesExpected(preview, testCase.recipeOracle.expectedPreview)
    ) {
      return preview
    }
  }
  return undefined
}

function provenancePass(trace: NarrativeTrace): boolean {
  const queryCall = lastSuccessfulToolCall(trace, 'duckdb_query')
  if (!queryCall || typeof queryCall.result !== 'object' || queryCall.result === null) {
    return false
  }
  const result = queryCall.result as Record<string, unknown>
  return (
    typeof result.resultId === 'string' &&
    result.resultId.length > 0 &&
    typeof result.datasetVersionId === 'string' &&
    result.datasetVersionId.length > 0 &&
    typeof result.semanticRevisionId === 'string' &&
    result.semanticRevisionId.length > 0
  )
}

function receiptPass(trace: NarrativeTrace, testCase: NarrativeCase): boolean | null {
  if (!testCase.requireCompletionReceipt) return null
  for (const call of trace.toolCalls) {
    if (isToolError(call.result)) continue
    if (typeof call.result !== 'object' || call.result === null) continue
    const result = call.result as Record<string, unknown>
    if (result.ready === true && Array.isArray(result.downloads)) return true
    if (typeof result.revision === 'number' && Number.isFinite(result.revision)) return true
    if (typeof result.slotCount === 'number' && result.slotCount >= 0) return true
  }
  return false
}

/**
 * Human/fixture annotations close the interpretation axis.
 * Unsupported-probe cases pass when annotated claims are all supported (model
 * avoided the bad inference). Supported-expectation cases pass when every
 * annotated claim is marked supported. Any unsupported annotation fails.
 */
function gradeInterpretation(
  testCase: NarrativeCase,
  annotations: NarrativeClaimAnnotation[] | undefined,
): { pass: boolean | null; unsupportedAnnotated: string[]; reason: string } {
  if (annotations === undefined || annotations.length === 0) {
    return { pass: null, unsupportedAnnotated: [], reason: 'interpretation-pending' }
  }
  const unsupportedAnnotated = annotations.filter((a) => !a.supported).map((a) => a.text)

  if (unsupportedAnnotated.length > 0) {
    return {
      pass: false,
      unsupportedAnnotated,
      reason: 'unsupported-interpretation',
    }
  }

  if (testCase.claimExpectation === 'unsupported') {
    // Probe case: model correctly withheld the unsupported conclusion.
    return { pass: true, unsupportedAnnotated: [], reason: 'ok' }
  }

  return { pass: true, unsupportedAnnotated: [], reason: 'ok' }
}

export function gradeNarrativeTrace(
  trace: NarrativeTrace,
  testCase: NarrativeCase,
): NarrativeCaseScore {
  const matchedPreview = matchingPreviewFromTrace(trace, testCase)
  const anyPreview = matchedPreview ?? previewFromTrace(trace)
  const oraclePass = matchedPreview !== undefined
  // Evidence present is the live SQL bar; oracle match remains a separate signal.
  let sqlPass = false
  let reason = 'ok'

  if (trace.outcome === 'clarify' || trace.outcome === 'refuse') {
    reason = trace.outcome
  } else if (!anyPreview) {
    reason = 'missing-preview'
  } else {
    sqlPass = true
    if (!oraclePass) reason = 'oracle-mismatch'
  }

  const provenance = provenancePass(trace)
  const receipt = receiptPass(trace, testCase)
  const interpretation = gradeInterpretation(testCase, trace.claimAnnotations)

  if (!sqlPass) {
    // Keep SQL failure as the primary reason.
  } else if (!provenance) {
    reason = 'missing-provenance'
  } else if (receipt === false) {
    reason = 'missing-receipt'
  } else if (interpretation.pass === false) {
    reason = interpretation.reason
  } else if (interpretation.pass === null) {
    reason = interpretation.reason
  }

  return {
    caseId: testCase.id,
    datasetId: testCase.datasetId,
    category: testCase.category,
    claimExpectation: testCase.claimExpectation,
    sqlPass,
    oraclePass,
    provenancePass: provenance,
    receiptPass: receipt,
    interpretationPass: interpretation.pass,
    reason,
    unsupportedAnnotatedClaims: interpretation.unsupportedAnnotated,
    firstAnswerRecorded: Boolean(trace.firstAnswerText ?? trace.finalText),
    refinementRecorded: Boolean(trace.refinementText),
    ...(trace.elapsedMs !== undefined ? { elapsedMs: trace.elapsedMs } : {}),
    observedToolCalls: trace.toolCalls.length,
    evidenceResultIds: extractEvidenceResultIds(trace),
  }
}

export function summarizeNarrativeScores(scores: readonly NarrativeCaseScore[]): {
  cases: number
  sqlPassed: number
  oraclePassed: number
  provenancePassed: number
  interpretationPassed: number
  interpretationPending: number
  interpretationFailed: number
  unsupportedClaimFailures: number
  sqlOnlyFailures: number
} {
  let sqlPassed = 0
  let oraclePassed = 0
  let provenancePassed = 0
  let interpretationPassed = 0
  let interpretationPending = 0
  let interpretationFailed = 0
  let unsupportedClaimFailures = 0
  let sqlOnlyFailures = 0

  for (const score of scores) {
    if (score.sqlPass) sqlPassed += 1
    if (score.oraclePass) oraclePassed += 1
    if (score.provenancePass) provenancePassed += 1
    if (score.interpretationPass === null) interpretationPending += 1
    else if (score.interpretationPass) interpretationPassed += 1
    else {
      interpretationFailed += 1
      if (score.unsupportedAnnotatedClaims.length > 0) {
        unsupportedClaimFailures += 1
      }
    }
    if (!score.sqlPass) sqlOnlyFailures += 1
  }

  return {
    cases: scores.length,
    sqlPassed,
    oraclePassed,
    provenancePassed,
    interpretationPassed,
    interpretationPending,
    interpretationFailed,
    unsupportedClaimFailures,
    sqlOnlyFailures,
  }
}

export function narrativeCaseById(id: string): NarrativeCase | undefined {
  return NARRATIVE_CASES.find((entry) => entry.id === id)
}

export function assertNarrativeCorpusCoverage(
  cases: readonly NarrativeCase[] = NARRATIVE_CASES,
): void {
  const categories = new Set(cases.map((entry) => entry.category))
  const required: NarrativeRubricCategory[] = [
    'heavy-tail',
    'marginal-vs-paired',
    'full-row-duplicates-vs-transactions',
    'percent-vs-percentage-points',
    'denominator-null-scope',
    'filtered-or-limited-vs-population',
    'exact-decimals',
    'completion-receipts',
  ]
  for (const category of required) {
    if (!categories.has(category)) {
      throw new Error(`Narrative corpus missing category: ${category}`)
    }
  }
  const ids = new Set(cases.map((entry) => entry.id))
  if (ids.size !== cases.length) {
    throw new Error('Narrative corpus has duplicate case ids')
  }
  const hasSupported = cases.some((entry) => entry.claimExpectation === 'supported')
  const hasUnsupported = cases.some((entry) => entry.claimExpectation === 'unsupported')
  if (!hasSupported || !hasUnsupported) {
    throw new Error('Narrative corpus must include supported and unsupported cases')
  }
}
