/**
 * A multi-file relational fixture with 5 tables and real FK
 * chains (categories -> products -> order_items <- orders <- customers),
 * exercising `propose_structure`'s underlying mechanism -- `profiler.ts`'s
 * `profileColumnStats` / `proposeKeyCandidates` / `profileRelationships` --
 * at more width than `tests/fixtures/olist-mini/`'s handful of tables.
 *
 * Fixture data (see tests/fixtures/relational-5table/*.csv), by hand:
 * - categories: cat_a, cat_b, cat_c (3 rows)
 * - products: p1,p2 -> cat_a; p3,p4 -> cat_b; p5 -> cat_c (5 rows)
 * - customers: cust1, cust2, cust3, cust4 (4 rows)
 * - orders: cust1 has ord1,ord2; cust2 has ord3; cust3 has ord4,ord5;
 *   cust4 has ord6 (6 rows)
 * - order_items: ord1->p1,p2; ord2->p3; ord3->p1,p3,p5; ord4->p2; ord5->p4;
 *   ord6->p1 (9 rows)
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import type { IngestRecipe } from 'dsh-data-core/recipes/types'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  profileColumnStats,
  profileRelationships,
  proposeKeyCandidates,
  type ProfiledTable,
} from '../src/profiler.js'
import { runIngestFromArchive } from '../src/ingest-pipeline.js'

const FIXTURE_DIR = fileURLToPath(
  new URL('../../../tests/fixtures/relational-5table', import.meta.url),
)

const EXPECTED_ROWS = {
  categories: 3,
  products: 5,
  customers: 4,
  orders: 6,
  order_items: 9,
} as const

const RECIPE: IngestRecipe = {
  datasetId: 'relational-5table',
  recipeHash: 'relational-5table-recipe-v1',
  importerVersion: '0.1.0',
  license: null,
  sourceUrl: 'https://example.invalid/test-fixture/relational-5table',
  tables: [
    {
      sourceFile: 'categories.csv',
      tableId: 'categories',
      columns: [
        { name: 'category_id', type: 'VARCHAR' },
        { name: 'category_name', type: 'VARCHAR' },
        { name: 'region', type: 'VARCHAR' },
      ],
    },
    {
      sourceFile: 'products.csv',
      tableId: 'products',
      columns: [
        { name: 'product_id', type: 'VARCHAR' },
        { name: 'category_id', type: 'VARCHAR' },
        { name: 'product_name', type: 'VARCHAR' },
        { name: 'price', type: 'DECIMAL(10,2)' },
      ],
    },
    {
      sourceFile: 'customers.csv',
      tableId: 'customers',
      columns: [
        { name: 'customer_id', type: 'VARCHAR' },
        { name: 'country', type: 'VARCHAR' },
        { name: 'signup_date', type: 'DATE' },
      ],
    },
    {
      sourceFile: 'orders.csv',
      tableId: 'orders',
      columns: [
        { name: 'order_id', type: 'VARCHAR' },
        { name: 'customer_id', type: 'VARCHAR' },
        { name: 'order_date', type: 'DATE' },
        { name: 'status', type: 'VARCHAR' },
      ],
    },
    {
      sourceFile: 'order_items.csv',
      tableId: 'order_items',
      columns: [
        { name: 'order_item_id', type: 'VARCHAR' },
        { name: 'order_id', type: 'VARCHAR' },
        { name: 'product_id', type: 'VARCHAR' },
        { name: 'quantity', type: 'BIGINT' },
        { name: 'unit_price', type: 'DECIMAL(10,2)' },
      ],
    },
  ],
}

async function buildArchive(destination: string): Promise<string> {
  const zipfile = new yazl.ZipFile()
  for (const table of RECIPE.tables) {
    zipfile.addBuffer(await readFile(join(FIXTURE_DIR, table.sourceFile)), table.sourceFile)
  }
  const archivePath = join(destination, 'relational-5table.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return archivePath
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-relational-fixture-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('ingests all 5 tables with zero row loss and proposes correct keys/relationships', async () => {
  const archivePath = await buildArchive(directory)
  const result = await runIngestFromArchive({
    archivePath,
    workspaceDir: directory,
    catalogPath: join(directory, 'catalog.sqlite'),
    recipe: RECIPE,
    slug: 'test/relational-5table',
    sourceVersion: '1',
    idempotencyKey: 'relational-5table',
  })

  expect(result.datasetId).toBe('relational-5table')
  const byTable = Object.fromEntries(result.tables.map((table) => [table.id, table]))
  for (const [tableId, expectedRows] of Object.entries(EXPECTED_ROWS)) {
    expect(byTable[tableId]).toMatchObject({ rows: expectedRows, rejectedRows: 0 })
  }

  // Zero silent data loss: rows in (source CSV lines) equal rows out.
  for (const table of RECIPE.tables) {
    const csv = await readFile(join(FIXTURE_DIR, table.sourceFile), 'utf8')
    const dataLines = csv.trim().split('\n').length - 1 // minus header
    expect(byTable[table.tableId]?.rows).toBe(dataLines)
  }

  const reader = await DuckDBInstance.create(result.datasetPath, {
    access_mode: 'READ_ONLY',
    enable_external_access: 'false',
  })
  const connection = await reader.connect()
  try {
    const profiledTables: ProfiledTable[] = RECIPE.tables.map((table) => ({
      tableId: table.tableId,
      columns: table.columns.map((column) => ({ name: column.name, type: column.type })),
    }))

    // Primary-key candidates: each table's *_id surrogate key is unique/non-null;
    // `region`/`country`/`status` intentionally repeat so they are NOT proposed.
    const grainByTable: Record<string, string[]> = {}
    for (const table of profiledTables) {
      const stats = await profileColumnStats(connection, table.tableId, table.columns)
      grainByTable[table.tableId] = proposeKeyCandidates(stats).map((c) => c.columns[0]!)
    }
    expect(grainByTable.categories).toEqual(['category_id'])
    expect(grainByTable.products).toEqual(['product_id'])
    expect(grainByTable.customers).toEqual(['customer_id'])
    expect(grainByTable.orders).toEqual(['order_id'])
    expect(grainByTable.order_items).toEqual(['order_item_id'])

    const relationships = await profileRelationships(connection, profiledTables)
    const byPair = Object.fromEntries(
      relationships.map((rel) => [`${rel.fromTable}.${rel.fromColumn}->${rel.toTable}`, rel]),
    )
    expect(Object.keys(byPair).sort()).toEqual(
      [
        'categories.category_id->products',
        'customers.customer_id->orders',
        'orders.order_id->order_items',
        'products.product_id->order_items',
      ].sort(),
    )

    // categories -> products: cat_a/cat_b have 2 products each, cat_c has 1;
    // every product has exactly 1 category.
    expect(byPair['categories.category_id->products']).toMatchObject({
      cardinality: '1:n',
      fromDistinct: 3,
      toDistinct: 3,
      matchedFrom: 3,
      matchedTo: 3,
      maxFromTo: 2,
      maxToFrom: 1,
    })

    // customers -> orders: cust1/cust3 have 2 orders each, cust2/cust4 have 1;
    // every order has exactly 1 customer.
    expect(byPair['customers.customer_id->orders']).toMatchObject({
      cardinality: '1:n',
      fromDistinct: 4,
      toDistinct: 4,
      matchedFrom: 4,
      matchedTo: 4,
      maxFromTo: 2,
      maxToFrom: 1,
    })

    // orders -> order_items: ord1 has 2 items, ord3 has 3 items, the rest have 1;
    // every item has exactly 1 order.
    expect(byPair['orders.order_id->order_items']).toMatchObject({
      cardinality: '1:n',
      fromDistinct: 6,
      toDistinct: 6,
      matchedFrom: 6,
      matchedTo: 6,
      maxFromTo: 3,
      maxToFrom: 1,
    })

    // products -> order_items: p1 appears in 3 items, p2/p3 in 2, p4/p5 in 1;
    // every item has exactly 1 product.
    expect(byPair['products.product_id->order_items']).toMatchObject({
      cardinality: '1:n',
      fromDistinct: 5,
      toDistinct: 5,
      matchedFrom: 5,
      matchedTo: 5,
      maxFromTo: 3,
      maxToFrom: 1,
    })
  } finally {
    connection.closeSync()
    reader.closeSync()
  }
})
