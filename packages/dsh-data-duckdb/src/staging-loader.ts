/**
 * Trusted CSV staging load with quarantine and profiling. Loads exactly one
 * already-validated, already-extracted CSV file into a writable staging
 * table using DuckDB's own CSV reader and its built-in `store_rejects`
 * quarantine — never `ignore_errors`, and never a model-authored transform.
 * Column names/types are a trusted, reviewed input the
 * coordinator supplies, not free text from a download or a model.
 */
import type { DuckDBConnection } from '@duckdb/node-api'

export class InvalidIdentifierError extends Error {}

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/
/** Documented CSV header labels only — never interpolated into SQL identifiers. */
const SAFE_DATE_FORMAT = /^[%A-Za-z0-9.\-/: ]{1,64}$/

/** Reject anything that is not a safe bare SQL identifier before interpolating it into DDL. */
export function assertSafeIdentifier(name: string, kind: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new InvalidIdentifierError(`${kind} "${name}" is not a safe identifier`)
  }
}

export function assertSafeDateFormat(format: string): void {
  if (!SAFE_DATE_FORMAT.test(format) || format.includes("'") || format.includes('"')) {
    throw new InvalidIdentifierError(`dateFormat "${format}" is not an allowed strftime pattern`)
  }
}

export function assertSafeType(type: string): void {
  const decimal = /^DECIMAL\((\d+),(\d+)\)$/.exec(type)
  const safeDecimal =
    decimal !== null &&
    Number(decimal[1]) >= 1 &&
    Number(decimal[1]) <= 38 &&
    Number(decimal[2]) >= 0 &&
    Number(decimal[2]) <= Number(decimal[1])
  const safeScalar = /^(?:VARCHAR|BOOLEAN|INTEGER|BIGINT|DOUBLE|DATE|TIMESTAMP)$/.test(type)
  if (!safeScalar && !safeDecimal) {
    throw new InvalidIdentifierError(
      `Column type "${type}" is not an allowed DuckDB type expression`,
    )
  }
}

export interface StagingColumn {
  name: string
  /**
   * Original source label. CSV assigns reviewed names positionally and never
   * interpolates this value; Parquet/JSON projection quotes it as an identifier.
   */
  sourceName?: string
  /** A DuckDB type name/expression from a reviewed, trusted set (e.g. "VARCHAR", "DECIMAL(18,2)", "DATE"). */
  type: string
}

export interface LoadCsvIntoStagingRequest {
  csvPath: string
  tableId: string
  columns: readonly StagingColumn[]
  hasHeader?: boolean
  /** Explicit strftime pattern for DATE columns (e.g. `%m/%d/%Y` for Superstore). */
  dateFormat?: string
  /** Explicit strftime pattern for TIMESTAMP columns (e.g. `%Y-%m-%d %H:%M:%S`). */
  timestampFormat?: string
}

export interface RejectedRow {
  line: number
  columnName: string
  errorType: string
  errorMessage: string
}

export interface StagingLoadResult {
  tableId: string
  rowCount: number
  rejectedRows: RejectedRow[]
  /** Null count per requested column, computed over the loaded (non-rejected) rows. */
  nullCounts: Record<string, number>
}

export type ControlledSourceFormat = 'csv' | 'parquet' | 'json' | 'excel'

export interface LoadTabularIntoStagingRequest {
  sourcePath: string
  sourceFormat: ControlledSourceFormat
  tableId: string
  columns: readonly StagingColumn[]
}

