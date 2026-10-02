/**
 * Trusted Excel → CSV materialization for controlled ingest (Phase 3).
 * Uses exceljs; does not execute formulas beyond exceljs' stored values/results.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && value !== null && 'text' in value) {
    return String((value as { text: unknown }).text ?? '')
  }
  if (typeof value === 'object' && value !== null && 'result' in value) {
    return String((value as { result: unknown }).result ?? '')
  }
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function csvEscape(cell: string): string {
  if (/[",\n\r]/.test(cell)) return `"${cell.replaceAll('"', '""')}"`
  return cell
}

/**
 * Write one worksheet to a temporary UTF-8 CSV (full sheet, not sample-capped).
 */
export async function excelSheetToTempCsv(
  workbookPath: string,
  sheetName: string,
): Promise<string> {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(workbookPath)
  const sheet =
    workbook.getWorksheet(sheetName) ??
    workbook.worksheets.find((candidate) => candidate.name === sheetName)
  if (!sheet) {
    throw new Error(`Excel sheet "${sheetName}" was not found in the workbook`)
  }
  const rows: string[][] = []
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : []
    rows.push(values.map((value) => cellToString(value)))
  })
  if (rows.length < 2) {
    throw new Error(
      `Excel sheet "${sheetName}" has no header+data rows. Next step: remove that sheet from the workbook, or re-export it with one header row and at least one data row, then run preview_ingest_source again.`,
    )
  }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-excel-load-'))
  const csvPath = join(dir, 'sheet.csv')
  await writeFile(
    csvPath,
    `${rows.map((cols) => cols.map(csvEscape).join(',')).join('\n')}\n`,
    'utf8',
  )
  return csvPath
}
