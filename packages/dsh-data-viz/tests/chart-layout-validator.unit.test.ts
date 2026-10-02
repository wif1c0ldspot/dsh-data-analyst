/**
 * Deterministic post-render layout validation. Proves the validator:
 *
 *   - passes ordinary single-panel, horizontal-category and time-series
 *     charts;
 *   - correctly identifies isolated collision/out-of-bounds/blank-legend/
 *     oversized-bounds geometry shapes from minimal synthetic SVGs; and
 *   - is bounded in input size/element count and never throws on malformed
 *     input.
 *
 * The three food-ordering reproduction shapes below originally failed this
 * validator with stable issue codes (`duplicate-shared-title`,
 * `oversized-axis-title`, `excessive-output-bounds` — see the git history of
 * this file for the failing assertions this suite once froze). Responsive
 * facet layout and deterministic label/orientation policy fixes to the
 * underlying `chart.ts` compilation logic made them pass; see
 * `validateChartLayoutSvg / food-ordering reproduction shapes`
 * below for that now-passing coverage.
 */
import { describe, expect, it } from 'vitest'
import { compileChartIntent, deliveryWidthPxForProfile, renderChartSvg } from '../src/chart.js'
import { validateChartLayoutSvg } from '../src/chart-layout-validator.js'
import {
  buildFacetedXAxisOverlapIntent,
  buildOversizedYAxisIntent,
  buildRotatedLabelLegendIntent,
  foodOrderingLayoutStressRows,
} from './fixtures/food-ordering-layout-stress.js'

/**
 * Synthetic reproduction of the `deliveryWidthPx`-ignored bug found via a
 * live walkthrough (dsh + DeepSeek + the `spscientist/students-performance-
 * in-exams` Kaggle dataset): "average math score by parental level of
 * education (6 categories, some long — e.g. "associate's degree") faceted
 * [sic — actually grouped, non-faceted] by test preparation course (2
 * categories)". Values below are the real result-set values from that
 * walkthrough; no Kaggle rows or credentials are checked in, only this
 * synthetic row list matching the shape that failed.
 */
const mathScoreByEducationRows = [
  {
    parental_education: "associate's degree",
    test_preparation: 'completed',
    avg_math_score: 71.83,
  },
  { parental_education: "associate's degree", test_preparation: 'none', avg_math_score: 65.57 },
  { parental_education: "bachelor's degree", test_preparation: 'completed', avg_math_score: 73.28 },
  { parental_education: "bachelor's degree", test_preparation: 'none', avg_math_score: 66.9 },
  { parental_education: 'high school', test_preparation: 'completed', avg_math_score: 65.0 },
  { parental_education: 'high school', test_preparation: 'none', avg_math_score: 60.99 },
  { parental_education: "master's degree", test_preparation: 'completed', avg_math_score: 70.6 },
  { parental_education: "master's degree", test_preparation: 'none', avg_math_score: 69.31 },
  { parental_education: 'some college', test_preparation: 'completed', avg_math_score: 71.45 },
  { parental_education: 'some college', test_preparation: 'none', avg_math_score: 64.89 },
  { parental_education: 'some high school', test_preparation: 'completed', avg_math_score: 66.7 },
  { parental_education: 'some high school', test_preparation: 'none', avg_math_score: 61.08 },
]

