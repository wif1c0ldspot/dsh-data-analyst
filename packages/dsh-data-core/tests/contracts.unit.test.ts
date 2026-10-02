import { describe, expect, it } from 'vitest'
import {
  ChartIntentSchema,
  ChartLayoutValidationSchema,
  ChartRenderStateSchema,
  QueryRequestSchema,
  StudioAvailabilityCheckSchema,
  WorkflowTrailEntrySchema,
} from '../src/contracts.js'

describe('untrusted query and chart inputs', () => {
  it('preserves exact decimal strings and leading-zero IDs in bound parameters', () => {
    const query = QueryRequestSchema.parse({
      datasetVersionId: 'retail-v1',
      semanticRevisionId: 'semantics-v1',
      sql: 'SELECT amount FROM retail WHERE customer_id = ? AND amount >= ?',
      parameters: [
        { logicalType: 'VARCHAR', value: '0007' },
        { logicalType: 'DECIMAL(18,2)', value: '9007199254740993.01' },
      ],
    })
    expect(query.parameters.map((parameter) => parameter.value)).toEqual([
      '0007',
      '9007199254740993.01',
    ])
  })

  it.each([NaN, Infinity, { sql: 'SELECT 1' }])(
    'rejects non-scalar or non-JSON parameter %s',
    (value) => {
      expect(
        QueryRequestSchema.safeParse({
          datasetVersionId: 'retail-v1',
          semanticRevisionId: 'semantics-v1',
          sql: 'SELECT ?',
          parameters: [{ logicalType: 'VARCHAR', value }],
        }).success,
      ).toBe(false)
    },
  )

  it('rejects alternate data sources and executable chart properties', () => {
    const chart = { mark: 'bar', title: 'Revenue by region', x: 'region', y: 'revenue' }
    expect(ChartIntentSchema.parse(chart)).toEqual(chart)
    for (const injected of [
      { data: { url: 'https://example.invalid/data' } },
      { calculate: 'malicious()' },
      { sort: { field: 'revenue', direction: 'ascending', expression: 'malicious()' } },
    ]) {
      expect(ChartIntentSchema.safeParse({ ...chart, ...injected }).success).toBe(false)
    }
  })

  it('accepts bounded complex chart templates and rejects incompatible combinations', () => {
    expect(
      ChartIntentSchema.parse({
        mark: 'heatmap',
        title: 'Revenue by region and month',
        x: 'month',
        y: 'region',
        value: 'revenue',
        facet: 'segment',
        facetColumns: 2,
      }),
    ).toMatchObject({ mark: 'heatmap', value: 'revenue', facetColumns: 2 })
    expect(
      ChartIntentSchema.parse({
        mark: 'line',
        title: 'Revenue and profit',
        x: 'month',
        y: 'revenue',
        y2: 'profit',
      }),
    ).toMatchObject({ mark: 'line', y2: 'profit' })

    for (const invalid of [
      { mark: 'bar', title: 'x', x: 'region', y: 'revenue', y2: 'profit' },
      { mark: 'heatmap', title: 'x', x: 'month', y: 'region' },
      { mark: 'line', title: 'x', x: 'month', y: 'revenue', stack: 'zero' },
      { mark: 'bar', title: 'x', x: 'region', y: 'revenue', facetColumns: 3 },
      {
        mark: 'area',
        title: 'x',
        x: 'month',
        y: 'revenue',
        y2: 'profit',
        series: 'segment',
      },
    ]) {
      expect(ChartIntentSchema.safeParse(invalid).success).toBe(false)
    }
  })
})

/**
 * These schemas are the data-contract half of "make_chart cannot claim
 * Studio or browser verification" and "layout verification is generated
 * only by the validator, never by model text" — proved here structurally,
 * independent of any live model.
 */
