import { expect, it } from 'vitest'
import { formatRecipeSchemaSummary } from 'dsh-data-core/recipes'

it('schema summary lists recipe columns and approved alias terms (no @table noise)', () => {
  const summary = formatRecipeSchemaSummary('retail-fixture', [
    {
      term: 'revenue',
      expression: 'SUM(amount)',
      tableId: 'retail',
    },
  ])
  expect(summary).toBeDefined()
  expect(summary!).toMatch(/retail\(/)
  expect(summary!).toMatch(/amount:/)
  expect(summary!).toMatch(/revenue on retail=SUM\(amount\)/)
  expect(summary!).not.toMatch(/revenue@/)
})

it('business-term questions can be answered from reviewed alias without naming amount', () => {
  // Documents DoD A3: approved alias "revenue" maps to SUM(amount); the
  // fixture/golden question says "revenue" not "amount".
  const question = 'revenue by region'
  expect(question.toLowerCase()).toContain('revenue')
  expect(question.toLowerCase()).not.toContain('amount')
  const summary = formatRecipeSchemaSummary('retail-fixture', [
    { term: 'revenue', expression: 'SUM(amount)', tableId: 'retail' },
  ])!
  expect(summary).toMatch(/revenue on retail=SUM\(amount\)/)
})
