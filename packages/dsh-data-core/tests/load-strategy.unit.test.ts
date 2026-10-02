import { describe, expect, it } from 'vitest'
import { effectiveLoadStrategy, type IngestRecipe } from '../src/recipes/types.js'

const BASE: IngestRecipe = {
  datasetId: 'widgets',
  recipeHash: 'hash',
  importerVersion: '1',
  tables: [],
  license: null,
  sourceUrl: 'https://example.test',
}

describe('effectiveLoadStrategy', () => {
  it('defaults absent loadStrategy to typed_recipe', () => {
    expect(effectiveLoadStrategy(BASE)).toBe('typed_recipe')
    expect(effectiveLoadStrategy({ ...BASE, loadStrategy: undefined })).toBe('typed_recipe')
  })

  it('preserves explicit raw_then_typed', () => {
    expect(effectiveLoadStrategy({ ...BASE, loadStrategy: 'raw_then_typed' })).toBe(
      'raw_then_typed',
    )
  })

  it('preserves explicit typed_recipe', () => {
    expect(effectiveLoadStrategy({ ...BASE, loadStrategy: 'typed_recipe' })).toBe('typed_recipe')
  })
})
