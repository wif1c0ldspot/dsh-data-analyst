/**
 * Bounded typed findings resolved from trusted stored query results.
 * A result id beside free-text prose does not validate that prose — only
 * service-resolved findings from matching identity and complete evidence do.
 */
import { z } from 'zod'
import { deriveResultEvidence } from './result-evidence.js'
import type { StoredQueryResult } from './stored-result.js'

export const ComputedFindingOperationSchema = z.enum([
  'column_minimum',
  'column_maximum',
  'column_non_null_count',
  'row_count',
  'descriptive_total_count',
  'descriptive_non_null_count',
  'descriptive_mean',
  'descriptive_median',
  'descriptive_min',
  'descriptive_max',
  'duplicate_total_rows',
  'duplicate_distinct_rows',
  'duplicate_excess',
  'ratio_of_sums',
  'elapsed_bin_row_count',
])
export type ComputedFindingOperation = z.infer<typeof ComputedFindingOperationSchema>

export const ComputedFindingReferenceSchema = z
  .object({
    resultId: z.string().min(1).max(128),
    datasetVersionId: z.string().min(1).max(128),
    semanticRevisionId: z.string().min(1).max(128),
    operation: ComputedFindingOperationSchema,
    field: z.string().min(1).max(256).optional(),
    units: z.string().min(1).max(128).optional(),
    /** Human-readable filter / LIMIT scope; required when the result is scoped. */
    filterScope: z.string().min(1).max(512).optional(),
    nullScope: z.string().min(1).max(512).optional(),
    denominatorField: z.string().min(1).max(256).optional(),
  })
  .strict()
export type ComputedFindingReference = z.infer<typeof ComputedFindingReferenceSchema>

export const ComputedFindingSchema = z
  .object({
    reference: ComputedFindingReferenceSchema,
    exactValue: z.string().min(1).max(256),
    sentence: z.string().min(1).max(1000),
    complete: z.literal(true),
    rowCount: z.number().int().nonnegative(),
  })
  .strict()
export type ComputedFinding = z.infer<typeof ComputedFindingSchema>

export class ComputedFindingError extends Error {
  readonly code:
    | 'identity_mismatch'
    | 'incomplete_result'
    | 'missing_field'
    | 'unsupported_operation'
    | 'empty_or_all_null'
    | 'zero_denominator'
    | 'inconsistent_value'

  constructor(code: ComputedFindingError['code'], message: string) {
    super(message)
    this.name = 'ComputedFindingError'
    this.code = code
  }
}

function assertIdentity(result: StoredQueryResult, reference: ComputedFindingReference): void {
  if (
    result.resultId !== reference.resultId ||
    result.datasetVersionId !== reference.datasetVersionId ||
    result.semanticRevisionId !== reference.semanticRevisionId
  ) {
    throw new ComputedFindingError(
      'identity_mismatch',
      'Finding reference does not match the trusted stored result identity.',
    )
  }
}

function requireComplete(result: StoredQueryResult): unknown[][] {
  const rows = result.rows
  if (!Array.isArray(rows) || rows.length !== result.rowCount) {
    throw new ComputedFindingError(
      'incomplete_result',
      'Complete stored rows are required before resolving a computed finding.',
    )
  }
  return rows
}

function columnIndex(result: StoredQueryResult, field: string): number {
  const index = result.columns.findIndex((column) => column.name === field)
  if (index < 0) {
    throw new ComputedFindingError('missing_field', `Unknown field "${field}" on stored result.`)
  }
  return index
}

function cellToExactString(value: unknown): string {
  if (value === null || value === undefined) {
    throw new ComputedFindingError('empty_or_all_null', 'Finding value is NULL.')
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ComputedFindingError('inconsistent_value', 'Finding value is not finite.')
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new ComputedFindingError(
        'inconsistent_value',
        'Integer finding exceeds the safe exact range.',
      )
    }
    return String(value)
  }
  if (typeof value === 'string') {
    if (value.length === 0) {
      throw new ComputedFindingError('inconsistent_value', 'Empty string finding value.')
    }
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  throw new ComputedFindingError('inconsistent_value', 'Unsupported finding value type.')
}

function singleColumnValues(result: StoredQueryResult, field: string): unknown[] {
  const rows = requireComplete(result)
  const index = columnIndex(result, field)
  return rows.map((row) => row[index])
}

