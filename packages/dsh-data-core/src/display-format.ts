/**
 * Display formatting for human-facing tables.
 *
 * Grouping only: a plain integer/decimal string gains thousands separators so a
 * table reads like the chart axis beside it (9688 -> 9,688). Stored values are
 * never rewritten - CSV, JSON, result artifacts and provenance keep the value
 * exactly as produced by the query.
 *
 * Values that only look numeric are left alone: identifiers with leading zeroes
 * ("007"), ranges and labels ("1988-2017", "3-5"), and anything else that is not
 * a plain integer/decimal string.
 */

/** Number of digits each side of a grouped integer, for readability. */
const GROUP = /\B(?=(\d{3})+(?!\d))/g

/**
 * @param value - a stored cell value, already stringified or not.
 * @returns the value with digit grouping when it is a plain number, else the
 *   unchanged text (or `NULL` for null/undefined).
 */
export function formatDisplayCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  const text = typeof value === 'string' ? value : String(value)
  return formatDisplayNumber(text)
}

/**
 * @param text - candidate cell text.
 * @returns grouped text for a plain number, otherwise the input unchanged. A
 *   leading zero on a multi-digit integer marks an identifier, not a quantity.
 */
export function formatDisplayNumber(text: string): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return text
  const [integer, fraction] = text.split('.')
  const digits = integer.replace('-', '')
  if (digits.length > 1 && digits.startsWith('0')) return text
  const grouped = integer.replace(GROUP, ',')
  return fraction === undefined ? grouped : `${grouped}.${fraction}`
}
