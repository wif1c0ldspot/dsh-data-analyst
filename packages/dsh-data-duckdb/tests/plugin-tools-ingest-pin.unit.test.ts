/**
 * `ingest_dataset` must be able to look up an
 * analyst-approved workspace pin by its `recipe.datasetId` — not only by
 * the exact slug it was created under — since `resolveSourcePin` advertises
 * dataset-id lookup too (`docs/contracts.md`: "Kaggle owner/dataset slug or
 * reviewed dataset id"). Calling `store.listWorkspaceSourcePins(slug)` with
 * the dataset id as `slug` filtered out the pin entirely.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { UnsupportedSourceError } from 'dsh-data-core/recipes/registry'
import type { IngestRecipe } from 'dsh-data-core/recipes/types'
import { resolveIngestPin } from '../src/plugin-tools.js'

let directory: string
let catalogPath: string

function genericRecipe(overrides: Partial<IngestRecipe> = {}): IngestRecipe {
  return {
    datasetId: 'widgets',
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
    ...overrides,
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-ingest-pin-'))
  catalogPath = join(directory, 'catalog.sqlite')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('resolves ingest_dataset("widgets") to an approved pin stored under a different slug', () => {
  const store = new MetadataStore(catalogPath)
  try {
    const created = store.createWorkspaceSourcePin({
      slug: 'someone/widgets',
      sourceVersion: '1',
      recipe: genericRecipe(),
      actorId: 'analyst-session',
    })
    store.setWorkspaceSourcePinStatus(
      created.pinId,
      'approved',
      store.getWorkspaceSourcePin(created.pinId)?.revision ?? 1,
    )
  } finally {
    store.close()
  }

  // Calling ingest_dataset with the bare dataset id (not the slug it was
  // stored under) must still resolve the approved pin.
  const pin = resolveIngestPin(catalogPath, 'widgets')
  expect(pin.slug).toBe('someone/widgets')
  expect(pin.recipe.datasetId).toBe('widgets')
})

it('still fails closed for an unapproved dataset id', () => {
  expect(() => resolveIngestPin(catalogPath, 'widgets')).toThrow(UnsupportedSourceError)
})