export function quoteIdentifier(name: string): string {
  const hasControl = [...name].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
  if (name.length === 0 || name.length > 512 || hasControl) {
    throw new InvalidIdentifierError('Source column name is empty, too long, or contains controls')
  }
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * Load a reviewed Parquet or JSON/JSONL source through DuckDB's built-in readers.
 * Paths stay bound parameters and every projected source column is quoted as an
 * identifier. Cast failures reject the whole table instead of silently dropping rows.
 */
export async function loadTabularIntoStaging(
  connection: DuckDBConnection,
  request: LoadTabularIntoStagingRequest,
): Promise<StagingLoadResult> {
  if (request.sourceFormat === 'csv') {
    return loadCsvIntoStaging(connection, {
      csvPath: request.sourcePath,
      tableId: request.tableId,
      columns: request.columns,
    })
  }
  assertSafeIdentifier(request.tableId, 'Table id')
  if (request.columns.length === 0) throw new Error('At least one column is required')
  for (const column of request.columns) {
    assertSafeIdentifier(column.name, 'Column name')
    assertSafeType(column.type)
    if (column.sourceName === undefined) {
      throw new Error(`Source column name is required for ${request.sourceFormat} ingest`)
    }
  }
  const tableRef = quoteIdentifier(request.tableId)
  const projection = request.columns
    .map(
      (column) =>
        `CAST(${quoteIdentifier(column.sourceName!)} AS ${column.type}) AS ${quoteIdentifier(column.name)}`,
    )
    .join(', ')
  const reader =
    request.sourceFormat === 'parquet' ? 'read_parquet(?)' : "read_json_auto(?, format='auto')"
  await connection.run(`CREATE TABLE ${tableRef} AS SELECT ${projection} FROM ${reader}`, [
    request.sourcePath,
  ])

  const rowCountReader = await connection.runAndReadAll(`SELECT COUNT(*) FROM ${tableRef}`)
  const rowCount = Number(rowCountReader.getRowsJson()[0]?.[0] ?? 0)
  const nullCountsClause = request.columns
    .map(
      (column) =>
        `COUNT(*) - COUNT(${quoteIdentifier(column.name)}) AS ${quoteIdentifier(column.name)}`,
    )
    .join(', ')
  const nullCountsReader = await connection.runAndReadAll(
    `SELECT ${nullCountsClause} FROM ${tableRef}`,
  )
  const nullCountsRow = (nullCountsReader.getRowObjectsJson()[0] ?? {}) as Record<string, unknown>
  const nullCounts = Object.fromEntries(
    request.columns.map((column) => [column.name, Number(nullCountsRow[column.name] ?? 0)]),
  )
  return { tableId: request.tableId, rowCount, rejectedRows: [], nullCounts }
}

/**
 * Load one CSV into a new table on `connection` (expected to be a writable
 * staging DuckDB), quarantining cast failures via DuckDB's own
 * `store_rejects` instead of silently dropping or ignoring them, and profile
 * the result (row count, null counts per column).
 */
/**
 * Rewrite a CSV read failure to lead with the next step. The product's acceptance
 * contract is that a refusal names the reason AND what to do next; DuckDB's own
 * dialect-sniffing error names only the reason, and its search-space dump runs to
 * hundreds of characters, so a next step appended to the tail is cut off by every
 * bounded view of the message (log line, tool observe text, review card). The
 * actionable half goes first and the engine's reason follows.
 */
function withCsvReadNextStep(error: unknown, csvPath: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  const reason = message.replaceAll(csvPath, '<source-file>')
  const nextStep = /sniff|dialect/i.test(reason)
    ? 'Next step: check that the file has one header row and one consistent delimiter, or re-export that sheet as UTF-8 CSV, then run preview_ingest_source again.'
    : 'Next step: inspect the file with preview_ingest_source, correct the reported shape, then re-run the ingest.'
  return new Error(`${nextStep} Reason: ${reason}`)
}

export async function loadCsvIntoStaging(
  connection: DuckDBConnection,
  request: LoadCsvIntoStagingRequest,
): Promise<StagingLoadResult> {
  assertSafeIdentifier(request.tableId, 'Table id')
  for (const column of request.columns) {
    assertSafeIdentifier(column.name, 'Column name')
    assertSafeType(column.type)
    // sourceName is metadata for CSV: `columns={}` assigns the reviewed names
    // positionally, so the source label is never interpolated into this query.
  }
  if (request.columns.length === 0) {
    throw new Error('At least one column is required to load a staging table')
  }
  if (request.dateFormat !== undefined) assertSafeDateFormat(request.dateFormat)
  if (request.timestampFormat !== undefined) assertSafeDateFormat(request.timestampFormat)

  const tableRef = quoteIdentifier(request.tableId)
  const columnsClause = request.columns
    .map((column) => `'${column.name}': '${column.type}'`)
    .join(', ')
  const dateFormatClause =
    request.dateFormat !== undefined ? `, dateformat='${request.dateFormat}'` : ''
  const timestampFormatClause =
    request.timestampFormat !== undefined ? `, timestampformat='${request.timestampFormat}'` : ''
  try {
    await connection.run(
      `CREATE TABLE ${tableRef} AS
       SELECT * FROM read_csv(?, header=${request.hasHeader === false ? 'false' : 'true'}, columns={${columnsClause}}, store_rejects=true${dateFormatClause}${timestampFormatClause})`,
      [request.csvPath],
    )
  } catch (error) {
    throw withCsvReadNextStep(error, request.csvPath)
  }

  const rowCountReader = await connection.runAndReadAll(`SELECT COUNT(*) FROM ${tableRef}`)
  const rowCount = Number(rowCountReader.getRowsJson()[0]?.[0] ?? 0)

  const nullCountsClause = request.columns
    .map(
      (column) =>
        `COUNT(*) - COUNT(${quoteIdentifier(column.name)}) AS ${quoteIdentifier(column.name)}`,
    )
    .join(', ')
  const nullCountsReader = await connection.runAndReadAll(
    `SELECT ${nullCountsClause} FROM ${tableRef}`,
  )
  const nullCountsRow = (nullCountsReader.getRowObjectsJson()[0] ?? {}) as Record<string, unknown>
  const nullCounts: Record<string, number> = {}
  for (const column of request.columns)
    nullCounts[column.name] = Number(nullCountsRow[column.name] ?? 0)

  const rejectsReader = await connection.runAndReadAll(
    `SELECT e.line, e.column_name, e.error_type, e.error_message
     FROM reject_errors e JOIN reject_scans s ON e.scan_id = s.scan_id
     WHERE s.file_path = ?
     ORDER BY e.line`,
    [request.csvPath],
  )
  const rejectedRows: RejectedRow[] = rejectsReader.getRowObjectsJson().map((row) => ({
    line: Number(row.line),
    columnName: String(row.column_name),
    errorType: String(row.error_type),
    errorMessage: String(row.error_message),
  }))

  return { tableId: request.tableId, rowCount, rejectedRows, nullCounts }
}

/** Staging table id for the lossless raw layer (`raw_<tableId>`). */
export function rawTableIdFor(tableId: string): string {
  assertSafeIdentifier(tableId, 'Table id')
  const rawId = `raw_${tableId}`
  assertSafeIdentifier(rawId, 'Raw table id')
  return rawId
}

export interface LoadCsvRawIntoStagingRequest {
  csvPath: string
  tableId: string
  columns: readonly StagingColumn[]
  hasHeader?: boolean
}

export interface RawStagingLoadResult {
  tableId: string
  rawTableId: string
  /** Adapter source row count (DuckDB CSV data rows for this path). */
  sourceRowCount: number
  rawRowCount: number
}

/**
 * Lossless CSV load: every reviewed column stored as VARCHAR. No typed
 * `store_rejects` quarantine — cast handling belongs in the projection step.
 */
export async function loadCsvRawIntoStaging(
  connection: DuckDBConnection,
  request: LoadCsvRawIntoStagingRequest,
): Promise<RawStagingLoadResult> {
  const rawTableId = rawTableIdFor(request.tableId)
  if (request.columns.length === 0) {
    throw new Error('At least one column is required to load a raw staging table')
  }
  for (const column of request.columns) {
    assertSafeIdentifier(column.name, 'Column name')
  }

  const header = request.hasHeader === false ? 'false' : 'true'
  const columnsClause = request.columns.map((column) => `'${column.name}': 'VARCHAR'`).join(', ')

  let sourceCountReader
  try {
    sourceCountReader = await connection.runAndReadAll(
      `SELECT COUNT(*) FROM read_csv(?, header=${header}, columns={${columnsClause}})`,
      [request.csvPath],
    )
  } catch (error) {
    // The first read is where an unreadable sheet fails: DuckDB cannot sniff the
    // dialect, names the reason, and would otherwise leave the analyst with no
    // next step at all.
    throw withCsvReadNextStep(error, request.csvPath)
  }
  const sourceRowCount = Number(sourceCountReader.getRowsJson()[0]?.[0] ?? 0)

  try {
    await connection.run(
      `CREATE TABLE ${quoteIdentifier(rawTableId)} AS
       SELECT * FROM read_csv(?, header=${header}, columns={${columnsClause}})`,
      [request.csvPath],
    )
  } catch (error) {
    throw withCsvReadNextStep(error, request.csvPath)
  }

  const rawCountReader = await connection.runAndReadAll(
    `SELECT COUNT(*) FROM ${quoteIdentifier(rawTableId)}`,
  )
  const rawRowCount = Number(rawCountReader.getRowsJson()[0]?.[0] ?? 0)
  if (rawRowCount !== sourceRowCount) {
    throw new Error(
      `Raw row reconciliation failed for "${request.tableId}": source=${sourceRowCount} raw=${rawRowCount}`,
    )
  }

  return {
    tableId: request.tableId,
    rawTableId,
    sourceRowCount,
    rawRowCount,
  }
}

export interface LoadTabularRawIntoStagingRequest {
  sourcePath: string
  sourceFormat: 'parquet' | 'json'
  tableId: string
  columns: readonly StagingColumn[]
}

/**
 * Lossless Parquet/JSON load: reviewed columns stored as VARCHAR via CAST of
 * quoted source identifiers. Typed casting happens in `projectTypedFromRaw`.
 */
export async function loadTabularRawIntoStaging(
  connection: DuckDBConnection,
  request: LoadTabularRawIntoStagingRequest,
): Promise<RawStagingLoadResult> {
  const rawTableId = rawTableIdFor(request.tableId)
  if (request.columns.length === 0) {
    throw new Error('At least one column is required to load a raw staging table')
  }
  for (const column of request.columns) {
    assertSafeIdentifier(column.name, 'Column name')
    if (column.sourceName === undefined) {
      throw new Error(`Source column name is required for ${request.sourceFormat} raw ingest`)
    }
  }

  const rawTableRef = quoteIdentifier(rawTableId)
  const projection = request.columns
    .map(
      (column) =>
        `CAST(${quoteIdentifier(column.sourceName!)} AS VARCHAR) AS ${quoteIdentifier(column.name)}`,
    )
    .join(', ')
  const reader =
    request.sourceFormat === 'parquet' ? 'read_parquet(?)' : "read_json_auto(?, format='auto')"

  const sourceCountReader = await connection.runAndReadAll(
    `SELECT COUNT(*) FROM (SELECT ${projection} FROM ${reader})`,
    [request.sourcePath],
  )
  const sourceRowCount = Number(sourceCountReader.getRowsJson()[0]?.[0] ?? 0)

  await connection.run(`CREATE TABLE ${rawTableRef} AS SELECT ${projection} FROM ${reader}`, [
    request.sourcePath,
  ])

  const rawCountReader = await connection.runAndReadAll(`SELECT COUNT(*) FROM ${rawTableRef}`)
  const rawRowCount = Number(rawCountReader.getRowsJson()[0]?.[0] ?? 0)
  if (rawRowCount !== sourceRowCount) {
    throw new Error(
      `Raw row reconciliation failed for "${request.tableId}": source=${sourceRowCount} raw=${rawRowCount}`,
    )
  }

  return {
    tableId: request.tableId,
    rawTableId,
    sourceRowCount,
    rawRowCount,
  }
}

export interface ProjectTypedFromRawRequest {
  tableId: string
  columns: readonly StagingColumn[]
  dateFormat?: string
  timestampFormat?: string
}

/**
 * A column whose approved type could not parse ANY of its non-empty values. It is
 * not a typed column with missing data: it is a column the pipeline cannot type,
 * and publishing it as all-NULL would discard every value. The raw values are kept
 * as VARCHAR instead and the fallback is reported, so the analyst can name the
 * intended format (day-first vs month-first) and re-ingest.
 */
export interface TypeFallback {
  column: string
  /** The approved type whose cast failed for every non-empty value. */
  approvedType: string
  /** Non-empty source values that no format could parse. */
  unparsedValues: number
}

export interface ProjectionResult {
  tableId: string
  rawTableId: string
  projectionRowCount: number
  /** Nulls introduced by TRY_CAST / try_strptime (not source empty strings alone). */
  castNullCounts: Record<string, number>
  nullCounts: Record<string, number>
  /** Columns republished as raw VARCHAR because no value parsed as the approved type. */
  typeFallbacks: TypeFallback[]
}

function typedValueExpression(
  column: StagingColumn,
  dateFormat: string | undefined,
  timestampFormat: string | undefined,
): string {
  const source = quoteIdentifier(column.name)
  if (column.type === 'VARCHAR') return source
  if (column.type === 'DATE' && dateFormat !== undefined) {
    assertSafeDateFormat(dateFormat)
    return `CAST(try_strptime(${source}, '${dateFormat}') AS DATE)`
  }
  if (column.type === 'TIMESTAMP' && timestampFormat !== undefined) {
    assertSafeDateFormat(timestampFormat)
    return `CAST(try_strptime(${source}, '${timestampFormat}') AS TIMESTAMP)`
  }
  return `TRY_CAST(${source} AS ${column.type})`
}

function projectionExpression(
  column: StagingColumn,
  dateFormat: string | undefined,
  timestampFormat: string | undefined,
): string {
  return `${typedValueExpression(column, dateFormat, timestampFormat)} AS ${quoteIdentifier(column.name)}`
}

/**
 * Build the typed analyst table from `raw_<tableId>` without dropping rows.
 * Unparsable cells become NULL via TRY_CAST; raw cells remain in the raw table.
 */
export async function projectTypedFromRaw(
  connection: DuckDBConnection,
  request: ProjectTypedFromRawRequest,
): Promise<ProjectionResult> {
  assertSafeIdentifier(request.tableId, 'Table id')
  const rawTableId = rawTableIdFor(request.tableId)
  if (request.columns.length === 0) throw new Error('At least one column is required')
  for (const column of request.columns) {
    assertSafeIdentifier(column.name, 'Column name')
    assertSafeType(column.type)
  }
  if (request.dateFormat !== undefined) assertSafeDateFormat(request.dateFormat)
  if (request.timestampFormat !== undefined) assertSafeDateFormat(request.timestampFormat)

  const tableRef = quoteIdentifier(request.tableId)
  const rawTableRef = quoteIdentifier(rawTableId)
  const rawCountReader = await connection.runAndReadAll(`SELECT COUNT(*) FROM ${rawTableRef}`)
  const rawRowCount = Number(rawCountReader.getRowsJson()[0]?.[0] ?? 0)

  const projection = request.columns
    .map((column) => projectionExpression(column, request.dateFormat, request.timestampFormat))
    .join(', ')
  await connection.run(`CREATE TABLE ${tableRef} AS SELECT ${projection} FROM ${rawTableRef}`)

  const projectionCountReader = await connection.runAndReadAll(`SELECT COUNT(*) FROM ${tableRef}`)
  const projectionRowCount = Number(projectionCountReader.getRowsJson()[0]?.[0] ?? 0)
  if (projectionRowCount !== rawRowCount) {
    throw new Error(
      `Projection row reconciliation failed for "${request.tableId}": raw=${rawRowCount} projection=${projectionRowCount}`,
    )
  }

  const nullCountsClause = request.columns
    .map(
      (column) =>
        `COUNT(*) - COUNT(${quoteIdentifier(column.name)}) AS ${quoteIdentifier(column.name)}`,
    )
    .join(', ')
  const nullCountsReader = await connection.runAndReadAll(
    `SELECT ${nullCountsClause} FROM ${tableRef}`,
  )
  const nullCountsRow = (nullCountsReader.getRowObjectsJson()[0] ?? {}) as Record<string, unknown>
  const nullCounts = Object.fromEntries(
    request.columns.map((column) => [column.name, Number(nullCountsRow[column.name] ?? 0)]),
  )

  const castNullCounts: Record<string, number> = {}
  for (const column of request.columns) {
    if (column.type === 'VARCHAR') {
      castNullCounts[column.name] = 0
      continue
    }
    const typedExpr = typedValueExpression(column, request.dateFormat, request.timestampFormat)
    const columnRef = quoteIdentifier(column.name)
    const castReader = await connection.runAndReadAll(
      `SELECT COUNT(*) FROM ${rawTableRef}
       WHERE ${columnRef} IS NOT NULL
         AND TRIM(CAST(${columnRef} AS VARCHAR)) <> ''
         AND (${typedExpr}) IS NULL`,
    )
    castNullCounts[column.name] = Number(castReader.getRowsJson()[0]?.[0] ?? 0)
  }

  // A date/timestamp column whose approved type parses NONE of its non-empty values
  // is the case the live sweep found on superstore: genuinely ambiguous M/D vs D/M
  // values, which the format detector correctly refuses to guess and DuckDB's native
  // cast cannot parse at all. Publishing that as all-NULL loses the data, so the raw
  // values are republished as VARCHAR and the fallback is reported.
  const typeFallbacks: TypeFallback[] = []
  if (projectionRowCount > 0) {
    for (const column of request.columns) {
      if (column.type !== 'DATE' && column.type !== 'TIMESTAMP') continue
      const castNulls = castNullCounts[column.name] ?? 0
      if (castNulls === 0) continue
      const columnRef = quoteIdentifier(column.name)
      const nonEmptyReader = await connection.runAndReadAll(
        `SELECT COUNT(*) FROM ${rawTableRef}
         WHERE ${columnRef} IS NOT NULL AND TRIM(CAST(${columnRef} AS VARCHAR)) <> ''`,
      )
      const nonEmptyValues = Number(nonEmptyReader.getRowsJson()[0]?.[0] ?? 0)
      if (nonEmptyValues === 0 || castNulls < nonEmptyValues) continue
      typeFallbacks.push({
        column: column.name,
        approvedType: column.type,
        unparsedValues: castNulls,
      })
    }
  }
  if (typeFallbacks.length > 0) {
    const recovered = new Set(typeFallbacks.map((fallback) => fallback.column))
    const rebuiltProjection = request.columns
      .map((column) =>
        recovered.has(column.name)
          ? `${quoteIdentifier(column.name)} AS ${quoteIdentifier(column.name)}`
          : projectionExpression(column, request.dateFormat, request.timestampFormat),
      )
      .join(', ')
    await connection.run(`DROP TABLE ${tableRef}`)
    await connection.run(
      `CREATE TABLE ${tableRef} AS SELECT ${rebuiltProjection} FROM ${rawTableRef}`,
    )
    const recountReader = await connection.runAndReadAll(
      `SELECT ${nullCountsClause} FROM ${tableRef}`,
    )
    const recountRow = (recountReader.getRowObjectsJson()[0] ?? {}) as Record<string, unknown>
    for (const fallback of typeFallbacks) {
      // The values are now the raw strings: no parse nulls remain, and the null count
      // is whatever the raw column genuinely has.
      castNullCounts[fallback.column] = 0
      nullCounts[fallback.column] = Number(recountRow[fallback.column] ?? 0)
    }
  }

  return {
    tableId: request.tableId,
    rawTableId,
    projectionRowCount,
    castNullCounts,
    nullCounts,
    typeFallbacks,
  }
}