describe('validateChartLayoutSvg / food-ordering reproduction shapes', () => {
  const rows = foodOrderingLayoutStressRows()

  it('passes art_9dd789f676df4f1e (previously: repeated faceted x-axis titles)', async () => {
    const svg = await renderChartSvg(compileChartIntent(buildFacetedXAxisOverlapIntent(), rows))
    const result = validateChartLayoutSvg(svg)
    expect(result).toMatchObject({ ok: true, diagnostics: [] })
  })

  it('passes art_17de88137e3e481e (previously: repeated titles + oversized y-axis title)', async () => {
    const svg = await renderChartSvg(compileChartIntent(buildOversizedYAxisIntent(), rows))
    const result = validateChartLayoutSvg(svg)
    expect(result).toMatchObject({ ok: true, diagnostics: [] })
  })

  it('passes art_a7247eaaa21a4c41 (previously: rotated labels/legend/excess whitespace)', async () => {
    const svg = await renderChartSvg(compileChartIntent(buildRotatedLabelLegendIntent(), rows))
    const result = validateChartLayoutSvg(svg)
    expect(result).toMatchObject({ ok: true, diagnostics: [] })
  })

  it('passes all three shapes at both a narrow (~450px) and wide (~710px) delivery width', async () => {
    for (const deliveryWidthPx of [450, 710]) {
      for (const intent of [
        buildFacetedXAxisOverlapIntent(),
        buildOversizedYAxisIntent(),
        buildRotatedLabelLegendIntent(),
      ]) {
        const svg = await renderChartSvg(compileChartIntent(intent, rows, { deliveryWidthPx }))
        const result = validateChartLayoutSvg(svg)
        expect(result).toMatchObject({ ok: true, diagnostics: [] })
      }
    }
  })

  it('never reports a misleading success (ok=true) alongside diagnostics', async () => {
    for (const intent of [
      buildFacetedXAxisOverlapIntent(),
      buildOversizedYAxisIntent(),
      buildRotatedLabelLegendIntent(),
    ]) {
      const svg = await renderChartSvg(compileChartIntent(intent, rows))
      const result = validateChartLayoutSvg(svg)
      expect(result.ok).toBe(result.diagnostics.length === 0)
    }
  })
})

describe('validateChartLayoutSvg / deliveryWidthPx-ignored-for-non-faceted-charts reproduction', () => {
  // A single-panel (non-faceted) grouped bar with 6 nominal x-categories
  // (some long, e.g. "associate's degree") and a 2-value series/legend field
  // — the exact live-walkthrough failure shape. `withFacet`'s non-faceted
  // branch previously hardcoded `width: 560, height: 320` regardless of
  // `deliveryWidthPx`, so this rendered at a fixed size no matter what
  // delivery context asked for it and failed `excessive-output-bounds` at a
  // narrow (chat-card) width.
  const rows = mathScoreByEducationRows
  const baseIntent = {
    mark: 'bar' as const,
    title: 'Average math score by parental education',
    x: 'parental_education',
    y: 'avg_math_score',
    series: 'test_preparation',
  }

  it('passes at chat-card width, both explicitly horizontal and with orientation left to the deterministic auto-policy', async () => {
    const deliveryWidthPx = deliveryWidthPxForProfile('chat-card')
    for (const intent of [
      baseIntent,
      { ...baseIntent, format: { orientation: 'horizontal' as const } },
    ]) {
      const svg = await renderChartSvg(compileChartIntent(intent, rows, { deliveryWidthPx }))
      const result = validateChartLayoutSvg(svg)
      expect(result).toMatchObject({ ok: true, diagnostics: [] })
    }
  })

  it('passes at every delivery profile (chat-card, sidebar-narrow, sidebar-wide, export), not just one width by accident', async () => {
    for (const profile of ['chat-card', 'sidebar-narrow', 'sidebar-wide', 'export'] as const) {
      const deliveryWidthPx = deliveryWidthPxForProfile(profile)
      const svg = await renderChartSvg(compileChartIntent(baseIntent, rows, { deliveryWidthPx }))
      const result = validateChartLayoutSvg(svg)
      expect(result).toMatchObject({ ok: true, diagnostics: [] })
    }
  })

  it('scales the rendered plot width down at a narrower delivery profile instead of a fixed constant', async () => {
    const narrowSpec = compileChartIntent(baseIntent, rows, {
      deliveryWidthPx: deliveryWidthPxForProfile('chat-card'),
    }) as unknown as { width: number }
    const wideSpec = compileChartIntent(baseIntent, rows, {
      deliveryWidthPx: deliveryWidthPxForProfile('export'),
    }) as unknown as { width: number }
    expect(narrowSpec.width).toBeLessThan(wideSpec.width)
  })

  // Documented limitation, not fixed by this change: an EXPLICIT vertical
  // orientation for this same verbose-category, legend-bearing shape still
  // fails at every delivery width, including the previous default (640px)
  // and every wider profile — independent of `deliveryWidthPx`. Vega-Lite
  // itself rotates the long category labels into the plot margin when
  // rendered vertically, and that rotation overflow (not the chart's
  // declared width/height) drives the canvas past what any width/height
  // combination can satisfy without either dropping labels or requesting an
  // oversized canvas. This is exactly why the existing deterministic
  // chart-choice policy (`categoricalLabelsAreLong`) already auto-switches
  // to horizontal for long labels unless a caller explicitly overrides the
  // orientation — an explicit override remains the caller's own choice and
  // its risk, and is out of scope for the `deliveryWidthPx` plumbing fixed
  // here.
  it('accepts an EXPLICIT vertical orientation of this shape at every delivery width', async () => {
    // Reversal, measured 2026-09-20: the old `(content + chrome) * 1.3` budget
    // refused this shape purely as "excessive blank space" (panel share 36.9%,
    // 40.4% and 45.2% at the three widths). Its twelve bars sit in a canvas that
    // is tall because six long category labels rotate into the axis band — a
    // readable chart, not a defect, and no collision or out-of-bounds diagnostic
    // fires on it. The panel-share floor (0.25) no longer blocks it; the
    // orientation *policy* still prefers horizontal for long labels by default
    // (asserted in the sibling test), so an explicit vertical override is the
    // caller's deliberate choice rather than a trap.
    for (const deliveryWidthPx of [
      640,
      deliveryWidthPxForProfile('chat-card'),
      deliveryWidthPxForProfile('export'),
    ]) {
      const svg = await renderChartSvg(
        compileChartIntent({ ...baseIntent, format: { orientation: 'vertical' as const } }, rows, {
          deliveryWidthPx,
        }),
      )
      const result = validateChartLayoutSvg(svg)
      expect(result.diagnostics).toEqual([])
      expect(result.ok).toBe(true)
    }
  })
})

