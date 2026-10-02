import { expect, it } from 'vitest'
import {
  inferSharedFilterKeys,
  planDashboardFilters,
  stripFilterCaption,
  unwrapEqualityFilter,
} from '../src/dashboard-filters.js'
import { applyEqualityFilter } from '../src/query-filter.js'

it('applies region to mapped slots and discloses the rest', () => {
  const sqlByAnalysis = new Map([
    ['ana_a', 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region'],
    ['ana_b', 'SELECT category, COUNT(*) AS n FROM orders GROUP BY category'],
  ])
  const plans = planDashboardFilters(
    [
      { analysisId: 'ana_a', revision: 1, sharedFilterKeys: ['region'] },
      { analysisId: 'ana_b', revision: 1, sharedFilterKeys: [] },
    ],
    sqlByAnalysis,
    { column: 'region', value: 'West' },
  )
  expect(plans[0]?.supported).toBe(true)
  expect(plans[0]?.nextSql).toContain('_analysis_filter')
  expect(plans[0]?.nextSql).toContain("'West'")
  expect(plans[1]?.supported).toBe(false)
  expect(plans[1]?.reason).toBe('no-shared-filter-keys')
})

it('rejects a filter column that a mapped slot did not declare', () => {
  const sqlByAnalysis = new Map([
    ['ana_a', 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region'],
  ])
  const plans = planDashboardFilters(
    [{ analysisId: 'ana_a', revision: 1, sharedFilterKeys: ['region'] }],
    sqlByAnalysis,
    { column: 'category', value: 'Widgets' },
  )
  expect(plans[0]?.supported).toBe(false)
  expect(plans[0]?.reason).toBe('column-not-mapped')
  expect(plans[0]?.nextSql).toBeUndefined()
})

it('carries analysisId and revision through for every slot', () => {
  const sqlByAnalysis = new Map([['ana_c', 'SELECT region FROM orders']])
  const plans = planDashboardFilters(
    [{ analysisId: 'ana_c', revision: 3, sharedFilterKeys: ['region'] }],
    sqlByAnalysis,
    { column: 'region', value: 'East' },
  )
  expect(plans[0]).toMatchObject({ analysisId: 'ana_c', revision: 3, supported: true })
})

it('infers shared filter keys as the intersection of result columns and the reviewed list', () => {
  const sql = 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region'
  expect(inferSharedFilterKeys(sql, ['region', 'revenue'])).toEqual(['region'])
})

it('infers no shared filter keys when no reviewed column is present', () => {
  const sql = 'SELECT customer_id, COUNT(*) AS n FROM orders GROUP BY customer_id'
  expect(inferSharedFilterKeys(sql, ['customer_id', 'n'])).toEqual([])
})

it('matches the reviewed list case-insensitively but preserves result column casing', () => {
  const sql = 'SELECT Region, SUM(sales) AS Revenue FROM orders GROUP BY Region'
  expect(inferSharedFilterKeys(sql, ['Region', 'Revenue'])).toEqual(['Region'])
})

it('unwrapEqualityFilter reverses exactly what applyEqualityFilter produced', () => {
  const base = 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region'
  const wrapped = applyEqualityFilter(base, 'region', 'West')
  expect(unwrapEqualityFilter(wrapped)).toBe(base)
})

it('unwrapEqualityFilter round-trips through a re-wrap with a different column/value', () => {
  const base = 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region'
  const wrappedOnce = applyEqualityFilter(base, 'region', 'West')
  const rewrapped = applyEqualityFilter(unwrapEqualityFilter(wrappedOnce), 'region', 'East')
  expect(rewrapped).not.toContain('West')
  expect(rewrapped).toContain('East')
  expect((rewrapped.match(/WITH _analysis_filter AS/g) ?? []).length).toBe(1)
})

it('unwrapEqualityFilter leaves SQL unchanged when it was not produced by applyEqualityFilter', () => {
  const sql = 'SELECT category, COUNT(*) AS n FROM orders GROUP BY category'
  expect(unwrapEqualityFilter(sql)).toBe(sql)
})

it('unwrapEqualityFilter handles a value containing an escaped quote', () => {
  const base = 'SELECT region, SUM(sales) AS revenue FROM orders GROUP BY region'
  const wrapped = applyEqualityFilter(base, 'region', "O'Brien")
  expect(unwrapEqualityFilter(wrapped)).toBe(base)
})

it('stripFilterCaption removes a single trailing filter caption', () => {
  expect(stripFilterCaption('Revenue by region [filter region=West]')).toBe('Revenue by region')
})

it('stripFilterCaption leaves a question with no caption unchanged', () => {
  expect(stripFilterCaption('Revenue by region')).toBe('Revenue by region')
})

it('stripFilterCaption only removes the caption, not legitimate trailing text', () => {
  const question = 'Revenue by region (2024)'
  expect(stripFilterCaption(question)).toBe(question)
})
