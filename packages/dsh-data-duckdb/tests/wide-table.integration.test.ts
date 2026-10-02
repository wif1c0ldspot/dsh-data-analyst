/**
 * A wide table (104 columns, over the 100+ bar) stresses
 * `get_schema`'s column paging (`catalog-query.ts`'s `getDatasetSchemaSlice`)
 * and the ingest pipeline's per-column cast-null tracking
 * (`staging-loader.ts`'s `projectTypedFromRaw`, via `raw_then_typed`).
 *
 * Fixture (see tests/fixtures/wide-table/wide.csv, 6 data rows):
 * - id, name, numeric001..numeric100 (100 columns), bad_int, bad_date.
 * - `name` intentionally repeats row 1's value on row 6 (no false key).
 * - `bad_int` has non-numeric "N/A" on rows 3 and 5 -> 2 cast-null cells.
 * - `bad_date` has "not-a-date" on row 4 -> 1 cast-null cell.
 * - every other column casts cleanly -> 0 cast-null cells.
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import type { IngestRecipe, RecipeColumn } from 'dsh-data-core/recipes/types'
import { getDatasetSchemaSlice } from 'dsh-data-core/catalog-query'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { publishPendingAdaptation, runIngestFromArchive } from '../src/ingest-pipeline.js'

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../tests/fixtures/wide-table/wide.csv', import.meta.url),
)
const DATASET_ID = 'wide-table-fixture'
const SLUG = 'test/wide-table-fixture'
const SOURCE_VERSION = '1'
const NUM_NUMERIC = 100
const TOTAL_COLUMNS = 2 + NUM_NUMERIC + 2 // id, name, numeric001..100, bad_int, bad_date

function buildColumns(): RecipeColumn[] {
  const columns: RecipeColumn[] = [
    { name: 'id', type: 'VARCHAR' },
    { name: 'name', type: 'VARCHAR' },
  ]
  for (let index = 1; index <= NUM_NUMERIC; index += 1) {
    columns.push({ name: `numeric${String(index).padStart(3, '0')}`, type: 'BIGINT' })
  }
  columns.push({ name: 'bad_int', type: 'INTEGER' })
  columns.push({ name: 'bad_date', type: 'DATE' })
  return columns
}

function buildRecipe(): IngestRecipe {
  return {
    datasetId: DATASET_ID,
    recipeHash: 'wide-table-fixture-recipe-v1',
    importerVersion: '0.1.0',
    license: null,
    sourceUrl: 'https://example.invalid/test-fixture/wide-table',
    loadStrategy: 'raw_then_typed',
    tables: [
      {
        sourceFile: 'wide.csv',
        sourceFormat: 'csv',
        tableId: 'wide',
        columns: buildColumns(),
      },
    ],
  }
}

async function buildArchive(destination: string): Promise<string> {
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(await readFile(FIXTURE_PATH), 'wide.csv')
  const archivePath = join(destination, 'wide-table.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return archivePath
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-wide-table-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('ingests a 104-column table with zero row loss and precise per-column cast-null tracking', async () => {
  expect(buildColumns()).toHaveLength(TOTAL_COLUMNS)
  const csv = await readFile(FIXTURE_PATH, 'utf8')
  const dataLines = csv.trim().split('\n').length - 1
  expect(dataLines).toBe(6)

  const recipe = buildRecipe()
  const archivePath = await buildArchive(directory)
  const catalogPath = join(directory, 'catalog.sqlite')

  const paused = await runIngestFromArchive({
    archivePath,
    workspaceDir: directory,
    catalogPath,
    recipe,
    slug: SLUG,
    sourceVersion: SOURCE_VERSION,
    idempotencyKey: 'wide-table-fixture',
  })
  expect(paused.status).toBe('needs-input') // bad_int's 33% cast-null rate is material

  const result = await publishPendingAdaptation({
    catalogPath,
    workspaceDir: directory,
    jobId: paused.jobId,
  })
  expect(result.status).toBe('ready')
  expect(result.tables).toHaveLength(1)
  const table = result.tables[0]!
  expect(table.id).toBe('wide')

  // Zero silent data loss: raw row count == projection row count == source rows.
  expect(table.sourceRowCount).toBe(6)
  expect(table.rawRowCount).toBe(6)
  expect(table.projectionRowCount).toBe(6)
  expect(table.rows).toBe(6)
  expect(table.rejectedRows).toBe(0)

  // Precise per-column cast-null accounting: only bad_int/bad_date have any,
  // and the exact counts match the two/one intentionally malformed cells.
  const castNullCounts = table.castNullCounts ?? {}
  expect(castNullCounts.bad_int).toBe(2)
  expect(castNullCounts.bad_date).toBe(1)
  const nonZero = Object.entries(castNullCounts).filter(([, count]) => count > 0)
  expect(nonZero.sort()).toEqual([
    ['bad_date', 1],
    ['bad_int', 2],
  ])
  expect(castNullCounts.id).toBe(0)
  expect(castNullCounts.name).toBe(0)
  expect(castNullCounts.numeric001).toBe(0)
  expect(castNullCounts.numeric100).toBe(0)

  // Approve a workspace pin so get_schema's schema slice can attach columns,
  // then exercise get_schema's limit/offset paging contract across 3 pages.
  const store = new MetadataStore(catalogPath)
  try {
    const pin = store.createWorkspaceSourcePin({
      slug: SLUG,
      sourceVersion: SOURCE_VERSION,
      recipe,
      actorId: 'analyst-session',
    })
    store.setWorkspaceSourcePinStatus(pin.pinId, 'approved', pin.revision)

    const full = getDatasetSchemaSlice(store, DATASET_ID)
    expect(full.totalColumns).toBe(TOTAL_COLUMNS)
    expect(full.columnsTruncated).toBe(false)
    expect(full.nextOffset).toBeNull()
    expect(full.tables[0]?.columns).toHaveLength(TOTAL_COLUMNS)

    const allColumnNames: string[] = []
    let offset = 0
    let pages = 0
    for (;;) {
      const page = getDatasetSchemaSlice(store, DATASET_ID, { limit: 50, offset })
      expect(page.totalColumns).toBe(TOTAL_COLUMNS)
      pages += 1
      const names = page.tables[0]?.columns?.map((column) => column.name) ?? []
      allColumnNames.push(...names)
      if (!page.columnsTruncated) {
        expect(page.nextOffset).toBeNull()
        break
      }
      expect(page.nextOffset).toBe(offset + 50)
      offset = page.nextOffset!
    }
    // 104 columns at 50/page -> 3 pages (50 + 50 + 4), covering every column once.
    expect(pages).toBe(3)
    expect(allColumnNames).toHaveLength(TOTAL_COLUMNS)
    expect(allColumnNames).toEqual(buildColumns().map((column) => column.name))
    expect(allColumnNames.slice(-2)).toEqual(['bad_int', 'bad_date'])
  } finally {
    store.close()
  }
})