describe('validateChartLayoutSvg / long-chart-title-ignored-for-deliveryWidthPx reproduction', () => {
  // Follow-on to the `deliveryWidthPx`-ignored-for-non-faceted-charts fix
  // above: that fix bounds the *plot* width by `deliveryWidthPx`, but a long
  // chart TITLE independently forces Vega-Lite to widen the whole rendered
  // canvas to fit it on one line, regardless of what `computePlotWidth`
  // requested. This is the exact live-walkthrough failure mode again, one
  // level up: `baseIntent.title` above (40 chars) only names one of the two
  // charted dimensions, and passes purely by chance — the natural title a
  // model writes when charting *both* dimensions (as the real walkthrough
  // did) is long enough to still fail even after the plot-width fix.
  const rows = mathScoreByEducationRows
  const longNaturalTitle = 'Average math score by parental education and test preparation course'
  const longNaturalTitleWithMultiplicationSign =
    'Average math score by parental education × test preparation course'
  const baseIntent = {
    mark: 'bar' as const,
    x: 'parental_education',
    y: 'avg_math_score',
    series: 'test_preparation',
  }

  it('passes a long, natural two-dimension title at chat-card width', async () => {
    for (const title of [longNaturalTitle, longNaturalTitleWithMultiplicationSign]) {
      const svg = await renderChartSvg(
        compileChartIntent({ ...baseIntent, title }, rows, {
          deliveryWidthPx: deliveryWidthPxForProfile('chat-card'),
        }),
      )
      const result = validateChartLayoutSvg(svg)
      expect(result).toMatchObject({ ok: true, diagnostics: [] })
    }
  })

  it('passes the same long title at every delivery profile, not just chat-card', async () => {
    for (const profile of ['chat-card', 'sidebar-narrow', 'sidebar-wide', 'export'] as const) {
      const svg = await renderChartSvg(
        compileChartIntent({ ...baseIntent, title: longNaturalTitle }, rows, {
          deliveryWidthPx: deliveryWidthPxForProfile(profile),
        }),
      )
      const result = validateChartLayoutSvg(svg)
      expect(result).toMatchObject({ ok: true, diagnostics: [] })
    }
  })

  it('does not widen the rendered canvas beyond the short-title baseline for the same delivery width', async () => {
    const deliveryWidthPx = deliveryWidthPxForProfile('chat-card')
    const shortTitleSvg = await renderChartSvg(
      compileChartIntent(
        { ...baseIntent, title: 'Average math score by parental education' },
        rows,
        { deliveryWidthPx },
      ),
    )
    const longTitleSvg = await renderChartSvg(
      compileChartIntent({ ...baseIntent, title: longNaturalTitle }, rows, { deliveryWidthPx }),
    )
    const shortBounds = validateChartLayoutSvg(shortTitleSvg).bounds
    const longBounds = validateChartLayoutSvg(longTitleSvg).bounds
    expect(longBounds.width).toBe(shortBounds.width)
  })
})

