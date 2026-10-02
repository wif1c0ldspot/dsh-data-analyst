/**
 * `investigate_metric` composite: a policy-gated "current vs
 * baseline" read against one authorized dataset, in place of spinning up a
 * dsh subagent to answer "why did X change" questions. There is exactly one
 * reasoning agent in this product (see AGENTS.md); this module is a
 * deterministic two-query helper the tool layer calls directly, never a
 * second agent loop.
 *
 * Both candidate SQL strings are authorized independently — via
 * {@link authorizeQuery} against an ephemeral `:memory:` connection, the
 * same pattern `executeAuthorizedQuery` uses (query-service.ts) — *before*
 * either query is ever executed. If either statement is denied (an
 * unauthorized table, a non-SELECT statement such as `DROP`/`DELETE`, more
 * than one statement, etc.) this throws and neither {@link executeIsolatedQuery}
 * call runs, so a denied baseline can never leave the current query's result
 * JSON behind in `resultStoreDir`. `executeIsolatedQuery` re-authorizes SQL
 * again inside its own child process; this upfront pass exists solely to
 * guarantee the *pairing* is all-or-nothing, not to replace that inner check.
 */
import { DuckDBInstance } from '@duckdb/node-api'
import { authorizeQuery, QueryPolicyViolation } from './sql-policy.js'
import { executeIsolatedQuery, type IsolatedQueryRequest } from './query-worker.js'
import type { AuthorizedQuerySummary } from './query-service.js'

export interface InvestigateRequest {
  datasetId: string
  sqlCurrent: string
  sqlBaseline: string
  parameters?: ReadonlyArray<{ logicalType: string; value: unknown }>
}

export interface InvestigateObservation {
  current: Omit<AuthorizedQuerySummary, 'elapsedMs' | 'warnings'>
  baseline: Omit<AuthorizedQuerySummary, 'elapsedMs' | 'warnings'>
  warnings: string[]
}

/** Authorize one SQL string on a fresh ephemeral connection, same shape as executeAuthorizedQuery. */
async function authorizeOnEphemeralConnection(
  sql: string,
  allowedTables: readonly string[],
): Promise<void> {
  const policyDb = await DuckDBInstance.create(':memory:')
  const policyConnection = await policyDb.connect()
  try {
    await authorizeQuery(policyConnection, sql, { allowedTables })
  } finally {
    policyConnection.closeSync()
    policyDb.closeSync()
  }
}

export async function investigateMetric(
  request: InvestigateRequest & {
    datasetPath: string
    datasetVersionId: string
    semanticRevisionId: string
    allowedTables: readonly string[]
    resultStoreDir: string
    signal?: AbortSignal
  },
): Promise<InvestigateObservation> {
  const parameters = request.parameters ?? []

  // Both statements are authorized to completion before either one runs.
  // Max two statements total (one per SQL string; each string is itself
  // limited to exactly one SELECT by authorizeQuery). On either denial,
  // surface POLICY_DENIED and run neither write.
  try {
    await authorizeOnEphemeralConnection(request.sqlCurrent, request.allowedTables)
    await authorizeOnEphemeralConnection(request.sqlBaseline, request.allowedTables)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new QueryPolicyViolation(`POLICY_DENIED: ${reason}`)
  }

  const shared: Omit<IsolatedQueryRequest, 'sql'> = {
    datasetPath: request.datasetPath,
    datasetVersionId: request.datasetVersionId,
    semanticRevisionId: request.semanticRevisionId,
    parameters: [...parameters],
    allowedTables: request.allowedTables,
    resultStoreDir: request.resultStoreDir,
    signal: request.signal,
  }

  const current = await executeIsolatedQuery({ ...shared, sql: request.sqlCurrent })
  const baseline = await executeIsolatedQuery({ ...shared, sql: request.sqlBaseline })

  const warnings: string[] = []
  for (const warning of [...current.warnings, ...baseline.warnings]) {
    if (!warnings.includes(warning)) warnings.push(warning)
  }

  return {
    current: {
      resultId: current.resultId,
      datasetVersionId: current.datasetVersionId,
      semanticRevisionId: current.semanticRevisionId,
      columns: current.columns,
      preview: current.preview,
      rowCount: current.rowCount,
      previewTruncated: current.previewTruncated,
      resultComplete: current.resultComplete,
      evidence: current.evidence,
    },
    baseline: {
      resultId: baseline.resultId,
      datasetVersionId: baseline.datasetVersionId,
      semanticRevisionId: baseline.semanticRevisionId,
      columns: baseline.columns,
      preview: baseline.preview,
      rowCount: baseline.rowCount,
      previewTruncated: baseline.previewTruncated,
      resultComplete: baseline.resultComplete,
      evidence: baseline.evidence,
    },
    warnings,
  }
}
