/**
 * `duckdb_query`'s observe render must still
 * surface join-fanout warnings when the analyst call passed
 * `datasetVersionId` but not `datasetId` — resolve `datasetId` from the
 * catalog off the result's resolved `datasetVersionId`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { DatasetManifest } from 'dsh-data-core/contracts'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveQueryObserveWarnings } from '../src/plugin-tools.js'

let directory: string
let catalogPath: string

const FANOUT_SQL =
  'SELECT o.order_id, oi.price, op.payment_value FROM orders o ' +
  'JOIN order_items oi ON oi.order_id = o.order_id ' +
  'JOIN order_payments op ON op.order_id = o.order_id'

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-observe-warnings-'))
  catalogPath = join(directory, 'catalog.sqlite')
  const store = new MetadataStore(catalogPath)
  try {
    const manifest: DatasetManifest = {
      contractVersion: 1,
      datasetId: 'olist-mini',
      datasetVersionId: 'olist-mini-v1-test',
      source: {
        slug: 'test/olist-mini',
        version: '1',
        url: 'https://example.invalid',
        retrievedAt: new Date().toISOString(),
        license: null,
      },
      files: [],
      recipeHash: 'test',
      importerVersion: '0.1.0',
      tables: [
        { id: 'orders', sourceFile: 'orders.csv', rows: 1, rejectedRows: 0 },
        { id: 'order_items', sourceFile: 'order_items.csv', rows: 1, rejectedRows: 0 },
        { id: 'order_payments', sourceFile: 'order_payments.csv', rows: 1, rejectedRows: 0 },
      ],
    }
    store.publishDatasetVersion(manifest)
  } finally {
    store.close()
  }
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('warns using args.datasetId directly when the call passed it', () => {
  const warnings = resolveQueryObserveWarnings(
    catalogPath,
    { datasetId: 'olist-mini', sql: FANOUT_SQL },
    {},
  )
  expect(warnings).toEqual(['fanout-risk: order_items x order_payments'])
})

it('resolves datasetId from the catalog when the call passed only datasetVersionId', () => {
  const warnings = resolveQueryObserveWarnings(
    catalogPath,
    { datasetVersionId: 'olist-mini-v1-test', sql: FANOUT_SQL }, // no args.datasetId
    { datasetVersionId: 'olist-mini-v1-test' }, // execute()'s resolved summary
  )
  expect(warnings).toEqual(['fanout-risk: order_items x order_payments'])
})

it('resolves datasetId off the resolved result even when args carried neither id', () => {
  const warnings = resolveQueryObserveWarnings(
    catalogPath,
    { sql: FANOUT_SQL },
    { datasetVersionId: 'olist-mini-v1-test' },
  )
  expect(warnings).toEqual(['fanout-risk: order_items x order_payments'])
})

it('returns no warnings (never throws) for an unknown datasetVersionId', () => {
  const warnings = resolveQueryObserveWarnings(
    catalogPath,
    { datasetVersionId: 'does-not-exist', sql: FANOUT_SQL },
    { datasetVersionId: 'does-not-exist' },
  )
  expect(warnings).toEqual([])
})

it('returns no warnings when the call has no sql', () => {
  const warnings = resolveQueryObserveWarnings(catalogPath, { datasetId: 'olist-mini' }, {})
  expect(warnings).toEqual([])
})

// Currency-mix warnings are no longer computed here: `resolveQueryObserveWarnings`
// is only ever called from `render`, which `@deepseek-ai/dsh-tools` documents
// as pure/synchronous and which therefore cannot open a DuckDB connection to
// parse SQL. Currency-mix warnings are now AST-based
// (`currencyWarningsForStatement`, dsh-data-core/currency-warnings.ts) and
// computed at `execute()` time inside `query-service.ts`, reusing the
// statement `authorizeQuery` already parses; see
// `currency-warnings-ast.integration.test.ts` for the real-parser coverage
// and `plugin-tools-duckdb-query-currency-warning.integration.test.ts` for
// the end-to-end tool coverage.
