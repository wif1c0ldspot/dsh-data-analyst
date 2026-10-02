import { expect, it } from 'vitest'
import { ComputedFindingError, resolveComputedFinding } from '../src/computed-finding.js'
import type { StoredQueryResult } from '../src/stored-result.js'

const baseResult = (): StoredQueryResult => ({
  resultId: 'res_test',
  datasetVersionId: 'dv_1',
  semanticRevisionId: 'sem_1',
  sql: 'SELECT amount FROM retail',
  columns: [{ name: 'amount', logicalType: 'DOUBLE', unit: 'USD' }],
  rows: [[10], [20], [null]],
  preview: [[10]],
  rowCount: 3,
  previewTruncated: false,
})

it('resolves column extrema and non-NULL counts from complete stored rows', () => {
  const result = baseResult()
  const minimum = resolveComputedFinding(result, {
    resultId: 'res_test',
    datasetVersionId: 'dv_1',
    semanticRevisionId: 'sem_1',
    operation: 'column_minimum',
    field: 'amount',
    units: 'USD',
    filterScope: 'retail rows',
  })
  expect(minimum.exactValue).toBe('10')
  expect(minimum.sentence).toContain('Minimum')
  expect(minimum.sentence).toContain('USD')

  const nonNull = resolveComputedFinding(result, {
    resultId: 'res_test',
    datasetVersionId: 'dv_1',
    semanticRevisionId: 'sem_1',
    operation: 'column_non_null_count',
    field: 'amount',
  })
  expect(nonNull.exactValue).toBe('2')
})

it('rejects foreign or stale identity references', () => {
  expect(() =>
    resolveComputedFinding(baseResult(), {
      resultId: 'res_other',
      datasetVersionId: 'dv_1',
      semanticRevisionId: 'sem_1',
      operation: 'row_count',
    }),
  ).toThrow(ComputedFindingError)
})

it('rejects incomplete results and all-NULL columns', () => {
  const incomplete = baseResult()
  delete incomplete.rows
  expect(() =>
    resolveComputedFinding(incomplete, {
      resultId: 'res_test',
      datasetVersionId: 'dv_1',
      semanticRevisionId: 'sem_1',
      operation: 'row_count',
    }),
  ).toThrow(/Complete stored rows/)

  const allNull = baseResult()
  allNull.rows = [[null], [null]]
  allNull.rowCount = 2
  expect(() =>
    resolveComputedFinding(allNull, {
      resultId: 'res_test',
      datasetVersionId: 'dv_1',
      semanticRevisionId: 'sem_1',
      operation: 'column_maximum',
      field: 'amount',
    }),
  ).toThrow(/all NULL/)
})

it('preserves exact decimal strings from recipe ratio results and rejects NULL ratios', () => {
  const ratioResult: StoredQueryResult = {
    resultId: 'res_ratio',
    datasetVersionId: 'dv_1',
    semanticRevisionId: 'sem_1',
    sql: 'SELECT population_rate, undefined_reason FROM recipe',
    columns: [
      { name: 'population_rate', logicalType: 'DECIMAL(38,20)' },
      { name: 'undefined_reason', logicalType: 'VARCHAR' },
    ],
    rows: [['0.12345678901234567890', null]],
    preview: [['0.12345678901234567890', null]],
    rowCount: 1,
    previewTruncated: false,
  }
  const finding = resolveComputedFinding(ratioResult, {
    resultId: 'res_ratio',
    datasetVersionId: 'dv_1',
    semanticRevisionId: 'sem_1',
    operation: 'ratio_of_sums',
    field: 'numerator',
    denominatorField: 'denominator',
    nullScope: 'NULL denominators excluded',
  })
  expect(finding.exactValue).toBe('0.12345678901234567890')

  ratioResult.rows = [[null, 'ZERO_DENOMINATOR']]
  expect(() =>
    resolveComputedFinding(ratioResult, {
      resultId: 'res_ratio',
      datasetVersionId: 'dv_1',
      semanticRevisionId: 'sem_1',
      operation: 'ratio_of_sums',
    }),
  ).toThrow(/denominator sum is zero/)
})

it('resolves duplicate-excess recipe columns without claiming duplicate transactions', () => {
  const result: StoredQueryResult = {
    resultId: 'res_dup',
    datasetVersionId: 'dv_1',
    semanticRevisionId: 'sem_1',
    sql: 'SELECT total_count, distinct_row_count, duplicate_excess FROM recipe',
    columns: [
      { name: 'total_count', logicalType: 'BIGINT' },
      { name: 'distinct_row_count', logicalType: 'BIGINT' },
      { name: 'duplicate_excess', logicalType: 'BIGINT' },
    ],
    rows: [['10', '8', '2']],
    preview: [['10', '8', '2']],
    rowCount: 1,
    previewTruncated: false,
  }
  const finding = resolveComputedFinding(result, {
    resultId: 'res_dup',
    datasetVersionId: 'dv_1',
    semanticRevisionId: 'sem_1',
    operation: 'duplicate_excess',
  })
  expect(finding.exactValue).toBe('2')
  expect(finding.sentence).toContain('not proven duplicate transactions')
})

it('keeps mean/median findings from asserting a heavy-tailed distribution', () => {
  const result: StoredQueryResult = {
    resultId: 'res_desc',
    datasetVersionId: 'dv_1',
    semanticRevisionId: 'sem_1',
    sql: 'SELECT mean_value, median_value FROM recipe',
    columns: [
      { name: 'mean_value', logicalType: 'DOUBLE' },
      { name: 'median_value', logicalType: 'DOUBLE' },
    ],
    rows: [[12.5, 10]],
    preview: [[12.5, 10]],
    rowCount: 1,
    previewTruncated: false,
  }
  const mean = resolveComputedFinding(result, {
    resultId: 'res_desc',
    datasetVersionId: 'dv_1',
    semanticRevisionId: 'sem_1',
    operation: 'descriptive_mean',
    field: 'amount',
  })
  expect(mean.exactValue).toBe('12.5')
  expect(mean.sentence).toContain('does not establish a heavy-tailed distribution')
})

it('rejects grouped recipe results with inconsistent values', () => {
  const result: StoredQueryResult = {
    resultId: 'res_group',
    datasetVersionId: 'dv_1',
    semanticRevisionId: 'sem_1',
    sql: 'SELECT mean_value FROM recipe GROUP BY region',
    columns: [{ name: 'mean_value', logicalType: 'DOUBLE' }],
    rows: [[1], [2]],
    preview: [[1], [2]],
    rowCount: 2,
    previewTruncated: false,
  }
  expect(() =>
    resolveComputedFinding(result, {
      resultId: 'res_group',
      datasetVersionId: 'dv_1',
      semanticRevisionId: 'sem_1',
      operation: 'descriptive_mean',
      field: 'amount',
      filterScope: 'grouped by region without selecting one group',
    }),
  ).toThrow(/multiple values/)
})
