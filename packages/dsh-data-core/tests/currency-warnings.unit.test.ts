/**
 * Pure unit coverage for `currencyWarningsForStatement`'s tree walk, against
 * hand-built fixtures shaped exactly like real `json_serialize_sql` output
 * (captured empirically before writing this module). `dsh-data-core`
 * has no DuckDB dependency, so this module never parses SQL itself; the
 * real-parser round trip is covered separately in
 * `dsh-data-duckdb/tests/currency-warnings-ast.integration.test.ts`.
 */
import { expect, it } from 'vitest'
import {
  currencyWarningsForStatement,
  type CurrencyDimensionRef,
} from '../src/currency-warnings.js'

const ORDERS_CURRENCY: CurrencyDimensionRef = {
  tableId: 'orders',
  column: 'currency',
  currencies: ['EUR', 'GBP', 'USD'],
}

function columnRef(...columnNames: string[]) {
  return { class: 'COLUMN_REF', type: 'COLUMN_REF', column_names: columnNames }
}

function sumOf(...columnNames: string[]) {
  return {
    class: 'FUNCTION',
    type: 'FUNCTION',
    function_name: 'sum',
    children: [columnRef(...columnNames)],
  }
}

function baseTable(tableName: string, alias = '') {
  return { type: 'BASE_TABLE', table_name: tableName, alias }
}

function equalsFilter(columnNames: string[], value: string) {
  return {
    class: 'COMPARISON',
    type: 'COMPARE_EQUAL',
    left: columnRef(...columnNames),
    right: { class: 'CONSTANT', type: 'VALUE_CONSTANT', value: { type: { id: 'VARCHAR' }, value } },
  }
}

/** Wraps a bare SELECT_NODE the way `json_serialize_sql` wraps `statements[0]`. */
function statement(node: Record<string, unknown>) {
  return {
    node: {
      type: 'SELECT_NODE',
      select_list: [],
      from_table: baseTable('orders'),
      where_clause: null,
      group_expressions: [],
      having: null,
      ...node,
    },
    named_param_map: [],
  }
}

it('warns on an ungrouped, unfiltered SUM over a flagged table', () => {
  const stmt = statement({ select_list: [sumOf('amount')] })
  expect(currencyWarningsForStatement(stmt, [ORDERS_CURRENCY])).toEqual([
    'currency-mix-risk: orders.currency mixes EUR, GBP, USD — group or filter by currency before trusting a SUM/AVG in this table',
  ])
})

it('warns on AVG the same way as SUM', () => {
  const stmt = statement({
    select_list: [{ class: 'FUNCTION', function_name: 'avg', children: [columnRef('amount')] }],
  })
  expect(currencyWarningsForStatement(stmt, [ORDERS_CURRENCY])).toHaveLength(1)
})

it('does not warn when GROUP BY names the currency column', () => {
  const stmt = statement({
    select_list: [columnRef('currency'), sumOf('amount')],
    group_expressions: [columnRef('currency')],
  })
  expect(currencyWarningsForStatement(stmt, [ORDERS_CURRENCY])).toEqual([])
})

it('does not warn when a WHERE equality filter names the currency column (AST improvement over the regex version)', () => {
  const stmt = statement({
    select_list: [sumOf('amount')],
    where_clause: equalsFilter(['currency'], 'USD'),
  })
  expect(currencyWarningsForStatement(stmt, [ORDERS_CURRENCY])).toEqual([])
})

it('recognizes an equality filter conjoined with AND alongside an unrelated predicate', () => {
  const stmt = statement({
    select_list: [sumOf('amount')],
    where_clause: {
      class: 'CONJUNCTION',
      type: 'CONJUNCTION_AND',
      children: [equalsFilter(['region'], 'US'), equalsFilter(['currency'], 'USD')],
    },
  })
  expect(currencyWarningsForStatement(stmt, [ORDERS_CURRENCY])).toEqual([])
})

it('does not warn when the query has no SUM/AVG at all', () => {
  const stmt = statement({ select_list: [columnRef('amount')] })
  expect(currencyWarningsForStatement(stmt, [ORDERS_CURRENCY])).toEqual([])
})

it('does not warn when the aggregate reads a different, unflagged table', () => {
  const stmt = statement({
    select_list: [sumOf('amount')],
    from_table: baseTable('order_items'),
  })
  expect(currencyWarningsForStatement(stmt, [ORDERS_CURRENCY])).toEqual([])
})

it('does not warn when there are no currency dimensions at all', () => {
  const stmt = statement({ select_list: [sumOf('amount')] })
  expect(currencyWarningsForStatement(stmt, [])).toEqual([])
})

it('resolves a qualified column through a table alias in a join', () => {
  const stmt = statement({
    select_list: [
      { class: 'FUNCTION', function_name: 'sum', children: [columnRef('o', 'amount')] },
    ],
    from_table: {
      type: 'JOIN',
      left: baseTable('orders', 'o'),
      right: baseTable('order_items', 'oi'),
    },
  })
  expect(currencyWarningsForStatement(stmt, [ORDERS_CURRENCY])).toHaveLength(1)
})

it('does not guess an unqualified column across an ambiguous multi-table join', () => {
  const stmt = statement({
    select_list: [sumOf('amount')],
    from_table: {
      type: 'JOIN',
      left: baseTable('orders', 'o'),
      right: baseTable('order_items', 'oi'),
    },
  })
  expect(currencyWarningsForStatement(stmt, [ORDERS_CURRENCY])).toEqual([])
})

it('isolates a subquery pre-aggregation as its own scope instead of inheriting the outer GROUP BY', () => {
  // Outer query groups by something unrelated; the flagged SUM lives only
  // inside the subquery, which does NOT group by currency — must still warn.
  const stmt = statement({
    select_list: [columnRef('region')],
    from_table: {
      type: 'JOIN',
      left: baseTable('regions', 'r'),
      right: {
        type: 'SUBQUERY',
        alias: 'agg',
        subquery: statement({ select_list: [sumOf('amount')] }),
      },
    },
    group_expressions: [columnRef('region')],
  })
  expect(currencyWarningsForStatement(stmt, [ORDERS_CURRENCY])).toHaveLength(1)
})

it('does not warn when the subquery itself groups by the currency column', () => {
  const stmt = statement({
    select_list: [columnRef('region')],
    from_table: {
      type: 'JOIN',
      left: baseTable('regions', 'r'),
      right: {
        type: 'SUBQUERY',
        alias: 'agg',
        subquery: statement({
          select_list: [columnRef('currency'), sumOf('amount')],
          group_expressions: [columnRef('currency')],
        }),
      },
    },
  })
  expect(currencyWarningsForStatement(stmt, [ORDERS_CURRENCY])).toEqual([])
})

it('deduplicates repeated warnings for the same dimension across multiple aggregates', () => {
  const stmt = statement({ select_list: [sumOf('amount'), sumOf('amount')] })
  expect(currencyWarningsForStatement(stmt, [ORDERS_CURRENCY])).toHaveLength(1)
})

it('reports each flagged table only when its own table is actually referenced', () => {
  const productsCurrency: CurrencyDimensionRef = {
    tableId: 'products',
    column: 'list_currency',
    currencies: ['CAD', 'USD'],
  }
  const stmt = statement({ select_list: [sumOf('amount')] })
  expect(currencyWarningsForStatement(stmt, [ORDERS_CURRENCY, productsCurrency])).toEqual([
    'currency-mix-risk: orders.currency mixes EUR, GBP, USD — group or filter by currency before trusting a SUM/AVG in this table',
  ])
})
