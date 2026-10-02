import type { IngestRecipe } from './types.js'

/**
 * Reviewed Superstore recipe for `vivek468/superstore-dataset-final`.
 * Known offline totals after a successful load (9994 rows):
 * Sales 2297200.86, Profit 286397.02;
 * region Sales West 725457.82 / East 678781.24 / Central 501239.89 / South 391721.91.
 */
export const SUPERSTORE_RECIPE: IngestRecipe = {
  datasetId: 'superstore',
  recipeHash: 'superstore-recipe-v1',
  importerVersion: '0.1.0',
  license: null,
  sourceUrl: 'https://www.kaggle.com/datasets/vivek468/superstore-dataset-final',
  tables: [
    {
      sourceFile: 'Sample - Superstore.csv',
      tableId: 'orders',
      sourceEncoding: 'windows-1252',
      dateFormat: '%m/%d/%Y',
      columns: [
        { name: 'row_id', sourceName: 'Row ID', type: 'BIGINT' },
        { name: 'order_id', sourceName: 'Order ID', type: 'VARCHAR' },
        { name: 'order_date', sourceName: 'Order Date', type: 'DATE' },
        { name: 'ship_date', sourceName: 'Ship Date', type: 'DATE' },
        { name: 'ship_mode', sourceName: 'Ship Mode', type: 'VARCHAR' },
        { name: 'customer_id', sourceName: 'Customer ID', type: 'VARCHAR' },
        { name: 'customer_name', sourceName: 'Customer Name', type: 'VARCHAR' },
        { name: 'segment', sourceName: 'Segment', type: 'VARCHAR' },
        { name: 'country', sourceName: 'Country', type: 'VARCHAR' },
        { name: 'city', sourceName: 'City', type: 'VARCHAR' },
        { name: 'state', sourceName: 'State', type: 'VARCHAR' },
        { name: 'postal_code', sourceName: 'Postal Code', type: 'VARCHAR' },
        { name: 'region', sourceName: 'Region', type: 'VARCHAR' },
        { name: 'product_id', sourceName: 'Product ID', type: 'VARCHAR' },
        { name: 'category', sourceName: 'Category', type: 'VARCHAR' },
        { name: 'sub_category', sourceName: 'Sub-Category', type: 'VARCHAR' },
        { name: 'product_name', sourceName: 'Product Name', type: 'VARCHAR' },
        { name: 'sales', sourceName: 'Sales', type: 'DECIMAL(18,4)' },
        { name: 'quantity', sourceName: 'Quantity', type: 'INTEGER' },
        { name: 'discount', sourceName: 'Discount', type: 'DECIMAL(18,4)' },
        { name: 'profit', sourceName: 'Profit', type: 'DECIMAL(18,4)' },
      ],
    },
  ],
}
