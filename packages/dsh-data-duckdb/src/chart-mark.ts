import type { ChartIntent } from 'dsh-data-core/contracts'
import { toChartNumber } from 'dsh-data-viz/chart'

type ResultColumn = { name: string; logicalType: string }

export interface ChartSelectionInput {
  question?: string
  columns: ResultColumn[]
  rowCount?: number
  preview?: unknown[][]
}

export type DefaultChartMark = 'bar' | 'line' | 'point' | 'boxplot' | 'histogram' | 'table' | 'kpi'

const QUANTITATIVE_TYPE =
  /^(?:u?(?:tiny|small|medium|big|huge)?int(?:eger)?|float\d*|real|double|decimal(?:\(.+\))?|numeric(?:\(.+\))?)$/i
const TEMPORAL_TYPE =
  /^(?:date|time(?: with time zone)?|timestamp(?:_s|_ms|_ns|tz)?(?: with time zone)?)(?:\(.+\))?$/i
const TEMPORAL_BUCKET_NAME = /(?:^|[^a-z0-9])(?:date|time|timestamp|month|year|week)$/i
const TEMPORAL_ALIAS_NAME = /(?:^|[^a-z0-9])(?:period|bucket)$/i
const TEMPORAL_BUCKET_VALUE =
  /^(?:\d{4}(?:[-/](?:0?[1-9]|1[0-2])(?:[-/](?:0?[1-9]|[12]\d|3[01]))?)?|q[1-4]\s*[-/]?\s*\d{4}|\d{4}\s*[-/]?\s*q[1-4])$/i
const TIME_QUESTION = /\b(over time|by month|by year|trend|time series)\b/i
const DISTRIBUTION_QUESTION = /\b(distribution|histogram|frequency|spread|box\s*plot)\b/i

function isQuantitative(column: ResultColumn): boolean {
  return QUANTITATIVE_TYPE.test(column.logicalType.trim())
}

function isIntrinsicTemporal(column: ResultColumn): boolean {
  return TEMPORAL_TYPE.test(column.logicalType.trim())
}

function hasTemporalBucketPreview(input: ChartSelectionInput, columnIndex: number): boolean {
  const values = (input.preview ?? [])
    .map((row) => row[columnIndex])
    .filter((value) => value !== null && value !== undefined)
  return (
    values.length > 0 &&
    values.every(
      (value) =>
        (typeof value === 'string' && TEMPORAL_BUCKET_VALUE.test(value.trim())) ||
        (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9999),
    )
  )
}

function resolveRoles(input: ChartSelectionInput): {
  quantitative: ResultColumn[]
  temporal: ResultColumn[]
  categorical: ResultColumn[]
} {
  const temporalIndexes = new Set<number>()
  input.columns.forEach((column, index) => {
    if (isIntrinsicTemporal(column)) temporalIndexes.add(index)
  })

  const rawQuantitative = input.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => isQuantitative(column))

  if (temporalIndexes.size === 0 && input.columns.length === 2) {
    const asksForTime = TIME_QUESTION.test(input.question ?? '')
    const namedCandidates = input.columns
      .map((column, index) => ({ column, index }))
      .filter(
        ({ column, index }) =>
          (TEMPORAL_BUCKET_NAME.test(column.name) || TEMPORAL_ALIAS_NAME.test(column.name)) &&
          isQuantitative(input.columns[index === 0 ? 1 : 0]!) &&
          (asksForTime || hasTemporalBucketPreview(input, index)),
      )

    if (namedCandidates.length === 1) {
      temporalIndexes.add(namedCandidates[0]!.index)
    } else if (namedCandidates.length === 0 && rawQuantitative.length === 1 && asksForTime) {
      const candidateIndex = rawQuantitative[0]!.index === 0 ? 1 : 0
      if (hasTemporalBucketPreview(input, candidateIndex)) {
        temporalIndexes.add(candidateIndex)
      }
    }
  }

  return {
    temporal: input.columns.filter((_, index) => temporalIndexes.has(index)),
    quantitative: input.columns.filter(
      (column, index) => isQuantitative(column) && !temporalIndexes.has(index),
    ),
    categorical: input.columns.filter(
      (column, index) => !isQuantitative(column) && !temporalIndexes.has(index),
    ),
  }
}

function hasFiniteChartNumber(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false
  try {
    toChartNumber(value)
    return true
  } catch {
    return false
  }
}

/**
 * Choose a conservative default from typed authorized-result shape and question.
 * Unsupported or ambiguous shapes remain available as a bounded table.
 */
export function selectChartMark(input: ChartSelectionInput): DefaultChartMark {
  const question = input.question?.toLowerCase() ?? ''
  const { quantitative, temporal, categorical } = resolveRoles(input)
  const asksForDistribution = DISTRIBUTION_QUESTION.test(question)

  if (input.columns.length === 1) {
    if (asksForDistribution && quantitative.length === 1) return 'histogram'
    if (
      quantitative.length === 1 &&
      input.rowCount === 1 &&
      hasFiniteChartNumber(input.preview?.[0]?.[0])
    ) {
      return 'kpi'
    }
    return 'table'
  }

  if (input.columns.length !== 2) return 'table'
  if (temporal.length === 1 && quantitative.length === 1) return 'line'
  if (asksForDistribution && categorical.length === 1 && quantitative.length === 1) {
    return 'boxplot'
  }
  if (quantitative.length === 2) return 'point'
  if (categorical.length === 1 && quantitative.length === 1) return 'bar'
  return 'table'
}

/** Build a schema-valid intent with roles appropriate to the selected mark. */
export function buildDefaultChartIntent(
  input: ChartSelectionInput & { title: string },
): ChartIntent {
  const mark = selectChartMark(input)
  const { quantitative, temporal, categorical } = resolveRoles(input)

  if (mark === 'table') return { mark, title: input.title }
  if (mark === 'kpi') return { mark, title: input.title, y: quantitative[0]!.name }
  if (mark === 'histogram') return { mark, title: input.title, x: quantitative[0]!.name }
  if (mark === 'point') {
    return {
      mark,
      title: input.title,
      x: quantitative[0]!.name,
      y: quantitative[1]!.name,
    }
  }
  if (mark === 'line') {
    return {
      mark,
      title: input.title,
      x: temporal[0]!.name,
      y: quantitative[0]!.name,
    }
  }

  const intent: ChartIntent = {
    mark,
    title: input.title,
    x: categorical[0]!.name,
    y: quantitative[0]!.name,
  }
  return mark === 'bar'
    ? { ...intent, sort: { field: quantitative[0]!.name, direction: 'descending' } }
    : intent
}