function evidenceFact(result: StoredQueryResult, field: string) {
  const evidence = deriveResultEvidence(result)
  if (!evidence.complete) {
    throw new ComputedFindingError(
      'incomplete_result',
      'Complete stored rows are required before resolving a computed finding.',
    )
  }
  const fact = evidence.facts.find((entry) => entry.column === field)
  if (!fact) {
    throw new ComputedFindingError(
      'empty_or_all_null',
      `No safe numeric evidence for field "${field}".`,
    )
  }
  return fact
}

function recipeColumnValue(result: StoredQueryResult, columnName: string): string {
  const rows = requireComplete(result)
  if (rows.length === 0) {
    throw new ComputedFindingError('empty_or_all_null', 'Stored result has no rows.')
  }
  const index = columnIndex(result, columnName)
  if (rows.length === 1) {
    const value = rows[0]![index]
    if (value === 'WITHHELD_HIGH_PRECISION_DECIMAL') {
      throw new ComputedFindingError(
        'inconsistent_value',
        `Withheld high-precision value for "${columnName}".`,
      )
    }
    return cellToExactString(value)
  }
  // Grouped recipe results: require a unique non-null value across groups.
  const values = rows
    .map((row) => row[index])
    .filter((value) => value !== null && value !== undefined)
  if (values.length === 0) {
    throw new ComputedFindingError('empty_or_all_null', `All NULL values for "${columnName}".`)
  }
  const exact = values.map(cellToExactString)
  if (new Set(exact).size !== 1) {
    throw new ComputedFindingError(
      'inconsistent_value',
      `Grouped result has multiple values for "${columnName}"; pick a scoped query.`,
    )
  }
  return exact[0]!
}

function scopeClause(reference: ComputedFindingReference): string {
  const parts = [
    'scoped to the stored query result',
    reference.filterScope ? `filter/limit: ${reference.filterScope}` : undefined,
    reference.nullScope ? `NULL handling: ${reference.nullScope}` : undefined,
  ].filter(Boolean)
  return parts.join('; ')
}

function renderSentence(reference: ComputedFindingReference, exactValue: string): string {
  const field = reference.field ? `"${reference.field}"` : 'the result'
  const units = reference.units ? ` ${reference.units}` : ''
  const scope = scopeClause(reference)
  switch (reference.operation) {
    case 'column_minimum':
      return `Minimum of ${field} is ${exactValue}${units} (${scope}).`
    case 'column_maximum':
      return `Maximum of ${field} is ${exactValue}${units} (${scope}).`
    case 'column_non_null_count':
      return `Non-NULL count of ${field} is ${exactValue} (${scope}).`
    case 'row_count':
      return `Stored result row count is ${exactValue} (${scope}).`
    case 'descriptive_total_count':
      return `Descriptive total_count for ${field} is ${exactValue} (${scope}).`
    case 'descriptive_non_null_count':
      return `Descriptive non-NULL count for ${field} is ${exactValue} (${scope}).`
    case 'descriptive_mean':
      return `Descriptive mean of ${field} is ${exactValue}${units} (${scope}). This does not establish a heavy-tailed distribution.`
    case 'descriptive_median':
      return `Descriptive median of ${field} is ${exactValue}${units} (${scope}). This does not establish a heavy-tailed distribution.`
    case 'descriptive_min':
      return `Descriptive minimum of ${field} is ${exactValue}${units} (${scope}).`
    case 'descriptive_max':
      return `Descriptive maximum of ${field} is ${exactValue}${units} (${scope}).`
    case 'duplicate_total_rows':
      return `Full-row duplicate recipe total_rows is ${exactValue} (${scope}).`
    case 'duplicate_distinct_rows':
      return `Full-row duplicate recipe distinct_rows is ${exactValue} (${scope}).`
    case 'duplicate_excess':
      return `Full-row duplicate_excess is ${exactValue} (${scope}). Identical stored rows are not proven duplicate transactions.`
    case 'ratio_of_sums':
      return (
        `Ratio of sums` +
        (reference.field && reference.denominatorField
          ? ` (${reference.field} / ${reference.denominatorField})`
          : '') +
        ` is ${exactValue}${units} (${scope}).`
      )
    case 'elapsed_bin_row_count':
      return `Elapsed-interval bin row_count is ${exactValue} (${scope}).`
    default: {
      const _exhaustive: never = reference.operation
      throw new ComputedFindingError(
        'unsupported_operation',
        `Unsupported operation ${String(_exhaustive)}.`,
      )
    }
  }
}

