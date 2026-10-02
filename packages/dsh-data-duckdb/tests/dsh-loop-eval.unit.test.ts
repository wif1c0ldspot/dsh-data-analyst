import { expect, it } from 'vitest'
import { HELD_OUT_CASES } from '../src/nl-eval.js'
import {
  assertCoreDshLoopCoverage,
  coreDshLoopCases,
  countDshLoopCalls,
  extractChartIntent,
  extractQuerySql,
  gradeDshLoopTrace,
  summarizeDshLoopScores,
  summarizeDshLoopTelemetry,
  type DshLoopTrace,
} from '../src/dsh-loop-eval.js'

const sales = HELD_OUT_CASES.find(
  (entry) => entry.id.includes('superstore') && entry.goldenSql.includes('region'),
)
if (!sales) throw new Error('expected a superstore region held-out case')

it('extracts the last duckdb_query SQL and last make_chart intent', () => {
  const trace: DshLoopTrace = {
    caseId: sales.id,
    question: sales.question,
    datasetId: sales.datasetId,
    analystTurns: 1,
    outcome: 'answer',
    toolCalls: [
      { name: 'get_schema', args: { datasetId: 'superstore' }, result: {} },
      {
        name: 'duckdb_query',
        args: { datasetId: 'superstore', sql: sales.goldenSql, parameters: [] },
        result: { resultId: 'res_a', preview: sales.expectedPreview },
      },
      {
        name: 'make_chart',
        args: {
          resultId: 'res_a',
          intent: { mark: 'bar', title: 'Sales', x: 'region', y: 'revenue' },
        },
        result: { artifactId: 'art_a' },
      },
    ],
  }
  expect(extractQuerySql(trace)).toBe(sales.goldenSql)
  expect(extractChartIntent(trace)).toEqual({ mark: 'bar', x: 'region', y: 'revenue' })
})

it('fails SQL when duckdb_query is missing and counts analyst turns not tool rounds', () => {
  const scored = gradeDshLoopTrace(
    {
      caseId: sales.id,
      question: sales.question,
      datasetId: sales.datasetId,
      analystTurns: 3,
      outcome: 'answer',
      toolCalls: [{ name: 'get_schema', args: {}, result: {} }],
    },
    sales,
  )
  expect(scored.sqlPass).toBe(false)
  expect(scored.turnsPass).toBe(false)
  expect(scored.analystTurns).toBe(3)
})

it('does not treat nl-loop fixture success as a dsh-loop pass', () => {
  const summary = summarizeDshLoopScores([])
  expect(summary.sqlTotal).toBe(0)
})

it('returns undefined when the last make_chart has no usable intent', () => {
  const trace: DshLoopTrace = {
    caseId: sales.id,
    question: sales.question,
    datasetId: sales.datasetId,
    analystTurns: 1,
    outcome: 'answer',
    toolCalls: [
      {
        name: 'make_chart',
        args: {
          resultId: 'res_a',
          intent: { mark: 'bar', x: 'region', y: 'revenue' },
        },
        result: { artifactId: 'art_a' },
      },
      {
        name: 'make_chart',
        args: { resultId: 'res_a', intent: { title: 'Bad' } },
        result: { artifactId: 'art_b' },
      },
    ],
  }
  expect(extractChartIntent(trace)).toBeUndefined()
})

it('grades chart when acceptableCharts is an empty array', () => {
  const scored = gradeDshLoopTrace(
    {
      caseId: sales.id,
      question: sales.question,
      datasetId: sales.datasetId,
      analystTurns: 1,
      outcome: 'answer',
      toolCalls: [
        {
          name: 'duckdb_query',
          args: { datasetId: 'superstore', sql: sales.goldenSql, parameters: [] },
          result: { resultId: 'res_a', preview: sales.expectedPreview },
        },
        {
          name: 'make_chart',
          args: {
            resultId: 'res_a',
            intent: { mark: 'bar', x: 'region', y: 'revenue' },
          },
          result: { artifactId: 'art_a' },
        },
      ],
    },
    { ...sales, acceptableCharts: [] },
  )
  expect(scored.chartPass).toBe(false)
})

