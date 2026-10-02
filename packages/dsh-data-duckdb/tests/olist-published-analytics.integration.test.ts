/**
 * Published Olist analytical fixtures against datasets/dev when the catalog
 * pointer exists. Skipped in CI without a published dump or when
 * DSH_SKIP_PUBLISHED_OLIST=1.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { expect, it } from 'vitest'
import {
  gradeCanceledCount,
  gradeCustomerOrderGrain,
  gradeDeliveredPaymentSum,
  gradeFanoutExists,
  gradeNullDeliverySample,
  manifestMatchesSmokeTotals,
  OLIST_ALLOWED_TABLES,
  OLIST_ANALYTICS_SQL,
  OLIST_SMOKE_TABLE_ROWS,
} from '../src/olist-analytics-fixtures.js'
import { executeAuthorizedQuery } from '../src/query-service.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const workspace = resolveWorkspacePaths(join(repoRoot, 'datasets/dev'))

function loadPublishedOlist():
  | {
      datasetPath: string
      datasetVersionId: string
      tables: Array<{ id: string; rows: number }>
    }
  | undefined {
  if (!existsSync(workspace.catalogPath)) return undefined
  const store = new MetadataStore(workspace.catalogPath)
  try {
    const manifest = store.getCurrentDatasetVersion('olist')
    if (!manifest) return undefined
    return {
      datasetPath: workspace.datasetFile(manifest.datasetVersionId, manifest.datasetId),
      datasetVersionId: manifest.datasetVersionId,
      tables: manifest.tables.map((table) => ({ id: table.id, rows: table.rows })),
    }
  } finally {
    store.close()
  }
}

const skipEnv = process.env.DSH_SKIP_PUBLISHED_OLIST === '1'
const published = skipEnv ? undefined : loadPublishedOlist()

it.skipIf(skipEnv || !published)(
  'published olist: fanout, cancellations, payments, null delivery, grain',
  async () => {
    const ctx = published!
    const allowedTables = [...OLIST_ALLOWED_TABLES]
    const base = {
      datasetPath: ctx.datasetPath,
      datasetVersionId: ctx.datasetVersionId,
      semanticRevisionId: 'sem-olist-v1',
      parameters: [] as { logicalType: string; value: unknown }[],
      allowedTables,
      timeoutMs: 60_000,
    }

    const fanout = await executeAuthorizedQuery({
      ...base,
      sql: OLIST_ANALYTICS_SQL.fanoutExists,
    })
    expect(gradeFanoutExists(fanout)).toEqual({ ok: true })

    const canceled = await executeAuthorizedQuery({
      ...base,
      sql: OLIST_ANALYTICS_SQL.canceledCount,
    })
    const canceledGrade = gradeCanceledCount(canceled)
    expect(canceledGrade.ok, JSON.stringify(canceledGrade)).toBe(true)

    const payments = await executeAuthorizedQuery({
      ...base,
      sql: OLIST_ANALYTICS_SQL.deliveredPaymentSum,
    })
    const paymentGrade = gradeDeliveredPaymentSum(payments)
    expect(paymentGrade.ok, JSON.stringify(paymentGrade)).toBe(true)

    const nullDelivery = await executeAuthorizedQuery({
      ...base,
      sql: OLIST_ANALYTICS_SQL.nullDeliverySample,
    })
    expect(gradeNullDeliverySample(nullDelivery)).toEqual({ ok: true })

    const grain = await executeAuthorizedQuery({
      ...base,
      sql: OLIST_ANALYTICS_SQL.customerOrderGrain,
    })
    const grainGrade = gradeCustomerOrderGrain(grain)
    expect(grainGrade.ok, JSON.stringify(grainGrade)).toBe(true)
    if (grainGrade.ok) {
      expect(grainGrade.inflate).toBeGreaterThanOrEqual(0)
      // Relative invariant: distinct customers cannot exceed order rows.
      expect(grainGrade.customersDistinct).toBeLessThanOrEqual(grainGrade.ordersCount)
    }

    if (manifestMatchesSmokeTotals(ctx.tables)) {
      expect(ctx.tables.find((table) => table.id === 'orders')?.rows).toBe(
        OLIST_SMOKE_TABLE_ROWS.orders,
      )
      expect(ctx.tables.find((table) => table.id === 'order_items')?.rows).toBe(
        OLIST_SMOKE_TABLE_ROWS.order_items,
      )
      expect(ctx.tables.find((table) => table.id === 'customers')?.rows).toBe(
        OLIST_SMOKE_TABLE_ROWS.customers,
      )
    }
  },
  90_000,
)
