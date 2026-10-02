/**
 * Bounded, trusted schema inspection for generic Kaggle tabular files.
 * DuckDB owns CSV dialect/quoted-record parsing and JSON/Parquet decoding;
 * Excel sheets are converted through exceljs then inspected as CSV.
 * No model-authored transform or source-provided SQL is executed.
 */
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import {
  detectCsvEncoding,
  normalizeCsvToUtf8,
  type SupportedSourceEncoding,
} from './csv-encoding.js'
import { detectStrptimeFormat } from './date-format.js'
import {
  allocateTableId,
  headerLabelQualityWarning,
  proposeColumnsFromSchema,
  readHeaderLabels,
  SAMPLE_ROW_LIMIT,
  type ProposedIngestRecipe,
  type ProposedTableRecipe,
} from './recipe-proposer.js'
import { quoteIdentifier } from './staging-loader.js'

export type InspectedSourceFormat = 'csv' | 'parquet' | 'json' | 'excel'

export interface InspectableSourceFile {
  sourceFile: string
  path: string
  /** Byte size when known; used to rank multi-file archives. */
  sizeBytes?: number
}

export interface InspectedTableRecipe extends ProposedTableRecipe {
  sourceFormat: InspectedSourceFormat
  /** Worksheet name when sourceFormat is excel. */
  excelSheet?: string
  /** Detected CSV source encoding; omitted for UTF-8 (the read default). */
  sourceEncoding?: SupportedSourceEncoding
  /** Detected strftime pattern for DATE columns (CSV only); persisted so the projection re-parses with the same convention. */
  dateFormat?: string
  /** Detected strftime pattern for TIMESTAMP columns (CSV only). */
  timestampFormat?: string
}

export interface InspectedIngestRecipe extends Omit<ProposedIngestRecipe, 'tables'> {
  tables: InspectedTableRecipe[]
}

/** Soft cap on tables proposed from one archive (Phase 2). */
export const MAX_PROPOSED_TABLES = 20

/** Default child-process inspection deadline (Phase 1). */
export const DEFAULT_INSPECT_TIMEOUT_MS = 60_000

function formatFor(name: string): InspectedSourceFormat | undefined {
  if (/\.csv$/i.test(name)) return 'csv'
  if (/\.parquet$/i.test(name)) return 'parquet'
  if (/\.(?:json|jsonl|ndjson)$/i.test(name)) return 'json'
  if (/\.xlsx$/i.test(name)) return 'excel'
  return undefined
}

function unsupportedReason(name: string): string {
  if (/\.(?:sqlite|sqlite3|db)$/i.test(name)) {
    return 'SQLite requires a dedicated reviewed adapter (not enabled yet)'
  }
  if (/\.xls$/i.test(name)) return 'Legacy XLS requires a dedicated reviewed adapter'
  if (/\.(?:py|ipynb|r)$/i.test(name)) return 'Executable source files are never run during ingest'
  return 'File format is not supported by a controlled tabular adapter'
}

function isJunkEntry(name: string): boolean {
  const base = basename(name)
  if (name.includes('__MACOSX/') || name.startsWith('__MACOSX')) return true
  if (base.startsWith('.')) return true
  if (base === 'Thumbs.db' || base.toLowerCase() === 'desktop.ini') return true
  return false
}

function inspectionSql(
  format: Exclude<InspectedSourceFormat, 'excel'>,
  sourceFile?: string,
): string {
  if (format === 'csv') {
    return `DESCRIBE SELECT * FROM read_csv_auto(?, header=true, sample_size=${SAMPLE_ROW_LIMIT}, ignore_errors=true)`
  }
  if (format === 'json') {
    const jsonl = sourceFile !== undefined && /\.(?:jsonl|ndjson)$/i.test(sourceFile)
    const formatArg = jsonl ? 'newline_delimited' : 'auto'
    // Do not pass ignore_errors: DuckDB cannot ignore parse errors for auto JSON
    // and some malformed payloads busy-loop under that flag.
    return `DESCRIBE SELECT * FROM read_json_auto(?, format='${formatArg}', sample_size=${SAMPLE_ROW_LIMIT})`
  }
  return 'DESCRIBE SELECT * FROM read_parquet(?)'
}

/** Hard byte cap for head samples (protects against pathological long lines). */
const SAMPLE_BYTE_LIMIT = 1_000_000

