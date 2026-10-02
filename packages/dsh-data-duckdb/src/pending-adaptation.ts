/**
 * Pending adaptive publish after materiality confirm (raw_then_typed).
 * Written when ingest pauses at needs-input; confirmed via same-origin POST.
 */
import type { DatasetManifest } from 'dsh-data-core/contracts'
import type { MaterialityDecision } from './materiality.js'

export const PENDING_ADAPTATION_FILENAME = 'pending-adaptation.json'

export interface PendingAdaptationPublish {
  contractVersion: 1
  jobId: string
  datasetId: string
  datasetVersionId: string
  slug: string
  sourceVersion: string
  recipeHash: string
  importerVersion: string
  sourceUrl: string
  license: string | null
  tables: DatasetManifest['tables']
  files: DatasetManifest['files']
  materiality: MaterialityDecision
  /** Absolute path to closed staging.duckdb at pause time. */
  stagingPath: string
  /** Absolute path where dataset.duckdb will be published. */
  datasetPath: string
  /** Dataset workspace dir (contains staging/ and datasets/). */
  workspaceDir: string
  createdAt: string
}
