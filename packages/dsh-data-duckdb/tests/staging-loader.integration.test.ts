import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ONLINE_RETAIL_RECIPE } from 'dsh-data-core/recipes/online-retail'
import {
  InvalidIdentifierError,
  loadCsvIntoStaging,
  loadCsvRawIntoStaging,
  loadTabularIntoStaging,
  loadTabularRawIntoStaging,
  projectTypedFromRaw,
} from '../src/staging-loader.js'

let directory: string
let connection: DuckDBConnection
let instance: InstanceType<typeof DuckDBInstance>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-staging-loader-test-'))
  instance = await DuckDBInstance.create(join(directory, 'staging.duckdb'))
  connection = await instance.connect()
})

afterEach(async () => {
  connection.closeSync()
  instance.closeSync()
  await rm(directory, { recursive: true, force: true })
})

it('loads a clean CSV and profiles row count and null counts', async () => {
  const csvPath = join(directory, 'clean.csv')
  await writeFile(
    csvPath,
    'line_id,region,amount\n001,North,100.00\n002,South,50.00\n003,North,-20.00\n',
    'utf8',
  )

  const result = await loadCsvIntoStaging(connection, {
    csvPath,
    tableId: 'retail',
    columns: [
      { name: 'line_id', type: 'VARCHAR' },
      { name: 'region', type: 'VARCHAR' },
      { name: 'amount', type: 'DECIMAL(18,2)' },
    ],
  })

  expect(result.rowCount).toBe(3)
  expect(result.rejectedRows).toEqual([])
  expect(result.nullCounts).toEqual({ line_id: 0, region: 0, amount: 0 })

  const total = await connection.runAndReadAll('SELECT SUM(amount) FROM retail')
  expect(total.getRowsJson()).toEqual([['130.00']])
})

it('loads and projects columns named with reserved words via identifier quoting', async () => {
  const csvPath = join(directory, 'reserved.csv')
  await writeFile(
    csvPath,
    'cast,type,group,order,order_date,mixedcase,weird_name\n1,2,3,4,a,b,c\n',
    'utf8',
  )
  const columns = [
    { name: 'cast', type: 'BIGINT' },
    { name: 'type', type: 'BIGINT' },
    { name: 'group', type: 'BIGINT' },
    { name: 'order', type: 'BIGINT' },
    { name: 'order_date', type: 'VARCHAR' },
    { name: 'mixedcase', type: 'VARCHAR' },
    { name: 'weird_name', type: 'VARCHAR' },
  ]

  const raw = await loadCsvRawIntoStaging(connection, { csvPath, tableId: 'events', columns })
  expect(raw.rawRowCount).toBe(1)

  const projected = await projectTypedFromRaw(connection, { tableId: 'events', columns })
  expect(projected.projectionRowCount).toBe(1)
  expect(projected.castNullCounts).toEqual({
    cast: 0,
    type: 0,
    group: 0,
    order: 0,
    order_date: 0,
    mixedcase: 0,
    weird_name: 0,
  })

  // Reserved-word columns must be addressable through double-quoted identifiers.
  const read = await connection.runAndReadAll(
    'SELECT "cast", "type", "group", "order", "order_date", "mixedcase", "weird_name" FROM events',
  )
  expect(read.getRowsJson()).toEqual([['1', '2', '3', '4', 'a', 'b', 'c']])
})

it('uses DuckDB dialect detection for semicolon CSVs with multiline quoted records', async () => {
  const csvPath = join(directory, 'dialect.csv')
  await writeFile(csvPath, 'id;note;amount\n1;"first line\nsecond line";10.50\n', 'utf8')
  const result = await loadCsvIntoStaging(connection, {
    csvPath,
    tableId: 'dialect_rows',
    columns: [
      { name: 'id', sourceName: 'id', type: 'BIGINT' },
      { name: 'note', sourceName: 'note', type: 'VARCHAR' },
      { name: 'amount', sourceName: 'amount', type: 'DECIMAL(18,2)' },
    ],
  })
  expect(result).toMatchObject({ rowCount: 1, rejectedRows: [] })
  const rows = await connection.runAndReadAll('SELECT note, amount FROM dialect_rows')
  expect(rows.getRowsJson()).toEqual([['first line\nsecond line', '10.50']])
})