// A single non-nested quantified character class (no `(?:...)+` wrapping another
// unbounded quantifier) — nesting two unbounded repetitions here previously caused
// catastrophic backtracking on error messages that contain many path-like
// characters but never actually end in a supported extension.
const SOURCE_FILE_PATH_PATTERN = /[\w ./-]+\.(?:csv|parquet|jsonl?|ndjson|xlsx?)/gi

function safeInspectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // A sheet whose dialect cannot be sniffed is the one failure this path has no
  // recovery hint for on its own; the acceptance contract says a refusal names
  // both the reason and the next step.
  const nextStep = /sniff|dialect/i.test(message)
    ? ' Next step: re-export that sheet as a single-header CSV with one consistent delimiter, or remove it from the workbook and run preview_ingest_source again.'
    : ''
  return `${message.replaceAll(SOURCE_FILE_PATH_PATTERN, '<source-file>').slice(0, 300)}${nextStep}`
}

async function readHeadBytes(sourcePath: string): Promise<Buffer> {
  // Byte-capped read avoids readline for-await hangs on files without a final newline.
  const handle = await open(sourcePath, 'r')
  try {
    const buffer = Buffer.alloc(SAMPLE_BYTE_LIMIT)
    const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTE_LIMIT, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function readHeadSampleInfo(
  sourcePath: string,
): Promise<{ sourceEncoding: SupportedSourceEncoding; headText: string }> {
  const bytes = await readHeadBytes(sourcePath)
  const sourceEncoding = detectCsvEncoding(bytes)
  // Decode with the detected encoding so head text is valid UTF-8 for the
  // JSONL fast-path gate (the raw file may be windows-1252 / UTF-16).
  const headText = new TextDecoder(sourceEncoding).decode(bytes)
  return { sourceEncoding, headText }
}

/**
 * Return a UTF-8 inspection path for DuckDB. UTF-8 sources are inspected in
 * place; other encodings are normalized to a temp file first. Never hand-slice
 * records: DuckDB's own readers bound type inference via `sample_size`, and a
 * line/byte truncation would cut quoted multiline CSV records and pretty-printed
 * JSON arrays in half.
 */
async function ensureUtf8Source(
  sourcePath: string,
  sourceEncoding: SupportedSourceEncoding,
): Promise<{ path: string; tempDir?: string }> {
  if (sourceEncoding === 'utf-8') return { path: sourcePath }
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-inspect-utf8-'))
  const path = join(tempDir, `source${extname(sourcePath) || '.txt'}`)
  await normalizeCsvToUtf8(sourcePath, path, { fromEncoding: sourceEncoding })
  return { path, tempDir }
}

/**
 * Cheap fast-path gate for JSONL/NDJSON only (records are one per line, so
 * line sampling is complete and never truncates a record). Single-document
 * JSON (object/array) is validated whole via `validateSingleJsonDocument` and
 * then inspected by DuckDB `read_json_auto` — a truncated line/byte sample
 * would split a valid pretty-printed array in half and report it as malformed.
 */
function assertJsonlSampleParseable(headText: string): void {
  const lines = headText.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) throw new Error('JSONL sample has no records')
  for (const line of lines.slice(0, 5)) {
    JSON.parse(line)
  }
}

/** Whole-document JSON validation cap; larger docs are left to worker-bounded DuckDB. */
const JSON_VALIDATE_BYTE_LIMIT = 64 * 1024 * 1024

/**
 * Validate a single JSON document by parsing the complete file (never a
 * truncated sample) so malformed input fails fast without reaching DuckDB's
 * slower auto-format rejection. Files beyond the cap skip this and rely on the
 * resource-bounded worker.
 *
 * Also rejects a non-array root (e.g. `{"metadata": ..., "records": [...]}`):
 * DuckDB's `read_json_auto` treats a top-level object as exactly one row, so
 * nested record arrays would silently collapse into a single VARCHAR-stuffed
 * row instead of being recognized as non-tabular. A flat array of objects (or
 * newline-delimited JSONL, handled separately) is the only supported shape.
 */
async function validateSingleJsonDocument(
  sourcePath: string,
  sourceEncoding: SupportedSourceEncoding,
): Promise<void> {
  const info = await stat(sourcePath)
  if (info.size > JSON_VALIDATE_BYTE_LIMIT) return
  const bytes = await readFile(sourcePath)
  const text = new TextDecoder(sourceEncoding).decode(bytes)
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) {
    throw new Error(
      'JSON document is not a flat array of records (found a top-level object); ' +
        'export as a JSON array of objects or newline-delimited JSONL instead',
    )
  }
}

