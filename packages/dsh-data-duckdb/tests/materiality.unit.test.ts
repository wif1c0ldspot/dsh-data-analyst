import { expect, it } from 'vitest'
import { MAX_TYPE_REPROPOSALS, evaluateMateriality } from '../src/materiality.js'

it('is not material when cast-nulls are rare', () => {
  const decision = evaluateMateriality([
    {
      id: 'retail',
      sourceFile: 'retail.csv',
      rows: 200,
      rejectedRows: 0,
      rawRowCount: 200,
      castNullCounts: { amount: 1 },
      loadStrategy: 'raw_then_typed',
    },
  ])
  expect(decision.material).toBe(false)
})

it('is material when a column exceeds 1% cast-nulls', () => {
  const decision = evaluateMateriality(
    [
      {
        id: 'retail',
        sourceFile: 'retail.csv',
        rows: 3,
        rejectedRows: 0,
        rawRowCount: 3,
        castNullCounts: { amount: 1 },
        loadStrategy: 'raw_then_typed',
      },
    ],
    [{ tableId: 'retail', name: 'amount', type: 'DECIMAL(18,2)' }],
  )
  expect(decision.material).toBe(true)
  expect(decision.reasons.some((reason) => reason.includes('retail.amount'))).toBe(true)
  expect(decision.reasons.some((reason) => reason.startsWith('type-widen'))).toBe(true)
  expect(decision.typeWidenColumns).toBe(1)
})

it('fires type-widen when three typed columns have any cast-nulls', () => {
  const decision = evaluateMateriality(
    [
      {
        id: 't',
        sourceFile: 't.csv',
        rows: 10_000,
        rejectedRows: 0,
        rawRowCount: 10_000,
        castNullCounts: { a: 1, b: 1, c: 1 },
        loadStrategy: 'raw_then_typed',
      },
    ],
    [
      { tableId: 't', name: 'a', type: 'BIGINT' },
      { tableId: 't', name: 'b', type: 'DATE' },
      { tableId: 't', name: 'c', type: 'DOUBLE' },
    ],
  )
  expect(decision.material).toBe(true)
  expect(decision.typeWidenColumns).toBe(3)
  expect(decision.reasons.some((reason) => /type-widen|3 columns pressure/.test(reason))).toBe(true)
})

it('names the affected column and the type that would have accepted it', () => {
  const decision = evaluateMateriality(
    [
      {
        id: 'retail',
        sourceFile: 'retail.csv',
        rows: 10_000,
        rejectedRows: 0,
        rawRowCount: 10_000,
        castNullCounts: { amount: 400, note: 1 },
        loadStrategy: 'raw_then_typed',
      },
    ],
    [{ tableId: 'retail', name: 'amount', type: 'DOUBLE' }],
  )
  // A count alone leaves the analyst to work out which column and what to do;
  // the proposal names both, worst share first.
  expect(decision.reproposals.map((proposal) => proposal.column)).toEqual(['amount', 'note'])
  expect(decision.reproposals[0]).toMatchObject({
    tableId: 'retail',
    column: 'amount',
    approvedType: 'DOUBLE',
    proposedType: 'VARCHAR',
    castNullCells: 400,
    material: true,
  })
  expect(decision.reproposals[0]!.castNullShare).toBeCloseTo(0.04, 6)
  // A column below the materiality threshold is still named, just not flagged.
  expect(decision.reproposals[1]).toMatchObject({
    column: 'note',
    castNullCells: 1,
    material: false,
  })
  expect(decision.reproposals[1]!.approvedType).toBeUndefined()
})

it('carries no proposals when nothing was cast to NULL, and caps the list', () => {
  const clean = evaluateMateriality([
    {
      id: 't',
      sourceFile: 't.csv',
      rows: 5,
      rejectedRows: 0,
      castNullCounts: {},
      loadStrategy: 'raw_then_typed',
    },
  ])
  expect(clean.reproposals).toEqual([])

  const many = evaluateMateriality([
    {
      id: 'wide',
      sourceFile: 'wide.csv',
      rows: 100,
      rejectedRows: 0,
      rawRowCount: 100,
      castNullCounts: Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`c${index}`, index + 1]),
      ),
      loadStrategy: 'raw_then_typed',
    },
  ])
  expect(many.reproposals).toHaveLength(MAX_TYPE_REPROPOSALS)
  // Ranked by cast-null share, so the worst column leads.
  expect(many.reproposals[0]!.column).toBe('c19')
})
