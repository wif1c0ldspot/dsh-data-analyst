import type { IngestRecipe } from './types.js'

/**
 * Online Retail II (`mashlyn/online-retail-ii-uci`) — single wide fact table with
 * real data-quality issues (negative quantities, missing Customer ID).
 * Known totals: 1,067,371 rows; top countries by line_items
 * UK 981330 / EIRE 17866 / Germany 17624 / France 14330 / Netherlands 5140.
 */
export const ONLINE_RETAIL_RECIPE: IngestRecipe = {
  datasetId: 'online-retail',
  recipeHash: 'online-retail-recipe-v2-index',
  importerVersion: '0.1.0',
  license: null,
  sourceUrl: 'https://www.kaggle.com/datasets/mashlyn/online-retail-ii-uci',
  tables: [
    {
      sourceFile: 'online_retail_II.csv',
      tableId: 'online_retail',
      timestampFormat: '%Y-%m-%d %H:%M:%S',
      columns: [
        // Version 1 includes a leading, unnamed pandas row index.
        { name: 'source_row_index', type: 'BIGINT' },
        { name: 'invoice', sourceName: 'Invoice', type: 'VARCHAR' },
        { name: 'stock_code', sourceName: 'StockCode', type: 'VARCHAR' },
        { name: 'description', sourceName: 'Description', type: 'VARCHAR' },
        { name: 'quantity', sourceName: 'Quantity', type: 'INTEGER' },
        { name: 'invoice_date', sourceName: 'InvoiceDate', type: 'TIMESTAMP' },
        { name: 'price', sourceName: 'Price', type: 'DECIMAL(18,4)' },
        { name: 'customer_id', sourceName: 'Customer ID', type: 'VARCHAR' },
        { name: 'country', sourceName: 'Country', type: 'VARCHAR' },
      ],
    },
  ],
}