async function sampleCsvRawStrings(
  connection: DuckDBConnection,
  csvPath: string,
  sourceName: string,
): Promise<string[]> {
  const columnRef = quoteIdentifier(sourceName)
  const reader = await connection.runAndReadAll(
    `SELECT DISTINCT ${columnRef} FROM (
       SELECT ${columnRef} FROM read_csv_auto(?, header=true, all_varchar=true) LIMIT ${SAMPLE_ROW_LIMIT}
     )`,
    [csvPath],
  )
  return reader
    .getRowsJson()
    .map((row) => String(row[0] ?? '').trim())
    .filter((value) => value !== '')
}

interface DateTimeFormatDetection {
  dateFormat?: string
  timestampFormat?: string
  warnings: string[]
}

/**
 * Detect table-level DATE/TIMESTAMP strftime patterns from raw CSV strings so
 * the projection (`projectTypedFromRaw`) re-parses with the same convention
 * DuckDB used to infer the column. Ambiguous values (DD/MM vs MM/DD) produce a
 * review warning and no format instead of a silent calendar choice.
 */
async function detectTableDateTimeFormats(
  connection: DuckDBConnection,
  csvPath: string,
  schema: ReadonlyArray<{ sourceName: string; sourceType: string }>,
  columns: ProposedTableRecipe['columns'],
): Promise<DateTimeFormatDetection> {
  const dateColumns: string[] = []
  const timestampColumns: string[] = []
  columns.forEach((column, index) => {
    const sourceName = schema[index]?.sourceName
    if (!sourceName) return
    if (column.type === 'DATE') dateColumns.push(sourceName)
    else if (column.type === 'TIMESTAMP') timestampColumns.push(sourceName)
  })

  const warnings: string[] = []
  const dateFormat = await detectColumnFormat(connection, csvPath, dateColumns, 'DATE', warnings)
  const timestampFormat = await detectColumnFormat(
    connection,
    csvPath,
    timestampColumns,
    'TIMESTAMP',
    warnings,
  )
  return {
    ...(dateFormat ? { dateFormat } : {}),
    ...(timestampFormat ? { timestampFormat } : {}),
    warnings,
  }
}

async function detectColumnFormat(
  connection: DuckDBConnection,
  csvPath: string,
  sourceNames: string[],
  kind: 'DATE' | 'TIMESTAMP',
  warnings: string[],
): Promise<string | undefined> {
  if (sourceNames.length === 0) return undefined
  const samples: string[] = []
  for (const sourceName of sourceNames) {
    samples.push(...(await sampleCsvRawStrings(connection, csvPath, sourceName)))
  }
  const detection = detectStrptimeFormat(samples, kind)
  if (detection.format) return detection.format
  if (detection.ambiguous) {
    warnings.push(`${kind} format not persisted: ${detection.reason}`)
  }
  return undefined
}

/** `A1:C1` → `{ startColumn: 1, endColumn: 3, row: 1 }`; `null` when unparsable. */
export function parseA1Range(range: string): {
  startColumn: number
  endColumn: number
  row: number
} | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(range.trim())
  if (!match) return null
  const columnIndex = (letters: string) =>
    [...letters.toUpperCase()].reduce(
      (total, letter) => total * 26 + (letter.charCodeAt(0) - 64),
      0,
    )
  const startColumn = columnIndex(match[1]!)
  const endColumn = match[3] ? columnIndex(match[3]) : startColumn
  return {
    startColumn: Math.min(startColumn, endColumn),
    endColumn: Math.max(startColumn, endColumn),
    row: Number(match[2]),
  }
}

/** Last non-empty cell position + 1, i.e. how wide this row actually is. */
function cellExtent(cells: readonly string[]): number {
  let extent = 0
  cells.forEach((cell, index) => {
    if (cell.trim() !== '') extent = index + 1
  })
  return extent
}

