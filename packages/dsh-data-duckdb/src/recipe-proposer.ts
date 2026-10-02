/**
 * Trusted CSV recipe proposer: sample headers and rows to propose
 * ingest column types and identifiers. Models never author ETL; this code runs
 * in the plugin before an analyst approves a workspace pin.
 */
import { basename } from 'node:path'
import { assertSafeIdentifier } from './staging-loader.js'

export interface ProposedColumn {
  name: string
  sourceName: string
  type:
    | 'VARCHAR'
    | 'BOOLEAN'
    | 'BIGINT'
    | 'DOUBLE'
    | 'DATE'
    | 'TIMESTAMP'
    | `DECIMAL(${number},${number})`
  reason: string
}

export interface ProposedTableRecipe {
  sourceFile: string
  tableId: string
  columns: ProposedColumn[]
  warnings: string[]
}

export interface ProposedIngestRecipe {
  datasetId: string
  tables: ProposedTableRecipe[]
  unsupportedFiles: Array<{ name: string; reason: string }>
}

/**
 * Exported so `preview-ingest.ts` can bound
 * how many CSV lines it reads off disk to this exact same limit, instead of
 * `readFile`-ing an entire extracted (potentially multi-GiB) CSV only to
 * sample the first 200 rows of it here.
 */
export const SAMPLE_ROW_LIMIT = 200
const MAX_IDENTIFIER_LEN = 128
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/
const SAFE_SOURCE_NAME = /^[\w ./\-#()+]+$/
const UNSUPPORTED_SUFFIXES: ReadonlyArray<{ suffix: string; reason: string }> = [
  {
    suffix: '.parquet',
    reason: 'Parquet is handled by preview_ingest_source inspection, not the CSV-text proposer',
  },
  {
    suffix: '.xlsx',
    reason: 'Excel is handled by preview_ingest_source inspection, not the CSV-text proposer',
  },
  {
    suffix: '.xls',
    reason: 'Excel is handled by preview_ingest_source inspection, not the CSV-text proposer',
  },
  { suffix: '.ipynb', reason: 'Notebook files are not executed during ingest' },
  { suffix: '.py', reason: 'Python scripts are not executed during ingest' },
  { suffix: '.sqlite', reason: 'SQLite requires a dedicated reviewed adapter' },
  { suffix: '.sqlite3', reason: 'SQLite requires a dedicated reviewed adapter' },
  { suffix: '.db', reason: 'SQLite requires a dedicated reviewed adapter' },
]

type ProposedType = ProposedColumn['type']
type InferredValueType = ProposedType | 'EMPTY'

function isSafeSourceName(name: string): boolean {
  return (
    SAFE_SOURCE_NAME.test(name) && !name.includes("'") && !name.includes('"') && !name.includes(';')
  )
}

function isSafeIdentifier(name: string): boolean {
  return SAFE_IDENTIFIER.test(name)
}

function sanitizeStem(raw: string): string {
  let stem = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')

  if (stem.length === 0 || /^\d/.test(stem)) {
    stem = `col_${stem}`
  }
  return stem
}

function allocateUniqueName(stem: string, used: Set<string>): string {
  let suffixNumber = 1
  while (suffixNumber < 100_000) {
    const suffix = suffixNumber === 1 ? '' : `_${suffixNumber}`
    const maxStemLen = MAX_IDENTIFIER_LEN - suffix.length
    const candidate = `${stem.slice(0, maxStemLen)}${suffix}`
    if (isSafeIdentifier(candidate) && !used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
    suffixNumber += 1
  }
  throw new Error('Unable to allocate a unique column identifier')
}

function resolveColumnNames(
  header: string,
  columnIndex: number,
  used: Set<string>,
): { name: string; sourceName: string; warnings: string[] } {
  const warnings: string[] = []
  const sourceName = isSafeSourceName(header) ? header : `col_${columnIndex + 1}`
  if (sourceName !== header) {
    warnings.push(`Unsafe CSV header label "${header}"; using generated sourceName ${sourceName}`)
  }

  const stem = sanitizeStem(header)
  const name = isSafeIdentifier(stem)
    ? allocateUniqueName(stem, used)
    : allocateUniqueName(`col_${columnIndex + 1}`, used)

  return { name, sourceName, warnings }
}

function normalizeDuckDbType(type: string): ProposedType {
  const normalized = type.toUpperCase()
  if (normalized === 'BOOLEAN') return 'BOOLEAN'
  if (/^(?:TINYINT|SMALLINT|INTEGER|BIGINT)$/.test(normalized)) return 'BIGINT'
  if (/^(?:UTINYINT|USMALLINT|UINTEGER)$/.test(normalized)) return 'BIGINT'
  if (/^(?:FLOAT|REAL|DOUBLE)$/.test(normalized)) return 'DOUBLE'
  const decimal = /^DECIMAL\((\d+),(\d+)\)$/.exec(normalized)
  if (decimal) {
    const precision = Number(decimal[1])
    const scale = Number(decimal[2])
    if (precision >= 1 && precision <= 38 && scale >= 0 && scale <= precision) {
      return `DECIMAL(${precision},${scale})`
    }
  }
  // DuckDB's wider unsigned/128-bit integers cannot be represented exactly
  // by the current BIGINT contract. Preserve their textual value instead.
  if (/^(?:HUGEINT|UHUGEINT|UBIGINT)$/.test(normalized)) return 'VARCHAR'
  if (normalized === 'DATE') return 'DATE'
  if (normalized.startsWith('TIMESTAMP')) return 'TIMESTAMP'
  return 'VARCHAR'
}

/** Convert DuckDB-inspected source schema into safe reviewed recipe columns. */
export function proposeColumnsFromSchema(
  schema: ReadonlyArray<{ sourceName: string; sourceType: string }>,
): { columns: ProposedColumn[]; warnings: string[] } {
  const warnings: string[] = []
  const usedNames = new Set<string>()
  const columns = schema.map((entry, columnIndex) => {
    const resolved = resolveColumnNames(entry.sourceName, columnIndex, usedNames)
    warnings.push(...resolved.warnings)
    const type = normalizeDuckDbType(entry.sourceType)
    if (type === 'VARCHAR' && entry.sourceType.toUpperCase() !== 'VARCHAR') {
      warnings.push(
        `Source column "${entry.sourceName}" has ${entry.sourceType}; converted to VARCHAR for controlled ingest`,
      )
    }
    return {
      name: resolved.name,
      sourceName: entry.sourceName,
      type,
      reason: `DuckDB inspected ${entry.sourceType}; reviewed ingest type is ${type}`,
    }
  })
  return { columns, warnings }
}

function isUnsupportedSourceFile(sourceFile: string): { name: string; reason: string } | null {
  const lower = sourceFile.toLowerCase()
  for (const entry of UNSUPPORTED_SUFFIXES) {
    if (lower.endsWith(entry.suffix)) {
      return { name: sourceFile, reason: entry.reason }
    }
  }
  return null
}

function isCsvSourceFile(sourceFile: string): boolean {
  return sourceFile.toLowerCase().endsWith('.csv')
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === ',') {
      fields.push(current)
      current = ''
      continue
    }
    current += char
  }

  fields.push(current)
  return fields
}