describe('truthful chart-completion contracts', () => {
  const okLayoutValidation = { ok: true, diagnostics: [], bounds: { width: 400, height: 300 } }
  const noRefinement = {
    attempted: false,
    changes: [],
    resolvedCodes: [],
    remainingDiagnostics: [],
  }

  it('ChartRenderStateSchema accepts only a literal rendered:true plus a validated layoutValidation/refinement, and nothing else', () => {
    expect(
      ChartRenderStateSchema.parse({
        rendered: true,
        layoutValidation: okLayoutValidation,
        refinement: noRefinement,
      }),
    ).toEqual({ rendered: true, layoutValidation: okLayoutValidation, refinement: noRefinement })

    // rendered cannot be false, a string, or omitted — the schema has no
    // "not yet rendered" shape a model could construct and claim as success.
    // refinement is likewise required — there is no shape that omits the
    // attempt metadata.
    for (const invalid of [
      { rendered: false, layoutValidation: okLayoutValidation, refinement: noRefinement },
      { rendered: 'true', layoutValidation: okLayoutValidation, refinement: noRefinement },
      { layoutValidation: okLayoutValidation, refinement: noRefinement },
      { rendered: true, refinement: noRefinement },
      { rendered: true, layoutValidation: okLayoutValidation },
    ]) {
      expect(ChartRenderStateSchema.safeParse(invalid).success).toBe(false)
    }

    // No amount of extra input fields can add a persistence or
    // Studio-availability claim onto this shape — it is a strict object.
    expect(
      ChartRenderStateSchema.safeParse({
        rendered: true,
        layoutValidation: okLayoutValidation,
        refinement: noRefinement,
        persisted: true,
        availableInStudio: true,
        visuallyVerified: true,
      }).success,
    ).toBe(false)
  })

  it('ChartLayoutValidationSchema rejects a free-text "verified" claim that lacks real diagnostics/bounds', () => {
    // A model cannot construct a valid layout-verified receipt from
    // self-attested text alone — it must supply the exact bounded shape the
    // validator itself produces (diagnostics array, numeric bounds).
    for (const invalid of [
      { ok: true, verified: true },
      {
        ok: true,
        diagnostics: [],
        bounds: { width: 400, height: 300 },
        note: 'inspected visually',
      },
      { ok: true, diagnostics: 'none', bounds: { width: 400, height: 300 } },
    ]) {
      expect(ChartLayoutValidationSchema.safeParse(invalid).success).toBe(false)
    }
    expect(ChartLayoutValidationSchema.parse(okLayoutValidation)).toEqual(okLayoutValidation)
  })

  it('StudioAvailabilityCheckSchema requires the checkedVia literal identifying the real check path', () => {
    const valid = {
      analysisId: 'analysis_1',
      requestedRevision: 1,
      latestRevision: 1,
      availableInStudio: true,
      checkedVia: 'studio-overview-route' as const,
      checkedAt: new Date().toISOString(),
    }
    expect(StudioAvailabilityCheckSchema.parse(valid)).toEqual(valid)

    // A model cannot invent its own provenance label for how availability
    // was "checked" — only the one real code path's literal is accepted.
    expect(
      StudioAvailabilityCheckSchema.safeParse({ ...valid, checkedVia: 'agent-claim' }).success,
    ).toBe(false)
    expect(
      StudioAvailabilityCheckSchema.safeParse({ ...valid, checkedVia: undefined }).success,
    ).toBe(false)
  })
})

describe('workflow trail contract', () => {
  const valid = {
    entryId: 'trail_0000000000000001',
    milestone: 'chart_rendered' as const,
    actor: 'service' as const,
    datasetVersionId: 'food-ordering-v1',
    analysisId: null,
    receiptId: 'art_0000000000000001',
    recordedAt: new Date().toISOString(),
  }

  it('accepts a compact, identifier-only milestone entry', () => {
    expect(WorkflowTrailEntrySchema.parse(valid)).toEqual(valid)
  })

  it('rejects an unknown milestone type or actor a model could invent', () => {
    expect(
      WorkflowTrailEntrySchema.safeParse({ ...valid, milestone: 'chart_visually_inspected' })
        .success,
    ).toBe(false)
    expect(WorkflowTrailEntrySchema.safeParse({ ...valid, actor: 'model-claim' }).success).toBe(
      false,
    )
  })

  it('rejects a receiptId shaped like raw row data, SVG or a credential string', () => {
    for (const receiptId of [
      'password=hunter2',
      '{"ssn": "123-45-6789"}',
      '<svg><text>secret</text></svg>',
      'api_key: sk-abcdef 1234',
    ]) {
      expect(WorkflowTrailEntrySchema.safeParse({ ...valid, receiptId }).success).toBe(false)
    }
  })

  it('rejects extra fields (strictObject) so a caller cannot smuggle payloads alongside identifiers', () => {
    expect(WorkflowTrailEntrySchema.safeParse({ ...valid, rawRows: [{ a: 1 }] }).success).toBe(
      false,
    )
  })
})
