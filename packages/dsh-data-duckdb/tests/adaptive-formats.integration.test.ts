/**
 * Adaptive ingest multi-format verification: CSV, Parquet, JSONL, and XLSX
 * publish under loadStrategy raw_then_typed without dropping source rows.
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { DuckDBInstance } from '@duckdb/node-api'
import type { IngestRecipe } from 'dsh-data-core/recipes/types'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { publishPendingAdaptation, runIngestFromArchive } from '../src/ingest-pipeline.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-adaptive-formats-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function buildZip(entries: Array<{ name: string; bytes: Buffer }>): Promise<string> {
  const zipfile = new yazl.ZipFile()
  for (const entry of entries) zipfile.addBuffer(entry.bytes, entry.name)
  const archivePath = join(directory, 'source.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return archivePath
}

async function makeParquet(path: string): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  try {
    await connection.run(
      `COPY (SELECT '1'::VARCHAR AS id, 'not-a-number'::VARCHAR AS amount
             UNION ALL SELECT '2', '10.50')
       TO ? (FORMAT PARQUET)`,
      [path],
    )
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

async function makeXlsx(path: string): Promise<void> {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sales')
  sheet.addRow(['id', 'amount'])
  sheet.addRow(['1', 'bad'])
  sheet.addRow(['2', '10.50'])
  await workbook.xlsx.writeFile(path)
}

it('ingests CSV, Parquet, JSONL, and XLSX under raw_then_typed', async () => {
  const parquetPath = join(directory, 'events.parquet')
  const xlsxPath = join(directory, 'sales.xlsx')
  await makeParquet(parquetPath)
  await makeXlsx(xlsxPath)

  const archivePath = await buildZip([
    {
      name: 'retail.csv',
      bytes: Buffer.from('id,amount\n1,100.00\n2,not-a-number\n3,20.00\n', 'utf8'),
    },
    { name: 'events.parquet', bytes: await readFile(parquetPath) },
    {
      name: 'events.jsonl',
      bytes: Buffer.from('{"id":"1","amount":"bad"}\n{"id":"2","amount":"10.50"}\n', 'utf8'),
    },
    { name: 'sales.xlsx', bytes: await readFile(xlsxPath) },
  ])

  const recipe: IngestRecipe = {
    datasetId: 'multi-format-fixture',
    recipeHash: 'multi-format-adaptive-v1',
    importerVersion: '0.1.0',
    loadStrategy: 'raw_then_typed',
    license: null,
    sourceUrl: 'https://example.invalid/multi-format',
    tables: [
      {
        sourceFile: 'retail.csv',
        sourceFormat: 'csv',
        tableId: 'retail',
        columns: [
          { name: 'id', type: 'BIGINT' },
          { name: 'amount', type: 'DECIMAL(18,2)' },
        ],
      },
      {
        sourceFile: 'events.parquet',
        sourceFormat: 'parquet',
        tableId: 'events_pq',
        columns: [
          { name: 'id', sourceName: 'id', type: 'BIGINT' },
          { name: 'amount', sourceName: 'amount', type: 'DECIMAL(18,2)' },
        ],
      },
      {
        sourceFile: 'events.jsonl',
        sourceFormat: 'json',
        tableId: 'events_json',
        columns: [
          { name: 'id', sourceName: 'id', type: 'BIGINT' },
          { name: 'amount', sourceName: 'amount', type: 'DECIMAL(18,2)' },
        ],
      },
      {
        sourceFile: 'sales.xlsx',
        sourceFormat: 'excel',
        excelSheet: 'Sales',
        tableId: 'sales',
        columns: [
          { name: 'id', type: 'BIGINT' },
          { name: 'amount', type: 'DECIMAL(18,2)' },
        ],
      },
    ],
  }

  const paused = await runIngestFromArchive({
    archivePath,
    workspaceDir: directory,
    catalogPath: join(directory, 'catalog.sqlite'),
    recipe,
    slug: 'test/multi-format',
    sourceVersion: '1',
    idempotencyKey: 'multi-format-adaptive-v1',
  })
  expect(paused.status).toBe('needs-input')
  const result = await publishPendingAdaptation({
    catalogPath: join(directory, 'catalog.sqlite'),
    workspaceDir: directory,
    jobId: paused.jobId,
  })
  expect(result.status).toBe('ready')

  expect(result.tables).toHaveLength(4)
  for (const table of result.tables) {
    expect(table.loadStrategy).toBe('raw_then_typed')
    expect(table.rawRowCount).toBe(table.projectionRowCount)
    expect(table.rejectedRows).toBe(0)
    expect(table.castNullCounts?.amount).toBeGreaterThanOrEqual(1)
  }

  const reader = await DuckDBInstance.create(result.datasetPath, {
    access_mode: 'READ_ONLY',
    enable_external_access: 'false',
  })
  const connection = await reader.connect()
  try {
    const names = await connection.runAndReadAll(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'main' ORDER BY table_name`,
    )
    const tableNames = names.getRowsJson().map((row) => String(row[0]))
    expect(tableNames).toEqual([
      'events_json',
      'events_pq',
      'raw_events_json',
      'raw_events_pq',
      'raw_retail',
      'raw_sales',
      'retail',
      'sales',
    ])

    // Raw cells preserved; typed projections keep row counts.
    const rawCsv = await connection.runAndReadAll(
      "SELECT COUNT(*), COUNT(amount) FILTER (WHERE amount = 'not-a-number') FROM raw_retail",
    )
    expect(rawCsv.getRowsJson()[0]).toEqual(['3', '1'])
    const typedCsv = await connection.runAndReadAll('SELECT COUNT(*) FROM retail')
    expect(Number(typedCsv.getRowsJson()[0]?.[0])).toBe(3)
  } finally {
    connection.closeSync()
    reader.closeSync()
  }

  await writeFile(
    join(directory, 'adaptive-formats-result.json'),
    JSON.stringify(
      {
        datasetVersionId: result.datasetVersionId,
        tables: result.tables,
      },
      null,
      2,
    ),
    'utf8',
  )
})