function parseCsvContent(content: string): { headers: string[]; rows: string[][] } {
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)

  if (lines.length === 0) {
    return { headers: [], rows: [] }
  }

  const headers = parseCsvLine(lines[0]!)
  const rows = lines.slice(1).map(parseCsvLine)
  return { headers, rows }
}

/**
 * Header labels exactly as the source wrote them, from the first record of
 * `csvText`. DuckDB's reader renames a duplicated or blank header before the
 * proposer ever sees it (`region` → `region_1`, `` → `column3`), so the only
 * way to tell the analyst their header was malformed is to read the raw
 * labels here. Quote-aware, and stops at the first record: an unterminated
 * record (a header longer than the byte-bounded head sample) returns `[]`
 * rather than a partial, misleading list.
 */
export function readHeaderLabels(csvText: string): string[] {
  const text = csvText.replace(/^\uFEFF/, '')
  const labels: string[] = []
  let current = ''
  let inQuotes = false
  let closed = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          current += '"'
          index += 1
        } else {
          inQuotes = false
        }
        continue
      }
      current += char
      continue
    }
    if (char === '"' && current === '') {
      inQuotes = true
      continue
    }
    if (char === ',' || char === '\t' || char === ';') {
      labels.push(current)
      current = ''
      continue
    }
    if (char === '\n' || char === '\r') {
      closed = true
      break
    }
    current += char
  }
  if (inQuotes || !closed) return []
  labels.push(current)
  return labels
}

/**
 * Quality note for a header row whose labels are duplicated or blank, or
 * `undefined` when the header is clean. The reader's rename is silent, so
 * without this the analyst's column review cannot tell that a proposed
 * `region_1` / `column3` was generated rather than authored.
 */
export function headerLabelQualityWarning(labels: readonly string[]): string | undefined {
  if (labels.length === 0) return undefined
  const counts = new Map<string, number>()
  const blanks: number[] = []
  labels.forEach((label, index) => {
    const key = label.trim()
    if (key === '') {
      blanks.push(index + 1)
      return
    }
    const normalized = key.toLowerCase()
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  })
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1)
  if (duplicates.length === 0 && blanks.length === 0) return undefined
  const parts: string[] = []
  if (duplicates.length > 0) {
    parts.push(
      `${duplicates.length} duplicated header label(s): ${duplicates
        .map(([label, count]) => `${label} (x${count})`)
        .join(', ')}`,
    )
  }
  if (blanks.length > 0) {
    parts.push(`${blanks.length} blank header label(s) at position(s) ${blanks.join(', ')}`)
  }
  return (
    `Source header row has ${parts.join('; ')} — the reader renames those columns ` +
    `(e.g. region_1, column3) before proposing them; values are still loaded positionally, ` +
    `so confirm each proposed name maps to its own source column before approving`
  )
}

