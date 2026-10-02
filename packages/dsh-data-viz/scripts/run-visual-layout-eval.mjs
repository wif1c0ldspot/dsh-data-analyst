#!/usr/bin/env node
/**
 * Live visual QA release gate.
 *
 * Default (no extra env): runs the deterministic-validator-only path — the
 * same rendering/validation pipeline production chart creation uses, with
 * NO live model and NO booted dsh/Studio harness. Every case in the report
 * is honestly recorded as `checkedVia: 'deterministic-validator'`,
 * `openedInStudio: false`, and `model`/`harnessLockVersion` are `null`. This
 * mode proves the machinery works and gives a real (if partial) result; it
 * is NOT the live release gate ("≥90% appropriate charts and zero
 * collision/clipping defects in the named delivery suite" as an actual
 * release-gate result requires a live model and a live Studio open).
 *
 * Live mode — set DSH_VISUAL_QA_LIVE=1 plus DSH_VISUAL_QA_STUDIO_HOOK
 * pointing at a JS module (absolute path or bare specifier resolvable from
 * this script) whose default export is:
 *
 *   async function openInStudio({ caseId, svg, deliveryWidthPx }) {
 *     // 1. Boot/attach to a pinned dsh profile with a live browser
 *     //    (see the internal verification record's "Reproduce and report" section for
 *     //    the DSH_HOME/DSH_DATA_WORKSPACE/DEEPSEEK_API_KEY setup this
 *     //    needs).
 *     // 2. Actually open the rendered chart (or the equivalent saved
 *     //    analysis artifact) in the pinned Studio seam at deliveryWidthPx.
 *     // 3. Return { opened: true, artifactId } only once that open was
 *     //    observed to succeed — never optimistically.
 *     return { opened: false, artifactId: null }
 *   }
 *
 * This script cannot supply that hook itself: it has no booted harness, no
 * browser, and no DEEPSEEK_API_KEY/DSH_NL_API_KEY in this environment (see
 * the internal verification record's "Reproduce and report" section). A human with live access
 * implements the hook and re-runs this script to close the live gate.
 *
 * Additional env:
 * - DSH_VISUAL_QA_MODEL: model id to record in the report (live mode only;
 *   ignored/recorded as null otherwise).
 * - DSH_VISUAL_QA_HARNESS_LOCK: pinned harness/Studio build id to record.
 * - DSH_VISUAL_QA_REPORT: file path to also write the JSON report to.
 */
import { writeFileSync } from 'node:fs'
import { runVisualLayoutEval } from '../dist/visual-layout-eval.js'

/**
 * Mirrors `packages/dsh-data-viz/tests/fixtures/food-ordering-layout-stress.ts`.
 * Kept as a small inline duplicate here — rather than an import —
 * because this script runs against built `dist/` output and test fixtures
 * are not part of the published package; keep the two in sync if either
 * changes. Together the three cases below cover at least
 * three dataset archetypes with long labels, facets, and multi-series
 * charts.
 */
const POPULATION_FACET_VALUES = ['Married', 'Single']
const OCCUPATION_LABELS = ['Student', 'Employee', 'Self Employeed']
const INCOME_BAND_LABELS = [
  'No Income',
  'Below Rs.10000',
  '10001 to 25000',
  '25001 to 50000',
  'More than 50000',
]

function foodOrderingLayoutStressRows() {
  const rows = []
  let seed = 1
  for (const population of POPULATION_FACET_VALUES) {
    for (const occupation of OCCUPATION_LABELS) {
      for (const incomeBand of INCOME_BAND_LABELS) {
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

const DELIVERY_WIDTHS_PX = [450, 710]

function buildCases() {
  const rows = foodOrderingLayoutStressRows()
  return [
    {
      caseId: 'food-ordering-faceted-x-axis-overlap',
      archetype: 'facets',
      datasetId: 'food-ordering-synthetic',
      rows,
      intent: {
        mark: 'bar',
        title: 'Orders by occupation and population',
        x: 'occupation',
        y: 'order_count',
        facet: 'population',
        facetColumns: 2,
        xLabel: 'Customer occupation (self-reported)',
      },
      deliveryWidthsPx: DELIVERY_WIDTHS_PX,
      chartChoice: { ok: true },
    },
    {
      caseId: 'food-ordering-oversized-y-axis',
      archetype: 'long-labels',
      datasetId: 'food-ordering-synthetic',
      rows,
      intent: {
        mark: 'bar',
        title: 'Order volume by income band and population',
        x: 'income_band',
        y: 'order_count',
        facet: 'population',
        yLabel: 'Total number of orders placed across the observed data collection period',
      },
      deliveryWidthsPx: DELIVERY_WIDTHS_PX,
      chartChoice: { ok: true },
    },
    {
      caseId: 'food-ordering-rotated-label-legend',
      archetype: 'multi-series-legend',
      datasetId: 'food-ordering-synthetic',
      rows,
      intent: {
        mark: 'bar',
        title: 'Orders by occupation, split by income band',
        x: 'occupation',
        y: 'order_count',
        series: 'income_band',
        xLabel: 'Customer occupation (self-reported)',
      },
      deliveryWidthsPx: DELIVERY_WIDTHS_PX,
      chartChoice: { ok: true },
    },
  ]
}

const live = process.env.DSH_VISUAL_QA_LIVE === '1'
let openInStudio
if (live) {
  const hookPath = process.env.DSH_VISUAL_QA_STUDIO_HOOK
  if (!hookPath) {
    console.error(
      'DSH_VISUAL_QA_LIVE=1 requires DSH_VISUAL_QA_STUDIO_HOOK pointing at a module ' +
        "exporting an openInStudio(...) hook — see this script's header comment.",
    )
    process.exit(2)
  }
  const hookModule = await import(hookPath)
  openInStudio = hookModule.default ?? hookModule.openInStudio
  if (typeof openInStudio !== 'function') {
    console.error(`${hookPath} must export a default (or named openInStudio) function`)
    process.exit(2)
  }
}

const report = await runVisualLayoutEval(buildCases(), {
  model: live ? (process.env.DSH_VISUAL_QA_MODEL ?? null) : null,
  harnessLockVersion: live ? (process.env.DSH_VISUAL_QA_HARNESS_LOCK ?? null) : null,
  ...(openInStudio ? { openInStudio } : {}),
})

console.log(JSON.stringify(report, null, 2))
if (process.env.DSH_VISUAL_QA_REPORT) {
  writeFileSync(process.env.DSH_VISUAL_QA_REPORT, JSON.stringify(report, null, 2))
}

if (!live) {
  console.error(
    '\nNOTE: this was the deterministic-validator-only path (no live model, no booted ' +
      'Studio harness). It is not the live release gate the plan requires — rerun with ' +
      'DSH_VISUAL_QA_LIVE=1 and a real DSH_VISUAL_QA_STUDIO_HOOK to close that gate.',
  )
}

const liveGatePassed =
  live && report.summary.zeroP0LayoutDefects && report.summary.visualLayoutPassRate >= 0.9
process.exit(live ? (liveGatePassed ? 0 : 1) : report.summary.zeroP0LayoutDefects ? 0 : 1)
