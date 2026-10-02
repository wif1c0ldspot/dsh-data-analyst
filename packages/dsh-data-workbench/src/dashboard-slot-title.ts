import type { AnalysisRevision, DashboardSlot } from 'dsh-data-core/contracts'

/**
 * Resolve the title shown for a persisted dashboard card.
 *
 * Older tool pins stored the full analysis question as the slot title. That
 * exact equality is the only safe signal that the title is the legacy default;
 * every other stored slot title may be an analyst edit and stays authoritative.
 */
export function dashboardSlotTitle(
  slot: Pick<DashboardSlot, 'title'>,
  analysis: Pick<AnalysisRevision, 'question' | 'chart'> | undefined,
): string {
  if (!analysis) return slot.title
  return slot.title === analysis.question ? analysis.chart.title : slot.title
}
