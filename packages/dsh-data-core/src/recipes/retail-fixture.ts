import type { IngestRecipe } from './types.js'

/** Synthetic retail fixture used by offline ingest/pipeline tests. */
export const RETAIL_FIXTURE_RECIPE: IngestRecipe = {
  datasetId: 'retail-fixture',
  recipeHash: 'retail-fixture-recipe-v1',
  importerVersion: '0.1.0',
  tables: [
    {
      sourceFile: 'retail.csv',
      tableId: 'retail',
      columns: [
        { name: 'line_id', type: 'VARCHAR' },
        { name: 'customer_id', type: 'VARCHAR' },
        { name: 'order_date', type: 'DATE' },
        { name: 'region', type: 'VARCHAR' },
        { name: 'amount', type: 'DECIMAL(18,2)' },
      ],
    },
  ],
  license: null,
  sourceUrl: 'https://example.invalid/test-fixture',
}
