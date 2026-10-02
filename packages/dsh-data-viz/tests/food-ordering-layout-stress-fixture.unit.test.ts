/**
 * Smoke test for the long-label/facet layout-stress fixture. This does not
 * assert anything about layout quality — that is the layout validator's job,
 * which consumes `tests/fixtures/food-ordering-layout-stress.ts` for its own
 * geometry/collision assertions. This test only proves the fixture itself
 * builds a valid `ChartIntent` and compiles through the current chart
 * pipeline without throwing, so the fixture stays usable as infrastructure.
 */
import { describe, expect, it } from 'vitest'
import { compileChartIntent } from '../src/chart.js'
import {
  buildFacetedXAxisOverlapIntent,
  buildOversizedYAxisIntent,
  buildRotatedLabelLegendIntent,
  foodOrderingLayoutStressRows,
  INCOME_BAND_LABELS,
  OCCUPATION_LABELS,
  POPULATION_FACET_VALUES,
} from './fixtures/food-ordering-layout-stress.js'

describe('food-ordering layout-stress fixture', () => {
  const rows = foodOrderingLayoutStressRows()

  it('produces a non-empty row set crossing population, occupation and income band', () => {
    expect(rows.length).toBe(
      POPULATION_FACET_VALUES.length * OCCUPATION_LABELS.length * INCOME_BAND_LABELS.length,
    )
    expect(rows.every((row) => typeof row.order_count === 'number')).toBe(true)
  })

  it('includes the long "Self Employeed" occupation label from the walkthrough evidence', () => {
    expect(OCCUPATION_LABELS).toContain('Self Employeed')
  })

  it('compiles the art_9dd789f676df4f1e faceted-x-axis-overlap shape without throwing', () => {
    const spec = compileChartIntent(buildFacetedXAxisOverlapIntent(), rows) as unknown as {
      facet: { field: string }
    }
    expect(spec.facet.field).toBe('population')
  })

  it('compiles the art_17de88137e3e481e oversized-y-axis-title shape without throwing', () => {
    const spec = compileChartIntent(buildOversizedYAxisIntent(), rows) as unknown as {
      facet: { field: string }
    }
    expect(spec.facet.field).toBe('population')
  })

  it('compiles the art_a7247eaaa21a4c41 rotated-label/legend shape without throwing', () => {
    const spec = compileChartIntent(buildRotatedLabelLegendIntent(), rows) as unknown as {
      encoding: { color: { field: string } }
    }
    expect(spec.encoding.color.field).toBe('income_band')
  })
})
