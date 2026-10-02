/**
 * Analyst-approved workspace source pins. Product resolve uses **only**
 * approved workspace rows — there is no in-code Core recipe privilege.
 * Candidate and revoked pins never let `ingest_dataset` publish.
 * Fixture recipes in `./registry.js` remain for tests/operator seeds only.
 */
import { normalizeSourceSlug, UnsupportedSourceError } from './registry.js'
import type { ReviewedSourcePin } from './registry.js'
import type { IngestRecipe } from './types.js'

export type WorkspaceSourcePinStatus = 'candidate' | 'approved' | 'revoked'

export interface WorkspaceSourcePin {
  pinId: string
  revision: number
  slug: string
  sourceVersion: string
  recipe: IngestRecipe
  status: WorkspaceSourcePinStatus
  /** Populated from authenticated context, never trusted from model arguments. */
  actorId: string
  createdAt: string
  reviewedAt: string | null
}

/**
 * Resolve a Kaggle owner/slug (or dataset id) to an approved workspace pin.
 * Throws {@link UnsupportedSourceError} when no approved pin matches —
 * including former Core slugs — so callers must preview and get analyst
 * approval first.
 */
export function resolveSourcePin(
  slugOrDatasetId: string,
  workspacePins: readonly WorkspaceSourcePin[],
): ReviewedSourcePin {
  const trimmed = normalizeSourceSlug(slugOrDatasetId)
  if (!trimmed) {
    throw new UnsupportedSourceError(slugOrDatasetId, 'Source slug is required')
  }
  const key = trimmed.toLowerCase()
  let approved: WorkspaceSourcePin | undefined
  for (const pin of workspacePins) {
    if (pin.status !== 'approved') continue
    if (pin.slug.toLowerCase() !== key && pin.recipe.datasetId.toLowerCase() !== key) continue
    // Later entries win when more than one approved pin matches (assumes
    // callers order pins oldest-first, matching MetadataStore's created_at
    // ASC listing) so the most recently approved recipe is used.
    approved = pin
  }
  if (!approved) {
    throw new UnsupportedSourceError(
      trimmed,
      `No analyst-approved workspace pin for "${trimmed}". Call preview_ingest_source and get analyst approval first.`,
    )
  }
  return {
    slug: approved.slug,
    sourceVersion: approved.sourceVersion,
    recipe: approved.recipe,
    requiresDownload: true,
  }
}
