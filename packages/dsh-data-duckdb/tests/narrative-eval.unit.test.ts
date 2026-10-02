import { expect, it } from 'vitest'
import {
  NARRATIVE_CASES,
  assertNarrativeCorpusCoverage,
  gradeNarrativeTrace,
  summarizeNarrativeScores,
  type NarrativeTrace,
} from '../src/narrative-eval.js'

const heavyTail = NARRATIVE_CASES.find((entry) => entry.id === 'narrative-heavy-tail-unsupported')
const completion = NARRATIVE_CASES.find(
  (entry) => entry.id === 'narrative-completion-receipt-supported',
)
const exact = NARRATIVE_CASES.find((entry) => entry.id === 'narrative-exact-decimals-supported')
if (!heavyTail || !completion || !exact) throw new Error('expected narrative corpus cases')

function baseTrace(
  testCase: (typeof NARRATIVE_CASES)[number],
  preview: unknown[][],
  extras: Partial<NarrativeTrace> = {},
): NarrativeTrace {
  return {
    caseId: testCase.id,
    question: testCase.question,
    datasetId: testCase.datasetId,
    analystTurns: 1,
    outcome: 'answer',
    firstAnswerText: 'First answer body',
    toolCalls: [
      {
        name: 'duckdb_query',
        args: { datasetId: testCase.datasetId, sql: 'SELECT 1', parameters: [] },
        result: {
          resultId: 'res_1',
          datasetVersionId: 'dv_1',
          semanticRevisionId: 'sem_1',
          preview,
        },
      },
    ],
    ...extras,
  }
}

it('freezes the narrative corpus with every rubric category and both claim expectations', () => {
  expect(() => assertNarrativeCorpusCoverage()).not.toThrow()
  expect(NARRATIVE_CASES.length).toBeGreaterThanOrEqual(8)
})

it('keeps SQL evidence pass when oracle matches and marks unsupported claims as failures', () => {
  const scored = gradeNarrativeTrace(
    baseTrace(heavyTail, heavyTail.expectedPreview, {
      claimAnnotations: [
        {
          text: 'The distribution is heavy-tailed because mean exceeds median',
          supported: false,
        },
      ],
    }),
    heavyTail,
  )
  expect(scored.sqlPass).toBe(true)
  expect(scored.oraclePass).toBe(true)
  expect(scored.provenancePass).toBe(true)
  expect(scored.interpretationPass).toBe(false)
  expect(scored.reason).toBe('unsupported-interpretation')
})

it('passes unsupported-probe cases when annotations show the model avoided the bad claim', () => {
  const scored = gradeNarrativeTrace(
    baseTrace(heavyTail, heavyTail.expectedPreview, {
      claimAnnotations: [
        {
          text: 'Mean and median reported with scope; heavy-tail label withheld',
          supported: true,
        },
      ],
    }),
    heavyTail,
  )
  expect(scored.interpretationPass).toBe(true)
  expect(scored.reason).toBe('ok')
})

it('keeps SQL evidence pass on oracle mismatch without collapsing into interpretation failure', () => {
  const scored = gradeNarrativeTrace(
    baseTrace(heavyTail, [['wrong']], {
      claimAnnotations: [{ text: 'mean/median only; no heavy-tail label', supported: true }],
    }),
    heavyTail,
  )
  expect(scored.sqlPass).toBe(true)
  expect(scored.oraclePass).toBe(false)
  expect(scored.interpretationPass).toBe(true)
})

it('passes SQL when an earlier query matches even if the last query does not', () => {
  const scored = gradeNarrativeTrace(
    {
      ...baseTrace(heavyTail, heavyTail.expectedPreview),
      toolCalls: [
        {
          name: 'duckdb_query',
          args: { datasetId: heavyTail.datasetId, sql: 'SELECT region, amount', parameters: [] },
          result: {
            resultId: 'res_match',
            datasetVersionId: 'dv_1',
            semanticRevisionId: 'sem_1',
            preview: heavyTail.expectedPreview,
          },
        },
        {
          name: 'duckdb_query',
          args: { datasetId: heavyTail.datasetId, sql: 'SELECT mean(amount)', parameters: [] },
          result: {
            resultId: 'res_last',
            datasetVersionId: 'dv_1',
            semanticRevisionId: 'sem_1',
            preview: [['43.33']],
          },
        },
      ],
      claimAnnotations: [
        { text: 'mean/median with scope; heavy-tail label withheld', supported: true },
      ],
    },
    heavyTail,
  )
  expect(scored.sqlPass).toBe(true)
  expect(scored.oraclePass).toBe(true)
  expect(scored.provenancePass).toBe(true)
  expect(scored.interpretationPass).toBe(true)
})

