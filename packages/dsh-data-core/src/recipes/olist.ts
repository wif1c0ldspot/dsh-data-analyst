import type { IngestRecipe } from './types.js'

/**
 * Olist Brazilian e-commerce (`olistbr/brazilian-ecommerce`) — full relational
 * fanout (9 CSVs). Known row counts from source inventory:
 * customers/orders 99441, order_items 112650, payments 103886, reviews 100000,
 * products 32951, sellers 3095, geolocation 1000163, category_translation 71.
 */
export const OLIST_RECIPE: IngestRecipe = {
  datasetId: 'olist',
  recipeHash: 'olist-recipe-v2-full',
  importerVersion: '0.1.0',
  license: null,
  sourceUrl: 'https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce',
  tables: [
    {
      sourceFile: 'olist_customers_dataset.csv',
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
      sourceFile: 'olist_geolocation_dataset.csv',
      tableId: 'geolocation',
      columns: [
        { name: 'geolocation_zip_code_prefix', type: 'VARCHAR' },
        { name: 'geolocation_lat', type: 'DOUBLE' },
        { name: 'geolocation_lng', type: 'DOUBLE' },
        { name: 'geolocation_city', type: 'VARCHAR' },
        { name: 'geolocation_state', type: 'VARCHAR' },
      ],
    },
    {
      sourceFile: 'olist_order_items_dataset.csv',
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
      sourceFile: 'olist_order_payments_dataset.csv',
      tableId: 'order_payments',
      columns: [
        { name: 'order_id', type: 'VARCHAR' },
        { name: 'payment_sequential', type: 'INTEGER' },
        { name: 'payment_type', type: 'VARCHAR' },
        { name: 'payment_installments', type: 'INTEGER' },
        { name: 'payment_value', type: 'DECIMAL(18,2)' },
      ],
    },
    {
      sourceFile: 'olist_order_reviews_dataset.csv',
      tableId: 'order_reviews',
      timestampFormat: '%Y-%m-%d %H:%M:%S',
      columns: [
        { name: 'review_id', type: 'VARCHAR' },
        { name: 'order_id', type: 'VARCHAR' },
        { name: 'review_score', type: 'INTEGER' },
        { name: 'review_comment_title', type: 'VARCHAR' },
        { name: 'review_comment_message', type: 'VARCHAR' },
        { name: 'review_creation_date', type: 'TIMESTAMP' },
        { name: 'review_answer_timestamp', type: 'TIMESTAMP' },
      ],
    },
    {
      sourceFile: 'olist_orders_dataset.csv',
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
      ],
    },
    {
      sourceFile: 'olist_products_dataset.csv',
      tableId: 'products',
      columns: [
        { name: 'product_id', type: 'VARCHAR' },
        { name: 'product_category_name', type: 'VARCHAR' },
        { name: 'product_name_lenght', type: 'INTEGER' },
        { name: 'product_description_lenght', type: 'INTEGER' },
        { name: 'product_photos_qty', type: 'INTEGER' },
        { name: 'product_weight_g', type: 'DOUBLE' },
        { name: 'product_length_cm', type: 'DOUBLE' },
        { name: 'product_height_cm', type: 'DOUBLE' },
        { name: 'product_width_cm', type: 'DOUBLE' },
      ],
    },
    {
      sourceFile: 'olist_sellers_dataset.csv',
      tableId: 'sellers',
      columns: [
        { name: 'seller_id', type: 'VARCHAR' },
        { name: 'seller_zip_code_prefix', type: 'VARCHAR' },
        { name: 'seller_city', type: 'VARCHAR' },
        { name: 'seller_state', type: 'VARCHAR' },
      ],
    },
    {
      sourceFile: 'product_category_name_translation.csv',
      tableId: 'category_translation',
      columns: [
        { name: 'product_category_name', type: 'VARCHAR' },
        { name: 'product_category_name_english', type: 'VARCHAR' },
      ],
    },
  ],
}