export function allocateTableId(sourceFile: string, used: Set<string>): string {
  const stem = basename(sourceFile).replace(/\.(?:csv|parquet|jsonl?|ndjson)$/i, '')
  const sanitized = sanitizeStem(stem)
  return allocateUniqueName(isSafeIdentifier(sanitized) ? sanitized : 'table', used)
}

function inferValueType(value: string): InferredValueType {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'na') {
    return 'EMPTY'
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(trimmed)) {
    return 'TIMESTAMP'
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed)) {
    return 'DATE'
  }
  if (/^-?\d+\.\d{1,2}$/.test(trimmed)) {
    return 'DECIMAL(18,2)'
  }
  if (/^-?\d+$/.test(trimmed)) {
    return 'BIGINT'
  }
  if (/^-?\d+\.\d+$/.test(trimmed) || /^-?\d+\.?\d*[eE][+-]?\d+$/.test(trimmed)) {
    return 'DOUBLE'
  }
  return 'VARCHAR'
}

function inferColumnType(values: readonly string[]): {
  type: ProposedType
  reason: string
  warning?: string
} {
  const sampled = values.slice(0, SAMPLE_ROW_LIMIT)
  const nonEmptyTypes = sampled
    .map(inferValueType)
    .filter((type): type is ProposedType => type !== 'EMPTY')
  const uniqueTypes = [...new Set(nonEmptyTypes)]

  if (uniqueTypes.length === 0) {
    return { type: 'VARCHAR', reason: 'No non-empty sample values; defaulted to VARCHAR' }
  }
  if (uniqueTypes.length > 1) {
    return {
      type: 'VARCHAR',
      reason: 'Mixed inferred types in sample; defaulted to VARCHAR',
      warning: `Column values suggest conflicting types (${uniqueTypes.join(', ')}); defaulted to VARCHAR`,
    }
  }

  const type = uniqueTypes[0]!
  return {
    type,
    reason: `All ${nonEmptyTypes.length} sampled non-empty values (up to ${SAMPLE_ROW_LIMIT}) match ${type}`,
  }
}

function proposeTableFromCsv(
  sourceFile: string,
  content: string,
  tableId: string,
): ProposedTableRecipe {
  const warnings: string[] = []
  const { headers, rows } = parseCsvContent(content)

  if (headers.length === 0) {
    return {
      sourceFile,
      tableId,
      columns: [],
      warnings: ['CSV file has no header row'],
    }
  }

  const usedNames = new Set<string>()
  const columns: ProposedColumn[] = []

  for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
    const header = headers[columnIndex]!
    const resolved = resolveColumnNames(header, columnIndex, usedNames)
    warnings.push(...resolved.warnings)

    const columnValues = rows.slice(0, SAMPLE_ROW_LIMIT).map((row) => row[columnIndex] ?? '')
    const inferred = inferColumnType(columnValues)
    if (inferred.warning) warnings.push(inferred.warning)

    columns.push({
      name: resolved.name,
      sourceName: resolved.sourceName,
      type: inferred.type,
      reason: inferred.reason,
    })
  }

  assertSafeIdentifier(tableId, 'Table id')
  for (const column of columns) {
    assertSafeIdentifier(column.name, 'Column name')
  }

  return { sourceFile, tableId, columns, warnings }
}

export function proposeRecipeFromCsvFiles(
  files: ReadonlyArray<{ sourceFile: string; content: string }>,
): ProposedIngestRecipe {
  const unsupportedFiles: Array<{ name: string; reason: string }> = []
  const tables: ProposedTableRecipe[] = []
  const usedTableIds = new Set<string>()

  for (const file of files) {
    const unsupported = isUnsupportedSourceFile(file.sourceFile)
    if (unsupported) {
      unsupportedFiles.push(unsupported)
      continue
    }
    if (!isCsvSourceFile(file.sourceFile)) {
      unsupportedFiles.push({
        name: file.sourceFile,
        reason: 'Only CSV files are supported in the CSV-first proposer',
      })
      continue
    }
    tables.push(
      proposeTableFromCsv(
        file.sourceFile,
        file.content,
        allocateTableId(file.sourceFile, usedTableIds),
      ),
    )
  }

  return {
    datasetId: tables[0]?.tableId ?? '',
    tables,
    unsupportedFiles,
  }
}