it('ignores failed chart renders and keeps the last successfully rendered intent', () => {
  const trace: DshLoopTrace = {
    caseId: sales.id,
    question: sales.question,
    datasetId: sales.datasetId,
    analystTurns: 1,
    outcome: 'answer',
    toolCalls: [
      {
        name: 'duckdb_query',
        args: { sql: sales.goldenSql },
        result: { resultId: 'res_a', preview: sales.expectedPreview },
      },
      {
        name: 'make_chart',
        args: { resultId: 'res_a', intent: { mark: 'bar', x: 'wrong', y: 'profit' } },
        result: { artifactId: 'art_wrong' },
      },
      {
        name: 'make_chart',
        args: { resultId: 'res_a', intent: { mark: 'bar', x: 'region', y: 'revenue' } },
        result: { error: 'render failed' },
      },
    ],
  }

  expect(extractChartIntent(trace)).toEqual({ mark: 'bar', x: 'wrong', y: 'profit' })
  expect(
    gradeDshLoopTrace(trace, {
      ...sales,
      acceptableCharts: [{ mark: 'bar', x: 'region', y: 'revenue' }],
    }).chartPass,
  ).toBe(false)
})

it('does not grade an unrendered chart intent as a chart', () => {
  const scored = gradeDshLoopTrace(
    {
      caseId: sales.id,
      question: sales.question,
      datasetId: sales.datasetId,
      analystTurns: 1,
      outcome: 'answer',
      toolCalls: [
        {
          name: 'duckdb_query',
          args: { sql: sales.goldenSql },
          result: { resultId: 'res_a', preview: sales.expectedPreview },
        },
        {
          name: 'make_chart',
          args: { resultId: 'res_a', intent: { mark: 'bar', x: 'region', y: 'revenue' } },
          result: {},
        },
      ],
    },
    { ...sales, acceptableCharts: [{ mark: 'bar', x: 'region', y: 'revenue' }] },
  )
  expect(scored.chartPass).toBe(false)
})

it('accepts the case-specific city result alias proven by the held-out query projection', () => {
  const customerCities = HELD_OUT_CASES.find(
    (testCase) => testCase.id === 'heldout-olist-top-customer-cities',
  )
  if (!customerCities) throw new Error('expected customer-cities held-out case')
  const scored = gradeDshLoopTrace(
    {
      caseId: customerCities.id,
      question: customerCities.question,
      datasetId: customerCities.datasetId,
      analystTurns: 1,
      outcome: 'answer',
      toolCalls: [
        {
          name: 'duckdb_query',
          args: { sql: 'SELECT customer_city AS city, COUNT(*) AS customer_count FROM customers' },
          result: { resultId: 'res_city', preview: customerCities.expectedPreview },
        },
        {
          name: 'make_chart',
          args: {
            resultId: 'res_city',
            intent: { mark: 'bar', x: 'city', y: 'customer_count' },
          },
          result: { artifactId: 'art_city' },
        },
      ],
    },
    customerCities,
  )
  expect(scored.chartPass).toBe(true)
})