it('loads messy CSV losslessly then projects with cast-nulls (raw_then_typed)', async () => {
  const csvPath = join(directory, 'adaptive-messy.csv')
  await writeFile(
    csvPath,
    'line_id,region,amount\n001,North,100.00\n002,South,not-a-number\n003,North,-20.00\n',
    'utf8',
  )
  const columns = [
    { name: 'line_id', type: 'VARCHAR' },
    { name: 'region', type: 'VARCHAR' },
    { name: 'amount', type: 'DECIMAL(18,2)' },
  ]

  const raw = await loadCsvRawIntoStaging(connection, {
    csvPath,
    tableId: 'retail',
    columns,
  })
  expect(raw).toMatchObject({ sourceRowCount: 3, rawRowCount: 3, rawTableId: 'raw_retail' })

  const rawAmounts = await connection.runAndReadAll(
    'SELECT amount FROM raw_retail ORDER BY line_id',
  )
  expect(rawAmounts.getRowsJson()).toEqual([['100.00'], ['not-a-number'], ['-20.00']])

  const projected = await projectTypedFromRaw(connection, { tableId: 'retail', columns })
  expect(projected.projectionRowCount).toBe(3)
  expect(projected.castNullCounts.amount).toBe(1)
  const typed = await connection.runAndReadAll('SELECT amount FROM retail ORDER BY line_id')
  expect(typed.getRowsJson()).toEqual([['100.00'], [null], ['-20.00']])
})

it('quarantines cast failures via store_rejects instead of dropping or failing the whole load', async () => {
  const csvPath = join(directory, 'messy.csv')
  await writeFile(
    csvPath,
    'line_id,region,amount\n001,North,100.00\n002,South,not-a-number\n003,North,-20.00\n',
    'utf8',
  )

  const result = await loadCsvIntoStaging(connection, {
    csvPath,
    tableId: 'retail',
    columns: [
      { name: 'line_id', type: 'VARCHAR' },
      { name: 'region', type: 'VARCHAR' },
      { name: 'amount', type: 'DECIMAL(18,2)' },
    ],
  })

  // Two good rows loaded; the malformed row is quarantined, not silently dropped.
  expect(result.rowCount).toBe(2)
  expect(result.rejectedRows).toHaveLength(1)
  expect(result.rejectedRows[0]?.columnName).toBe('amount')
  expect(result.rejectedRows[0]?.errorMessage).toContain('not-a-number')
})

it('tracks null counts per column separately from quarantined rows', async () => {
  const csvPath = join(directory, 'nulls.csv')
  await writeFile(
    csvPath,
    'line_id,region,amount\n001,North,100.00\n002,,50.00\n003,North,\n',
    'utf8',
  )

  const result = await loadCsvIntoStaging(connection, {
    csvPath,
    tableId: 'retail',
    columns: [
      { name: 'line_id', type: 'VARCHAR' },
      { name: 'region', type: 'VARCHAR' },
      { name: 'amount', type: 'DECIMAL(18,2)' },
    ],
  })

  expect(result.rowCount).toBe(3)
  expect(result.rejectedRows).toEqual([])
  expect(result.nullCounts).toEqual({ line_id: 0, region: 1, amount: 1 })
})

it('scopes quarantined rows to the correct load when the connection loads more than one file', async () => {
  const firstCsv = join(directory, 'first.csv')
  const secondCsv = join(directory, 'second.csv')
  await writeFile(firstCsv, 'id,amount\n1,bad-value\n', 'utf8')
  await writeFile(secondCsv, 'id,amount\n2,worse-value\n', 'utf8')

  const first = await loadCsvIntoStaging(connection, {
    csvPath: firstCsv,
    tableId: 'first_table',
    columns: [
      { name: 'id', type: 'INTEGER' },
      { name: 'amount', type: 'DECIMAL(10,2)' },
    ],
  })
  const second = await loadCsvIntoStaging(connection, {
    csvPath: secondCsv,
    tableId: 'second_table',
    columns: [
      { name: 'id', type: 'INTEGER' },
      { name: 'amount', type: 'DECIMAL(10,2)' },
    ],
  })

  expect(first.rejectedRows).toHaveLength(1)
  expect(first.rejectedRows[0]?.errorMessage).toContain('bad-value')
  expect(second.rejectedRows).toHaveLength(1)
  expect(second.rejectedRows[0]?.errorMessage).toContain('worse-value')
})

it('rejects an unsafe table or column identifier before ever touching SQL', async () => {
  const csvPath = join(directory, 'clean.csv')
  await writeFile(csvPath, 'a\n1\n', 'utf8')
  await expect(
    loadCsvIntoStaging(connection, {
      csvPath,
      tableId: 'retail; DROP TABLE x',
      columns: [{ name: 'a', type: 'INTEGER' }],
    }),
  ).rejects.toBeInstanceOf(InvalidIdentifierError)
  await expect(
    loadCsvIntoStaging(connection, {
      csvPath,
      tableId: 'retail',
      columns: [{ name: 'a"; DROP TABLE x; --', type: 'INTEGER' }],
    }),
  ).rejects.toBeInstanceOf(InvalidIdentifierError)
  await expect(
    loadCsvIntoStaging(connection, {
      csvPath,
      tableId: 'retail',
      columns: [{ name: 'a', type: 'VARCHAR) FROM range(100) WHERE (1' }],
    }),
  ).rejects.toBeInstanceOf(InvalidIdentifierError)
})

