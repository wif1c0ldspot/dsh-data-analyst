import { expect, it } from 'vitest'
import { inferCardinality, proposeKeyCandidates, type ColumnProfile } from '../src/profiler.js'

function column(name: string, overrides: Partial<ColumnProfile> = {}): ColumnProfile {
  return { name, type: 'BIGINT', rowCount: 100, nullCount: 0, distinctCount: 100, ...overrides }
}

it('proposes single-column primary keys with full uniqueness and no NULLs', () => {
  const keys = proposeKeyCandidates([
    column('id'),
    column('customer_id', { distinctCount: 80 }),
    column('note', { nullCount: 5 }),
    column('empty', { rowCount: 0, distinctCount: 0, nullCount: 0 }),
  ])
  expect(keys.map((key) => key.columns)).toEqual([['id']])
  expect(keys[0]?.uniqueness).toBe(1)
  expect(keys[0]?.nullRatio).toBe(0)
})

it('infers relationship cardinality from join fan-out', () => {
  expect(inferCardinality(1, 1)).toBe('1:1')
  expect(inferCardinality(1, 25)).toBe('n:1') // many from rows per to row
  expect(inferCardinality(4, 1)).toBe('1:n') // one from row per many to rows
  expect(inferCardinality(4, 25)).toBe('n:n')
})