/**
 * Structural notes for one worksheet, computed from the sheet's own shape
 * rather than from DuckDB's already-dialect-resolved view of it:
 *
 * - a merged range that covers the row which becomes the table header is a
 *   title banner, not a header. The reader promotes that banner to the header
 *   and loads the real header row as data — a silent structural misread
 *   unless it is surfaced at review time.
 * - rows whose cell count differs from the header row (a merged banner row, a
 *   short row, a stray trailing cell) make the sheet's dialect ambiguous; the
 *   CSV materialization keeps every cell, so the analyst is told to check the
 *   column mapping instead of assuming a clean grid.
 */
export function describeSheetStructure(input: {
  sheet: { name?: string; model?: { merges?: string[] } }
  sheetName: string
  sourceFile: string
  rows: readonly string[][]
  rowNumbers: readonly number[]
}): string[] {
  const notes: string[] = []
  const headerRowNumber = input.rowNumbers[0]
  const header = input.rows[0]
  if (header === undefined || headerRowNumber === undefined) return notes
  if (header.length === 0) return notes

  const headerExtent = cellExtent(header)
  for (const range of input.sheet.model?.merges ?? []) {
    const parsed = parseA1Range(range)
    if (!parsed || parsed.row !== headerRowNumber) continue
    const span = parsed.endColumn - parsed.startColumn + 1
    if (span < 2) continue
    const banner = header[parsed.startColumn - 1]?.trim() ?? ''
    if (banner === '') continue
    notes.push(
      `Excel sheet "${input.sheetName}" in ${input.sourceFile} row ${headerRowNumber} is a merged ` +
        `banner spanning ${span} columns ("${banner}") and was read as the table header, so the ` +
        `real header row is loaded as data — split the banner out (or re-export the sheet with the ` +
        `real header in row 1) and re-run preview_ingest_source if this layout is wrong`,
    )
    break
  }

  const ragged: number[] = []
  for (let index = 1; index < input.rows.length; index += 1) {
    const row = input.rows[index]!
    const extent = cellExtent(row)
    if (extent === 0) continue
    if (extent !== headerExtent) ragged.push(input.rowNumbers[index] ?? index + 1)
  }
  if (ragged.length > 0) {
    const shown = ragged.slice(0, 5).join(', ')
    notes.push(
      `Excel sheet "${input.sheetName}" in ${input.sourceFile} has ${ragged.length} ragged row(s) ` +
        `(row ${shown}${ragged.length > 5 ? ', …' : ''}) whose cell count differs from the header row ` +
        `(${headerExtent} column(s)) — every cell is kept, so check the proposed column mapping and ` +
        `the banner/title rows before approving`,
    )
  }
  return notes
}

async function materializeExcelSheets(
  workbookPath: string,
  sourceFile: string,
  usedTableIds: Set<string>,
): Promise<{
  tables: Array<{
    sourceFile: string
    path: string
    excelSheet: string
    tableId: string
    headerWarning?: string
    structuralNotes?: string[]
  }>
  warnings: string[]
}> {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(workbookPath)
  const outDir = await mkdtemp(join(tmpdir(), 'dsh-excel-sheets-'))
  const tables: Array<{
    sourceFile: string
    path: string
    excelSheet: string
    tableId: string
    headerWarning?: string
    structuralNotes?: string[]
  }> = []
  const warnings: string[] = []
  for (const sheet of workbook.worksheets) {
    if (!sheet || sheet.state === 'hidden' || sheet.state === 'veryHidden') continue
    const sheetName = sheet.name?.trim() || `sheet_${tables.length + 1}`
    const rows: string[][] = []
    const rowNumbers: number[] = []
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > SAMPLE_ROW_LIMIT + 1) return
      const values = Array.isArray(row.values) ? row.values.slice(1) : []
      rows.push(
        values.map((value) => {
          if (value === null || value === undefined) return ''
          if (typeof value === 'object' && value !== null && 'text' in value) {
            return String((value as { text: unknown }).text ?? '')
          }
          if (typeof value === 'object' && value !== null && 'result' in value) {
            return String((value as { result: unknown }).result ?? '')
          }
          return String(value)
        }),
      )
      rowNumbers.push(rowNumber)
    })
    if (rows.length < 2) {
      warnings.push(
        `Excel sheet "${sheetName}" in ${sourceFile} has no header+data rows and was skipped — remove it from the workbook or give it one header row, then re-run the preview`,
      )
      continue
    }
    const csvPath = join(outDir, `${tables.length}.csv`)
    const csv = rows
      .map((cols) =>
        cols
          .map((cell) => {
            if (/[",\n\r]/.test(cell)) return `"${cell.replaceAll('"', '""')}"`
            return cell
          })
          .join(','),
      )
      .join('\n')
    await writeFile(csvPath, `${csv}\n`, 'utf8')
    const tableId = allocateTableId(
      `${basename(sourceFile, extname(sourceFile))}_${sheetName}`,
      usedTableIds,
    )
    // Header labels as the sheet actually wrote them: exceljs exposes no
    // rename, but the materialized CSV round-trips the same quote-aware
    // header the reader will parse, so a duplicated/blank label is visible
    // here even though the inspector's DuckDB view has already renamed it.
    const headerWarning = headerLabelQualityWarning(rows[0] ?? [])
    const structuralNotes = describeSheetStructure({
      sheet,
      sheetName,
      sourceFile,
      rows,
      rowNumbers,
    })
    tables.push({
      sourceFile,
      path: csvPath,
      excelSheet: sheetName,
      tableId,
      ...(headerWarning ? { headerWarning } : {}),
      ...(structuralNotes.length > 0 ? { structuralNotes } : {}),
    })
  }
  return { tables, warnings }
}

