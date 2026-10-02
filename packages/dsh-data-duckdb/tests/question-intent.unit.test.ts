import { describe, expect, it } from 'vitest'
import { getEffectiveSemantics, getWorkspaceBaseSemantics } from 'dsh-data-core/semantics'
import { CLARIFICATION_CASES } from '../src/nl-eval.js'
import { classifyAnalystQuestion } from '../src/question-intent.js'

const OLIST_REVIEW_HINT_SEMANTICS = getWorkspaceBaseSemantics('olist')
const APPROVED_REVENUE_SEMANTICS = getEffectiveSemantics('olist', {
  listAliasCandidates: () => [
    {
      term: 'revenue',
      expression: 'SUM(net_amount)',
      description: 'Analyst-approved net revenue',
      tableId: 'facts',
    },
  ],
})!
const FIXTURE_DATASET_IDS = ['superstore', 'olist', 'online-retail', 'retail-fixture']

const QUESTION_INTENT_REGRESSION_CASES = [
  {
    id: 'clarify-last-week-without-fixed-clock',
    question: 'Show orders last week',
    expected: 'clarify',
  },
  {
    id: 'refuse-plain-language-table-wipe',
    question: 'Wipe the table',
    expected: 'refuse',
  },
  {
    id: 'answer-comparison-of-dataset-name-values',
    question: 'Compare the labels Superstore and Olist in source_name',
    knownDatasetIds: FIXTURE_DATASET_IDS,
    expected: 'answer',
  },
  {
    id: 'clarify-cross-dataset-comparison-from-context',
    question: 'Compare Alpha Mart revenue to Beta Market sales',
    knownDatasetIds: ['alpha-mart', 'beta-market'],
    expected: 'clarify',
  },
  {
    id: 'clarify-cross-dataset-comparison-with-outside-vocabulary-measure',
    question: 'Compare Alpha Mart average basket size to Beta Market average basket size',
    knownDatasetIds: ['alpha-mart', 'beta-market'],
    expected: 'clarify',
  },
  {
    id: 'refuse-cross-dataset-join-from-context',
    question: 'Join Alpha Mart orders to Beta Market customers',
    knownDatasetIds: ['alpha-mart', 'beta-market'],
    expected: 'refuse',
  },
  {
    id: 'answer-single-dataset-join-with-overlapping-dataset-ids',
    question: 'Join Olist Mini orders to customers',
    knownDatasetIds: ['olist', 'olist-mini'],
    expected: 'answer',
  },
  {
    id: 'clarify-revenue-without-approved-definition',
    datasetId: 'olist',
    question: 'What is revenue by state?',
    semantics: OLIST_REVIEW_HINT_SEMANTICS,
    expected: 'clarify',
  },
  {
    id: 'answer-revenue-with-approved-definition',
    datasetId: 'olist',
    question: 'What is revenue by state?',
    semantics: APPROVED_REVENUE_SEMANTICS,
    expected: 'answer',
  },
  {
    id: 'answer-revenue-without-a-reviewed-missing-definition-hint',
    datasetId: 'generic-fixture',
    question: 'What is revenue by state?',
    semantics: { aliases: [], metricTermsRequiringApproval: [] },
    expected: 'answer',
  },
  {
    id: 'clarify-generic-reviewed-missing-definition-hint',
    datasetId: 'generic-fixture',
    question: 'Show net proceeds by state',
    semantics: { aliases: [], metricTermsRequiringApproval: ['net proceeds'] },
    expected: 'clarify',
  },
] as const

describe('classifyAnalystQuestion', () => {
  it('matches the frozen clarify|refuse corpus', () => {
    for (const testCase of CLARIFICATION_CASES) {
      const actual = classifyAnalystQuestion(testCase.question, {
        datasetId: testCase.datasetId,
        knownDatasetIds: FIXTURE_DATASET_IDS,
        semantics: testCase.datasetId ? getWorkspaceBaseSemantics(testCase.datasetId) : undefined,
      })
      expect(actual, testCase.id).toBe(testCase.expected)
    }
  })

  it('allows ordinary answerable asks through', () => {
    expect(
      classifyAnalystQuestion('Total sales by region, highest first', {
        datasetId: 'superstore',
      }),
    ).toBe('answer')
  })

  it.each(QUESTION_INTENT_REGRESSION_CASES)('$id', (testCase) => {
    const actual = classifyAnalystQuestion(testCase.question, {
      datasetId: 'datasetId' in testCase ? testCase.datasetId : 'fixture-dataset',
      knownDatasetIds: 'knownDatasetIds' in testCase ? testCase.knownDatasetIds : [],
      semantics: 'semantics' in testCase ? testCase.semantics : undefined,
    })
    expect(actual, testCase.id).toBe(testCase.expected)
  })
})
