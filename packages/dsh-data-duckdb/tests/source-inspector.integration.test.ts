import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { inspectSourceFilesInProcess, selectInspectableSources } from '../src/source-inspector.js'
import { describeSheetStructure, parseA1Range } from '../src/source-inspector.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-source-inspection-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('delegates CSV dialect and quoted multiline record parsing to DuckDB', async () => {
  const path = join(directory, 'orders.csv')
  await writeFile(path, 'id;note;amount\n1;"first line\nsecond line";10.50\n', 'utf8')

  const proposal = await inspectSourceFilesInProcess([{ sourceFile: 'orders.csv', path }])

  expect(proposal.unsupportedFiles).toEqual([])
  expect(proposal.tables[0]).toMatchObject({ sourceFormat: 'csv', tableId: 'orders' })
  expect(proposal.tables[0]?.columns.map((column) => [column.name, column.type])).toEqual([
    ['id', 'BIGINT'],
    ['note', 'VARCHAR'],
    ['amount', 'DOUBLE'],
  ])
})

it('inspects Parquet metadata and JSONL samples through controlled readers', async () => {
  const parquetPath = join(directory, 'events.parquet')
  const jsonlPath = join(directory, 'events.jsonl')
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  try {
    await connection.run(
      `COPY (SELECT 1::INTEGER AS event_id, DATE '2025-01-02' AS occurred_on) TO ? (FORMAT PARQUET)`,
      [parquetPath],
    )
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
  await writeFile(
    jsonlPath,
    '{"event_id":1,"label":"open"}\n{"event_id":2,"label":"close"}\n',
    'utf8',
  )

  const proposal = await inspectSourceFilesInProcess([
    { sourceFile: 'warehouse/events.parquet', path: parquetPath, sizeBytes: 200 },
    { sourceFile: 'logs/events.jsonl', path: jsonlPath, sizeBytes: 100 },
  ])

  expect(proposal.unsupportedFiles).toEqual([])
  expect(proposal.tables.map((table) => [table.tableId, table.sourceFormat])).toEqual([
    ['events', 'parquet'],
    ['events_2', 'json'],
  ])
  expect(proposal.tables[0]?.columns.map((column) => column.type)).toEqual(['BIGINT', 'DATE'])
  expect(proposal.tables[1]?.columns.map((column) => column.type)).toEqual(['BIGINT', 'VARCHAR'])
})

it('inspects a valid pretty-printed JSON array beyond the old line-sampling limit', async () => {
  const path = join(directory, 'events.json')
  const records = Array.from({ length: 300 }, (_, index) => ({
    id: index,
    label: `event-${index}`,
  }))
  await writeFile(path, JSON.stringify(records, null, 2), 'utf8')

  const proposal = await inspectSourceFilesInProcess([{ sourceFile: 'events.json', path }])

  expect(proposal.unsupportedFiles).toEqual([])
  expect(proposal.tables[0]).toMatchObject({ sourceFormat: 'json', tableId: 'events' })
  expect(proposal.tables[0]?.columns.map((column) => [column.name, column.type])).toEqual([
    ['id', 'BIGINT'],
    ['label', 'VARCHAR'],
  ])
})

it('inspects a one-line JSON document larger than the old 1 MB byte sample', async () => {
  const path = join(directory, 'big.json')
  const records = Array.from({ length: 40_000 }, (_, index) => ({
    id: index,
    label: 'x'.repeat(48),
  }))
  const singleLine = JSON.stringify(records)
  expect(singleLine.length).toBeGreaterThan(1_000_000)
  await writeFile(path, singleLine, 'utf8')

  const proposal = await inspectSourceFilesInProcess([{ sourceFile: 'big.json', path }])

  expect(proposal.unsupportedFiles).toEqual([])
  expect(proposal.tables[0]?.columns.map((column) => [column.name, column.type])).toEqual([
    ['id', 'BIGINT'],
    ['label', 'VARCHAR'],
  ])
})

it('persists an unambiguous day-first CSV date format for the projection', async () => {
  const path = join(directory, 'dates.csv')
  await writeFile(path, 'id,order_date\n1,31/01/2024\n2,29/02/2024\n', 'utf8')

  const proposal = await inspectSourceFilesInProcess([{ sourceFile: 'dates.csv', path }])

  expect(proposal.unsupportedFiles).toEqual([])
  expect(proposal.tables[0]?.columns.map((column) => column.type)).toEqual(['BIGINT', 'DATE'])
  expect(proposal.tables[0]?.dateFormat).toBe('%d/%m/%Y')
})

it('persists an unambiguous month-first CSV date format', async () => {
  const path = join(directory, 'us-dates.csv')
  await writeFile(path, 'id,order_date\n1,01/25/2024\n2,12/31/2024\n', 'utf8')

  const proposal = await inspectSourceFilesInProcess([{ sourceFile: 'us-dates.csv', path }])

  expect(proposal.unsupportedFiles).toEqual([])
  expect(proposal.tables[0]?.columns.map((column) => column.type)).toEqual(['BIGINT', 'DATE'])
  expect(proposal.tables[0]?.dateFormat).toBe('%m/%d/%Y')
})

it('preserves bounded decimals and does not coerce oversized integers to floating point', async () => {
  const parquetPath = join(directory, 'precision.parquet')
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  try {
    await connection.run(
      `COPY (SELECT 123456789012345678.1234::DECIMAL(22,4) AS amount,
                   18446744073709551615::UBIGINT AS external_id)
       TO ? (FORMAT PARQUET)`,
      [parquetPath],
    )
  } finally {
    connection.closeSync()
    instance.closeSync()
  }

  const proposal = await inspectSourceFilesInProcess([
    { sourceFile: 'precision.parquet', path: parquetPath },
  ])
  expect(proposal.tables[0]?.columns.map((column) => column.type)).toEqual([
    'DECIMAL(22,4)',
    'VARCHAR',
  ])
})

it('surfaces unsupported and malformed files without executing them', async () => {
  const scriptPath = join(directory, 'transform.py')
  const badJsonPath = join(directory, 'bad.json')
  await writeFile(scriptPath, 'raise Exception("must never run")', 'utf8')
  await writeFile(badJsonPath, '{not valid json', 'utf8')

  const proposal = await inspectSourceFilesInProcess([
    { sourceFile: 'transform.py', path: scriptPath },
    { sourceFile: 'bad.json', path: badJsonPath },
  ])

  expect(proposal.tables).toEqual([])
  expect(proposal.unsupportedFiles).toHaveLength(2)
  expect(proposal.unsupportedFiles[0]?.reason).toMatch(/never run/)
  expect(proposal.unsupportedFiles[1]?.reason).toMatch(/inspection failed/i)
})

it('samples only the head of a large CSV instead of scanning the whole file', async () => {
  const path = join(directory, 'wide.csv')
  const header = 'id,value'
  const body = Array.from({ length: 5_000 }, (_, index) => `${index},${index * 2}`).join('\n')
  await writeFile(path, `${header}\n${body}\n`, 'utf8')

  const started = Date.now()
  const proposal = await inspectSourceFilesInProcess([{ sourceFile: 'wide.csv', path }])
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(proposal.tables[0]?.columns.map((column) => column.name)).toEqual(['id', 'value'])
  expect(proposal.tables[0]?.warnings.some((warning) => /at most 200/.test(warning))).toBe(true)
})

it('skips junk entries and caps multi-file proposals', async () => {
  const ranked = selectInspectableSources(
    [
      { sourceFile: '__MACOSX/._orders.csv', path: '/tmp/a', sizeBytes: 99 },
      { sourceFile: 'orders.csv', path: '/tmp/b', sizeBytes: 100 },
      { sourceFile: 'notes.txt', path: '/tmp/c', sizeBytes: 5 },
      { sourceFile: 'data.sqlite', path: '/tmp/d', sizeBytes: 50 },
    ],
    { maxTables: 1 },
  )
  expect(ranked.selected.map((file) => file.sourceFile)).toEqual(['orders.csv'])
  expect(ranked.skipped.some((file) => /junk/i.test(file.reason))).toBe(true)
  expect(ranked.skipped.some((file) => /SQLite/i.test(file.reason))).toBe(true)
})

it('rejects legacy XLS instead of sending it to the XLSX reader', () => {
  const ranked = selectInspectableSources([
    { sourceFile: 'legacy.xls', path: '/tmp/legacy.xls', sizeBytes: 10 },
  ])
  expect(ranked.selected).toEqual([])
  expect(ranked.skipped).toEqual([
    { name: 'legacy.xls', reason: 'Legacy XLS requires a dedicated reviewed adapter' },
  ])
})

it('proposes Excel worksheets as excel-format tables', async () => {
  const ExcelJS = (await import('exceljs')).default
  const workbookPath = join(directory, 'sales.xlsx')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('North')
  sheet.addRow(['region', 'amount'])
  sheet.addRow(['West', 10])
  sheet.addRow(['East', 12])
  await workbook.xlsx.writeFile(workbookPath)

  const proposal = await inspectSourceFilesInProcess([
    { sourceFile: 'sales.xlsx', path: workbookPath },
  ])
  expect(proposal.unsupportedFiles).toEqual([])
  expect(proposal.tables[0]).toMatchObject({
    sourceFormat: 'excel',
    excelSheet: 'North',
  })
  expect(proposal.tables[0]?.columns.map((column) => column.name)).toEqual(['region', 'amount'])
})

it('parses A1 merge ranges and ignores a merged banner that is not the header row', () => {
  expect(parseA1Range('A1:C1')).toEqual({ startColumn: 1, endColumn: 3, row: 1 })
  expect(parseA1Range('$B$4')).toEqual({ startColumn: 2, endColumn: 2, row: 4 })
  expect(parseA1Range('not-a-range')).toBeNull()
  expect(
    describeSheetStructure({
      sheet: { model: { merges: ['A3:C3'] } },
      sheetName: 'Sales',
      sourceFile: 'quarter.xlsx',
      rows: [
        ['region', 'units', 'amount'],
        ['North', '5', '50'],
      ],
      rowNumbers: [1, 2],
    }),
  ).toEqual([])
})

it('notes a merged banner promoted to the header and a ragged row, without inventing one when the sheet is clean', () => {
  const notes = describeSheetStructure({
    sheet: { model: { merges: ['A1:C1'] } },
    sheetName: 'Sales',
    sourceFile: 'quarter.xlsx',
    // exceljs reports the merged master's value for every cell of the range,
    // which is exactly why the banner row materializes as the header.
    rows: [
      ['Quarterly Sales Report', 'Quarterly Sales Report', 'Quarterly Sales Report'],
      ['region', 'units', 'amount'],
      ['North', '5', '50'],
      ['South', '7'],
    ],
    rowNumbers: [1, 2, 3, 4],
  })
  expect(notes).toHaveLength(2)
  expect(notes[0]).toMatch(/merged banner spanning 3 columns/)
  expect(notes[0]).toContain('read as the table header')
  expect(notes[0]).toContain('re-run preview_ingest_source')
  expect(notes[1]).toMatch(/1 ragged row\(s\) \(row 4\)/)

  expect(
    describeSheetStructure({
      sheet: { model: {} },
      sheetName: 'RunNotes',
      sourceFile: 'quarter.xlsx',
      rows: [['note'], ['generated by finance']],
      rowNumbers: [1, 2],
    }),
  ).toEqual([])
})
