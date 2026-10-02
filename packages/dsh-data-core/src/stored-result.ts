/**
 * Load an authorized query-result JSON from the workspace results store.
 * Rejects invalid ids; does not accept filesystem paths from callers.
 */
import type { QueryRequest } from './contracts.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const RESULT_ID_RE = /^res_[a-z0-9]+$/i

export interface StoredQueryResult {
  resultId: string
  datasetVersionId: string
  semanticRevisionId: string
  sql: string
  /** Absent on legacy results; never interpret missing provenance as no binds. */
  parameters?: QueryRequest['parameters']
  columns: Array<{ name: string; logicalType: string; unit?: string }>
  preview: unknown[][]
  rows?: unknown[][]
  rowCount: number
  previewTruncated: boolean
  warnings?: string[]
}

export function assertResultId(resultId: string): void {
  if (!RESULT_ID_RE.test(resultId)) {
    throw new Error(`Invalid result id "${resultId}"`)
  }
}

export async function loadStoredQueryResult(
  resultsDir: string,
  resultId: string,
): Promise<StoredQueryResult> {
  assertResultId(resultId)
  const raw = await readFile(join(resultsDir, `${resultId}.json`), 'utf8')
  const parsed = JSON.parse(raw) as Partial<StoredQueryResult>
  if (
    typeof parsed.datasetVersionId !== 'string' ||
    typeof parsed.semanticRevisionId !== 'string' ||
    typeof parsed.sql !== 'string'
  ) {
    throw new Error('Stored result missing revision binding fields')
  }
  return parsed as StoredQueryResult
}