it('passes SQL when a recipe-oracle preview appears on any successful query', () => {
  const duplicates = NARRATIVE_CASES.find(
    (entry) => entry.id === 'narrative-full-row-duplicates-supported',
  )
  if (!duplicates?.recipeOracle) throw new Error('expected duplicates recipe oracle')
  const scored = gradeNarrativeTrace(
    {
      ...baseTrace(duplicates, duplicates.expectedPreview),
      toolCalls: [
        {
          name: 'duckdb_query',
          args: { datasetId: duplicates.datasetId, sql: 'SELECT *', parameters: [] },
          result: {
            resultId: 'res_raw',
            datasetVersionId: 'dv_1',
            semanticRevisionId: 'sem_1',
            preview: [
              ['1', 'c1', '2024-01-01', 'North', '100.00'],
              ['2', 'c2', '2024-01-02', 'North', '-20.00'],
              ['3', 'c3', '2024-01-03', 'South', '50.00'],
            ],
          },
        },
        {
          name: 'duckdb_query',
          args: { datasetId: duplicates.datasetId, sql: 'duplicate excess', parameters: [] },
          result: {
            resultId: 'res_recipe',
            datasetVersionId: 'dv_1',
            semanticRevisionId: 'sem_1',
            preview: duplicates.recipeOracle.expectedPreview,
          },
        },
      ],
      claimAnnotations: [
        {
          text: '3 total, 3 distinct, 0 excess; not proven duplicate transactions',
          supported: true,
        },
      ],
    },
    duplicates,
  )
  expect(scored.sqlPass).toBe(true)
  expect(scored.oraclePass).toBe(true)
  expect(scored.interpretationPass).toBe(true)
})
it('leaves interpretation pending when annotations are absent', () => {
  const scored = gradeNarrativeTrace(baseTrace(exact, exact.expectedPreview), exact)
  expect(scored.sqlPass).toBe(true)
  expect(scored.interpretationPass).toBeNull()
  expect(scored.reason).toBe('interpretation-pending')
})

it('fails supported cases when a human marks a claim unsupported', () => {
  const scored = gradeNarrativeTrace(
    baseTrace(exact, exact.expectedPreview, {
      claimAnnotations: [{ text: 'Approximately 50', supported: false }],
    }),
    exact,
  )
  expect(scored.sqlPass).toBe(true)
  expect(scored.interpretationPass).toBe(false)
  expect(scored.reason).toBe('unsupported-interpretation')
})

it('requires a completion receipt separately from query success', () => {
  const withoutReceipt = gradeNarrativeTrace(
    baseTrace(completion, completion.expectedPreview, {
      claimAnnotations: [{ text: 'Export ready', supported: true }],
    }),
    completion,
  )
  expect(withoutReceipt.sqlPass).toBe(true)
  expect(withoutReceipt.receiptPass).toBe(false)
  expect(withoutReceipt.reason).toBe('missing-receipt')

  const withReceipt = gradeNarrativeTrace(
    {
      ...baseTrace(completion, completion.expectedPreview, {
        claimAnnotations: [{ text: 'Export ready with downloads', supported: true }],
      }),
      toolCalls: [
        ...baseTrace(completion, completion.expectedPreview).toolCalls,
        {
          name: 'export_analysis_report',
          args: {},
          result: { ready: true, downloads: ['report.html'], slotCount: 1 },
        },
      ],
    },
    completion,
  )
  expect(withReceipt.receiptPass).toBe(true)
  expect(withReceipt.interpretationPass).toBe(true)
  expect(withReceipt.reason).toBe('ok')
})

it('records first-answer and refinement fields separately in the score', () => {
  const scored = gradeNarrativeTrace(
    baseTrace(exact, exact.expectedPreview, {
      firstAnswerText: 'South amount is 50.00',
      refinementText: 'Confirming exact stored value 50.00',
      claimAnnotations: [{ text: 'South amount is 50.00', supported: true }],
      elapsedMs: 1200,
    }),
    exact,
  )
  expect(scored.firstAnswerRecorded).toBe(true)
  expect(scored.refinementRecorded).toBe(true)
  expect(scored.elapsedMs).toBe(1200)
  expect(scored.evidenceResultIds).toEqual(['res_1'])
})

it('summarizes SQL-only failures separately from unsupported interpretation', () => {
  const scores = [
    gradeNarrativeTrace(
      {
        caseId: heavyTail.id,
        question: heavyTail.question,
        datasetId: heavyTail.datasetId,
        analystTurns: 1,
        outcome: 'answer',
        firstAnswerText: 'no query',
        toolCalls: [],
      },
      heavyTail,
    ),
    gradeNarrativeTrace(
      baseTrace(exact, exact.expectedPreview, {
        claimAnnotations: [{ text: 'approx', supported: false }],
      }),
      exact,
    ),
  ]
  const summary = summarizeNarrativeScores(scores)
  expect(summary.sqlOnlyFailures).toBe(1)
  expect(summary.unsupportedClaimFailures).toBe(1)
  expect(summary.interpretationPending).toBe(1)
})
