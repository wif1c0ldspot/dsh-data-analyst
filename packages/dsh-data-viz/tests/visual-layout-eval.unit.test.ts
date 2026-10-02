/**
 * Live visual QA release gate. This is the "maximally
 * useful achievable" run in an environment with no live
 * model and no booted dsh/Studio harness: it exercises
 * `runVisualLayoutEval` against three reproduction archetypes
 * (facets, an oversized long axis title, and a multi-series legend with
 * long rotated-candidate labels — together covering at least
 * three dataset archetypes with long labels, facets, and multi-series
 * charts) at both documented delivery widths, and asserts the actual
 * results recorded by the deterministic-validator-only path. No
 * `openInStudio` hook is supplied, so every case is honestly reported as
 * `checkedVia: 'deterministic-validator'` / `openedInStudio: false`, and
 * `model`/`harnessLockVersion` are `null` — this test does not, and cannot,
 * simulate a live model or a live Studio open.
 */
import { describe, expect, it } from 'vitest'
import {
  buildFacetedXAxisOverlapIntent,
  buildOversizedYAxisIntent,
  buildRotatedLabelLegendIntent,
  foodOrderingLayoutStressRows,
} from './fixtures/food-ordering-layout-stress.js'
import type { ChartRow } from '../src/chart.js'
import { runVisualLayoutEval, type VisualLayoutEvalCase } from '../src/visual-layout-eval.js'

const DELIVERY_WIDTHS_PX = [450, 710]

function buildCases(): VisualLayoutEvalCase[] {
  const rows = foodOrderingLayoutStressRows()
  return [
    {
      caseId: 'food-ordering-faceted-x-axis-overlap',
      archetype: 'facets',
      datasetId: 'food-ordering-synthetic',
      rows,
      intent: buildFacetedXAxisOverlapIntent(),
      deliveryWidthsPx: DELIVERY_WIDTHS_PX,
      chartChoice: { ok: true },
    },
    {
      caseId: 'food-ordering-oversized-y-axis',
      archetype: 'long-labels',
      datasetId: 'food-ordering-synthetic',
      rows,
      intent: buildOversizedYAxisIntent(),
      deliveryWidthsPx: DELIVERY_WIDTHS_PX,
      chartChoice: { ok: true },
    },
    {
      caseId: 'food-ordering-rotated-label-legend',
      archetype: 'multi-series-legend',
      datasetId: 'food-ordering-synthetic',
      rows,
      intent: buildRotatedLabelLegendIntent(),
      deliveryWidthsPx: DELIVERY_WIDTHS_PX,
      chartChoice: { ok: true },
    },
  ]
}

describe('runVisualLayoutEval / deterministic-validator-only path', () => {
  it('reports chart-choice and visual-layout scores separately, honestly recording no live run', async () => {
    const report = await runVisualLayoutEval(buildCases())

    // Three archetypes x two delivery widths.
    expect(report.cases).toHaveLength(6)
    expect(new Set(report.cases.map((c) => c.archetype))).toEqual(
      new Set(['facets', 'long-labels', 'multi-series-legend']),
    )
    expect(report.viewportWidths).toEqual([450, 710])

    // No live model/harness was used in this environment.
    expect(report.model).toBeNull()
    expect(report.harnessLockVersion).toBeNull()
    expect(report.summary.anyOpenedInStudio).toBe(false)
    for (const caseResult of report.cases) {
      expect(caseResult.openedInStudio).toBe(false)
      expect(caseResult.checkedVia).toBe('deterministic-validator')
      expect(caseResult.artifactId).toBeNull()
    }

    // Chart-choice and visual-layout are reported as two independent scores.
    expect(report.summary.chartChoicePassRate).toBe(1)
    expect(report.cases.every((c) => c.chartChoice.scored)).toBe(true)

    // All three reproduction shapes are already fixed, so the achievable
    // deterministic path records a clean visual-layout result today.
    expect(report.summary.visualLayoutPassRate).toBe(1)
    expect(report.summary.zeroP0LayoutDefects).toBe(true)
    for (const caseResult of report.cases) {
      expect(caseResult.visualLayout.ok).toBe(true)
      expect(caseResult.visualLayout.diagnostics).toEqual([])
    }
  })

  it('honestly reports scored: false for a case with no chart-choice reference', async () => {
    const [unscoredCase] = buildCases()
    delete (unscoredCase as { chartChoice?: unknown }).chartChoice
    const report = await runVisualLayoutEval([{ ...unscoredCase, deliveryWidthsPx: [450] }])

    expect(report.cases[0]!.chartChoice).toEqual({ scored: false, ok: null })
    expect(report.summary.chartChoicePassRate).toBeNull()
  })

  it('flags a known-bad unfixed shape distinctly from chart-choice correctness', async () => {
    // 8 distinct facet groups x 4 regions with an explicit facetColumns: 6
    // override — the same forced-bad-layout shape
    // `chart-service-refinement.integration.test.ts` uses to prove
    // `createChartArtifact`'s first (pre-retry) render genuinely fails
    // layout validation. This module renders directly via
    // `compileChartIntent`/`renderChartSvg` with no refinement retry,
    // so the raw failure is exactly what this test asserts. Chart choice is
    // graded as correct even though layout fails, proving the two scores
    // are independent.
    const rows: ChartRow[] = []
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 4; j++) {
        rows.push({ region: `Region ${j}`, group: `Group ${i}`, value: (i * 7 + j * 3) % 50 })
      }
    }
    const report = await runVisualLayoutEval([
      {
        caseId: 'synthetic-forced-narrow-facet-override',
        archetype: 'facets',
        rows,
        intent: {
          mark: 'bar',
          title: 'Value by region, faceted by group',
          x: 'region',
          y: 'value',
          facet: 'group',
          facetColumns: 6,
        },
        deliveryWidthsPx: [480],
        chartChoice: { ok: true },
      },
    ])

    expect(report.cases[0]!.chartChoice).toEqual({ scored: true, ok: true })
    expect(report.cases[0]!.visualLayout.ok).toBe(false)
    expect(report.summary.chartChoicePassRate).toBe(1)
    expect(report.summary.visualLayoutPassRate).toBe(0)
    expect(report.summary.zeroP0LayoutDefects).toBe(false)
  })
})