it('rejects a chart rendered from a different query result than the scored answer', () => {
  const scored = gradeDshLoopTrace(
    {
      caseId: sales.id,
      question: sales.question,
      datasetId: sales.datasetId,
      analystTurns: 1,
      outcome: 'answer',
      toolCalls: [
        {
          name: 'duckdb_query',
          args: { sql: 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region' },
          result: { resultId: 'res_unrelated', preview: [] },
        },
        {
          name: 'duckdb_query',
          args: { sql: sales.goldenSql },
          result: { resultId: 'res_answer', preview: sales.expectedPreview },
        },
        {
          name: 'make_chart',
          args: {
            resultId: 'res_unrelated',
            intent: { mark: 'bar', x: 'region', y: 'revenue' },
          },
          result: { artifactId: 'art_unrelated' },
        },
      ],
    },
    { ...sales, acceptableCharts: [{ mark: 'bar', x: 'region', y: 'revenue' }] },
  )
  expect(scored.chartPass).toBe(false)
})

it('grades a find_top_n-only trace correctly instead of missing-query (Bug 1)', () => {
  const topN = HELD_OUT_CASES.find(
    (entry) => entry.id === 'heldout-retail-fixture-lowest-revenue-region',
  )
  if (!topN) throw new Error('expected the retail-fixture lowest-revenue-region held-out case')
  const trace: DshLoopTrace = {
    caseId: topN.id,
    question: topN.question,
    datasetId: topN.datasetId,
    analystTurns: 1,
    outcome: 'answer',
    toolCalls: [
      { name: 'get_schema', args: { datasetId: 'retail-fixture' }, result: {} },
      {
        name: 'find_top_n',
        args: {
          datasetId: 'retail-fixture',
          table: 'retail',
          measureColumn: 'amount',
          groupColumn: 'region',
          direction: 'bottom',
          limit: 1,
        },
        result: { resultId: 'res_topn', preview: topN.expectedPreview },
      },
      {
        name: 'make_chart',
        args: {
          resultId: 'res_topn',
          intent: { mark: 'bar', title: 'Lowest region', x: 'region', y: 'revenue' },
        },
        result: { artifactId: 'art_topn' },
      },
    ],
  }

  expect(extractChartIntent(trace)).toEqual({ mark: 'bar', x: 'region', y: 'revenue' })

  const scored = gradeDshLoopTrace(trace, topN)
  expect(scored.reason).toBe('ok')
  expect(scored.sqlPass).toBe(true)
  expect(scored.chartPass).toBe(true)
})

it("treats investigate_metric's current-period result as the answer for grading (Bug 1)", () => {
  const sales2 = HELD_OUT_CASES.find((entry) => entry.id === 'heldout-superstore-sales-by-category')
  if (!sales2) throw new Error('expected a superstore sales-by-category held-out case')
  const trace: DshLoopTrace = {
    caseId: sales2.id,
    question: sales2.question,
    datasetId: sales2.datasetId,
    analystTurns: 1,
    outcome: 'answer',
    toolCalls: [
      {
        name: 'investigate_metric',
        args: {
          datasetId: 'superstore',
          sqlCurrent: sales2.goldenSql,
          sqlBaseline: 'SELECT category, round(SUM(sales), 2) AS revenue FROM orders WHERE 1=0',
        },
        result: {
          current: { resultId: 'res_current', preview: sales2.expectedPreview },
          baseline: { resultId: 'res_baseline', preview: [] },
        },
      },
      {
        name: 'make_chart',
        args: {
          resultId: 'res_current',
          intent: { mark: 'bar', x: 'category', y: 'revenue' },
        },
        result: { artifactId: 'art_current' },
      },
      {
        name: 'make_chart',
        args: {
          resultId: 'res_baseline',
          intent: { mark: 'bar', x: 'category', y: 'revenue' },
        },
        result: { artifactId: 'art_baseline' },
      },
    ],
  }

  expect(extractQuerySql(trace)).toBe(sales2.goldenSql)
  const scored = gradeDshLoopTrace(trace, sales2)
  expect(scored.reason).toBe('ok')
  expect(scored.sqlPass).toBe(true)
  expect(scored.chartPass).toBe(true)
})

it('grades a find_top_n recipe chart by role via its fixed dimension_value/aggregate_value output columns', () => {
  const topSubcategories = HELD_OUT_CASES.find(
    (entry) => entry.id === 'heldout-superstore-top-subcategories',
  )
  if (!topSubcategories) throw new Error('expected the superstore top-subcategories held-out case')
  const trace: DshLoopTrace = {
    caseId: topSubcategories.id,
    question: topSubcategories.question,
    datasetId: topSubcategories.datasetId,
    analystTurns: 1,
    outcome: 'answer',
    toolCalls: [
      {
        name: 'find_top_n',
        args: {
          datasetId: 'superstore',
          table: 'orders',
          measureColumn: 'sales',
          groupColumn: 'sub_category',
          direction: 'top',
          limit: 5,
        },
        result: {
          resultId: 'res_topn',
          preview: topSubcategories.expectedPreview,
          columns: [
            { name: 'dimension_value', logicalType: 'VARCHAR' },
            { name: 'aggregate_value', logicalType: 'DOUBLE' },
            { name: 'row_count', logicalType: 'BIGINT' },
          ],
        },
      },
      {
        name: 'make_chart',
        args: {
          resultId: 'res_topn',
          intent: {
            mark: 'bar',
            title: 'Top 5 Sub-Categories',
            x: 'dimension_value',
            y: 'aggregate_value',
          },
        },
        result: { artifactId: 'art_topn' },
      },
    ],
  }

  const scored = gradeDshLoopTrace(trace, topSubcategories)
  expect(scored.chartPass).toBe(true)
})

// previewContainsExpectedMeasures fallback (dsh-loop-eval.ts's
// 'preview-mismatch' path). See nl-eval.ts's previewContainsExpectedMeasures
// doc comment for why non-numeric label cells aren't required to match
// literally, and .tmp/traces-live-prefix-20260919.json for the real traces
// this fallback was built to grade.
const bucketTestCase = {
  id: 'test-sql-shape-bucket-distribution',
  datasetId: 'test',
  question: 'What is the distribution of sales across buckets?',
  goldenSql: 'SELECT CASE ... END AS bucket, COUNT(*) AS n FROM t GROUP BY bucket ORDER BY bucket',
  expectedPreview: [
    ['0-100', '2106'],
    ['100-500', '1629'],
  ],
}

it('accepts the wide reconciliation shape for the long-form expectation', () => {
  const reconcileTestCase = {
    id: 'test-sql-shape-reconcile',
    datasetId: 'test',
    question: 'Does the total payment value reconcile with total (price + freight)?',
    goldenSql:
      "SELECT 'payments' AS source, 16008872.12 AS total UNION ALL SELECT 'order_items', 15843553.24",
    expectedPreview: [
      ['order_items', '15843553.24'],
      ['payments', '16008872.12'],
    ],
  }
  const trace: DshLoopTrace = {
    caseId: reconcileTestCase.id,
    question: reconcileTestCase.question,
    datasetId: reconcileTestCase.datasetId,
    analystTurns: 1,
    outcome: 'answer',
    toolCalls: [
      {
        name: 'duckdb_query',
        args: {
          datasetId: 'test',
          sql: 'SELECT 16008872.12 AS total_payment_value, 15843553.24 AS total_price_plus_freight, 165318.88 AS delta',
          parameters: [],
        },
        result: {
          resultId: 'res_wide',
          preview: [['16008872.12', '15843553.24', '165318.88']],
        },
      },
    ],
  }
  const scored = gradeDshLoopTrace(trace, reconcileTestCase)
  expect(scored.sqlPass).toBe(true)
  expect(scored.reason).toBe('ok')
})

it('accepts an extra context column alongside expected columns', () => {
  const trace: DshLoopTrace = {
    caseId: bucketTestCase.id,
    question: bucketTestCase.question,
    datasetId: bucketTestCase.datasetId,
    analystTurns: 1,
    outcome: 'answer',
    toolCalls: [
      {
        name: 'duckdb_query',
        args: { datasetId: 'test', sql: bucketTestCase.goldenSql, parameters: [] },
        result: {
          resultId: 'res_extra_col',
          // sales_bucket/order_count/bucket_sales: an extra `bucket_sales`
          // context column, and $-formatted labels the golden SQL doesn't use.
          preview: [
            ['$0-100', '2106', '76746.55'],
            ['$100-500', '1629', '412314.83'],
          ],
        },
      },
    ],
  }
  const scored = gradeDshLoopTrace(trace, bucketTestCase)
  expect(scored.sqlPass).toBe(true)
  expect(scored.reason).toBe('ok')
})

it('still fails when an expected value is wrong', () => {
  const trace: DshLoopTrace = {
    caseId: bucketTestCase.id,
    question: bucketTestCase.question,
    datasetId: bucketTestCase.datasetId,
    analystTurns: 1,
    outcome: 'answer',
    toolCalls: [
      {
        name: 'duckdb_query',
        args: { datasetId: 'test', sql: bucketTestCase.goldenSql, parameters: [] },
        result: {
          resultId: 'res_wrong_value',
          // 1999 instead of the expected 2106 for the '0-100' bucket.
          preview: [
            ['$0-100', '1999', '76746.55'],
            ['$100-500', '1629', '412314.83'],
          ],
        },
      },
    ],
  }
  const scored = gradeDshLoopTrace(trace, bucketTestCase)
  expect(scored.sqlPass).toBe(false)
  expect(scored.reason).toBe('preview-mismatch')
})

it('still fails when an expected column is missing from the result entirely', () => {
  const trace: DshLoopTrace = {
    caseId: bucketTestCase.id,
    question: bucketTestCase.question,
    datasetId: bucketTestCase.datasetId,
    analystTurns: 1,
    outcome: 'answer',
    toolCalls: [
      {
        name: 'duckdb_query',
        args: { datasetId: 'test', sql: bucketTestCase.goldenSql, parameters: [] },
        result: {
          resultId: 'res_missing_column',
          // No count/`n` column at all — only the bucket label and an
          // unrelated sum, so the expected measure (2106, 1629) can't be
          // found anywhere in the result.
          preview: [
            ['$0-100', '76746.55'],
            ['$100-500', '412314.83'],
          ],
        },
      },
    ],
  }
  const scored = gradeDshLoopTrace(trace, bucketTestCase)
  expect(scored.sqlPass).toBe(false)
  expect(scored.reason).toBe('preview-mismatch')
})

it('requires the exact frozen 69-case, three-dataset production corpus', () => {
  const coreCases = coreDshLoopCases(HELD_OUT_CASES)
  expect(coreCases).toHaveLength(69)
  expect(() => assertCoreDshLoopCoverage(coreCases)).not.toThrow()
  expect(() => assertCoreDshLoopCoverage(coreCases.slice(1))).toThrow(/exactly 69 cases/)
  const duplicateId = [...coreCases]
  duplicateId[1] = duplicateId[0]!
  expect(() => assertCoreDshLoopCoverage(duplicateId)).toThrow(/exactly 69 cases/)
})

it('reports direct queries and composite investigations separately', () => {
  const trace: DshLoopTrace = {
    caseId: 'metrics',
    question: 'metrics',
    datasetId: 'superstore',
    analystTurns: 1,
    outcome: 'answer',
    toolCallsComplete: true,
    toolCalls: [
      { name: 'get_schema', args: {}, result: {} },
      { name: 'duckdb_query', args: {}, result: {} },
      { name: 'investigate_metric', args: {}, result: {} },
    ],
  }
  expect(countDshLoopCalls(trace)).toEqual({
    observedToolCalls: 3,
    duckdbQueryCalls: 1,
    investigateMetricCalls: 1,
    complete: true,
  })
})

it('aggregates measured telemetry and keeps missing or partial coverage explicit', () => {
  const summary = summarizeDshLoopTelemetry([
    {
      caseId: 'measured',
      question: 'measured',
      datasetId: 'superstore',
      analystTurns: 1,
      outcome: 'answer',
      elapsedMs: 12,
      toolCallsComplete: true,
      toolCalls: [{ name: 'duckdb_query', args: {}, result: {} }],
      tokenUsage: {
        uncachedInputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
      },
    },
    {
      caseId: 'partial',
      question: 'partial',
      datasetId: 'olist',
      analystTurns: 1,
      outcome: 'error',
      toolCallsComplete: false,
      toolCalls: [{ name: 'investigate_metric', args: {}, result: {} }],
    },
  ])

  expect(summary).toMatchObject({
    cases: 2,
    elapsedMeasuredCases: 1,
    summedQuestionElapsedMs: 12,
    observedToolCalls: 2,
    duckdbQueryCalls: 1,
    investigateMetricCalls: 1,
    completeCallCountCases: 1,
    incompleteCallCountCases: 1,
    tokenUsageMeasuredCases: 1,
    tokenUsageMissingCases: 1,
    tokenUsage: {
      uncachedInputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    },
  })
})
