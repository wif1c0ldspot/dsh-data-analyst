/**
 * Saved analyses via the MetadataStore SQLite coordinator (ADR 002).
 * Append-only revisions; catalog.sqlite is the source of truth.
 */
import { randomUUID } from 'node:crypto'
import type { AnalysisRevision, ChartIntent, QueryRequest } from './contracts.js'
import { withFilterCaption } from './dashboard-filters.js'
import { AnalysisNotFoundError, MetadataStore } from './metadata-store.js'

export interface SaveAnalysisInput {
  analysisId?: string
  /** When set, must equal the current max revision (optimistic concurrency). */
  expectedRevision?: number
  datasetVersionId: string
  semanticRevisionId: string
  question: string
  query: QueryRequest
  resultId: string
  chart: ChartIntent
  artifactIds: string[]
  /** Optional equality filter disclosed on the revision question/caption. */
  filter?: { column: string; value: string }
  interpretation?: AnalysisRevision['interpretation']
  interpretationReview?: AnalysisRevision['interpretationReview']
}

export async function saveAnalysisRevision(
  catalogPath: string,
  input: SaveAnalysisInput,
): Promise<AnalysisRevision> {
  const store = new MetadataStore(catalogPath)
  try {
    const analysisId = input.analysisId ?? `ana_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const question = withFilterCaption(input.question, input.filter)
    const draft: AnalysisRevision = {
      contractVersion: 1,
      analysisId,
      revision: 0,
      datasetVersionId: input.datasetVersionId,
      semanticRevisionId: input.semanticRevisionId,
      question,
      query: input.query,
      resultId: input.resultId,
      chart: input.chart,
      artifactIds: input.artifactIds,
      createdAt: new Date().toISOString(),
      ...(input.interpretation ? { interpretation: input.interpretation } : {}),
      ...(input.interpretationReview ? { interpretationReview: input.interpretationReview } : {}),
    }
    const saved = store.saveAnalysisRevision(draft, { expectedRevision: input.expectedRevision })
    // Persistence is a service-observed fact (the append-only
    // `analysis_revisions` insert above already succeeded), never an agent
    // narration — recorded here so every caller of `saveAnalysisRevision`
    // (save_analysis, dashboard shared-filter publish) gets the same trail
    // entry rather than each one re-deriving it.
    store.recordWorkflowMilestone({
      milestone: 'analysis_persisted',
      actor: 'service',
      datasetVersionId: saved.datasetVersionId,
      analysisId: saved.analysisId,
      receiptId: `${saved.analysisId}:${saved.revision}`,
    })
    return saved
  } finally {
    store.close()
  }
}

export async function loadAnalysisRevision(
  catalogPath: string,
  analysisId: string,
  revision?: number,
): Promise<AnalysisRevision> {
  const store = new MetadataStore(catalogPath)
  try {
    const loaded = store.loadAnalysisRevision(analysisId, revision)
    if (!loaded) throw new AnalysisNotFoundError(`Unknown analysis "${analysisId}"`)
    return loaded
  } finally {
    store.close()
  }
}

export async function listAnalysisRevisions(catalogPath: string): Promise<AnalysisRevision[]> {
  const store = new MetadataStore(catalogPath)
  try {
    return store.listAnalysisRevisions()
  } finally {
    store.close()
  }
}
