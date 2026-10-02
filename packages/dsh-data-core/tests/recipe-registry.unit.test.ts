import { expect, it } from 'vitest'
import { resolveReviewedSource, UnsupportedSourceError } from '../src/recipes/registry.js'

it('resolves Superstore Kaggle slug to a pinned recipe', () => {
  const pin = resolveReviewedSource('vivek468/superstore-dataset-final')
  expect(pin.recipe.datasetId).toBe('superstore')
  expect(pin.sourceVersion).toBe('1')
  expect(pin.requiresDownload).toBe(true)
})

it('resolves dataset id aliases and Kaggle URLs', () => {
  expect(resolveReviewedSource('superstore').slug).toBe('vivek468/superstore-dataset-final')
  expect(
    resolveReviewedSource('https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce').slug,
  ).toBe('olistbr/brazilian-ecommerce')
})

it('rejects unsupported sources without inventing ETL', () => {
  expect(() => resolveReviewedSource('someone/random-csv')).toThrow(UnsupportedSourceError)
  expect(() => resolveReviewedSource('someone/random-csv')).toThrow(/Unsupported fixture source/)
})
