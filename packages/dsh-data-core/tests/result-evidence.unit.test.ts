import { expect, it } from 'vitest'
import { deriveResultEvidence } from '../src/result-evidence.js'
import type { StoredQueryResult } from '../src/stored-result.js'

const fixture = (): StoredQueryResult => ({
  resultId: 'res_test',
  datasetVersionId: 'data-v1',
  semanticRevisionId: 'sem-v1',
  sql: 'SELECT hour, mean FROM observations',
  columns: [
    { name: 'hour', logicalType: 'INTEGER' },
    { name: 'mean', logicalType: 'DOUBLE', unit: 'observations/hour' },
  ],
  rows: Array.from({ length: 48 }, (_, i) => [i, i === 41 ? 525.29 : 10]),
  preview: [[0, 10]],
  rowCount: 48,
  previewTruncated: true,
})

it('derives extrema beyond observation preview and binds evidence to revision', () => {
  const evidence = deriveResultEvidence(fixture(), {
    analysisId: 'ana_test',
    revision: 3,
    filter: 'workingday = 1',
  })
  expect(evidence.complete).toBe(true)
  expect(evidence.facts[1]).toMatchObject({
    unit: 'observations/hour',
    maximum: 525.29,
    maximumRow: 41,
    nonNullCount: 48,
  })
  expect(evidence).toMatchObject({ revision: 3, resultId: 'res_test', filter: 'workingday = 1' })
})
it('never substitutes preview rows or incomplete stored rows', () => {
  const result = fixture()
  delete result.rows
  expect(deriveResultEvidence(result).facts).toEqual([])
  result.rows = [[0, 10]]
  expect(deriveResultEvidence(result).complete).toBe(false)
})
it('withholds unsafe serialized numeric values instead of rounding or treating null as zero', () => {
  const result = fixture()
  result.rows = [
    [0, null],
    [1, '9007199254740993'],
  ]
  result.rowCount = 2
  expect(deriveResultEvidence(result).facts.map((f) => f.column)).toEqual(['hour'])
  expect(deriveResultEvidence(result).warnings.join(' ')).toContain('exact decimal')
})

it('includes exact serialized integer counts while withholding decimals and unsafe integers', () => {
  const result = fixture()
  result.columns = [
    { name: 'count', logicalType: 'BIGINT' },
    { name: 'amount', logicalType: 'DECIMAL(18,2)' },
  ]
  result.rows = [
    ['50474', '0.10'],
    ['44974', '0.20'],
    [null, null],
  ]
  result.rowCount = 3
  expect(deriveResultEvidence(result).facts).toEqual([
    {
      column: 'count',
      minimum: 44974,
      maximum: 50474,
      minimumRow: 1,
      maximumRow: 0,
      nonNullCount: 2,
      integerDomain: true,
      distinctCount: 2,
    },
  ])
  result.rows[0]![0] = '9007199254740993'
  expect(deriveResultEvidence(result).facts).toEqual([])
})

it('flags integerDomain and distinctCount from complete stored rows', () => {
  const result = fixture()
  const evidence = deriveResultEvidence(result)
  expect(evidence.facts.find((f) => f.column === 'hour')).toMatchObject({
    integerDomain: true,
    distinctCount: 48,
  })
  expect(evidence.facts.find((f) => f.column === 'mean')).toMatchObject({
    integerDomain: false,
    distinctCount: 2,
  })
})
