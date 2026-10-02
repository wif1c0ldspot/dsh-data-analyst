import { expect, it } from 'vitest'
import { TABLE_GRAINS, TABLE_RELATIONSHIPS } from '../src/grains.js'
import { METRIC_RULE_NOTES } from '../src/metric-rules.js'
import { OLIST_RECIPE } from '../src/recipes/olist.js'
import { OLIST_MINI_RECIPE } from '../src/recipes/olist-mini.js'
import { ONLINE_RETAIL_RECIPE } from '../src/recipes/online-retail.js'
import { RETAIL_FIXTURE_RECIPE } from '../src/recipes/retail-fixture.js'
import { SUPERSTORE_RECIPE } from '../src/recipes/superstore.js'
import type { IngestRecipe } from '../src/recipes/types.js'

const RECIPES_BY_DATASET: Record<string, IngestRecipe> = {
  'retail-fixture': RETAIL_FIXTURE_RECIPE,
  'olist-mini': OLIST_MINI_RECIPE,
  olist: OLIST_RECIPE,
  superstore: SUPERSTORE_RECIPE,
  'online-retail': ONLINE_RETAIL_RECIPE,
}

function recipeTableIds(datasetId: string): Set<string> | undefined {
  const recipe = RECIPES_BY_DATASET[datasetId]
  if (!recipe) return undefined
  return new Set(recipe.tables.map((table) => table.tableId))
}

function recipeColumnNames(datasetId: string, tableId: string): Set<string> | undefined {
  const recipe = RECIPES_BY_DATASET[datasetId]
  const table = recipe?.tables.find((entry) => entry.tableId === tableId)
  if (!table) return undefined
  return new Set(table.columns.map((column) => column.name))
}

it('grains reference recipe tables and primary-key columns where a recipe exists', () => {
  for (const grain of TABLE_GRAINS) {
    const tableIds = recipeTableIds(grain.datasetId)
    expect(tableIds, `recipe for ${grain.datasetId}`).toBeDefined()
    expect(tableIds!.has(grain.tableId), `${grain.datasetId}.${grain.tableId}`).toBe(true)

    const columns = recipeColumnNames(grain.datasetId, grain.tableId)
    expect(columns).toBeDefined()
    for (const key of grain.primaryKey) {
      expect(columns!.has(key), `${grain.datasetId}.${grain.tableId}.${key}`).toBe(true)
    }
    expect(grain.primaryKey.length).toBeGreaterThan(0)
    expect(grain.grainDescription.trim().length).toBeGreaterThan(0)
  }
})

it('relationships reference known tables and join columns in recipes', () => {
  for (const rel of TABLE_RELATIONSHIPS) {
    const tableIds = recipeTableIds(rel.datasetId)
    expect(tableIds).toBeDefined()
    expect(tableIds!.has(rel.fromTable)).toBe(true)
    expect(tableIds!.has(rel.toTable)).toBe(true)
    expect(rel.fromColumns.length).toBe(rel.toColumns.length)
    expect(rel.fromColumns.length).toBeGreaterThan(0)

    const fromColumns = recipeColumnNames(rel.datasetId, rel.fromTable)!
    const toColumns = recipeColumnNames(rel.datasetId, rel.toTable)!
    for (const column of rel.fromColumns) {
      expect(fromColumns.has(column)).toBe(true)
    }
    for (const column of rel.toColumns) {
      expect(toColumns.has(column)).toBe(true)
    }
  }
})

it('metric-rule notes point at recipe columns', () => {
  for (const rule of METRIC_RULE_NOTES) {
    const columns = recipeColumnNames(rule.datasetId, rule.tableId)
    expect(columns, `${rule.datasetId}.${rule.tableId}`).toBeDefined()
    expect(columns!.has(rule.column), `${rule.datasetId}.${rule.tableId}.${rule.column}`).toBe(true)
  }
})

it('olist-mini documents retail-style fanout grains', () => {
  const grains = TABLE_GRAINS.filter((grain) => grain.datasetId === 'olist-mini')
  expect(grains.map((grain) => grain.tableId).sort()).toEqual(
    ['customers', 'order_items', 'order_payments', 'orders'].sort(),
  )
  expect(grains.find((grain) => grain.tableId === 'order_items')?.primaryKey).toEqual([
    'order_item_id',
  ])
})

it('uses the preserved source row index as Online Retail row identity', () => {
  const grain = TABLE_GRAINS.find(
    (entry) => entry.datasetId === 'online-retail' && entry.tableId === 'online_retail',
  )
  expect(grain?.primaryKey).toEqual(['source_row_index'])
  expect(grain?.grainDescription).toMatch(/source CSV record/)
})
