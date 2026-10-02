import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { assertSafeIdentifier } from '../src/staging-loader.js'
import {
  headerLabelQualityWarning,
  proposeRecipeFromCsvFiles,
  readHeaderLabels,
} from '../src/recipe-proposer.js'

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/propose-ingest/orders.csv',
)

it('sanitizes header labels into safe identifiers while retaining sourceName', () => {
  const proposal = proposeRecipeFromCsvFiles([
    {
      sourceFile: 'orders.csv',
      content: 'Order Date,Customer ID,Sub-Category\n2024-01-01,C001,Chairs\n',
    },
  ])

  expect(proposal.tables).toHaveLength(1)
  const columns = proposal.tables[0]!.columns
  expect(columns.map((column) => column.name)).toEqual([
    'order_date',
    'customer_id',
    'sub_category',
  ])
  expect(columns.map((column) => column.sourceName)).toEqual([
    'Order Date',
    'Customer ID',
    'Sub-Category',
  ])
  for (const column of columns) {
    expect(() => assertSafeIdentifier(column.name, 'Column name')).not.toThrow()
  }
  expect(() => assertSafeIdentifier(proposal.tables[0]!.tableId, 'Table id')).not.toThrow()
})

it('preserves reserved-word headers as valid identifiers (loaders must quote them)', () => {
  const proposal = proposeRecipeFromCsvFiles([
    { sourceFile: 'orders.csv', content: 'cast,type,group,order\n1,2,3,4\n' },
  ])
  // Reserved words pass the safe-identifier shape but must be double-quoted
  // wherever the loaders interpolate them into SQL — see staging-loader tests.
  expect(proposal.tables[0]!.columns.map((column) => column.name)).toEqual([
    'cast',
    'type',
    'group',
    'order',
  ])
})

it('detects DECIMAL(18,2) columns from sampled monetary values', () => {
  const proposal = proposeRecipeFromCsvFiles([
    {
      sourceFile: 'orders.csv',
      content: 'Region,Sales\nWest,100.50\nEast,200.75\nCentral,300.25\n',
    },
  ])

  const sales = proposal.tables[0]!.columns.find((column) => column.name === 'sales')
  expect(sales).toMatchObject({
    sourceName: 'Sales',
    type: 'DECIMAL(18,2)',
  })
  expect(sales?.reason).toMatch(/DECIMAL/i)
})

it('defaults mixed numeric samples to VARCHAR with a warning', () => {
  const content = readFileSync(fixturePath, 'utf8')
  const proposal = proposeRecipeFromCsvFiles([{ sourceFile: 'orders.csv', content }])

  const sales = proposal.tables[0]!.columns.find((column) => column.name === 'sales')
  expect(sales?.type).toBe('VARCHAR')
  expect(
    proposal.tables[0]!.warnings.some((warning) => /conflict|mixed|VARCHAR/i.test(warning)),
  ).toBe(true)
})

it('lists xlsx, parquet, notebooks, and python files as unsupported', () => {
  const proposal = proposeRecipeFromCsvFiles([
    { sourceFile: 'data.xlsx', content: 'ignored' },
    { sourceFile: 'metrics.parquet', content: 'ignored' },
    { sourceFile: 'analysis.ipynb', content: '{}' },
    { sourceFile: 'transform.py', content: 'print(1)' },
    { sourceFile: 'orders.csv', content: 'Region,Sales\nWest,100.50\n' },
  ])

  expect(proposal.tables).toHaveLength(1)
  expect(proposal.tables[0]!.sourceFile).toBe('orders.csv')
  expect(proposal.unsupportedFiles.map((file) => file.name)).toEqual([
    'data.xlsx',
    'metrics.parquet',
    'analysis.ipynb',
    'transform.py',
  ])
  for (const file of proposal.unsupportedFiles) {
    expect(file.reason.length).toBeGreaterThan(0)
  }
})

it('keeps a safe sourceName for an unsafe identifier header with a generated name', () => {
  const proposal = proposeRecipeFromCsvFiles([
    {
      sourceFile: 'orders.csv',
      content: '123Sales,Region\n100.50,West\n',
    },
  ])

  const column = proposal.tables[0]!.columns[0]!
  expect(column.sourceName).toBe('123Sales')
  expect(column.name).toBe('col_123sales')
  expect(() => assertSafeIdentifier(column.name, 'Column name')).not.toThrow()
})

it('deduplicates 128-character colliding stems without looping', () => {
  const stem = 'a'.repeat(128)
  const proposal = proposeRecipeFromCsvFiles([
    {
      sourceFile: 'wide.csv',
      content: `${stem},${stem}\n1,2\n`,
    },
  ])

  const names = proposal.tables[0]!.columns.map((column) => column.name)
  expect(names[0]).toBe(stem)
  expect(names[1]).toBe(`${'a'.repeat(126)}_2`)
  expect(names[0]).not.toBe(names[1])
  expect(new Set(names).size).toBe(2)
  for (const name of names) {
    expect(name.length).toBeLessThanOrEqual(128)
    expect(() => assertSafeIdentifier(name, 'Column name')).not.toThrow()
  }
})

it('samples at most 200 data rows when inferring column types', () => {
  const rows = ['Region,Sales', ...Array.from({ length: 250 }, (_, index) => `R${index},1.00`)]
  const proposal = proposeRecipeFromCsvFiles([
    { sourceFile: 'large.csv', content: rows.join('\n') },
  ])

  const sales = proposal.tables[0]!.columns.find((column) => column.name === 'sales')
  expect(sales?.type).toBe('DECIMAL(18,2)')
  expect(sales?.reason).toMatch(/200/)
})

it('allocates unique table ids across directories with the same basename', () => {
  const proposal = proposeRecipeFromCsvFiles([
    { sourceFile: 'north/orders.csv', content: 'id\n1\n' },
    { sourceFile: 'south/orders.csv', content: 'id\n2\n' },
  ])

  expect(proposal.tables.map((table) => table.tableId)).toEqual(['orders', 'orders_2'])
})

it('reads the raw header labels DuckDB would otherwise rename away', () => {
  expect(readHeaderLabels('region,region,,sales\nNorth,north-dupe,blank-a,10\n')).toEqual([
    'region',
    'region',
    '',
    'sales',
  ])
  // Quoted labels keep their commas; a banner row is still one record.
  expect(readHeaderLabels('"a,b",c\n1,2\n')).toEqual(['a,b', 'c'])
})

it('does not guess a header from an unterminated record', () => {
  // A header longer than the byte-bounded head sample never closes its first
  // record: report nothing rather than a truncated, misleading label list.
  expect(readHeaderLabels('region,region,sales')).toEqual([])
  // A legitimately quoted multi-line label is still one record.
  expect(readHeaderLabels('"multi\nline",c\n')).toEqual(['multi\nline', 'c'])
})

it('reports duplicated and blank header labels as one quality note, and stays silent when the header is clean', () => {
  expect(headerLabelQualityWarning(['id', 'name', 'sales'])).toBeUndefined()
  const warning = headerLabelQualityWarning(['row_id', 'region', 'region', '', 'sales'])
  expect(warning).toContain('1 duplicated header label(s): region (x2)')
  expect(warning).toContain('1 blank header label(s) at position(s) 4')
  expect(warning).toContain('column3')
})

it('flags a duplicated label even when the duplicate differs only in case or padding', () => {
  const warning = headerLabelQualityWarning(['Region', ' region ', 'sales'])
  expect(warning).toContain('1 duplicated header label(s): region (x2)')
  expect(warning).not.toContain('blank')
})
