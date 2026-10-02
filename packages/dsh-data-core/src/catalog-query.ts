/**
 * Read-only catalog views for analyst tools. IDs and filesystem paths stay
 * inside the service; callers receive bounded schema/quality/semantics.
 */
import { getEffectiveGrains, getEffectiveRelationships } from './grains.js'
import type { MetadataStore } from './metadata-store.js'
import { metricRulesForDataset } from './metric-rules.js'
import { getRecipeByDatasetId } from './recipes/index.js'
import type { IngestRecipe } from './recipes/types.js'
import { getEffectiveSemantics } from './semantics.js'

export const INGESTION_QUALITY_SCOPE =
  'rows and rejectedRows are ingestion counts only; they do not provide duplicate, NULL/missingness, or distribution-shape evidence'

export interface PublishedDatasetSummary {
  datasetId: string
  datasetVersionId: string
  sourceSlug: string
  sourceVersion: string
  license: string | null
  tables: Array<{ id: string; rows: number; rejectedRows: number }>
  qualityScope: typeof INGESTION_QUALITY_SCOPE
  semanticRevisionId: string
}

export interface DatasetSchemaSlice {
  datasetId: string
  datasetVersionId: string
  semanticRevisionId: string
  qualityScope: typeof INGESTION_QUALITY_SCOPE
  tables: Array<{
    id: string
    rows: number
    rejectedRows: number
    columns?: Array<{ name: string; type: string }>
    grain?: { grainDescription: string; primaryKey: string[] }
    /** String columns whose distinct values are 2+ ISO-4217 currency codes — group/filter by them before summing. */
    currencyDimensions?: Array<{ column: string; currencies: string[] }>
    currencyScanSkipped?: Array<{ column: string; sampledDistinctValues: number }>
    typeFallbacks?: Array<{ column: string; approvedType: string; unparsedValues: number }>
  }>
  relationships: ReturnType<typeof getEffectiveRelationships>
  aliases: Array<{ term: string; expression: string; description: string; tableId: string }>
  /** Reviewed date/currency notes (P1) — data only, not enforced by the query service. */
  rules: ReturnType<typeof metricRulesForDataset>
  /** True when `limit` paging left columns unreturned; fetch the next page with `nextOffset`. */
  columnsTruncated: boolean
  /** Continuation cursor for `offset`, or null when no more columns remain. */
  nextOffset: number | null
  /** Total columns after `tables`/`search` filtering (before `limit`/`offset`). */
  totalColumns: number
}

export interface SchemaSliceOptions {
  /** Restrict schema to these table ids (all tables when omitted). */
  tables?: readonly string[]
  /** Case-insensitive substring filter on column names. */
  search?: string
  /** Max columns returned across all tables; enables paging via `offset`. */
  limit?: number
  /** Column offset for continuation; meaningful only with `limit`. */
  offset?: number
}

export function listPublishedDatasets(store: MetadataStore): PublishedDatasetSummary[] {
  return store.listCurrentDatasetVersions().map((manifest) => {
    const semantics = getEffectiveSemantics(manifest.datasetId, store)
    return {
      datasetId: manifest.datasetId,
      datasetVersionId: manifest.datasetVersionId,
      sourceSlug: manifest.source.slug,
      sourceVersion: manifest.source.version,
      license: manifest.source.license,
      tables: manifest.tables.map((table) => ({
        id: table.id,
        rows: table.rows,
        rejectedRows: table.rejectedRows,
      })),
      qualityScope: INGESTION_QUALITY_SCOPE,
      semanticRevisionId: semantics?.semanticRevisionId ?? '',
    }
  })
}

