/**
 * Fixture / test source pins (Superstore, Olist, Online Retail, mini fixtures).
 * Product resolve does **not** use this module — see
 * `./workspace-registry.js` (`resolveSourcePin` = approved workspace only).
 * Keep `resolveReviewedSource` for CI seeds and held-out fixture scripts.
 */
import { OLIST_RECIPE } from './olist.js'
import { OLIST_MINI_RECIPE } from './olist-mini.js'
import { ONLINE_RETAIL_RECIPE } from './online-retail.js'
import { RETAIL_FIXTURE_RECIPE } from './retail-fixture.js'
import { SUPERSTORE_RECIPE } from './superstore.js'
import type { IngestRecipe } from './types.js'

export class UnsupportedSourceError extends Error {
  readonly code = 'UNSUPPORTED_SOURCE' as const
  readonly slug: string

  constructor(slug: string, reason: string) {
    super(reason)
    this.name = 'UnsupportedSourceError'
    this.slug = slug
  }
}

export interface ReviewedSourcePin {
  slug: string
  sourceVersion: string
  recipe: IngestRecipe
  /** When false, ingest uses a local archive (tests / operator --archive). */
  requiresDownload: boolean
}

const PINS: readonly ReviewedSourcePin[] = [
  {
    slug: 'vivek468/superstore-dataset-final',
    sourceVersion: '1',
    recipe: SUPERSTORE_RECIPE,
    requiresDownload: true,
  },
  {
    slug: 'mashlyn/online-retail-ii-uci',
    sourceVersion: '1',
    recipe: ONLINE_RETAIL_RECIPE,
    requiresDownload: true,
  },
  {
    slug: 'olistbr/brazilian-ecommerce',
    sourceVersion: '7',
    recipe: OLIST_RECIPE,
    requiresDownload: true,
  },
  {
    slug: 'test/fixture-retail',
    sourceVersion: '1',
    recipe: RETAIL_FIXTURE_RECIPE,
    requiresDownload: false,
  },
  {
    slug: 'test/olist-mini',
    sourceVersion: '1',
    recipe: OLIST_MINI_RECIPE,
    requiresDownload: false,
  },
]

const BY_SLUG = new Map(PINS.map((pin) => [pin.slug.toLowerCase(), pin]))
const BY_DATASET_ID = new Map(PINS.map((pin) => [pin.recipe.datasetId.toLowerCase(), pin]))

/**
 * @deprecated Product path no longer reserves Core dataset ids. Kept for
 * transitional callers/tests; always returns false.
 */
export function isReservedDatasetId(_datasetId: string): boolean {
  return false
}

export function listReviewedSourcePins(): readonly ReviewedSourcePin[] {
  return PINS
}

export function normalizeSourceSlug(raw: string): string {
  return raw.trim().replace(/^https?:\/\/(www\.)?kaggle\.com\/datasets\//i, '')
}

/**
 * Resolve a fixture Kaggle owner/slug (or dataset id) to a pinned recipe.
 * For tests and operator seed scripts only — not product ingest resolve.
 * Throws {@link UnsupportedSourceError} for unknown/malformed sources.
 */
export function resolveReviewedSource(slugOrDatasetId: string): ReviewedSourcePin {
  const trimmed = normalizeSourceSlug(slugOrDatasetId)
  if (!trimmed) {
    throw new UnsupportedSourceError(slugOrDatasetId, 'Source slug is required')
  }
  const key = trimmed.toLowerCase()
  const pin = BY_SLUG.get(key) ?? BY_DATASET_ID.get(key)
  if (!pin) {
    throw new UnsupportedSourceError(
      trimmed,
      `Unsupported fixture source "${trimmed}". Fixture recipes: ${PINS.map((entry) => entry.slug).join(', ')}.`,
    )
  }
  return pin
}
