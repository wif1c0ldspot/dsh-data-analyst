/**
 * Authorized query service (model-facing `duckdb_query` path). Policy runs on
 * an ephemeral in-memory connection first so unauthorized SQL never touches the
 * dataset file; execution then opens the immutable dataset READ_ONLY with
 * external access disabled. Returns a bounded QueryResultSummary-shaped object
 * and persists the full capped rows under `resultStoreDir` when provided.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import type { DuckDBValue } from '@duckdb/node-api'
import {
  currencyWarningsForStatement,
  textDateWarningsForStatement,
  type TextDateColumnRef,
  type CurrencyDimensionRef,
} from 'dsh-data-core/currency-warnings'
import { splitResultWarnings } from 'dsh-data-core/result-warnings'
import { deriveResultEvidence, type ResultEvidence } from 'dsh-data-core/result-evidence'
import { runFixedQuery } from './fixed-query.js'
import { authorizeQuery, hasTopLevelOrderBy, QueryPolicyViolation } from './sql-policy.js'

export interface AuthorizedQueryRequest {
  datasetPath: string
  datasetVersionId: string
  semanticRevisionId: string
  sql: string
  parameters: readonly { logicalType: string; value: unknown }[]
  allowedTables: readonly string[]
  /**
   * Detected currency-mix dimensions for tables in this dataset (from the
   * published manifest) — resolved by the caller (which has `MetadataStore`
   * access) and passed through so `currencyWarningsForStatement` can reuse
   * the statement `authorizeQuery` already parsed, instead of a second SQL
   * parse or a separate render-time computation outside this worker.
   */
  currencyDimensions?: readonly CurrencyDimensionRef[]
  /**
   * Text-held date columns in this dataset (manifest `typeFallbacks`), resolved by the
   * caller exactly like `currencyDimensions`, so an order-sensitive read of a text date
   * warns on the result instead of quietly answering lexicographically.
   */
  textDateColumns?: readonly TextDateColumnRef[]
  /** When set, write the durable result JSON next to other workspace artifacts. */
  resultStoreDir?: string
  maxPreviewRows?: number
  /** Forwarded to runFixedQuery / runCancellableQuery (default 30_000). */
  timeoutMs?: number
  signal?: AbortSignal
  maxResultRows?: number
  maxResultBytes?: number
}

export interface AuthorizedQuerySummary {
  resultId: string
  datasetVersionId: string
  semanticRevisionId: string
  columns: Array<{ name: string; logicalType: string }>
  rowCount: number
  preview: unknown[][]
  previewTruncated: boolean
  resultComplete: true
  elapsedMs: number
  warnings: string[]
  evidence: ResultEvidence
}