/** Header-label warning for a CSV file, read from its own header record. */
async function csvHeaderWarning(sourcePath: string): Promise<string | undefined> {
  try {
    const head = await readHeadBytes(sourcePath)
    // `readHeaderLabels` is delimiter-aware (comma, tab, semicolon), strips a BOM
    // and refuses to guess from an unterminated record.
    return headerLabelQualityWarning(readHeaderLabels(head.toString('utf8')))
  } catch {
    return undefined
  }
}

/**
 * Rank and filter archive members before inspection (Phase 2).
 * Returns files to inspect plus skipped entries with reasons.
 */
export function selectInspectableSources(
  files: readonly InspectableSourceFile[],
  options: { maxTables?: number } = {},
): {
  selected: InspectableSourceFile[]
  skipped: Array<{ name: string; reason: string }>
} {
  const maxTables = options.maxTables ?? MAX_PROPOSED_TABLES
  const skipped: Array<{ name: string; reason: string }> = []
  const candidates: Array<InspectableSourceFile & { order: number }> = []
  for (const [order, file] of files.entries()) {
    if (isJunkEntry(file.sourceFile)) {
      skipped.push({ name: file.sourceFile, reason: 'Skipped junk/metadata archive entry' })
      continue
    }
    const format = formatFor(file.sourceFile)
    if (!format) {
      skipped.push({ name: file.sourceFile, reason: unsupportedReason(file.sourceFile) })
      continue
    }
    candidates.push({ ...file, order })
  }
  candidates.sort(
    (a, b) =>
      (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) ||
      a.order - b.order ||
      a.sourceFile.localeCompare(b.sourceFile),
  )
  const selected = candidates.slice(0, maxTables).map(({ order: _order, ...file }) => file)
  for (const file of candidates.slice(maxTables)) {
    skipped.push({
      name: file.sourceFile,
      reason: `Skipped after reaching the ${maxTables}-table preview cap; approve a narrower pin or split the archive`,
    })
  }
  return { selected, skipped }
}

/**
 * In-process inspection (used by the inspect worker child and unit tests).
 */
