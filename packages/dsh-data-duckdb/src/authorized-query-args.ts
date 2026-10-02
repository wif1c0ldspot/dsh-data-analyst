/**
 * Shared resolution for duckdb_query / workbench: load the immutable dataset
 * manifest and validate the semantic revision before any isolated SQL runs.
 * When the catalog has approved alias candidates, binds the effective overlay
 * revision id (auditable `+aliases.<fingerprint>` suffix).
 */
import type { MetadataStore } from 'dsh-data-core/metadata-store'
import { getEffectiveSemantics, resolveEffectiveSemanticRevision } from 'dsh-data-core/semantics'

export interface AuthorizedQueryArgsInput {
  datasetId?: string
  datasetVersionId?: string
  semanticRevisionId?: string
  sql: string
  parameters: readonly { logicalType: string; value: unknown }[]
}

export interface AuthorizedQueryArgs {
  datasetVersionId: string
  semanticRevisionId: string
  datasetId: string
  allowedTables: string[]
  sql: string
  parameters: readonly { logicalType: string; value: unknown }[]
}

export function resolveAuthorizedQueryArgs(
  store: MetadataStore,
  input: AuthorizedQueryArgsInput,
): AuthorizedQueryArgs {
  const datasetId = input.datasetId?.trim()
  const datasetVersionId = input.datasetVersionId?.trim()
  const manifest = datasetVersionId
    ? store.getDatasetVersion(datasetVersionId)
    : datasetId
      ? store.getCurrentDatasetVersion(datasetId)
      : undefined
  if (!manifest) {
    throw new Error(
      datasetVersionId
        ? `Unknown dataset version "${datasetVersionId}"`
        : datasetId
          ? `No published dataset "${datasetId}"`
          : 'datasetId or datasetVersionId is required',
    )
  }
  const effective = getEffectiveSemantics(manifest.datasetId, store)
  const requestedSemantic = input.semanticRevisionId?.trim() || effective?.semanticRevisionId
  if (!requestedSemantic) {
    throw new Error(`No semantics for dataset "${manifest.datasetId}"`)
  }
  const semantics = resolveEffectiveSemanticRevision(manifest.datasetId, requestedSemantic, store)
  return {
    datasetVersionId: manifest.datasetVersionId,
    semanticRevisionId: semantics.semanticRevisionId,
    datasetId: manifest.datasetId,
    allowedTables: manifest.tables.map((table) => table.id),
    sql: input.sql,
    parameters: input.parameters,
  }
}
