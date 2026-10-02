/**
 * Bounded automatic chart-refinement mapping. Maps layout validator issue
 * codes to a single, safe, deterministic `ChartIntent` template change —
 * never raw Vega, never a second query, never a loop. `createChartArtifact`
 * (`chart-service.ts`) calls this at most once per render: if it returns a
 * change, the caller recompiles/re-renders once with the same authorized
 * rows and keeps whichever result actually validates better.
 *
 * This module never mutates diagnostics or writes anything — it only
 * proposes a candidate intent. The caller (`chart-service.ts`) is solely
 * responsible for deciding whether the retry was actually kept.
 */
import type { ChartIntent, ChartLayoutDiagnostic } from 'dsh-data-core/contracts'

export interface ChartRefinementProposal {
  intent: ChartIntent
  /** Human-readable description of each template change tried, in order. */
  changes: string[]
  /**
   * The proposal discards a display choice the caller stated outright (today:
   * an explicit `format.orientation: 'vertical'`), rather than only filling in
   * something they left to the service.
   *
   * Every other refinement adjusts a default. This one reverses an instruction,
   * so when the retry is kept the analyst asked for one chart and received
   * another — the kind of substitution that has to be said out loud rather than
   * left in a change log the analyst never sees.
   */
  overrodeRequestedFormat?: true
}

/**
 * Propose one bounded, deterministic template change addressing the given
 * diagnostics, or `undefined` when no safe change maps to any of them (the
 * caller then reports the diagnostics as an unresolved, precise failure
 * rather than guessing further). Multiple independent fixes may be combined
 * in the single proposed intent (e.g. dropping a facet-column override *and*
 * moving the legend) since they are applied and validated together as one
 * retry, not as separate attempts.
 */
export function proposeChartRefinement(
  intent: ChartIntent,
  diagnostics: readonly ChartLayoutDiagnostic[],
): ChartRefinementProposal | undefined {
  const codes = new Set(diagnostics.map((diagnostic) => diagnostic.code))
  let next: ChartIntent = intent
  const changes: string[] = []
  let overrodeRequestedFormat = false

  // excessive-output-bounds: an explicit facetColumns override can force a
  // wider grid than the delivery width supports. Drop the override and let
  // computeFacetLayout (chart.ts) choose a column count that actually fits.
  if (codes.has('excessive-output-bounds') && next.facet && next.facetColumns !== undefined) {
    const { facetColumns: _facetColumns, ...withoutOverride } = next
    next = withoutOverride
    changes.push(
      'Removed the explicit facetColumns override so facet layout recomputes columns from the delivery width.',
    )
  }

  // oversized-axis-title / text-collision / label-out-of-bounds on a bar
  // chart: flip to horizontal orientation so long labels land on the axis
  // that has room for them, instead of rotating into the plot or
  // overflowing the canvas. Only ever flips *toward* horizontal — flipping
  // an already-horizontal chart back to vertical would reintroduce exactly
  // the label-pressure problem this fix exists to relieve, so there is
  // nothing safe left to try for that case.
  if (
    (codes.has('oversized-axis-title') ||
      codes.has('text-collision') ||
      codes.has('label-out-of-bounds')) &&
    next.mark === 'bar' &&
    next.format?.orientation !== 'horizontal'
  ) {
    next = { ...next, format: { ...next.format, orientation: 'horizontal' } }
    changes.push('Flipped bar orientation to horizontal to relieve axis-label pressure.')
  }

  // excessive-output-bounds: an explicitly vertical bar chart with long
  // categorical labels rotates those labels into a deep axis band, and Vega-Lite
  // then grows the canvas around them until the layout validator rejects the
  // result as excessive blank space. Both stacked-bar artifacts from the live
  // WebUI pass hit this (art_a2ef823d23434c06 with a bottom legend and
  // art_c643a0bf26a04182 with a right one: 10 attack categories x 2 splits,
  // explicit vertical). The deterministic chart-choice policy already prefers
  // horizontal for long labels for exactly this reason, so drop the explicit
  // override and let that orientation apply. Flipping an already-horizontal chart
  // is never proposed (there is nothing to relieve), and the caller keeps the
  // original whenever the refined render does not validate better.
  if (
    codes.has('excessive-output-bounds') &&
    next.mark === 'bar' &&
    next.format?.orientation === 'vertical'
  ) {
    next = { ...next, format: { ...next.format, orientation: 'horizontal' } }
    overrodeRequestedFormat = true
    changes.push(
      'Requested vertical orientation was not used: flipped this bar to horizontal because the rotated category labels grew the canvas past its bounds. Shorten the category labels or narrow the delivery profile to keep it vertical.',
    )
  }

  // blank-legend-label: a dense legend rendered where it has no room for
  // full labels. Move it below the plot, where Vega-Lite gives it the full
  // chart width instead of a narrow side column.
  if (codes.has('blank-legend-label') && next.format?.legend !== 'bottom') {
    next = { ...next, format: { ...next.format, legend: 'bottom' } }
    changes.push('Moved the legend to bottom placement to give entries more room.')
  }

  if (changes.length === 0) return undefined
  return { intent: next, changes, ...(overrodeRequestedFormat ? { overrodeRequestedFormat } : {}) }
}
