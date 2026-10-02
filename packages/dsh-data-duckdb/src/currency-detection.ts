/**
 * Deterministic ingest-time scan for a column whose distinct values are
 * ISO-4217 currency codes.
 * Reviewed date/currency notes in `dsh-data-core/metric-rules` are static,
 * hand-curated per dataset; they never generalize to a dataset an engineer
 * hasn't inspected. This scan runs against the actual typed staging table
 * for every ingest, so a monetary column mixing currencies is flagged
 * automatically instead of relying on an agent to notice it by inspection.
 *
 * A column only counts as a currency dimension when EVERY one of its
 * distinct non-NULL values is a recognized code — one stray non-code value
 * (a free-text note, an "N/A") disqualifies the whole column rather than
 * guessing. `MAX_DISTINCT_TO_SCAN` bounds the scan to genuinely
 * low-cardinality dimension columns; a column with more distinct values
 * than that is never a currency-code column in practice and is skipped
 * without truncating results silently.
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import { codes as isoCurrencyCodes } from 'currency-codes'
import { quoteIdentifier } from './staging-loader.js'

/**
 * The full ISO-4217 alphabetic code list from the `currency-codes` package
 * (maintained, versioned against the published standard) rather than a
 * hand-typed subset — a hand-maintained list drifts (a valid but less
 * common code silently fails to register as a currency dimension) with no
 * offsetting benefit; unlike the SQL policy boundary elsewhere in this
 * package, there is no trust reason to hand-roll this.
 */
export const KNOWN_CURRENCY_CODES: ReadonlySet<string> = new Set(isoCurrencyCodes())

const STRING_TYPES: ReadonlySet<string> = new Set(['VARCHAR', 'TEXT', 'STRING'])

/** Never scans a column with more distinct values than this. */
export const MAX_DISTINCT_TO_SCAN = 25

export interface CurrencyDimension {
  column: string
  /** Sorted, deduplicated ISO-4217 codes found in the column. */
  currencies: string[]
}

/**
 * A string column the bounded scan could not decide: it holds more distinct
 * values than the cap allows, and every sampled value is a recognized
 * ISO-4217 code. It is almost certainly monetary, but the sample is not the
 * whole column, so mixing inside it can be neither confirmed nor ruled out.
 * Reported instead of dropped — a silent skip is what lets an analyst sum
 * across currencies with no warning.
 */
export interface UnscannedCurrencyColumn {
  column: string
  /** Distinct values read before stopping at the cap (`MAX_DISTINCT_TO_SCAN + 1`). */
  sampledDistinctValues: number
}

export interface CurrencyScan {
  dimensions: CurrencyDimension[]
  unscanned: UnscannedCurrencyColumn[]
}

/**
 * Scan every string-typed column of `tableId` for a currency-code dimension,
 * returning both the confirmed columns (2+ distinct codes) and the ones the
 * bounded scan had to skip.
 */
export async function detectCurrencyScan(
  connection: DuckDBConnection,
  tableId: string,
  columns: readonly { name: string; type: string }[],
): Promise<CurrencyScan> {
  const dimensions: CurrencyDimension[] = []
  const unscanned: UnscannedCurrencyColumn[] = []
  const tableRef = quoteIdentifier(tableId)
  for (const column of columns) {
    if (!STRING_TYPES.has(column.type.toUpperCase())) continue
    const columnRef = quoteIdentifier(column.name)
    const reader = await connection.runAndReadAll(
      `SELECT DISTINCT ${columnRef} FROM ${tableRef} WHERE ${columnRef} IS NOT NULL LIMIT ${MAX_DISTINCT_TO_SCAN + 1}`,
    )
    const values = reader.getRowsJson().map((row) => String(row[0] ?? ''))
    if (values.length === 0) continue
    const normalized = values.map((value) => value.trim().toUpperCase())
    if (values.length > MAX_DISTINCT_TO_SCAN) {
      if (normalized.every((value) => KNOWN_CURRENCY_CODES.has(value))) {
        unscanned.push({ column: column.name, sampledDistinctValues: values.length })
      }
      continue
    }
    if (!normalized.every((value) => KNOWN_CURRENCY_CODES.has(value))) continue
    const currencies = [...new Set(normalized)].sort()
    if (currencies.length >= 2) dimensions.push({ column: column.name, currencies })
  }
  return { dimensions, unscanned }
}

/** Confirmed currency dimensions only — see {@link detectCurrencyScan} for the scan-cap skips. */
export async function detectCurrencyDimensions(
  connection: DuckDBConnection,
  tableId: string,
  columns: readonly { name: string; type: string }[],
): Promise<CurrencyDimension[]> {
  const scan = await detectCurrencyScan(connection, tableId, columns)
  return scan.dimensions
}
