/**
 * Spreadsheet-safe CSV for authorized query results (architecture export contract).
 * Formula-leading cells are prefixed with a single quote so Excel/Sheets do not
 * execute them. Exports the full authorized `rows` array, never preview-only.
 */

export function csvEscapeCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value)
  // Spreadsheet-safe: neutralize formula injection at cell start.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`
  }
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`
  }
  return text
}

export function renderResultCsv(columns: Array<{ name: string }>, rows: unknown[][]): string {
  const header = columns.map((column) => csvEscapeCell(column.name)).join(',')
  const body = rows.map((row) => row.map((cell) => csvEscapeCell(cell)).join(',')).join('\n')
  return `${header}\n${body}${rows.length > 0 ? '\n' : ''}`
}
