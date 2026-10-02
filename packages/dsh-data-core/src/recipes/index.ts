import { OLIST_RECIPE } from './olist.js'
import { OLIST_MINI_RECIPE } from './olist-mini.js'
import { ONLINE_RETAIL_RECIPE } from './online-retail.js'
import { RETAIL_FIXTURE_RECIPE } from './retail-fixture.js'
import { SUPERSTORE_RECIPE } from './superstore.js'
import type { IngestRecipe } from './types.js'

const RECIPES: readonly IngestRecipe[] = [
  SUPERSTORE_RECIPE,
  ONLINE_RETAIL_RECIPE,
  OLIST_RECIPE,
  OLIST_MINI_RECIPE,
  RETAIL_FIXTURE_RECIPE,
]

export function getRecipeByDatasetId(datasetId: string): IngestRecipe | undefined {
  return RECIPES.find((recipe) => recipe.datasetId === datasetId)
}

export {
  UnsupportedSourceError,
  listReviewedSourcePins,
  normalizeSourceSlug,
  resolveReviewedSource,
  type ReviewedSourcePin,
} from './registry.js'

export {
  effectiveLoadStrategy,
  type IngestRecipe,
  type IngestTableRecipe,
  type LoadStrategy,
  type RecipeColumn,
} from './types.js'

/** Bounded schema text for model/SQL generators (column names + types, not rows). */
export function formatRecipeSchemaSummary(
  datasetId: string,
  aliases: ReadonlyArray<{ term: string; expression: string; tableId: string }> = [],
): string | undefined {
  const recipe = getRecipeByDatasetId(datasetId)
  if (!recipe) return undefined
  const tables = recipe.tables
    .map((table) => {
      const cols = table.columns.map((col) => `${col.name}:${col.type}`).join(', ')
      return `${table.tableId}(${cols})`
    })
    .join('; ')
  const aliasPart =
    aliases.length === 0
      ? 'none'
      : aliases.map((alias) => `${alias.term} on ${alias.tableId}=${alias.expression}`).join('; ')
  return `tables: ${tables}; aliases: ${aliasPart}`
}
