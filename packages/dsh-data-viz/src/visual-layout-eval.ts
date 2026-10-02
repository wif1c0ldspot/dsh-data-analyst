/**
 * Live visual QA release gate. The existing chart gate
 * (`packages/dsh-data-duckdb/src/nl-eval.ts`'s `runChartAppropriatenessEval`)
 * only compares a compiled `ChartIntent` against a reviewed reference in
 * SQL-execution mode — it never renders an SVG or inspects layout. This
 * module renders each case through the same `compileChartIntent` /
 * `renderChartSvg` path production chart creation uses, runs the layout
 * validator's `validateChartLayoutSvg` against the result, and reports that
 * visual-layout score *separately* from whatever chart-choice grade the
 * caller supplies — never conflating the two into one pass/fail.
 *
 * This module never opens a live model or a booted Studio harness itself.
 * When neither is available (the common case — see the `openInStudio` doc
 * below), every case is honestly reported as
 * `checkedVia: 'deterministic-validator'`, `openedInStudio: false`, and the
 * report's `model`/`harnessLockVersion` are `null`. A caller with live
 * access supplies `openInStudio` to populate the live fields for real; see
 * `scripts/run-visual-layout-eval.mjs` for the documented live entry point.
 */
import type { ChartIntent } from 'dsh-data-core/contracts'
import {
  VisualLayoutQaCaseResultSchema,
  VisualLayoutQaReportSchema,
  type VisualLayoutQaCaseResult,
  type VisualLayoutQaReport,
} from 'dsh-data-core/contracts'
import { compileChartIntent, renderChartSvg, type ChartRow } from './chart.js'
import { validateChartLayoutSvg } from './chart-layout-validator.js'

/**
 * Issue codes this gate treats as release-blocking collision/clipping
 * defects: overlapping text (`text-collision`), a label extending past the
 * view box (`label-out-of-bounds`), and content that no longer fits its
 * canvas at all (`excessive-output-bounds`) — the failure mode the
 * refinement path's own forced-bad-layout fixture reproduces.
 * `duplicate-shared-title`, `oversized-axis-title` and `blank-legend-label`
 * are real defects but are not, on their own, a collision or a clip, so they
 * are not release-blocking here.
 */
const P0_LAYOUT_ISSUE_CODES: ReadonlySet<string> = new Set([
  'text-collision',
  'label-out-of-bounds',
  'excessive-output-bounds',
])

export interface VisualLayoutEvalCase {
  /** Stable id for this case, e.g. 'food-ordering-faceted-x-axis-overlap'. */
  caseId: string
  /**
   * Which known failure shape this case exercises — free text naming the
   * archetype, not an enum, so new archetypes don't require a contract
   * change. The plan's acceptance bar is "at least three dataset archetypes
   * with long labels, facets, and multi-series charts"; tag accordingly.
   */
  archetype: string
  datasetId?: string
  rows: ChartRow[]
  intent: ChartIntent
  /** One or more delivery widths (px) to render and validate at. */
  deliveryWidthsPx: readonly number[]
  /**
   * Chart-choice correctness for this case, precomputed by the caller (e.g.
   * from `runChartAppropriatenessEval`/`gradeChartIntent` in
   * `dsh-data-duckdb`). Omit when this case has no chart-choice reference to
   * grade against — the report then honestly records `scored: false` rather
   * than inferring a pass.
   */
  chartChoice?: { ok: boolean }
}

export interface VisualLayoutEvalOptions {
  /** Model id that produced the graded chart choices, or omit/null for a reference/deterministic-only run. */
  model?: string | null
  /** Pinned harness/Studio build id a live run used, or omit/null when no booted harness is available. */
  harnessLockVersion?: string | null
  /**
   * Live hook: open a rendered chart SVG in the pinned harness/Studio seam
   * and report whether it actually opened, plus the artifact id it opened
   * under. Omit this in an environment with no booted dsh/Studio harness —
   * every case then falls back to the deterministic-validator-only path
   * (`openedInStudio: false`), which is the only path this module can run
   * without a live browser.
   */
  openInStudio?: (input: {
    caseId: string
    svg: string
    deliveryWidthPx: number
  }) => Promise<{ opened: boolean; artifactId: string | null }>
}

/**
 * Render each case at each of its delivery widths, validate layout, and
 * (only if `options.openInStudio` is supplied) attempt a live Studio open.
 * Returns the typed `VisualLayoutQaReport` — parsed through its own Zod
 * schema so a caller can never receive a shape that doesn't match the
 * contract this gate promises.
 */
export async function runVisualLayoutEval(
  cases: readonly VisualLayoutEvalCase[],
  options: VisualLayoutEvalOptions = {},
): Promise<VisualLayoutQaReport> {
  const model = options.model ?? null
  const harnessLockVersion = options.harnessLockVersion ?? null
  const results: VisualLayoutQaCaseResult[] = []
  const viewportWidths = new Set<number>()

  for (const testCase of cases) {
    for (const deliveryWidthPx of testCase.deliveryWidthsPx) {
      viewportWidths.add(deliveryWidthPx)
      const spec = compileChartIntent(testCase.intent, testCase.rows, { deliveryWidthPx })
      const svg = await renderChartSvg(spec)
      const visualLayout = validateChartLayoutSvg(svg)

      let openedInStudio = false
      let artifactId: string | null = null
      let checkedVia: VisualLayoutQaCaseResult['checkedVia'] = 'deterministic-validator'
      if (options.openInStudio) {
        const opened = await options.openInStudio({ caseId: testCase.caseId, svg, deliveryWidthPx })
        openedInStudio = opened.opened
        artifactId = opened.artifactId
        checkedVia = opened.opened ? 'studio-live-open' : 'deterministic-validator'
      }

      const result: VisualLayoutQaCaseResult = {
        caseId: testCase.caseId,
        archetype: testCase.archetype,
        datasetId: testCase.datasetId ?? null,
        deliveryWidthPx,
        artifactId,
        chartChoice: {
          scored: testCase.chartChoice !== undefined,
          ok: testCase.chartChoice?.ok ?? null,
        },
        visualLayout,
        openedInStudio,
        checkedVia,
      }
      results.push(VisualLayoutQaCaseResultSchema.parse(result))
    }
  }

  const scoredChartChoice = results.filter((result) => result.chartChoice.scored)
  const chartChoicePassRate =
    scoredChartChoice.length === 0
      ? null
      : scoredChartChoice.filter((result) => result.chartChoice.ok).length /
        scoredChartChoice.length
  const visualLayoutPassRate =
    results.length === 0
      ? 0
      : results.filter((result) => result.visualLayout.ok).length / results.length
  const zeroP0LayoutDefects = results.every(
    (result) => !result.visualLayout.diagnostics.some((d) => P0_LAYOUT_ISSUE_CODES.has(d.code)),
  )

  const report: VisualLayoutQaReport = {
    generatedAt: new Date().toISOString(),
    model,
    harnessLockVersion,
    viewportWidths: [...viewportWidths].sort((a, b) => a - b),
    cases: results,
    summary: {
      chartChoicePassRate,
      visualLayoutPassRate,
      zeroP0LayoutDefects,
      anyOpenedInStudio: results.some((result) => result.openedInStudio),
    },
  }
  return VisualLayoutQaReportSchema.parse(report)
}
