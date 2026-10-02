/**
 * Olist-mini analytical fixture: ingest synthetic CSVs and prove fanout,
 * cancellation counts, and customers↔orders join grain with deterministic SQL.
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import { OLIST_MINI_RECIPE } from 'dsh-data-core/recipes/olist-mini'
import * as yazl from 'yazl'
import { expect, it } from 'vitest'
import { runFixedQuery } from '../src/fixed-query.js'
import { runIngestFromArchive } from '../src/ingest-pipeline.js'

const FIXTURE_DIR = fileURLToPath(new URL('../../../tests/fixtures/olist-mini', import.meta.url))

/**
 * Documented fixture expectations (see tests/fixtures/olist-mini/*.csv):
 * - customers: 3 (c_alice, c_bob, c_cara)
 * - orders: 5 (ord_multi, ord_single, ord_cancel, ord_unavail, ord_null_deliv)
 * - order_items: 7 (ord_multi has 3 lines; others 1 each)
 * - canceled/unavailable orders: 2
 * - customers JOIN orders without DISTINCT inflates to 5 rows (order grain)
 */
const EXPECTED = {
  customers: 3,
  orders: 5,
  orderItems: 7,
  multiOrderItems: 3,
  canceledOrUnavailable: 2,
  naiveCustomerOrderJoinRows: 5,
  nullDeliveryDates: 3, // cancel, unavail, null_deliv
  nullReviewScores: 2, // cancel, unavail
} as const

async function buildOlistMiniArchive(destination: string): Promise<string> {
  const zipfile = new yazl.ZipFile()
  const names = await readdir(FIXTURE_DIR)
  for (const name of names.filter((entry) => entry.endsWith('.csv'))) {
    zipfile.addBuffer(await readFile(join(FIXTURE_DIR, name)), name)
  }
  const archivePath = join(destination, 'olist-mini.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return archivePath
}

async function queryScalar(datasetPath: string, sql: string): Promise<unknown> {
  const reader = await DuckDBInstance.create(datasetPath, {
    access_mode: 'READ_ONLY',
    enable_external_access: 'false',
  })
  const connection = await reader.connect()
  try {
    const result = await runFixedQuery(connection, sql)
    expect(result.rowCount).toBe(1)
    return result.rows[0]![0]
  } finally {
    connection.closeSync()
    reader.closeSync()
  }
}

it('ingests olist-mini and proves fanout, cancellations, and customer join grain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-olist-mini-'))
  try {
    const archivePath = await buildOlistMiniArchive(directory)
    const result = await runIngestFromArchive({
      archivePath,
      workspaceDir: directory,
      catalogPath: join(directory, 'catalog.sqlite'),
      recipe: OLIST_MINI_RECIPE,
      slug: 'test/olist-mini',
      sourceVersion: '1',
      idempotencyKey: 'olist-mini-analytics',
    })

    expect(result.datasetId).toBe('olist-mini')
    const byTable = Object.fromEntries(result.tables.map((table) => [table.id, table.rows]))
    expect(byTable).toMatchObject({
      customers: EXPECTED.customers,
      orders: EXPECTED.orders,
      order_items: EXPECTED.orderItems,
      order_payments: EXPECTED.orders,
    })

    // Fanout: multi-item order has more items than distinct orders for that id.
    const multiItemCount = await queryScalar(
      result.datasetPath,
      `SELECT COUNT(*) FROM order_items WHERE order_id = 'ord_multi'`,
    )
    const multiOrderDistinct = await queryScalar(
      result.datasetPath,
      `SELECT COUNT(DISTINCT order_id) FROM order_items WHERE order_id = 'ord_multi'`,
    )
    expect(Number(multiItemCount)).toBe(EXPECTED.multiOrderItems)
    expect(Number(multiOrderDistinct)).toBe(1)
    expect(Number(multiItemCount)).toBeGreaterThan(Number(multiOrderDistinct))

    const itemVsOrder = await queryScalar(result.datasetPath, `SELECT COUNT(*) FROM order_items`)
    const distinctOrdersInItems = await queryScalar(
      result.datasetPath,
      `SELECT COUNT(DISTINCT order_id) FROM order_items`,
    )
    expect(Number(itemVsOrder)).toBe(EXPECTED.orderItems)
    expect(Number(distinctOrdersInItems)).toBe(EXPECTED.orders)
    expect(Number(itemVsOrder)).toBeGreaterThan(Number(distinctOrdersInItems))

    // Canceled / unavailable statuses are present and countable.
    const canceledCount = await queryScalar(
      result.datasetPath,
      `SELECT COUNT(*) FROM orders WHERE order_status IN ('canceled', 'unavailable')`,
    )
    expect(Number(canceledCount)).toBe(EXPECTED.canceledOrUnavailable)

    // NULL-friendly fields survived ingest.
    const nullDelivery = await queryScalar(
      result.datasetPath,
      `SELECT COUNT(*) FROM orders WHERE order_delivered_customer_date IS NULL`,
    )
    const nullReview = await queryScalar(
      result.datasetPath,
      `SELECT COUNT(*) FROM orders WHERE review_score IS NULL`,
    )
    expect(Number(nullDelivery)).toBe(EXPECTED.nullDeliveryDates)
    expect(Number(nullReview)).toBe(EXPECTED.nullReviewScores)

    // customers ↔ orders: correct customer metric uses customer grain, not order grain.
    const distinctCustomers = await queryScalar(
      result.datasetPath,
      `SELECT COUNT(DISTINCT customer_id) FROM customers`,
    )
    const distinctCustomersFromOrders = await queryScalar(
      result.datasetPath,
      `SELECT COUNT(DISTINCT o.customer_id) FROM orders o`,
    )
    const naiveJoinRows = await queryScalar(
      result.datasetPath,
      `SELECT COUNT(*) FROM customers c INNER JOIN orders o ON c.customer_id = o.customer_id`,
    )
    expect(Number(distinctCustomers)).toBe(EXPECTED.customers)
    expect(Number(distinctCustomersFromOrders)).toBe(EXPECTED.customers)
    // Naive COUNT(*) after join duplicates c_alice (2 orders) and c_bob (2 orders).
    expect(Number(naiveJoinRows)).toBe(EXPECTED.naiveCustomerOrderJoinRows)
    expect(Number(naiveJoinRows)).toBeGreaterThan(Number(distinctCustomers))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