export async function executeAuthorizedQuery(
  request: AuthorizedQueryRequest,
): Promise<AuthorizedQuerySummary> {
  const boundParameters = resolveBoundParameters(request.parameters)

  const policyDb = await DuckDBInstance.create(':memory:')
  const policyConnection = await policyDb.connect()
  let statement: unknown
  try {
    statement = await authorizeQuery(policyConnection, request.sql, {
      allowedTables: request.allowedTables,
    })
  } finally {
    policyConnection.closeSync()
    policyDb.closeSync()
  }
  // Reuse the already-parsed, already-authorized statement — never a second
  // SQL parse just to derive an advisory warning.
  const currencyWarnings = currencyWarningsForStatement(statement, request.currencyDimensions ?? [])
  const textDateWarnings = textDateWarningsForStatement(statement, request.textDateColumns ?? [])
  // A model-authored query with no ORDER BY of its own is otherwise free to
  // come back in a different physical row order on independent runs of the
  // identical SQL (hash aggregation, parallel scans) — silently breaking
  // repeatability of anything derived from row position, notably
  // `deriveResultEvidence`'s minimumRow/maximumRow, even though the
  // aggregate values themselves stay correct. Add a caller-invisible stable
  // tiebreaker only when the query didn't already specify its own order.
  const stableOrder = !hasTopLevelOrderBy(statement)

  const reader = await DuckDBInstance.create(request.datasetPath, {
    access_mode: 'READ_ONLY',
    enable_external_access: 'false',
  })
  const connection = await reader.connect()
  try {
    const fixed = await runFixedQuery(connection, request.sql, {
      maxPreviewRows: request.maxPreviewRows,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      maxResultRows: request.maxResultRows,
      maxResultBytes: request.maxResultBytes,
      parameters: boundParameters,
      stableOrder,
    })
    const resultId = `res_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    // `Preview capped at N of M rows` describes the payload the model was shown,
    // not the data. Persisted as a data caveat it became a subtitle on every chart
    // drawn from this result and shipped inside exported reports, where it reads as
    // "this chart is a 20-row preview" even though the chart draws every row.
    const { payloadNotes, dataWarnings } = splitResultWarnings(fixed.warnings)
    const warnings = [...dataWarnings, ...currencyWarnings, ...textDateWarnings]
    const storedResult = {
      resultId,
      datasetVersionId: request.datasetVersionId,
      semanticRevisionId: request.semanticRevisionId,
      columns: fixed.columns,
      rowCount: fixed.rowCount,
      preview: fixed.preview,
      previewTruncated: fixed.previewTruncated,
      resultComplete: true,
      elapsedMs: fixed.elapsedMs,
      warnings,
      sql: request.sql,
      parameters: request.parameters,
      rows: fixed.rows,
    }
    // Derive once from the complete in-memory result at the trusted worker
    // boundary. The model-facing summary receives only these selected facts;
    // full rows remain in the result store and never cross the IPC boundary.
    const evidence = deriveResultEvidence({
      resultId,
      datasetVersionId: request.datasetVersionId,
      semanticRevisionId: request.semanticRevisionId,
      columns: fixed.columns,
      preview: fixed.preview,
      rows: fixed.rows,
      rowCount: fixed.rowCount,
      previewTruncated: fixed.previewTruncated,
      warnings,
      sql: request.sql,
    })
    const summary: AuthorizedQuerySummary = {
      resultId,
      datasetVersionId: request.datasetVersionId,
      semanticRevisionId: request.semanticRevisionId,
      columns: fixed.columns,
      rowCount: fixed.rowCount,
      preview: fixed.preview,
      previewTruncated: fixed.previewTruncated,
      resultComplete: true,
      elapsedMs: fixed.elapsedMs,
      warnings: [...payloadNotes, ...warnings],
      evidence,
    }

    if (request.resultStoreDir) {
      await mkdir(request.resultStoreDir, { recursive: true })
      await writeFile(
        join(request.resultStoreDir, `${resultId}.json`),
        JSON.stringify({ ...storedResult, evidence }),
        'utf8',
      )
    }

    return summary
  } finally {
    connection.closeSync()
    reader.closeSync()
  }
}

const STRING_TYPES = /^(varchar|text|string|date|time|timestamp(?:_s|_ms|_ns|tz)?|interval)$/i
const INTEGER_TYPES = /^(?:u?(?:tiny|small|big|huge)?int(?:eger)?)$/i
const NUMBER_TYPES = /^(?:real|float|double|decimal(?:\(\d{1,2},\d{1,2}\))?)$/i

/** Validate model-supplied typed values before passing them to DuckDB's binder. */
export function resolveBoundParameters(
  parameters: readonly { logicalType: string; value: unknown }[],
): DuckDBValue[] {
  return parameters.map((parameter, index) => {
    const logicalType = parameter.logicalType.trim()
    const value = parameter.value
    if (value === null) return null
    if (/^(?:bool|boolean)$/i.test(logicalType)) {
      if (typeof value !== 'boolean') {
        throw new QueryPolicyViolation(`Parameter ${index + 1} must be a boolean`)
      }
      return value
    }
    if (STRING_TYPES.test(logicalType)) {
      if (typeof value !== 'string') {
        throw new QueryPolicyViolation(`Parameter ${index + 1} must be a string`)
      }
      return value
    }
    if (INTEGER_TYPES.test(logicalType) || NUMBER_TYPES.test(logicalType)) {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new QueryPolicyViolation(`Parameter ${index + 1} must be finite`)
        }
        return value
      }
      if (typeof value === 'string' && /^[-+]?\d+(?:\.\d+)?$/.test(value)) return value
      throw new QueryPolicyViolation(`Parameter ${index + 1} must be numeric`)
    }
    throw new QueryPolicyViolation(
      `Parameter ${index + 1} has unsupported logical type "${logicalType}"`,
    )
  })
}
