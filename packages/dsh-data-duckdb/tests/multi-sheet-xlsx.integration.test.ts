/**
 * A multi-sheet XLSX workbook. `excel-adapter.ts`'s
 * `excelSheetToTempCsv` and `source-inspector.ts`'s `materializeExcelSheets`
 * were previously only exercised against a single-sheet fixture; this proves
 * each worksheet becomes its own table with zero row loss, and that a hidden
 * worksheet is skipped rather than silently proposed or silently dropped
 * without a trace.
 *
 * Fixture (see tests/fixtures/multi-sheet-xlsx/regions.xlsx):
 * - "North": store_id,sales header + N1/100, N2/200, N3/300 (3 rows)
 * - "South": store_id,sales header + S1/50, S2/75 (2 rows)
 * - "Notes" (hidden): a single freeform note row, must not be proposed
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveSourcePin } from 'dsh-data-core/recipes/workspace-registry'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { runReviewedIngest } from '../src/ingest-coordinator.js'
import { datasetIdFromSlug, previewIngestSource } from '../src/preview-ingest.js'
import { runFixedQuery } from '../src/fixed-query.js'

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../tests/fixtures/multi-sheet-xlsx/regions.xlsx', import.meta.url),
)
const SLUG = 'test/multi-sheet-regions'
const VERSION = '1'
const EXPECTED_DATASET_ID = datasetIdFromSlug(SLUG)

let directory: string

async function buildArchive(destination: string): Promise<string> {
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(await readFile(FIXTURE_PATH), 'regions.xlsx')
  const archivePath = join(destination, 'regions.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return archivePath
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-multi-sheet-xlsx-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('proposes one table per visible worksheet, skips the hidden one, and ingests both with zero row loss', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildArchive(directory)

  const preview = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })

  expect(preview.status).toBe('candidate')
  expect(preview.datasetId).toBe(EXPECTED_DATASET_ID)
  // Only the 2 visible worksheets are proposed; "Notes" (hidden) is not.
  expect(preview.tables).toHaveLength(2)
  const byExcelSheet = new Map((preview.tables ?? []).map((table) => [table.excelSheet, table]))
  expect([...byExcelSheet.keys()].sort()).toEqual(['North', 'South'])
  expect(byExcelSheet.get('North')?.columns.map((c) => c.name)).toEqual(['store_id', 'sales'])
  expect(byExcelSheet.get('South')?.columns.map((c) => c.name)).toEqual(['store_id', 'sales'])

  const store = new MetadataStore(workspace.catalogPath)
  try {
    store.setWorkspaceSourcePinStatus(
      preview.pinId!,
      'approved',
      store.getWorkspaceSourcePin(preview.pinId!)?.revision ?? 1,
    )
    const pin = resolveSourcePin(SLUG, store.listWorkspaceSourcePins(SLUG))

    const ingest = await runReviewedIngest({
      slug: pin.slug,
      pin,
      workspace,
      kaggleExecutable: '/bin/false',
      localArchivePath: archivePath,
    })
    expect(ingest.status).toBe('ready')
    expect(ingest.tables).toHaveLength(2)
    const byTableId = Object.fromEntries(ingest.tables.map((table) => [table.id, table]))
    for (const table of Object.values(byTableId)) {
      expect(table.rejectedRows).toBe(0)
    }

    // Zero silent data loss: row counts match the sheets exactly (not swapped,
    // not merged, not truncated).
    const northTableId = pin.recipe.tables.find((t) => t.excelSheet === 'North')!.tableId
    const southTableId = pin.recipe.tables.find((t) => t.excelSheet === 'South')!.tableId
    expect(byTableId[northTableId]?.rows).toBe(3)
    expect(byTableId[southTableId]?.rows).toBe(2)

    const datasetPath = workspace.datasetFile(ingest.datasetVersionId, ingest.datasetId)
    const reader = await DuckDBInstance.create(datasetPath, {
      access_mode: 'READ_ONLY',
      enable_external_access: 'false',
    })
    const connection = await reader.connect()
    try {
      const northSumResult = await runFixedQuery(
        connection,
        `SELECT SUM(sales) FROM "${northTableId}"`,
      )
      expect(Number(northSumResult.rows[0]![0])).toBe(600) // 100 + 200 + 300
      const southSumResult = await runFixedQuery(
        connection,
        `SELECT SUM(sales) FROM "${southTableId}"`,
      )
      expect(Number(southSumResult.rows[0]![0])).toBe(125) // 50 + 75

      const northIds = await runFixedQuery(
        connection,
        `SELECT store_id FROM "${northTableId}" ORDER BY store_id`,
      )
      expect(northIds.rows.map((row) => row[0])).toEqual(['N1', 'N2', 'N3'])
      const southIds = await runFixedQuery(
        connection,
        `SELECT store_id FROM "${southTableId}" ORDER BY store_id`,
      )
      expect(southIds.rows.map((row) => row[0])).toEqual(['S1', 'S2'])
    } finally {
      connection.closeSync()
      reader.closeSync()
    }
  } finally {
    store.close()
  }
})