it('maps CSV headers onto safe table column names and honors dateFormat for ambiguous US dates', async () => {
  const csvPath = join(directory, 'spaced.csv')
  // Single ambiguous date (11/8) — without an explicit US dateFormat DuckDB may
  // interpret this as 11 August. Force %m/%d/%Y so Order Date is 8 November.
  await writeFile(csvPath, 'Order ID,Order Date,Sales\nCA-2016-1,11/8/2016,100.50\n', 'utf8')

  const result = await loadCsvIntoStaging(connection, {
    csvPath,
    tableId: 'orders',
    dateFormat: '%m/%d/%Y',
    columns: [
      { name: 'order_id', sourceName: 'Order ID', type: 'VARCHAR' },
      { name: 'order_date', sourceName: 'Order Date', type: 'DATE' },
      { name: 'sales', sourceName: 'Sales', type: 'DECIMAL(18,2)' },
    ],
  })

  expect(result.rowCount).toBe(1)
  expect(result.rejectedRows).toEqual([])
  const rows = await connection.runAndReadAll(
    'SELECT order_id, CAST(order_date AS VARCHAR), sales FROM orders',
  )
  expect(rows.getRowsJson()).toEqual([['CA-2016-1', '2016-11-08', '100.50']])
})

it('projects day-first dates via a persisted dateFormat in raw_then_typed', async () => {
  const csvPath = join(directory, 'dates.csv')
  await writeFile(csvPath, 'order_date\n31/01/2024\n29/02/2024\n', 'utf8')
  const columns = [{ name: 'order_date', type: 'DATE' }]

  const raw = await loadCsvRawIntoStaging(connection, { csvPath, tableId: 'orders', columns })
  expect(raw.rawRowCount).toBe(2)

  const projected = await projectTypedFromRaw(connection, {
    tableId: 'orders',
    columns,
    dateFormat: '%d/%m/%Y',
  })
  expect(projected.castNullCounts).toEqual({ order_date: 0 })

  const rows = await connection.runAndReadAll('SELECT CAST(order_date AS VARCHAR) FROM orders')
  expect(rows.getRowsJson()).toEqual([['2024-01-31'], ['2024-02-29']])
})

it('preserves invalid formatted dates and timestamps for cast-null quality review', async () => {
  const csvPath = join(directory, 'dates-with-invalid-later-row.csv')
  await writeFile(
    csvPath,
    'order_date,event_at\n31/01/2024,31/01/2024 10:15:00\n29/02/2024,29/02/2024 20:30:00\nnot-a-date,not-a-timestamp\n',
    'utf8',
  )
  const columns = [
    { name: 'order_date', type: 'DATE' },
    { name: 'event_at', type: 'TIMESTAMP' },
  ]

  const raw = await loadCsvRawIntoStaging(connection, { csvPath, tableId: 'orders', columns })
  expect(raw.rawRowCount).toBe(3)

  const projected = await projectTypedFromRaw(connection, {
    tableId: 'orders',
    columns,
    dateFormat: '%d/%m/%Y',
    timestampFormat: '%d/%m/%Y %H:%M:%S',
  })
  expect(projected.projectionRowCount).toBe(3)
  expect(projected.castNullCounts).toEqual({ order_date: 1, event_at: 1 })

  const rawRows = await connection.runAndReadAll(
    'SELECT order_date, event_at FROM raw_orders ORDER BY rowid',
  )
  expect(rawRows.getRowsJson()).toEqual([
    ['31/01/2024', '31/01/2024 10:15:00'],
    ['29/02/2024', '29/02/2024 20:30:00'],
    ['not-a-date', 'not-a-timestamp'],
  ])
  const typedRows = await connection.runAndReadAll(
    'SELECT CAST(order_date AS VARCHAR), CAST(event_at AS VARCHAR) FROM orders ORDER BY rowid',
  )
  expect(typedRows.getRowsJson()).toEqual([
    ['2024-01-31', '2024-01-31 10:15:00'],
    ['2024-02-29', '2024-02-29 20:30:00'],
    [null, null],
  ])
})

it('treats CSV sourceName as non-executable metadata', async () => {
  const csvPath = join(directory, 'clean.csv')
  await writeFile(csvPath, 'a\n1\n', 'utf8')
  const result = await loadCsvIntoStaging(connection, {
    csvPath,
    tableId: 'orders',
    columns: [{ name: 'a', sourceName: "Order ID'; DROP TABLE x; --", type: 'INTEGER' }],
  })
  expect(result.rowCount).toBe(1)
})

