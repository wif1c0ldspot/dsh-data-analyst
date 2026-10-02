/**
 * Deterministic SQL fixtures and graders for published Olist analytics.
 * Kept in `src/` so CI always typechecks/compiles them even when the
 * published-catalog integration suite is skipped.
 */

/** Known smoke totals from `ingest-dataset.mjs` for the reviewed full recipe. */
export const OLIST_SMOKE_TABLE_ROWS = {
  category_translation: 71,
  customers: 99_441,
  geolocation: 1_000_163,
  order_items: 112_650,
  order_payments: 103_886,
  order_reviews: 99_224,
  orders: 99_441,
  products: 32_951,
  sellers: 3_095,
} as const

export const OLIST_ALLOWED_TABLES = [
  'customers',
  'geolocation',
  'order_items',
  'order_payments',
  'order_reviews',
  'orders',
  'products',
  'sellers',
  'category_translation',
] as const

export const OLIST_ANALYTICS_SQL = {
  /** Fanout: at least one order has multiple line items. */
  fanoutExists: `
SELECT EXISTS (
  SELECT 1
  FROM order_items
  GROUP BY order_id
  HAVING COUNT(*) > 1
) AS has_multi_item_order
`.trim(),

  /** Cancellations present in the orders table. */
  canceledCount: `
SELECT COUNT(*) AS canceled_count
FROM orders
WHERE order_status = 'canceled'
`.trim(),

  /**
   * Payments join on a bounded delivered sample: sum must be finite and positive
   * when the sample has matching payment rows.
   */
  deliveredPaymentSum: `
SELECT SUM(p.payment_value) AS payment_sum
FROM (
  SELECT order_id
  FROM orders
  WHERE order_status = 'delivered'
  LIMIT 2000
) o
INNER JOIN order_payments p ON o.order_id = p.order_id
`.trim(),

  /**
   * NULL delivery timestamps among delivered/shipped orders (may be empty;
   * asserts the query shape, not a brittle absolute count).
   */
  nullDeliverySample: `
SELECT
  order_id,
  order_status,
  order_delivered_customer_date
FROM orders
WHERE order_status IN ('delivered', 'shipped')
  AND order_delivered_customer_date IS NULL
LIMIT 10
`.trim(),

  /**
   * Grain safety: naive customers↔orders join row count vs distinct customers.
   * Inflate is join_rows - customers_distinct (>= 0). On full Olist, customer_id
   * is typically 1:1 with orders so inflate may be 0; still documents the check.
   */
  customerOrderGrain: `
SELECT
  (SELECT COUNT(DISTINCT customer_id) FROM customers) AS customers_distinct,
  (SELECT COUNT(*) FROM orders) AS orders_count,
  (
    SELECT COUNT(*)
    FROM customers c
    INNER JOIN orders o ON c.customer_id = o.customer_id
  ) AS join_rows
`.trim(),
} as const

export type QueryLike = {
  rowCount: number
  columns: Array<{ name: string; logicalType: string }>
  preview: unknown[][]
}

function scalarNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  if (value === null || value === undefined) return Number.NaN
  return Number(value)
}

export function gradeFanoutExists(result: QueryLike): { ok: true } | { ok: false; reason: string } {
  if (result.rowCount !== 1 || result.preview.length < 1) {
    return { ok: false, reason: 'fanout query must return one row' }
  }
  const flag = result.preview[0]![0]
  const truthy = flag === true || flag === 1 || flag === 1n || flag === 'true' || flag === '1'
  if (!truthy) return { ok: false, reason: 'expected at least one multi-item order' }
  return { ok: true }
}

export function gradeCanceledCount(
  result: QueryLike,
): { ok: true; count: number } | { ok: false; reason: string } {
  if (result.rowCount !== 1 || result.preview.length < 1) {
    return { ok: false, reason: 'canceled count must return one row' }
  }
  const count = scalarNumber(result.preview[0]![0])
  if (!Number.isFinite(count) || count <= 0) {
    return {
      ok: false,
      reason: `expected canceled_count > 0, got ${String(result.preview[0]![0])}`,
    }
  }
  return { ok: true, count }
}

export function gradeDeliveredPaymentSum(
  result: QueryLike,
): { ok: true; sum: number } | { ok: false; reason: string } {
  if (result.rowCount !== 1 || result.preview.length < 1) {
    return { ok: false, reason: 'payment sum must return one row' }
  }
  const sum = scalarNumber(result.preview[0]![0])
  if (!Number.isFinite(sum) || sum <= 0) {
    return {
      ok: false,
      reason: `expected finite payment_sum > 0, got ${String(result.preview[0]![0])}`,
    }
  }
  return { ok: true, sum }
}

export function gradeNullDeliverySample(
  result: QueryLike,
): { ok: true } | { ok: false; reason: string } {
  const expected = ['order_id', 'order_status', 'order_delivered_customer_date']
  const names = result.columns.map((column) => column.name)
  for (const name of expected) {
    if (!names.includes(name)) {
      return { ok: false, reason: `missing column ${name}` }
    }
  }
  for (const column of result.columns) {
    if (!column.logicalType || typeof column.logicalType !== 'string') {
      return { ok: false, reason: `column ${column.name} missing logicalType` }
    }
  }
  if (result.rowCount < 0) {
    return { ok: false, reason: 'invalid rowCount' }
  }
  return { ok: true }
}

export function gradeCustomerOrderGrain(
  result: QueryLike,
):
  | { ok: true; customersDistinct: number; ordersCount: number; joinRows: number; inflate: number }
  | { ok: false; reason: string } {
  if (result.rowCount !== 1 || result.preview.length < 1) {
    return { ok: false, reason: 'grain query must return one row' }
  }
  const row = result.preview[0]!
  const customersDistinct = scalarNumber(row[0])
  const ordersCount = scalarNumber(row[1])
  const joinRows = scalarNumber(row[2])
  if (![customersDistinct, ordersCount, joinRows].every((n) => Number.isFinite(n) && n >= 0)) {
    return { ok: false, reason: `non-finite grain counts: ${JSON.stringify(row)}` }
  }
  const inflate = joinRows - customersDistinct
  if (inflate < 0) {
    return {
      ok: false,
      reason: `join inflate ${inflate} < 0 (join_rows=${joinRows}, customers_distinct=${customersDistinct})`,
    }
  }
  return { ok: true, customersDistinct, ordersCount, joinRows, inflate }
}

/** When manifest table rows match smoke totals, graders may lock absolute expectations. */
export function manifestMatchesSmokeTotals(
  tables: ReadonlyArray<{ id: string; rows: number }>,
): boolean {
  const byId = Object.fromEntries(tables.map((table) => [table.id, table.rows]))
  return (Object.keys(OLIST_SMOKE_TABLE_ROWS) as Array<keyof typeof OLIST_SMOKE_TABLE_ROWS>).every(
    (id) => byId[id] === OLIST_SMOKE_TABLE_ROWS[id],
  )
}
