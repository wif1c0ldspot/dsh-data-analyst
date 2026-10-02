/**
 * Carry or invalidate interpretation review across analysis revisions.
 * Style-only changes (same resultId + same narrative text) may retain approval.
 * Data/filter changes that alter resultId always invalidate.
 */
import type { AnalysisRevision } from 'dsh-data-core/contracts'

function narrativeKey(interpretation: AnalysisRevision['interpretation']): string {
  return JSON.stringify({
    findings: interpretation?.findings ?? [],
    caveats: interpretation?.caveats ?? [],
    nextSteps: interpretation?.nextSteps ?? [],
  })
}

export function isStyleOnlyRevisionCarry(
  previous: AnalysisRevision,
  next: Pick<AnalysisRevision, 'resultId' | 'interpretation'>,
): boolean {
  return (
    previous.resultId === next.resultId &&
    narrativeKey(previous.interpretation) === narrativeKey(next.interpretation)
  )
}

export function carryInterpretationReview(
  previous: AnalysisRevision,
  next: Pick<AnalysisRevision, 'resultId' | 'interpretation'>,
): AnalysisRevision['interpretationReview'] | undefined {
  const review = previous.interpretationReview
  if (!review || review.status === 'unreviewed') return undefined
  if (!isStyleOnlyRevisionCarry(previous, next)) return undefined
  if (review.resultId !== previous.resultId) return undefined
  return {
    status: review.status,
    resultId: next.resultId,
    reviewedAt: review.reviewedAt,
  }
}

export function interpretationApprovedForExport(analysis: AnalysisRevision): boolean {
  const review = analysis.interpretationReview
  return (
    review?.status === 'approved' &&
    review.resultId === analysis.resultId &&
    Boolean(analysis.interpretation?.findings?.length || analysis.interpretation?.caveats?.length)
  )
}