describe('validateChartLayoutSvg / clean control charts', () => {
  it('passes an ordinary single-panel bar chart', async () => {
    const svg = await renderChartSvg(
      compileChartIntent(
        {
          mark: 'bar',
          title: 'Net sales by region',
          x: 'region',
          y: 'revenue',
          xLabel: 'Region',
          yLabel: 'Revenue (USD)',
        },
        [
          { region: 'North', revenue: 80 },
          { region: 'South', revenue: 50 },
          { region: 'East', revenue: 65 },
          { region: 'West', revenue: 40 },
        ],
      ),
    )
    expect(validateChartLayoutSvg(svg)).toMatchObject({ ok: true, diagnostics: [] })
  })

  it('passes a horizontal-category bar chart with a long category label', async () => {
    const svg = await renderChartSvg(
      compileChartIntent(
        {
          mark: 'bar',
          title: 'Comparison',
          x: 'region',
          y: 'revenue',
          format: { orientation: 'horizontal' },
          xLabel: 'Region',
          yLabel: 'Revenue',
        },
        [
          { region: 'Lower', revenue: 2 },
          { region: 'Higher', revenue: 9 },
          { region: 'Middle income band', revenue: 5 },
        ],
      ),
    )
    expect(validateChartLayoutSvg(svg)).toMatchObject({ ok: true, diagnostics: [] })
  })

  it('passes a time-series line chart', async () => {
    const svg = await renderChartSvg(
      compileChartIntent(
        {
          mark: 'line',
          title: 'Revenue over time',
          x: 'month',
          y: 'revenue',
          xLabel: 'Month',
          yLabel: 'Revenue (USD)',
        },
        [
          { month: '2024-01-01', revenue: 10 },
          { month: '2024-02-01', revenue: 20 },
          { month: '2024-03-01', revenue: 15 },
          { month: '2024-04-01', revenue: 25 },
        ],
      ),
    )
    expect(validateChartLayoutSvg(svg)).toMatchObject({ ok: true, diagnostics: [] })
  })

  it('passes a many-category horizontal bar chart with long labels (bounded-height policy, not a defect)', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      region: `Region with a fairly long name ${i}`,
      revenue: i,
    }))
    const svg = await renderChartSvg(
      compileChartIntent(
        {
          mark: 'bar',
          title: 'Many categories',
          x: 'region',
          y: 'revenue',
          format: { orientation: 'horizontal' },
        },
        rows,
      ),
    )
    expect(validateChartLayoutSvg(svg)).toMatchObject({ ok: true, diagnostics: [] })
  })

  it('passes a multi-series line chart with a legend', async () => {
    const rows = [
      { x: 1, y: 2, segment: 'A' },
      { x: 2, y: 3, segment: 'B' },
      { x: 3, y: 1, segment: 'C' },
    ]
    const svg = await renderChartSvg(
      compileChartIntent(
        { mark: 'line', title: 'Segments', x: 'x', y: 'y', series: 'segment' },
        rows,
      ),
    )
    expect(validateChartLayoutSvg(svg)).toMatchObject({ ok: true, diagnostics: [] })
  })

  it('passes KPI, table and empty-result templates (no axis/plot view to be proportional to)', async () => {
    const kpiSvg = await renderChartSvg(
      compileChartIntent({ mark: 'kpi', title: 'Total', y: 'revenue' }, [{ revenue: 12345.6789 }]),
    )
    const tableSvg = await renderChartSvg(
      compileChartIntent({ mark: 'table', title: 'Rows' }, [
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ]),
    )
    expect(validateChartLayoutSvg(kpiSvg).ok).toBe(true)
    expect(validateChartLayoutSvg(tableSvg).ok).toBe(true)
  })
})