export function getDatasetSchemaSlice(
  store: MetadataStore,
  datasetId: string,
  options: SchemaSliceOptions = {},
): DatasetSchemaSlice {
  const manifest = store.getCurrentDatasetVersion(datasetId)
  if (!manifest) {
    throw new Error(`No published dataset "${datasetId}"`)
  }
  const semantics = getEffectiveSemantics(datasetId, store)
  const recipe = workspaceRecipeForManifest(store, manifest) ?? getRecipeByDatasetId(datasetId)
  const grains = getEffectiveGrains(datasetId, store)
  const allTables = manifest.tables.map((table) => {
    const recipeTable = recipe?.tables.find((entry) => entry.tableId === table.id)
    const grain = grains.find((entry) => entry.tableId === table.id)
    return {
      id: table.id,
      rows: table.rows,
      rejectedRows: table.rejectedRows,
      ...(recipeTable
        ? {
            columns: recipeTable.columns.map((column) => {
              // The recipe records what the analyst approved; the manifest records
              // what was actually published. A column whose approved type parsed
              // none of its values was republished as raw VARCHAR, so reporting the
              // approved DATE here would advertise a date column holding nothing.
              const fallback = (table.typeFallbacks ?? []).find(
                (entry) => entry.column === column.name,
              )
              return fallback
                ? { name: column.name, type: 'VARCHAR', fallbackFrom: fallback.approvedType }
                : { name: column.name, type: column.type }
            }),
          }
        : {}),
      ...(grain
        ? {
            grain: {
              grainDescription: grain.grainDescription,
              primaryKey: [...grain.primaryKey],
            },
          }
        : {}),
      ...(table.currencyDimensions && table.currencyDimensions.length > 0
        ? { currencyDimensions: table.currencyDimensions }
        : {}),
      ...(table.currencyScanSkipped && table.currencyScanSkipped.length > 0
        ? { currencyScanSkipped: table.currencyScanSkipped }
        : {}),
      ...(table.typeFallbacks && table.typeFallbacks.length > 0
        ? { typeFallbacks: table.typeFallbacks }
        : {}),
    }
  })

  // Table subset + column-name search, applied before paging so `totalColumns`
  // and the cursor are stable across pages of the same filtered view.
  const requestedTables = options.tables ? new Set(options.tables) : undefined
  const search = options.search?.trim().toLowerCase()
  const filteredTables = allTables
    .filter((table) => (requestedTables ? requestedTables.has(table.id) : true))
    .map((table) =>
      table.columns === undefined || search === undefined
        ? table
        : {
            ...table,
            columns: table.columns.filter((column) => column.name.toLowerCase().includes(search)),
          },
    )

  const totalColumns = filteredTables.reduce((sum, table) => sum + (table.columns?.length ?? 0), 0)
  const limit = options.limit
  const offset = limit !== undefined ? (options.offset ?? 0) : 0
  let columnsTruncated = false
  let nextOffset: number | null = null
  let tables = filteredTables

  if (limit !== undefined) {
    columnsTruncated = offset + limit < totalColumns
    nextOffset = columnsTruncated ? offset + limit : null
    let skip = offset
    let take = limit
    tables = filteredTables.map((table) => {
      if (table.columns === undefined || table.columns.length === 0) return table
      if (take <= 0) return { ...table, columns: [] }
      const length = table.columns.length
      if (skip >= length) {
        skip -= length
        return { ...table, columns: [] }
      }
      const start = skip
      const end = Math.min(length, start + take)
      skip = 0
      take -= end - start
      return { ...table, columns: table.columns.slice(start, end) }
    })
  }

  return {
    datasetId: manifest.datasetId,
    datasetVersionId: manifest.datasetVersionId,
    semanticRevisionId: semantics?.semanticRevisionId ?? '',
    qualityScope: INGESTION_QUALITY_SCOPE,
    tables,
    relationships: getEffectiveRelationships(datasetId, store),
    aliases: (semantics?.aliases ?? []).map((alias) => ({
      term: alias.term,
      expression: alias.expression,
      description: alias.description,
      tableId: alias.tableId,
    })),
    rules: metricRulesForDataset(datasetId),
    columnsTruncated,
    nextOffset,
    totalColumns,
  }
}

function workspaceRecipeForManifest(
  store: MetadataStore,
  manifest: { datasetId: string; source: { slug: string; version: string } },
): IngestRecipe | undefined {
  const pins = store.listWorkspaceSourcePins(manifest.source.slug)
  for (let index = pins.length - 1; index >= 0; index -= 1) {
    const pin = pins[index]
    if (
      pin.status === 'approved' &&
      pin.sourceVersion === manifest.source.version &&
      pin.recipe.datasetId === manifest.datasetId
    ) {
      return pin.recipe
    }
  }
  return undefined
}

export function getDatasetMetrics(
  store: MetadataStore,
  datasetId: string,
  terms?: readonly string[],
): DatasetSchemaSlice['aliases'] {
  if (!store.getCurrentDatasetVersion(datasetId)) {
    throw new Error(`No published dataset "${datasetId}"`)
  }
  const aliases = (getEffectiveSemantics(datasetId, store)?.aliases ?? []).map((alias) => ({
    term: alias.term,
    expression: alias.expression,
    description: alias.description,
    tableId: alias.tableId,
  }))
  if (!terms || terms.length === 0) return aliases
  const needles = new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean))
  return aliases.filter((alias) => needles.has(alias.term.toLowerCase()))
}
