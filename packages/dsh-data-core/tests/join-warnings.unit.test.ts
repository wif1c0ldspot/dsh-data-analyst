import { expect, it } from 'vitest'
import { joinWarningsForSql } from '../src/join-warnings.js'

it('warns on a direct join of order_items and order_payments without pre-aggregation', () => {
  const sql =
    'SELECT o.order_id, oi.price, op.payment_value ' +
    'FROM orders o ' +
    'JOIN order_items oi ON oi.order_id = o.order_id ' +
    'JOIN order_payments op ON op.order_id = o.order_id'
  expect(joinWarningsForSql('olist-mini', sql)).toEqual([
    'fanout-risk: order_items x order_payments',
  ])
  expect(joinWarningsForSql('olist', sql)).toEqual(['fanout-risk: order_items x order_payments'])
})

it('does not warn when order_items is pre-aggregated by order_id before the join', () => {
  const sql =
    'SELECT o.order_id, agg.item_total, op.payment_value ' +
    'FROM orders o ' +
    'JOIN (SELECT order_id, SUM(price) AS item_total FROM order_items GROUP BY order_id) agg ' +
    '  ON agg.order_id = o.order_id ' +
    'JOIN order_payments op ON op.order_id = o.order_id'
  expect(joinWarningsForSql('olist-mini', sql)).toEqual([])
})

it('does not warn for a dataset outside the fanout-prone set', () => {
  const sql = 'SELECT * FROM order_items oi JOIN order_payments op ON op.order_id = oi.order_id'
  expect(joinWarningsForSql('superstore', sql)).toEqual([])
  expect(joinWarningsForSql('retail-fixture', sql)).toEqual([])
})

it('does not warn when only one of the two tables is mentioned', () => {
  const onlyItems = 'SELECT * FROM orders o JOIN order_items oi ON oi.order_id = o.order_id'
  expect(joinWarningsForSql('olist-mini', onlyItems)).toEqual([])

  const onlyPayments = 'SELECT * FROM orders o JOIN order_payments op ON op.order_id = o.order_id'
  expect(joinWarningsForSql('olist-mini', onlyPayments)).toEqual([])
})

it('is case-insensitive on table names and the GROUP BY marker', () => {
  const sql =
    'select o.order_id, agg.item_total, op.payment_value ' +
    'from orders o ' +
    'join (select order_id, sum(price) as item_total from ORDER_ITEMS group by order_id) agg ' +
    '  on agg.order_id = o.order_id ' +
    'join ORDER_PAYMENTS op on op.order_id = o.order_id'
  expect(joinWarningsForSql('olist-mini', sql)).toEqual([])
})

it('accepts an explicit relationships override for the reviewed join graph', () => {
  const sql = 'SELECT * FROM order_items oi JOIN order_payments op ON op.order_id = oi.order_id'
  expect(joinWarningsForSql('olist-mini', sql, [])).toEqual([])
})

it('warns on a direct many-to-many relationship for a generic dataset', () => {
  const sql = 'SELECT * FROM movies m JOIN actors a ON a.movie_id = m.movie_id'
  const relationships = [
    {
      datasetId: 'movies',
      fromTable: 'movies',
      toTable: 'actors',
      fromColumns: ['movie_id'],
      toColumns: ['movie_id'],
      cardinality: 'n:n' as const,
    },
  ]
  expect(joinWarningsForSql('movies', sql, relationships)).toEqual(['fanout-risk: movies x actors'])
})

it('warns on transitive fan-out through a shared parent with 1:n cardinality', () => {
  const sql = 'SELECT * FROM claims c1 JOIN claims c2 ON c1.patient_id = c2.patient_id'
  const relationships = [
    {
      datasetId: 'health',
      fromTable: 'patients',
      toTable: 'claims',
      fromColumns: ['patient_id'],
      toColumns: ['patient_id'],
      cardinality: '1:n' as const,
    },
    {
      datasetId: 'health',
      fromTable: 'patients',
      toTable: 'encounters',
      fromColumns: ['patient_id'],
      toColumns: ['patient_id'],
      cardinality: '1:n' as const,
    },
  ]
  // claims and encounters are both many-sides of patients.
  const sqlBoth = 'SELECT * FROM claims c JOIN encounters e ON e.patient_id = c.patient_id'
  expect(joinWarningsForSql('health', sqlBoth, relationships)).toEqual([
    'fanout-risk: claims x encounters',
  ])
  // A self-join on the same many-side table does not warn (single table).
  expect(joinWarningsForSql('health', sql, relationships)).toEqual([])
})