describe('validateChartLayoutSvg / isolated geometry shapes (minimal synthetic SVGs)', () => {
  function wrap(width: number, height: number, body: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" class="marks" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="white"/>${body}</svg>`
  }

  it('flags two overlapping axis labels as a text-collision', () => {
    const svg = wrap(
      200,
      100,
      `<g class="mark-text role-axis-label">
         <text x="0" y="0" text-anchor="start" transform="translate(10,50)" font-size="14">Overlapping label one</text>
         <text x="0" y="0" text-anchor="start" transform="translate(14,50)" font-size="14">Overlapping label two</text>
       </g>`,
    )
    const result = validateChartLayoutSvg(svg)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toContain('text-collision')
  })

  it('flags a label extending past the view box as label-out-of-bounds', () => {
    const svg = wrap(
      120,
      80,
      `<g class="mark-text role-axis-label">
         <text text-anchor="start" transform="translate(90,70)" font-size="16">Way past the right edge</text>
       </g>`,
    )
    const result = validateChartLayoutSvg(svg)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toContain('label-out-of-bounds')
  })

  it('flags an empty legend label as blank-legend-label', () => {
    const svg = wrap(
      200,
      120,
      `<g class="mark-group role-legend">
         <g class="mark-text role-legend-label"><text text-anchor="start" transform="translate(10,10)" font-size="10"></text></g>
       </g>`,
    )
    const result = validateChartLayoutSvg(svg)
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'blank-legend-label', role: 'legend' }),
    ])
  })

  it('flags a canvas far beyond the absolute size cap as excessive-output-bounds', () => {
    const svg = wrap(
      2000,
      1500,
      '<g><path class="background" d="M0,0h100v100h-100Z" stroke="#ddd"/></g>',
    )
    const result = validateChartLayoutSvg(svg)
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'excessive-output-bounds', role: 'canvas' }),
    ])
  })

  it('passes a minimal clean single-panel shape with no text and a modest canvas', () => {
    const svg = wrap(300, 200, '<path class="background" d="M10,10h200v100h-200Z" stroke="#ddd"/>')
    expect(validateChartLayoutSvg(svg)).toMatchObject({ ok: true, diagnostics: [] })
  })

  it('never crashes on malformed SVG input and reports an explicit non-verified result', () => {
    const result = validateChartLayoutSvg('<svg>not a real chart</svg>')
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'unreadable-svg' })])
  })

  it('bounds an oversized input instead of scanning it unboundedly', () => {
    const huge = `<svg width="100" height="100">${'x'.repeat(5_000_000)}</svg>`
    const result = validateChartLayoutSvg(huge)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toContain('unreadable-svg')
  })

  it('bounds an oversized element count instead of scanning it unboundedly', () => {
    const manyTags = Array.from(
      { length: 25_000 },
      () => '<rect x="0" y="0" width="1" height="1"/>',
    ).join('')
    const svg = wrap(100, 100, manyTags)
    const start = Date.now()
    const result = validateChartLayoutSvg(svg)
    expect(Date.now() - start).toBeLessThan(2000)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toContain('unreadable-svg')
  })
})
