/**
 * Synthetic, credential-free fixture reproducing the layout-stress shape from
 * the online-food-ordering analyst walkthrough. No Kaggle rows and no
 * generated SVG artifacts are checked in —
 * this file only builds synthetic tabular rows plus `ChartIntent` inputs that
 * exercise the same combination of facets, long categorical labels and a
 * multi-series legend that produced the three reproduced SVGs:
 *
 *   - `art_9dd789f676df4f1e`: repeated faceted X-axis titles overlap at the
 *     bottom of the grid.
 *   - `art_17de88137e3e481e`: repeated titles overlap and a long Y-axis title
 *     consumes disproportionate space.
 *   - `art_a7247eaaa21a4c41`: rotated occupation labels enter the plot, the
 *     legend text is unreadable, and the fixed canvas leaves excessive blank
 *     space.
 *
 * Deterministic post-render layout validation, facet layout
 * policy, and categorical label/legend handling each exercise their
 * fixes against `buildFacetedXAxisOverlapIntent`, `buildOversizedYAxisIntent`
 * and `buildRotatedLabelLegendIntent` respectively, each paired with
 * `foodOrderingLayoutStressRows`.
 */
import type { ChartIntent, ChartRow } from '../../src/chart.js'

/** Two population facet values, matching the walkthrough's faceted-by-population shape. */
export const POPULATION_FACET_VALUES = ['Married', 'Single'] as const

/**
 * Three occupation category labels, one of them long — mirroring the
 * walkthrough evidence verbatim ("Self Employeed", including the analyst dataset's original
 * misspelling, kept intentionally so the fixture matches the real failure
 * shape rather than a cleaned-up label).
 */
export const OCCUPATION_LABELS = ['Student', 'Employee', 'Self Employeed'] as const

/**
 * Several income-band series values with long, punctuation-heavy labels —
 * the kind of legend text that renders unreadable at a narrow sidebar width.
 */
export const INCOME_BAND_LABELS = [
  'No Income',
  'Below Rs.10000',
  '10001 to 25000',
  '25001 to 50000',
  'More than 50000',
] as const

/**
 * Synthetic order-count rows crossing population x occupation x income band.
 * Deterministic (no RNG) so tests can assert exact geometry/collision
 * outcomes. Values are plain small integers, never Kaggle rows.
 */
export function foodOrderingLayoutStressRows(): ChartRow[] {
  const rows: ChartRow[] = []
  let seed = 1
  for (const population of POPULATION_FACET_VALUES) {
    for (const occupation of OCCUPATION_LABELS) {
      for (const incomeBand of INCOME_BAND_LABELS) {
        // Simple deterministic spread: no two cells share a value, without
        // needing an RNG dependency.
        seed += 1
        rows.push({
          population,
          occupation,
          income_band: incomeBand,
          order_count: (seed * 7) % 97,
        })
      }
    }
  }
  return rows
}

/**
 * Reproduces `art_9dd789f676df4f1e`: two population facets over a long
 * categorical (occupation) x-axis, so each facet panel repeats its own copy
 * of the x-axis title and the titles collide at the bottom of the grid at
 * narrow/medium delivery widths.
 */
export function buildFacetedXAxisOverlapIntent(): ChartIntent {
  return {
    mark: 'bar',
    title: 'Orders by occupation and population',
    x: 'occupation',
    y: 'order_count',
    facet: 'population',
    facetColumns: 2,
    xLabel: 'Customer occupation (self-reported)',
  }
}

/**
 * Reproduces `art_17de88137e3e481e`: faceted repeated titles plus a long
 * Y-axis title that consumes disproportionate horizontal space relative to
 * each 220x180 facet panel.
 */
export function buildOversizedYAxisIntent(): ChartIntent {
  return {
    mark: 'bar',
    title: 'Order volume by income band and population',
    x: 'income_band',
    y: 'order_count',
    facet: 'population',
    yLabel: 'Total number of orders placed across the observed data collection period',
  }
}

/**
 * Reproduces `art_a7247eaaa21a4c41`: a single-panel vertical grouped bar
 * chart with long occupation category labels (rotated into the plot by the
 * current renderer) and a dense multi-series income-band legend (rendered
 * unreadable at delivery width), without a facet — so the fixed canvas also
 * leaves excess blank space relative to the three-category x-axis.
 */
export function buildRotatedLabelLegendIntent(): ChartIntent {
  return {
    mark: 'bar',
    title: 'Orders by occupation, split by income band',
    x: 'occupation',
    y: 'order_count',
    series: 'income_band',
    xLabel: 'Customer occupation (self-reported)',
  }
}
