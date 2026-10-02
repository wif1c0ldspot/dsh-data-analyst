/** Descriptive evidence about a stored query result, never a preview or population estimate. */
import type { StoredQueryResult } from './stored-result.js'
import { z } from 'zod'

export const ResultEvidenceFactSchema = z
  .object({
    column: z.string().min(1).max(256),
    unit: z.string().min(1).max(128).optional(),
    minimum: z.number().finite(),
    maximum: z.number().finite(),
    minimumRow: z.number().int().nonnegative(),
    maximumRow: z.number().int().nonnegative(),
    nonNullCount: z.number().int().nonnegative(),
    integerDomain: z.boolean(),
    distinctCount: z.number().int().nonnegative(),
  })
  .strict()

export const ResultEvidenceSchema = z
  .object({
    resultId: z.string().min(1).max(128),
    datasetVersionId: z.string().min(1).max(128),
    semanticRevisionId: z.string().min(1).max(128),
    analysisId: z.string().min(1).max(128).optional(),
    revision: z.number().int().nonnegative().optional(),
    filter: z.string().max(256).optional(),
    scope: z.string().min(1).max(512),
    complete: z.boolean(),
    rowCount: z.number().int().nonnegative(),
    facts: z.array(ResultEvidenceFactSchema).max(4096),
    warnings: z.array(z.string().max(2048)).max(4096),
  })
  .strict()

export interface ResultEvidence {
  resultId: string
  datasetVersionId: string
  semanticRevisionId: string
  analysisId?: string
  revision?: number
  filter?: string
  scope: string
  complete: boolean
  rowCount: number
  facts: Array<{
    column: string
    unit?: string
    minimum: number
    maximum: number
    minimumRow: number
    maximumRow: number
    nonNullCount: number
    integerDomain: boolean
    distinctCount: number
  }>
  warnings: string[]
}

export function deriveResultEvidence(
  result: StoredQueryResult,
  provenance: { analysisId?: string; revision?: number; filter?: string } = {},
): ResultEvidence {
  const rows = result.rows
  const complete = Array.isArray(rows) && rows.length === result.rowCount
  const evidence: ResultEvidence = {
    resultId: result.resultId,
    datasetVersionId: result.datasetVersionId,
    semanticRevisionId: result.semanticRevisionId,
    ...provenance,
    scope:
      'Describes stored query rows only; query limits and filters still apply. No population totals or causal conclusions are inferred.',
    complete,
    rowCount: result.rowCount,
    facts: [],
    warnings: [...(result.warnings ?? [])],
  }
  if (!complete) {
    evidence.warnings.push('Complete stored rows are unavailable; descriptive facts are withheld.')
    return evidence
  }
  for (const [index, column] of result.columns.entries()) {
    if (
      !/^(U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|HUGEINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)/i.test(
        column.logicalType,
      )
    )
      continue
    let minimum = Infinity
    let maximum = -Infinity
    let minimumRow = -1
    let maximumRow = -1
    let nonNullCount = 0
    let integerDomain = true
    const distinctValues = new Set<number>()
    let unsafe = false
    for (const [rowIndex, row] of rows.entries()) {
      const raw = row[index]
      // Serialized integer counts may be used only when conversion is provably exact.
      const cell =
        typeof raw === 'string' &&
        /^(U?(TINYINT|SMALLINT|INTEGER|BIGINT)|U?HUGEINT)$/i.test(column.logicalType) &&
        /^-?\d+$/.test(raw) &&
        Number.isSafeInteger(Number(raw))
          ? Number(raw)
          : raw
      if (cell === null || cell === undefined) continue
      // Decimal strings and integers outside the safe range remain withheld.
      if (
        typeof cell !== 'number' ||
        !Number.isFinite(cell) ||
        (Number.isInteger(cell) && !Number.isSafeInteger(cell))
      ) {
        unsafe = true
        break
      }
      nonNullCount += 1
      if (!Number.isSafeInteger(cell)) integerDomain = false
      distinctValues.add(cell)
      if (cell < minimum) {
        minimum = cell
        minimumRow = rowIndex
      }
      if (cell > maximum) {
        maximum = cell
        maximumRow = rowIndex
      }
    }
    if (unsafe) {
      evidence.warnings.push(
        `Numeric evidence omitted for ${column.name}: values require exact decimal or integer handling.`,
      )
    } else if (nonNullCount) {
      evidence.facts.push({
        column: column.name,
        ...(column.unit ? { unit: column.unit } : {}),
        minimum,
        maximum,
        minimumRow,
        maximumRow,
        nonNullCount,
        integerDomain,
        distinctCount: distinctValues.size,
      })
    }
  }
  return evidence
}
