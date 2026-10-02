import { expect, it } from 'vitest'
import type { IngestRecipe } from '../src/recipes/types.js'
import { UnsupportedSourceError } from '../src/recipes/registry.js'
import { resolveSourcePin, type WorkspaceSourcePin } from '../src/recipes/workspace-registry.js'

const GENERIC_RECIPE: IngestRecipe = {
  datasetId: 'generic_widgets',
  recipeHash: 'workspace-csv-v1-abc123',
  importerVersion: '0.1.0',
  license: null,
  sourceUrl: 'https://www.kaggle.com/datasets/someone/widgets',
  tables: [
    {
      sourceFile: 'widgets.csv',
      tableId: 'widgets',
      columns: [{ name: 'region', sourceName: 'Region', type: 'VARCHAR' }],
    },
  ],
}

function pin(overrides: Partial<WorkspaceSourcePin> = {}): WorkspaceSourcePin {
  return {
    pinId: 'pin_0000000000000001',
    revision: 1,
    slug: 'someone/widgets',
    sourceVersion: '1',
    recipe: GENERIC_RECIPE,
    status: 'candidate',
    actorId: 'analyst-session',
    createdAt: '2026-09-14T00:00:00.000Z',
    reviewedAt: null,
    ...overrides,
  }
}

it('resolves an approved workspace pin for a former Core slug (no in-code privilege)', () => {
  const approved = pin({
    slug: 'vivek468/superstore-dataset-final',
    status: 'approved',
    recipe: { ...GENERIC_RECIPE, datasetId: 'superstore' },
  })
  const resolved = resolveSourcePin('vivek468/superstore-dataset-final', [approved])
  expect(resolved.recipe.datasetId).toBe('superstore')
  expect(resolved.recipe.recipeHash).toBe(GENERIC_RECIPE.recipeHash)
  expect(resolved.requiresDownload).toBe(true)
})

it('rejects a former Core slug with no approved workspace pin', () => {
  expect(() => resolveSourcePin('vivek468/superstore-dataset-final', [])).toThrow(
    UnsupportedSourceError,
  )
  expect(() => resolveSourcePin('olist', [])).toThrow(UnsupportedSourceError)
})

it('rejects a slug with only a candidate workspace pin (never approved)', () => {
  const candidateOnly = pin({ status: 'candidate' })
  expect(() => resolveSourcePin('someone/widgets', [candidateOnly])).toThrow(UnsupportedSourceError)
})

it('rejects a slug with only a revoked workspace pin', () => {
  const revoked = pin({ status: 'revoked' })
  expect(() => resolveSourcePin('someone/widgets', [revoked])).toThrow(UnsupportedSourceError)
})

it('resolves an approved workspace pin for a generic dataset', () => {
  const approved = pin({ status: 'approved' })
  const resolved = resolveSourcePin('someone/widgets', [approved])
  expect(resolved.recipe).toBe(GENERIC_RECIPE)
  expect(resolved.sourceVersion).toBe('1')
  expect(resolved.slug).toBe('someone/widgets')
  expect(resolved.requiresDownload).toBe(true)
})

it('resolves an approved workspace pin by the recipe datasetId as well as the slug', () => {
  const approved = pin({ status: 'approved' })
  const resolved = resolveSourcePin('generic_widgets', [approved])
  expect(resolved.recipe).toBe(GENERIC_RECIPE)
})

it('prefers the most recently approved pin when several match the slug', () => {
  const older = pin({
    pinId: 'pin_0000000000000001',
    revision: 1,
    status: 'approved',
    recipe: { ...GENERIC_RECIPE, recipeHash: 'older' },
    createdAt: '2026-09-14T00:00:00.000Z',
  })
  const newer = pin({
    pinId: 'pin_0000000000000002',
    status: 'approved',
    recipe: { ...GENERIC_RECIPE, recipeHash: 'newer' },
    createdAt: '2026-09-14T01:00:00.000Z',
  })
  const resolved = resolveSourcePin('someone/widgets', [older, newer])
  expect(resolved.recipe.recipeHash).toBe('newer')
})

it('throws for a slug with no workspace pin at all', () => {
  expect(() => resolveSourcePin('owner/unknown-dataset', [])).toThrow(UnsupportedSourceError)
})

it('accepts a Kaggle dataset URL the same way normalizeSourceSlug does', () => {
  const approved = pin({ status: 'approved' })
  const resolved = resolveSourcePin('https://www.kaggle.com/datasets/someone/widgets', [approved])
  expect(resolved.recipe).toBe(GENERIC_RECIPE)
})

it('allows an approved workspace pin whose recipe.datasetId was formerly Core-reserved', () => {
  const approved = pin({
    slug: 'other/superstore',
    status: 'approved',
    recipe: { ...GENERIC_RECIPE, datasetId: 'superstore' },
  })
  const resolved = resolveSourcePin('other/superstore', [approved])
  expect(resolved.recipe.datasetId).toBe('superstore')
  expect(resolveSourcePin('superstore', [approved]).recipe).toBe(approved.recipe)
})
