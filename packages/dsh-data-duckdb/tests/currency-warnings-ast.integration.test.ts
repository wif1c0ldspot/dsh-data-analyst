/**
 * Real-parser round trip for `currencyWarningsForStatement`
 * (dsh-data-core/currency-warnings.ts): actual SQL text through DuckDB's
 * own `json_serialize_sql` (`parseSqlStatement`), not the hand-built
 * fixtures `dsh-data-core`'s own unit test uses. Confirms the AST shapes
 * that design assumed (captured empirically before writing the module) are
 * what the pinned DuckDB grammar actually produces.
 */
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  currencyWarningsForStatement,
  type CurrencyDimensionRef,
} from 'dsh-data-core/currency-warnings'
import { parseSqlStatement } from '../src/sql-policy.js'

let db: DuckDBInstance
let connection: DuckDBConnection

beforeAll(async () => {
  db = await DuckDBInstance.create(':memory:')
  connection = await db.connect()
})

afterAll(() => {
  connection.closeSync()
  db.closeSync()
})

const ORDERS_CURRENCY: CurrencyDimensionRef = {
  tableId: 'orders',
  column: 'currency',
  currencies: ['EUR', 'GBP', 'USD'],
}

async function warningsFor(sql: string, dimensions: readonly CurrencyDimensionRef[]) {
  const statement = await parseSqlStatement(connection, sql)
  return currencyWarningsForStatement(statement, dimensions)
}

it('warns on a real ungrouped SUM', async () => {
  expect(await warningsFor('SELECT SUM(amount) FROM orders', [ORDERS_CURRENCY])).toEqual([
    'currency-mix-risk: orders.currency mixes EUR, GBP, USD — group or filter by currency before trusting a SUM/AVG in this table',
  ])
})

it('does not warn on a real GROUP BY currency', async () => {
  expect(
    await warningsFor('SELECT currency, SUM(amount) FROM orders GROUP BY currency', [
      ORDERS_CURRENCY,
    ]),
  ).toEqual([])
})

it('does not warn on a real WHERE currency = literal filter', async () => {
  expect(
    await warningsFor("SELECT SUM(amount) FROM orders WHERE currency = 'USD'", [ORDERS_CURRENCY]),
  ).toEqual([])
})

it('does not warn on a real WHERE with the literal on the left', async () => {
  expect(
    await warningsFor("SELECT SUM(amount) FROM orders WHERE 'USD' = currency", [ORDERS_CURRENCY]),
  ).toEqual([])
})

it('resolves a real qualified join column through its alias', async () => {
  expect(
    await warningsFor(
      'SELECT SUM(o.amount) FROM orders o JOIN order_items oi ON oi.order_id = o.order_id',
      [ORDERS_CURRENCY],
    ),
  ).toHaveLength(1)
})

it('does not guess a real unqualified column across an ambiguous join', async () => {
  expect(
    await warningsFor(
      'SELECT SUM(amount) FROM orders o JOIN order_items oi ON oi.order_id = o.order_id',
      [ORDERS_CURRENCY],
    ),
  ).toEqual([])
})

it('isolates a real pre-aggregating subquery from the outer scope', async () => {
  expect(
    await warningsFor(
      'SELECT region.name, agg.total FROM region ' +
        'JOIN (SELECT SUM(amount) AS total FROM orders) agg ON true',
      [ORDERS_CURRENCY],
    ),
  ).toHaveLength(1)
  expect(
    await warningsFor(
      'SELECT region.name, agg.total FROM region ' +
        'JOIN (SELECT currency, SUM(amount) AS total FROM orders GROUP BY currency) agg ON true',
      [ORDERS_CURRENCY],
    ),
  ).toEqual([])
})

it('does not warn on a real query with no aggregate', async () => {
  expect(await warningsFor('SELECT * FROM orders', [ORDERS_CURRENCY])).toEqual([])
})

it('reuses one already-parsed statement for multiple independent warning computations', async () => {
  const statement = await parseSqlStatement(connection, 'SELECT SUM(amount) FROM orders')
  const productsCurrency: CurrencyDimensionRef = {
    tableId: 'products',
    column: 'list_currency',
    currencies: ['CAD', 'USD'],
  }
  expect(currencyWarningsForStatement(statement, [ORDERS_CURRENCY])).toHaveLength(1)
  expect(currencyWarningsForStatement(statement, [productsCurrency])).toEqual([])
})
