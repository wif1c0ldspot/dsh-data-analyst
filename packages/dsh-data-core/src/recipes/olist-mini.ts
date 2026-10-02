import type { IngestRecipe } from './types.js'

/**
 * Tiny offline Olist-like fixture for CI (not the Kaggle dump).
 * Covers order→items fanout, canceled/unavailable status, and nullable
 * delivery/review fields. See `tests/fixtures/olist-mini/`.
 *
 * Expected row counts: customers 3, orders 5, order_items 7, order_payments 5.
 */
export const OLIST_MINI_RECIPE: IngestRecipe = {
  datasetId: 'olist-mini',
  recipeHash: 'olist-mini-recipe-v1',
  importerVersion: '0.1.0',
  license: null,
  sourceUrl: 'https://example.invalid/test-fixture/olist-mini',
  tables: [
    {
      sourceFile: 'customers.csv',
      tableId: 'customers',
      columns: [
        { name: 'customer_id', type: 'VARCHAR' },
        { name: 'customer_unique_id', type: 'VARCHAR' },
        { name: 'customer_zip_code_prefix', type: 'VARCHAR' },
        { name: 'customer_city', type: 'VARCHAR' },
        { name: 'customer_state', type: 'VARCHAR' },
      ],
    },
    {
      sourceFile: 'orders.csv',
      tableId: 'orders',
      timestampFormat: '%Y-%m-%d %H:%M:%S',
      columns: [
        { name: 'order_id', type: 'VARCHAR' },
        { name: 'customer_id', type: 'VARCHAR' },
        { name: 'order_status', type: 'VARCHAR' },
        { name: 'order_purchase_timestamp', type: 'TIMESTAMP' },
        { name: 'order_approved_at', type: 'TIMESTAMP' },
        { name: 'order_delivered_carrier_date', type: 'TIMESTAMP' },
        { name: 'order_delivered_customer_date', type: 'TIMESTAMP' },
        { name: 'order_estimated_delivery_date', type: 'TIMESTAMP' },
        { name: 'review_score', type: 'INTEGER' },
      ],
    },
    {
      sourceFile: 'order_items.csv',
      tableId: 'order_items',
      timestampFormat: '%Y-%m-%d %H:%M:%S',
      columns: [
        { name: 'order_id', type: 'VARCHAR' },
        { name: 'order_item_id', type: 'INTEGER' },
        { name: 'product_id', type: 'VARCHAR' },
        { name: 'seller_id', type: 'VARCHAR' },
        { name: 'shipping_limit_date', type: 'TIMESTAMP' },
        { name: 'price', type: 'DECIMAL(18,2)' },
        { name: 'freight_value', type: 'DECIMAL(18,2)' },
      ],
    },
    {
      sourceFile: 'order_payments.csv',
      tableId: 'order_payments',
      columns: [
        { name: 'order_id', type: 'VARCHAR' },
        { name: 'payment_sequential', type: 'INTEGER' },
        { name: 'payment_type', type: 'VARCHAR' },
        { name: 'payment_installments', type: 'INTEGER' },
        { name: 'payment_value', type: 'DECIMAL(18,2)' },
      ],
    },
  ],
}
