import { expect, it } from 'vitest'
import {
  gradeCanceledCount,
  gradeCustomerOrderGrain,
  gradeDeliveredPaymentSum,
  gradeFanoutExists,
  gradeNullDeliverySample,
  manifestMatchesSmokeTotals,
  OLIST_SMOKE_TABLE_ROWS,
} from '../src/olist-analytics-fixtures.js'

it('grades fanout / cancel / payment / null-delivery / grain fixtures', () => {
  expect(
    gradeFanoutExists({
      rowCount: 1,
      columns: [{ name: 'has_multi_item_order', logicalType: 'BOOLEAN' }],
      preview: [[true]],
    }),
  ).toEqual({ ok: true })

  expect(
    gradeCanceledCount({
      rowCount: 1,
      columns: [{ name: 'canceled_count', logicalType: 'BIGINT' }],
      preview: [[625n]],
    }),
  ).toMatchObject({ ok: true, count: 625 })

  expect(
    gradeDeliveredPaymentSum({
      rowCount: 1,
      columns: [{ name: 'payment_sum', logicalType: 'DECIMAL' }],
      preview: [['12345.67']],
    }),
  ).toMatchObject({ ok: true, sum: 12345.67 })

  expect(
    gradeNullDeliverySample({
      rowCount: 0,
      columns: [
        { name: 'order_id', logicalType: 'VARCHAR' },
        { name: 'order_status', logicalType: 'VARCHAR' },
        { name: 'order_delivered_customer_date', logicalType: 'TIMESTAMP' },
      ],
      preview: [],
    }),
  ).toEqual({ ok: true })

  expect(
    gradeCustomerOrderGrain({
      rowCount: 1,
      columns: [
        { name: 'customers_distinct', logicalType: 'BIGINT' },
        { name: 'orders_count', logicalType: 'BIGINT' },
        { name: 'join_rows', logicalType: 'BIGINT' },
      ],
      preview: [[100, 120, 120]],
    }),
  ).toMatchObject({ ok: true, inflate: 20 })

  expect(
    manifestMatchesSmokeTotals(
      Object.entries(OLIST_SMOKE_TABLE_ROWS).map(([id, rows]) => ({ id, rows })),
    ),
  ).toBe(true)
})