function resolveExactValue(result: StoredQueryResult, reference: ComputedFindingReference): string {
  switch (reference.operation) {
    case 'row_count':
      requireComplete(result)
      return String(result.rowCount)
    case 'column_minimum': {
      if (!reference.field) throw new ComputedFindingError('missing_field', 'field is required')
      return cellToExactString(evidenceFact(result, reference.field).minimum)
    }
    case 'column_maximum': {
      if (!reference.field) throw new ComputedFindingError('missing_field', 'field is required')
      return cellToExactString(evidenceFact(result, reference.field).maximum)
    }
    case 'column_non_null_count': {
      if (!reference.field) throw new ComputedFindingError('missing_field', 'field is required')
      return String(evidenceFact(result, reference.field).nonNullCount)
    }
    case 'descriptive_total_count':
      return recipeColumnValue(result, 'total_count')
    case 'descriptive_non_null_count':
      return recipeColumnValue(result, 'non_null_count')
    case 'descriptive_mean':
      return recipeColumnValue(result, 'mean_value')
    case 'descriptive_median':
      return recipeColumnValue(result, 'median_value')
    case 'descriptive_min':
      return recipeColumnValue(result, 'min_value')
    case 'descriptive_max':
      return recipeColumnValue(result, 'max_value')
    case 'duplicate_total_rows':
      return recipeColumnValue(result, 'total_count')
    case 'duplicate_distinct_rows':
      return recipeColumnValue(result, 'distinct_row_count')
    case 'duplicate_excess':
      return recipeColumnValue(result, 'duplicate_excess')
    case 'ratio_of_sums': {
      const rows = requireComplete(result)
      const rateIndex = columnIndex(result, 'population_rate')
      const reasonIndex = result.columns.findIndex((column) => column.name === 'undefined_reason')
      if (rows.length === 1 && reasonIndex >= 0) {
        const reason = rows[0]![reasonIndex]
        if (reason === 'ZERO_DENOMINATOR') {
          throw new ComputedFindingError(
            'zero_denominator',
            'Ratio is undefined because the denominator sum is zero.',
          )
        }
        if (reason === 'NO_COMPLETE_PAIRS' || reason === 'INCOMPLETE_PAIRS') {
          throw new ComputedFindingError('empty_or_all_null', `Ratio withheld (${String(reason)}).`)
        }
      }
      const raw = rows.length === 1 ? rows[0]![rateIndex] : undefined
      if (raw === null || raw === undefined) {
        throw new ComputedFindingError(
          'zero_denominator',
          'Ratio is NULL; a zero or missing denominator cannot yield a finite finding.',
        )
      }
      return recipeColumnValue(result, 'population_rate')
    }
    case 'elapsed_bin_row_count':
      return recipeColumnValue(result, 'row_count')
    default: {
      const _exhaustive: never = reference.operation
      throw new ComputedFindingError(
        'unsupported_operation',
        `Unsupported operation ${String(_exhaustive)}.`,
      )
    }
  }
}

/**
 * Resolve a typed finding from a trusted stored result. Rejects foreign, stale,
 * incomplete or inconsistent references. Does not invent heavy-tail or causal claims.
 */
export function resolveComputedFinding(
  result: StoredQueryResult,
  referenceInput: ComputedFindingReference,
): ComputedFinding {
  const reference = ComputedFindingReferenceSchema.parse(referenceInput)
  assertIdentity(result, reference)
  requireComplete(result)

  if (result.rowCount === 0 && reference.operation !== 'row_count') {
    throw new ComputedFindingError('empty_or_all_null', 'Stored result is empty.')
  }

  if (
    (reference.operation === 'column_minimum' ||
      reference.operation === 'column_maximum' ||
      reference.operation === 'column_non_null_count') &&
    reference.field
  ) {
    const values = singleColumnValues(result, reference.field)
    if (values.every((value) => value === null || value === undefined)) {
      throw new ComputedFindingError('empty_or_all_null', `Field "${reference.field}" is all NULL.`)
    }
  }

  const exactValue = resolveExactValue(result, reference)
  const sentence = renderSentence(reference, exactValue)
  return ComputedFindingSchema.parse({
    reference,
    exactValue,
    sentence,
    complete: true,
    rowCount: result.rowCount,
  })
}

export function renderComputedFindingsSection(findings: readonly ComputedFinding[]): string {
  if (findings.length === 0) return ''
  return findings.map((finding) => finding.sentence).join('\n')
}