it('loads Parquet through a bound path and safely quotes source column names', async () => {
  const parquetPath = join(directory, 'safe.parquet')
  await connection.run(
    `COPY (SELECT 1::BIGINT AS "odd""name", 10.25::DECIMAL(18,2) AS amount)
     TO ? (FORMAT PARQUET)`,
    [parquetPath],
  )
  const result = await loadTabularIntoStaging(connection, {
    sourcePath: parquetPath,
    sourceFormat: 'parquet',
    tableId: 'events',
    columns: [
      { name: 'odd_name', sourceName: 'odd"name', type: 'BIGINT' },
      { name: 'amount', sourceName: 'amount', type: 'DECIMAL(18,2)' },
    ],
  })
  expect(result).toMatchObject({ rowCount: 1, rejectedRows: [] })
  const rows = await connection.runAndReadAll('SELECT odd_name, amount FROM events')
  expect(rows.getRowsJson()).toEqual([['1', '10.25']])
})

it('loads Parquet and JSON as raw VARCHAR then projects without dropping rows', async () => {
  const parquetPath = join(directory, 'adaptive.parquet')
  await connection.run(
    `COPY (SELECT '1'::VARCHAR AS id, 'not-a-number'::VARCHAR AS amount
           UNION ALL SELECT '2', '10.50')
     TO ? (FORMAT PARQUET)`,
    [parquetPath],
  )
  const jsonPath = join(directory, 'adaptive.jsonl')
  await writeFile(jsonPath, '{"id":"1","amount":"bad"}\n{"id":"2","amount":"10.50"}\n', 'utf8')
  const columns = [
    { name: 'id', sourceName: 'id', type: 'BIGINT' },
    { name: 'amount', sourceName: 'amount', type: 'DECIMAL(18,2)' },
  ]

  const parquetRaw = await loadTabularRawIntoStaging(connection, {
    sourcePath: parquetPath,
    sourceFormat: 'parquet',
    tableId: 'events_pq',
    columns,
  })
  expect(parquetRaw).toMatchObject({ sourceRowCount: 2, rawRowCount: 2 })
  const pqProjected = await projectTypedFromRaw(connection, {
    tableId: 'events_pq',
    columns,
  })
  expect(pqProjected.projectionRowCount).toBe(2)
  expect(pqProjected.castNullCounts.amount).toBe(1)

  const jsonRaw = await loadTabularRawIntoStaging(connection, {
    sourcePath: jsonPath,
    sourceFormat: 'json',
    tableId: 'events_json',
    columns,
  })
  expect(jsonRaw.rawRowCount).toBe(2)
  const jsonProjected = await projectTypedFromRaw(connection, {
    tableId: 'events_json',
    columns,
  })
  expect(jsonProjected.castNullCounts.amount).toBe(1)
  const typed = await connection.runAndReadAll(
    'SELECT amount FROM events_json ORDER BY id NULLS LAST, amount NULLS FIRST',
  )
  expect(typed.getRowsJson().length).toBe(2)
})

it('fails closed when a reviewed JSON cast is invalid', async () => {
  const jsonPath = join(directory, 'bad-cast.jsonl')
  await writeFile(jsonPath, '{"id":"not-an-integer"}\n', 'utf8')
  await expect(
    loadTabularIntoStaging(connection, {
      sourcePath: jsonPath,
      sourceFormat: 'json',
      tableId: 'events',
      columns: [{ name: 'id', sourceName: 'id', type: 'BIGINT' }],
    }),
  ).rejects.toThrow(/convert|cast/i)
})

it('loads the pinned Online Retail index column without shifting quantities or prices', async () => {
  const csvPath = join(directory, 'online_retail_II.csv')
  await writeFile(
    csvPath,
    ',Invoice,StockCode,Description,Quantity,InvoiceDate,Price,Customer ID,Country\n0,489434,85048,GLASS BALL,12,2009-12-01 07:45:00,6.95,13085.0,United Kingdom\n1,C489434,85048,RETURN,-2,2009-12-01 07:45:00,6.95,,United Kingdom\n',
  )
  const recipe = ONLINE_RETAIL_RECIPE.tables[0]!
  const loaded = await loadCsvIntoStaging(connection, { ...recipe, csvPath })
  expect(loaded.rowCount).toBe(2)
  expect(loaded.rejectedRows).toEqual([])
  const totals = await connection.runAndReadAll(
    'SELECT SUM(quantity * price), COUNT(customer_id) FROM online_retail',
  )
  expect(totals.getRowsJson()).toEqual([['69.5000', '1']])
})
