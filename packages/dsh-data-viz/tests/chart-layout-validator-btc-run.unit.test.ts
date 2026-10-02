/**
 * Regression fixtures from the live `mczielinski/bitcoin-historical-data` run
 * (2026-09-20). They pin both directions of the gate that failed there:
 *
 *  - a *correct* 117-point line chart and a *correct* 34-bin bar chart, which the
 *    old `(content + chrome) * 1.3` budget refused as "excessive blank space"
 *    because their tick labels happened to carry ~3.5k px^2 less estimated text
 *    area than a broken chart's; and
 *  - two *broken* 2,454-row histograms (one per input row, every bar full panel
 *    height) which that same budget passed as layout-valid.
 *
 * Both charts here have one identical 560x320 panel and canvases within 0.6% of
 * each other, so any change that flips one verdict without the other is a
 * regression in what the check measures.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateChartLayoutSvg } from '../src/chart-layout-validator.js'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'btc-run', name), 'utf8')

describe('chart layout validation: bitcoin-run fixtures', () => {
  it('accepts a correct 117-point line chart instead of refusing its blank space', () => {
    const result = validateChartLayoutSvg(fixture('line-117-points.svg'))
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('accepts a correct 34-bin bar chart', () => {
    const result = validateChartLayoutSvg(fixture('bar-34-bins.svg'))
    expect(result.ok).toBe(true)
  })

  it('rejects a histogram that emitted one full-height mark per input row', () => {
    for (const name of ['histogram-per-row-vertical.svg', 'histogram-per-row-horizontal.svg']) {
      const result = validateChartLayoutSvg(fixture(name))
      expect(result.ok, name).toBe(false)
      expect(
        result.diagnostics.map((diagnostic) => diagnostic.code),
        name,
      ).toContain('degenerate-aggregate')
      // The under-fill that made this the *rejected-elsewhere* shape is not the
      // reason it fails: 2,454 marks in a 320x806 canvas still cover ~56% of it.
      expect(
        result.diagnostics.map((diagnostic) => diagnostic.code),
        name,
      ).not.toContain('excessive-output-bounds')
    }
  })

  it('does not let a longer axis label change an under-fill verdict', () => {
    // The coin flip this gate used to be: identical geometry, different label
    // text. Both must land on the same verdict now.
    const shorter = `<svg xmlns="http://www.w3.org/2000/svg" width="806" height="406" viewBox="0 0 806 406"><rect width="806" height="406" fill="white"/><path class="background" aria-hidden="true" d="M0.5,0.5h560v320h-560Z" stroke="#ddd"/><text x="10" y="380" class="mark-text role-axis-label">0</text></svg>`
    const longer = `<svg xmlns="http://www.w3.org/2000/svg" width="806" height="406" viewBox="0 0 806 406"><rect width="806" height="406" fill="white"/><path class="background" aria-hidden="true" d="M0.5,0.5h560v320h-560Z" stroke="#ddd"/><text x="10" y="380" class="mark-text role-axis-label">−1,234,567,890.00 percentage points of return</text></svg>`
    const shortVerdict = validateChartLayoutSvg(shorter)
    const longVerdict = validateChartLayoutSvg(longer)
    expect(shortVerdict.ok).toBe(longVerdict.ok)
    expect(shortVerdict.diagnostics.map((d) => d.code)).toEqual(
      longVerdict.diagnostics.map((d) => d.code),
    )
  })

  it('still refuses a canvas that really is mostly blank', () => {
    // 900x900 canvas with a 100x100 panel: 1.2% plot area. The floor this check
    // exists for stays enforceable on axis-bearing charts (KPI/table templates
    // are exempt: their background box is a frame, not a plot).
    const sparse = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900"><rect width="900" height="900" fill="white"/><path class="background" aria-hidden="true" d="M10.5,10.5h100v100h-100Z" stroke="#ddd"/><g class="mark-group role-axis"><path d="M0,0h1v1h-1Z"/></g></svg>`
    const result = validateChartLayoutSvg(sparse)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toContain('excessive-output-bounds')
  })
})