export async function inspectSourceFilesInProcess(
  files: readonly InspectableSourceFile[],
  options: { maxTables?: number } = {},
): Promise<InspectedIngestRecipe> {
  const { selected, skipped } = selectInspectableSources(files, options)
  const unsupportedFiles: Array<{ name: string; reason: string }> = [...skipped]
  const tables: InspectedTableRecipe[] = []
  const usedTableIds = new Set<string>()
  const cleanupDirs = new Set<string>()
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  try {
    for (const file of selected) {
      const sourceFormat = formatFor(file.sourceFile)
      if (!sourceFormat) {
        unsupportedFiles.push({ name: file.sourceFile, reason: unsupportedReason(file.sourceFile) })
        continue
      }

      try {
        if (sourceFormat === 'excel') {
          const materialized = await materializeExcelSheets(
            file.path,
            file.sourceFile,
            usedTableIds,
          )
          for (const warning of materialized.warnings) {
            unsupportedFiles.push({ name: file.sourceFile, reason: warning })
          }
          for (const sheet of materialized.tables) {
            cleanupDirs.add(dirname(sheet.path))
            const reader = await connection.runAndReadAll(inspectionSql('csv'), [sheet.path])
            const schema = reader.getRowObjectsJson().map((row) => ({
              sourceName: String(row.column_name),
              sourceType: String(row.column_type),
            }))
            if (schema.length === 0) {
              throw new Error(`No columns detected in sheet ${sheet.excelSheet}`)
            }
            const proposed = proposeColumnsFromSchema(schema)
            const formats = await detectTableDateTimeFormats(
              connection,
              sheet.path,
              schema,
              proposed.columns,
            )
            tables.push({
              sourceFile: sheet.sourceFile,
              sourceFormat: 'excel',
              excelSheet: sheet.excelSheet,
              tableId: sheet.tableId,
              columns: proposed.columns,
              warnings: [
                `Types are inferred from at most ${SAMPLE_ROW_LIMIT} sampled Excel rows`,
                ...proposed.warnings,
                ...(sheet.headerWarning ? [sheet.headerWarning] : []),
                ...(sheet.structuralNotes ?? []),
                ...(sheet.structuralNotes ?? []),
                ...formats.warnings,
              ],
              ...(formats.dateFormat ? { dateFormat: formats.dateFormat } : {}),
              ...(formats.timestampFormat ? { timestampFormat: formats.timestampFormat } : {}),
            })
          }
          continue
        }

        let inspectPath = file.path
        let sourceEncoding: SupportedSourceEncoding | undefined
        if (sourceFormat === 'csv' || sourceFormat === 'json') {
          const { sourceEncoding: detected, headText } = await readHeadSampleInfo(file.path)
          if (sourceFormat === 'json') {
            // JSONL fast-path; single JSON documents are validated whole then
            // inspected by read_json_auto in the worker (no line/byte truncation).
            if (/\.(?:jsonl|ndjson)$/i.test(file.sourceFile)) {
              assertJsonlSampleParseable(headText)
            } else {
              await validateSingleJsonDocument(file.path, detected)
            }
          } else if (detected !== 'utf-8') {
            sourceEncoding = detected
          }
          const normalized = await ensureUtf8Source(file.path, detected)
          inspectPath = normalized.path
          if (normalized.tempDir) cleanupDirs.add(normalized.tempDir)
        }

        const reader = await connection.runAndReadAll(
          inspectionSql(sourceFormat, file.sourceFile),
          [inspectPath],
        )
        const schema = reader.getRowObjectsJson().map((row) => ({
          sourceName: String(row.column_name),
          sourceType: String(row.column_type),
        }))
        if (schema.length === 0) throw new Error('No columns were detected')
        const proposed = proposeColumnsFromSchema(schema)
        const formats: DateTimeFormatDetection =
          sourceFormat === 'csv'
            ? await detectTableDateTimeFormats(connection, inspectPath, schema, proposed.columns)
            : { warnings: [] }
        const headerWarning =
          sourceFormat === 'csv' ? await csvHeaderWarning(inspectPath) : undefined
        tables.push({
          sourceFile: file.sourceFile,
          sourceFormat,
          tableId: allocateTableId(file.sourceFile, usedTableIds),
          columns: proposed.columns,
          warnings: [
            ...(sourceFormat === 'parquet'
              ? []
              : [`Types are inferred from at most ${SAMPLE_ROW_LIMIT} sampled records`]),
            ...proposed.warnings,
            ...formats.warnings,
            ...(headerWarning ? [headerWarning] : []),
          ],
          ...(sourceEncoding ? { sourceEncoding } : {}),
          ...(formats.dateFormat ? { dateFormat: formats.dateFormat } : {}),
          ...(formats.timestampFormat ? { timestampFormat: formats.timestampFormat } : {}),
        })
      } catch (error) {
        unsupportedFiles.push({
          name: file.sourceFile,
          reason: `Controlled ${sourceFormat.toUpperCase()} inspection failed: ${safeInspectionError(error)}`,
        })
      }
    }
  } finally {
    connection.closeSync()
    instance.closeSync()
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  return { datasetId: tables[0]?.tableId ?? '', tables, unsupportedFiles }
}

export async function inspectSourceFiles(
  files: readonly InspectableSourceFile[],
  options: { maxTables?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<InspectedIngestRecipe> {
  const { inspectSourceFilesIsolated } = await import('./inspect-worker.js')
  return inspectSourceFilesIsolated(files, options)
}
