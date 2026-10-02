/**
 * Deterministic strftime detection for CSV DATE/TIMESTAMP columns. Numeric
 * date formats only. When two orderings fit the samples (e.g. DD/MM/YYYY vs
 * MM/DD/YYYY) the detector returns `ambiguous: true` instead of silently
 * choosing a calendar — the caller must surface that to the analyst for review.
 *
 * This closes the parser-mismatch gap: inspection infers DATE/TIMESTAMP from
 * DuckDB's own reader, but the projection previously re-parsed the raw string
 * with the default `TRY_CAST` (ISO), so a `31/01/2024` cell became NULL. By
 * persisting the detected `strftime` pattern, `projectTypedFromRaw` re-parses
 * with the same convention that produced the inference.
 */

export interface StrptimeDetection {
  /** DuckDB strftime pattern; absent when ambiguous or unsupported. */
  format?: string
  /** True when samples fit more than one calendar interpretation. */
  ambiguous: boolean
  /** Human-readable decision, used in review warnings. */
  reason: string
}

type DateOrder = 'ymd' | 'ydm' | 'dmy' | 'mdy'

const ORDER_TO_STRFTIME: Record<DateOrder, (sep: string) => string> = {
  ymd: (sep) => `%Y${sep}%m${sep}%d`,
  ydm: (sep) => `%Y${sep}%d${sep}%m`,
  dmy: (sep) => `%d${sep}%m${sep}%Y`,
  mdy: (sep) => `%m${sep}%d${sep}%Y`,
}

interface DateToken {
  a: string
  b: string
  c: string
  sep: string
}

function tokenizeDate(value: string): DateToken | null {
  const match = /^(\d{1,4})([-/.])(\d{1,2})\2(\d{1,4})$/.exec(value)
  if (!match) return null
  return { a: match[1]!, b: match[3]!, c: match[4]!, sep: match[2]! }
}

function dateOrderFor(samples: string[]): { order?: DateOrder; sep?: string; ambiguous: boolean } {
  let sep: string | undefined
  const orders = new Set<DateOrder>()
  for (const sample of samples) {
    const token = tokenizeDate(sample)
    if (!token) return { ambiguous: true }
    if (sep === undefined) sep = token.sep
    if (token.sep !== sep) return { ambiguous: true } // mixed separators
    const a = Number(token.a)
    const b = Number(token.b)
    const c = Number(token.c)
    const aLen = token.a.length
    const cLen = token.c.length

    let order: DateOrder | undefined
    if (aLen === 4 && cLen <= 2) {
      // Year first: YYYY-MM-DD (ISO, DuckDB's default) or YYYY-DD-MM.
      if (b > 12 && c <= 12) order = 'ydm'
      else if (c > 12 && b <= 12) order = 'ymd'
      else if (b > 12 && c > 12) order = undefined
      else order = 'ymd' // ISO year-first is the universal convention.
    } else if (cLen === 4 && aLen <= 2) {
      // Year last: DD-MM-YYYY vs MM-DD-YYYY — only a component > 12 disambiguates.
      if (a > 12 && b <= 12) order = 'dmy'
      else if (b > 12 && a <= 12) order = 'mdy'
      else if (a > 12 && b > 12) order = undefined
      else order = undefined // genuinely ambiguous (01/02/2024).
    }
    if (order === undefined) return { ambiguous: true }
    orders.add(order)
  }
  if (orders.size !== 1) return { ambiguous: true }
  return { order: [...orders][0], sep, ambiguous: false }
}

function splitDateTime(value: string): { date: string; time?: string } {
  const trimmed = value.trim()
  const dateMatch = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.exec(trimmed)
  if (!dateMatch) return { date: trimmed }
  const date = dateMatch[0]
  const rest = trimmed.slice(date.length).trim()
  if (!rest) return { date }
  const timeCandidate = rest.startsWith('T') ? rest.slice(1) : rest
  const timeMatch = /^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,6})?/.exec(timeCandidate)
  if (!timeMatch) return { date }
  return { date, time: timeMatch[0] }
}

function timeFormatFor(samples: string[]): string | undefined {
  const formats = new Set<string>()
  for (const sample of samples) {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,6}))?$/.exec(sample)
    if (!match) return undefined
    if (match[3] !== undefined && match[4] !== undefined) formats.add('%H:%M:%S.%f')
    else if (match[3] !== undefined) formats.add('%H:%M:%S')
    else formats.add('%H:%M')
  }
  return formats.size === 1 ? [...formats][0] : undefined
}

export function detectStrptimeFormat(
  samples: readonly string[],
  kind: 'DATE' | 'TIMESTAMP',
): StrptimeDetection {
  const nonEmpty = samples.map((sample) => sample.trim()).filter((sample) => sample.length > 0)
  if (nonEmpty.length === 0) {
    return { ambiguous: false, reason: 'no non-empty sampled values' }
  }

  const dateParts: string[] = []
  const timeParts: string[] = []
  for (const sample of nonEmpty) {
    const { date, time } = splitDateTime(sample)
    dateParts.push(date)
    if (time) timeParts.push(time)
  }

  const dateDetection = dateOrderFor(dateParts)
  if (dateDetection.ambiguous) {
    return {
      ambiguous: true,
      reason: `ambiguous day/month order across sampled values (e.g. "${nonEmpty[0]}")`,
    }
  }
  if (!dateDetection.order || dateDetection.sep === undefined) {
    return { ambiguous: true, reason: `unsupported date format (e.g. "${nonEmpty[0]}")` }
  }
  const dateFormat = ORDER_TO_STRFTIME[dateDetection.order](dateDetection.sep)

  if (kind === 'DATE') {
    return { format: dateFormat, ambiguous: false, reason: `detected ${dateFormat}` }
  }

  if (timeParts.length === 0) {
    return { ambiguous: true, reason: 'timestamp column has no time-of-day in sampled values' }
  }
  const timeFormat = timeFormatFor(timeParts)
  if (!timeFormat) {
    return { ambiguous: true, reason: 'mixed or unsupported time-of-day formats in sampled values' }
  }
  return {
    format: `${dateFormat} ${timeFormat}`,
    ambiguous: false,
    reason: `detected ${dateFormat} ${timeFormat}`,
  }
}
