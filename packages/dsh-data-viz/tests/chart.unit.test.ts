import { describe, expect, it } from 'vitest'
import {
  compileChartIntent,
  deliveryWidthPxForProfile,
  renderChartSvg,
  renderEmptyResultSvg,
  toChartNumber,
} from '../src/chart.js'

describe('toChartNumber', () => {
  it('converts plain decimal strings within safe range', () => {
    expect(toChartNumber('80.00')).toBe(80)
    expect(toChartNumber('-20.50')).toBe(-20.5)
    expect(toChartNumber('88.2900')).toBe(88.29)
    expect(toChartNumber('0.0000001')).toBe(1e-7)
    expect(toChartNumber('-0.00')).toBe(-0)
    expect(toChartNumber(42)).toBe(42)
  })

  it('rejects fractional precision loss before charting exact decimal strings', () => {
    expect(() => toChartNumber('9007199254740991.1')).toThrow(/loses decimal precision/)
    expect(() => toChartNumber('0.123456789012345678901')).toThrow(/loses decimal precision/)
    expect(() => toChartNumber(`0.${'0'.repeat(324)}1`)).toThrow(/loses decimal precision/)
  })

  it('rejects integers outside the JS safe-integer range instead of silently truncating', () => {
    expect(() => toChartNumber('9007199254740993')).toThrow(/safe-integer range/)
  })

  it('rejects non-numeric or malformed strings', () => {
    expect(() => toChartNumber('80.00; DROP TABLE x')).toThrow(/not a plain decimal/)
    expect(() => toChartNumber('NaN')).toThrow(/not a plain decimal/)
  })

  it('rejects non-finite numbers', () => {
    expect(() => toChartNumber(Number.POSITIVE_INFINITY)).toThrow(/Non-finite/)
  })
})

describe('compileChartIntent', () => {
  const rows = [
    { region: 'North', revenue: 80 },
    { region: 'South', revenue: 50 },
  ]

  it('requires both x and y for a bar mark', () => {
    expect(() => compileChartIntent({ mark: 'bar', title: 'x' }, rows)).toThrow(
      /requires an x field/,
    )
  })

  it('applies descending sort by the requested field', () => {
    const spec = compileChartIntent(
      {
        mark: 'bar',
        title: 'Net sales by region',
        x: 'region',
        y: 'revenue',
        sort: { field: 'revenue', direction: 'descending' },
      },
      rows,
    ) as { encoding: { x: { sort: unknown } } }
    expect(spec.encoding.x.sort).toEqual({ field: 'revenue', order: 'descending' })
  })

  it('applies axis labels from xLabel/yLabel', () => {
    const spec = compileChartIntent(
      {
        mark: 'bar',
        title: 't',
        x: 'region',
        y: 'revenue',
        xLabel: 'Region',
        yLabel: 'Net sales (USD)',
      },
      rows,
    ) as { encoding: { x: { title: string }; y: { title: string } } }
    expect(spec.encoding.x.title).toBe('Region')
    expect(spec.encoding.y.title).toBe('Net sales (USD)')
  })

  it('compiles heatmaps with a quantitative color field', () => {
    const spec = compileChartIntent(
      {
        mark: 'heatmap',
        title: 'Revenue matrix',
        x: 'month',
        y: 'region',
        value: 'revenue',
        valueLabel: 'Revenue (USD)',
      },
      [
        { month: '2026-01-01', region: 'North', revenue: 80 },
        { month: '2026-01-01', region: 'South', revenue: 50 },
      ],
    ) as { mark: string; encoding: { color: { field: string; type: string; title: string } } }
    expect(spec.mark).toBe('rect')
    expect(spec.encoding.color).toEqual({
      field: 'revenue',
      type: 'quantitative',
      title: 'Revenue (USD)',
    })
  })

  it('binds two categorical fields to x/y and only the value field to color', () => {
    const spec = compileChartIntent(
      {
        mark: 'heatmap',
        title: 'Average sleep duration by occupation and BMI category',
        x: 'occupation',
        y: 'bmi_category',
        value: 'avg_sleep_duration',
      },
      [
        { occupation: 'Accountant', bmi_category: 'Normal', avg_sleep_duration: 7.2 },
        { occupation: 'Nurse', bmi_category: 'Overweight', avg_sleep_duration: 6.5 },
      ],
    ) as {
      mark: string
      encoding: {
        x: { field: string; type: string }
        y: { field: string; type: string }
        color: { field: string; type: string }
      }
    }
    expect(spec.mark).toBe('rect')
    expect(spec.encoding.x).toMatchObject({ field: 'occupation', type: 'nominal' })
    expect(spec.encoding.y).toMatchObject({ field: 'bmi_category', type: 'nominal' })
    expect(spec.encoding.color).toMatchObject({ field: 'avg_sleep_duration', type: 'quantitative' })
  })

  it('compiles stacked area small multiples through trusted fields', () => {
    const spec = compileChartIntent(
      {
        mark: 'area',
        title: 'Revenue by month and segment',
        x: 'month',
        y: 'revenue',
        series: 'segment',
        stack: 'normalize',
        facet: 'region',
        facetColumns: 2,
      },
      [
        { month: '2026-01-01', region: 'North', segment: 'Consumer', revenue: 80 },
        { month: '2026-01-01', region: 'South', segment: 'Corporate', revenue: 50 },
      ],
    ) as unknown as {
      facet: { field: string }
      columns: number
      spec: { mark: string; encoding: { y: { stack: string }; color: { field: string } } }
    }
    // `columns` (the Vega-Lite wrap directive) must sit at the top level, a
    // sibling of `facet`/`spec` — nested inside `facet` itself, Vega-Lite
    // silently ignores it (see chart.ts `withFacet`).
    expect(spec.facet).toMatchObject({ field: 'region' })
    expect(spec.columns).toBe(2)
    expect(spec.spec.mark).toBe('area')
    expect(spec.spec.encoding.y.stack).toBe('normalize')
    expect(spec.spec.encoding.color.field).toBe('segment')
  })

  it('defaults facet columns to the actual facet cardinality for a low-cardinality field at the default delivery width', () => {
    // Previously defaulted to a fixed 3 columns regardless of how many
    // distinct facet values existed (wasting a column on a 2-value facet at
    // the default delivery width) — replaced with a
    // delivery-width- and cardinality-aware column count; see
    // `computeFacetLayout` in chart.ts.
    const spec = compileChartIntent(
      { mark: 'bar', title: 't', x: 'month', y: 'revenue', facet: 'region' },
      [
        { month: '2026-01-01', region: 'North', revenue: 80 },
        { month: '2026-01-01', region: 'South', revenue: 50 },
      ],
    ) as unknown as { columns: number }
    expect(spec.columns).toBe(2)
  })

  it('prefers fewer facet columns at a narrower delivery width', () => {
    const rows = [
      { month: '2026-01-01', region: 'North', revenue: 80 },
      { month: '2026-01-01', region: 'South', revenue: 50 },
      { month: '2026-01-01', region: 'East', revenue: 40 },
      { month: '2026-01-01', region: 'West', revenue: 30 },
    ]
    const narrow = compileChartIntent(
      { mark: 'bar', title: 't', x: 'month', y: 'revenue', facet: 'region' },
      rows,
      { deliveryWidthPx: 450 },
    ) as unknown as { columns: number; spec: { width: number } }
    const wide = compileChartIntent(
      { mark: 'bar', title: 't', x: 'month', y: 'revenue', facet: 'region' },
      rows,
      { deliveryWidthPx: 900 },
    ) as unknown as { columns: number; spec: { width: number } }
    expect(narrow.columns).toBeLessThanOrEqual(wide.columns)
    expect(narrow.spec.width).toBeGreaterThanOrEqual(150)
    expect(wide.spec.width).toBeGreaterThanOrEqual(narrow.spec.width)
  })

  it('bounds a non-faceted chart width by deliveryWidthPx instead of ignoring it', () => {
    // Previously `withFacet`'s non-faceted branch hardcoded `width: 560`
    // regardless of `deliveryWidthPx` — the majority of real chart shapes
    // (any single-panel bar/line/point/area/heatmap) rendered at a fixed
    // width no matter what delivery context asked for it. A narrow
    // chat-card-sized delivery width must now produce a visibly narrower
    // plot than a wide export-sized one for the same intent/rows.
    const rows = [
      { region: 'North', revenue: 80 },
      { region: 'South', revenue: 50 },
      { region: 'East', revenue: 40 },
    ]
    const intent = { mark: 'line' as const, title: 't', x: 'region', y: 'revenue' }
    const narrow = compileChartIntent(intent, rows, {
      deliveryWidthPx: deliveryWidthPxForProfile('chat-card'),
    }) as unknown as { width: number }
    const wide = compileChartIntent(intent, rows, {
      deliveryWidthPx: deliveryWidthPxForProfile('export'),
    }) as unknown as { width: number }
    expect(narrow.width).toBeLessThan(wide.width)
  })

  it('bounds a non-faceted chart WITH a series legend by deliveryWidthPx too', () => {
    const rows = [
      { region: 'North', revenue: 80, channel: 'Online' },
      { region: 'South', revenue: 50, channel: 'Retail' },
      { region: 'East', revenue: 40, channel: 'Online' },
    ]
    const intent = {
      mark: 'bar' as const,
      title: 't',
      x: 'region',
      y: 'revenue',
      series: 'channel',
    }
    const narrow = compileChartIntent(intent, rows, {
      deliveryWidthPx: deliveryWidthPxForProfile('chat-card'),
    }) as unknown as { width: number }
    const wide = compileChartIntent(intent, rows, {
      deliveryWidthPx: deliveryWidthPxForProfile('export'),
    }) as unknown as { width: number }
    expect(narrow.width).toBeLessThan(wide.width)
  })

  it('widens facet columns for a high-cardinality facet field instead of an unbounded tall grid', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      month: '2026-01-01',
      region: `Region ${i}`,
      revenue: i,
    }))
    const spec = compileChartIntent(
      { mark: 'bar', title: 't', x: 'month', y: 'revenue', facet: 'region' },
      rows,
    ) as unknown as { columns: number }
    // 40 distinct facet values / 8 max grid rows => at least 5 columns.
    expect(spec.columns).toBe(5)
  })

  it('keeps an analyst-chosen facetColumns even for a high-cardinality facet field', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      month: '2026-01-01',
      region: `Region ${i}`,
      revenue: i,
    }))
    const spec = compileChartIntent(
      { mark: 'bar', title: 't', x: 'month', y: 'revenue', facet: 'region', facetColumns: 2 },
      rows,
    ) as unknown as { columns: number }
    expect(spec.columns).toBe(2)
  })

  it('compiles two quantitative measures as fixed trusted layers', () => {
    const spec = compileChartIntent(
      {
        mark: 'line',
        title: 'Revenue and profit',
        x: 'month',
        y: 'revenue',
        y2: 'profit',
        yLabel: 'Revenue',
        y2Label: 'Profit',
      },
      [{ month: '2026-01-01', revenue: 80, profit: 20 }],
    ) as { layer: Array<{ encoding: { y: { field: string }; color: { datum: string } } }> }
    expect(spec.layer.map((layer) => layer.encoding.y.field)).toEqual(['revenue', 'profit'])
    expect(spec.layer.map((layer) => layer.encoding.color.datum)).toEqual(['Revenue', 'Profit'])
  })

  it('compiles a boxplot template and an x-only histogram', () => {
    const boxplot = compileChartIntent(
      { mark: 'boxplot', title: 'Order values', x: 'region', y: 'revenue' },
      rows,
    ) as { mark: { type: string; extent: string } }
    expect(boxplot.mark).toEqual({ type: 'boxplot', extent: 'min-max' })

    const histogram = compileChartIntent(
      { mark: 'histogram', title: 'Revenue distribution', x: 'revenue' },
      rows,
    ) as {
      encoding: {
        x: { bin: boolean }
        y: { aggregate: string; field?: string }
        tooltip: Array<{ field: string; type: string; bin?: boolean }>
      }
    }
    expect(histogram.encoding.x.bin).toBe(true)
    expect(histogram.encoding.y).toMatchObject({ aggregate: 'count' })
    expect(histogram.encoding.y.field).toBeUndefined()
    // The tooltip must carry the *binned* field: in Vega-Lite any non-aggregated
    // field in an encoding joins the aggregation group-by, which collapsed the
    // count to 1 per row and emitted one full-height bar per input row.
    expect(histogram.encoding.tooltip).toEqual([
      { field: 'revenue', type: 'quantitative', bin: true },
    ])
  })

  it('does not print a payload-preview notice as a chart caption', () => {
    const chartRows = [{ month: '2026-01-01', revenue: 80 }]
    const spec = compileChartIntent(
      { mark: 'line', title: 'Monthly close', x: 'month', y: 'revenue' },
      chartRows,
      {
        warnings: [
          'Preview capped at 20 of 117 rows; the full result remains authorized and complete.',
          'Observed license CC-BY-SA-4.0 is unverified.',
        ],
      },
    ) as { title: { text: string; subtitle?: string } }
    expect(spec.title.subtitle).not.toMatch(/Preview capped/)
    expect(spec.title.subtitle).toContain('unverified')
  })

  it('omits the caption entirely when the only warning is the payload notice', () => {
    const chartRows = [{ month: '2026-01-01', revenue: 80 }]
    const spec = compileChartIntent(
      { mark: 'line', title: 'Monthly close', x: 'month', y: 'revenue' },
      chartRows,
      {
        warnings: [
          'Preview capped at 20 of 117 rows; the full result remains authorized and complete.',
        ],
      },
    ) as { title: { text: string; subtitle?: string } }
    expect(spec.title.subtitle).toBeUndefined()
  })

  it('rejects fields outside the authorized result before compilation', () => {
    expect(() =>
      compileChartIntent(
        { mark: 'line', title: 'x', x: 'region', y: 'revenue', y2: 'secret' },
        rows,
      ),
    ).toThrow(/not present in the authorized result/)
    expect(() =>
      compileChartIntent(
        {
          mark: 'bar',
          title: 'x',
          x: 'region',
          y: 'revenue',
          sort: { field: 'secret', direction: 'ascending' },
        },
        rows,
      ),
    ).toThrow(/sort field.*not present/)
  })
})

describe('renderChartSvg', () => {
  it('renders a fixed bar chart with axis labels, sorted values, and no external assets', async () => {
    const spec = compileChartIntent(
      {
        mark: 'bar',
        title: 'Net sales by region',
        x: 'region',
        y: 'revenue',
        xLabel: 'Region',
        yLabel: 'Net sales (USD)',
        sort: { field: 'revenue', direction: 'descending' },
      },
      [
        { region: 'North', revenue: 80 },
        { region: 'South', revenue: 50 },
      ],
    )
    const svg = await renderChartSvg(spec)
    expect(svg).toContain('<svg')
    expect(svg).toContain('Net sales by region')
    expect(svg).toContain('Region')
    expect(svg).toContain('Net sales (USD)')
    expect(svg).not.toMatch(/<script|<image|(?:href|src)=["']https?:/)
  })

  it('renders each complex template to self-contained SVG', async () => {
    const rows = [
      {
        month: '2026-01-01',
        region: 'North',
        segment: 'Consumer',
        revenue: 80,
        profit: 20,
      },
      {
        month: '2026-02-01',
        region: 'South',
        segment: 'Corporate',
        revenue: 50,
        profit: -5,
      },
    ]
    const intents = [
      { mark: 'area' as const, title: 'Area', x: 'month', y: 'revenue', series: 'segment' },
      { mark: 'point' as const, title: 'Point', x: 'month', y: 'revenue', series: 'segment' },
      {
        mark: 'heatmap' as const,
        title: 'Heatmap',
        x: 'month',
        y: 'region',
        value: 'revenue',
      },
      { mark: 'boxplot' as const, title: 'Boxplot', x: 'region', y: 'revenue' },
      {
        mark: 'line' as const,
        title: 'Layered',
        x: 'month',
        y: 'revenue',
        y2: 'profit',
      },
      { mark: 'bar' as const, title: 'Faceted', x: 'month', y: 'revenue', facet: 'region' },
    ]
    for (const intent of intents) {
      const svg = await renderChartSvg(compileChartIntent(intent, rows))
      expect(svg).toContain('<svg')
      expect(svg).not.toMatch(/<script|<image|(?:href|src)=["']https?:/)
    }
  })

  it('bin-counts a histogram instead of emitting one full-height mark per row', async () => {
    // The live bitcoin run rendered a 2,454-row histogram as 2,454 overlapping
    // full-height bars (every bar 320px tall, count axis 0.0-1.0, 626 KB of SVG):
    // the raw binned field rode along in `tooltip` and joined the aggregation
    // group-by, so every count came out as 1. Measured before the fix: marks
    // 2,454 / distinct heights 1 / count-axis max 1.0 / 463 KB; after: 6 marks,
    // 4 distinct heights, count axis reaching 450, 9 KB.
    const many = Array.from({ length: 2454 }, (_, index) => ({
      ret: ((index * 7919) % 6000) / 100 - 30,
    }))
    const svg = await renderChartSvg(
      compileChartIntent({ mark: 'histogram', title: 'Returns', x: 'ret' }, many),
    )
    const barHeights = [
      ...svg.matchAll(/aria-roledescription="bar"[^>]*d="M[\d.]+,[\d.]+h[\d.]+v([\d.]+)/g),
    ].map((match) => Number(match[1]))
    expect(barHeights.length).toBeLessThanOrEqual(60)
    expect(new Set(barHeights).size).toBeGreaterThanOrEqual(3)
    expect(svg.length).toBeLessThan(60_000)
    const axisNumbers = [...svg.matchAll(/<text[^>]*>([\d,]+(?:\.\d+)?)<\/text>/g)].map((match) =>
      Number(match[1].replace(/,/g, '')),
    )
    // A collapsed count axis (0.0-1.0) can never show a two- or three-digit count.
    expect(axisNumbers.some((value) => value >= 100)).toBe(true)
  })
})

describe('renderEmptyResultSvg', () => {
  it('renders an explicit empty-result placeholder rather than a blank misleading chart', async () => {
    const svg = await renderEmptyResultSvg('Net sales by region')
    expect(svg).toContain('<svg')
    expect(svg).toContain('No rows returned for this query')
  })
})

it('rejects a multi-row or nonnumeric KPI instead of overlaying values', () => {
  const intent = { mark: 'kpi' as const, y: 'value', title: 'Demand' }
  expect(() => compileChartIntent(intent, [{ value: 10 }, { value: 20 }])).toThrow(
    'exactly one row',
  )
  expect(() => compileChartIntent(intent, [{ value: null }])).toThrow('finite numeric')
  expect(() => compileChartIntent(intent, [{ value: 525.29 }])).not.toThrow()
})

it('renders table rows and columns into separate SVG cells with bounded disclosure', async () => {
  const rows = Array.from({ length: 52 }, (_, index) => ({
    region: `Region ${index + 1}`,
    amount: '9007199254740993',
  }))
  const spec = compileChartIntent(
    { mark: 'table', title: 'Exact table', x: 'region', y: 'amount' },
    rows,
  )
  const svg = await renderChartSvg(spec)
  expect(svg).toContain('Region 1')
  expect(svg).toContain('Region 50')
  expect(svg).not.toContain('Region 51')
  expect(svg).toContain('9007199254740993')
  expect(svg).toContain('50 of 52 rows')
  expect(svg).toContain('Full values in CSV')
  expect(svg).toContain('aria-label="column: region; row: 1; text: Region 1"')
})

it('applies bounded visual formatting without changing the supplied values', () => {
  const rows = [{ hour: 8, demand: 477.006048, segment: 'workday' }]
  const spec = compileChartIntent(
    {
      mark: 'line',
      title: 'Demand',
      x: 'hour',
      y: 'demand',
      series: 'segment',
      format: {
        xLabel: 'Hour',
        yLabel: 'Mean rentals',
        decimals: 2,
        palette: 'colorblind',
        legend: 'bottom',
      },
    },
    rows,
  ) as { encoding: Record<string, unknown>; data: { values: unknown[] } }
  expect(spec.encoding.x).toMatchObject({ title: 'Hour' })
  expect(spec.encoding.y).toMatchObject({ title: 'Mean rentals', axis: { format: ',.2f' } })
  expect(spec.encoding.color).toMatchObject({
    scale: { range: expect.arrayContaining(['#0072B2', '#E69F00']) },
    legend: { orient: 'bottom' },
  })
  expect(spec.data.values).toEqual(rows)
})

it('renders every offered palette rather than only compiling a specification', async () => {
  for (const palette of ['tableau10', 'colorblind', 'dark2'] as const) {
    const svg = await renderChartSvg(
      compileChartIntent(
        { mark: 'line', title: 'Segments', x: 'x', y: 'y', series: 'segment', format: { palette } },
        [
          { x: 1, y: 2, segment: 'A' },
          { x: 2, y: 3, segment: 'A' },
        ],
      ),
    )
    expect(svg).toContain('Segments')
    expect(svg).toContain('role-mark')
  }
})

it('defaults to the colorblind-safe palette when none is requested', () => {
  const spec = compileChartIntent(
    { mark: 'line', title: 'Segments', x: 'x', y: 'y', series: 'segment' },
    [
      { x: 1, y: 2, segment: 'A' },
      { x: 2, y: 3, segment: 'B' },
    ],
  ) as { encoding: { color: { scale: { range: string[] } } } }
  expect(spec.encoding.color.scale.range).toEqual(
    expect.arrayContaining(['#0072B2', '#E69F00', '#009E73']),
  )
})

it('encodes series by strokeDash (line/area) or shape (point), not colour alone', () => {
  const rows = [
    { x: 1, y: 2, segment: 'A' },
    { x: 2, y: 3, segment: 'B' },
  ]
  const line = compileChartIntent(
    { mark: 'line', title: 't', x: 'x', y: 'y', series: 'segment' },
    rows,
  ) as { encoding: { strokeDash?: { field: string } } }
  expect(line.encoding.strokeDash).toEqual({ field: 'segment', type: 'nominal', legend: null })

  const area = compileChartIntent(
    { mark: 'area', title: 't', x: 'x', y: 'y', series: 'segment' },
    rows,
  ) as { encoding: { strokeDash?: { field: string } } }
  expect(area.encoding.strokeDash).toEqual({ field: 'segment', type: 'nominal', legend: null })

  const point = compileChartIntent(
    { mark: 'point', title: 't', x: 'x', y: 'y', series: 'segment' },
    rows,
  ) as { encoding: { shape?: { field: string } } }
  expect(point.encoding.shape).toEqual({ field: 'segment', type: 'nominal', legend: null })

  const bar = compileChartIntent(
    { mark: 'bar', title: 't', x: 'x', y: 'y', series: 'segment' },
    rows,
  ) as { encoding: { strokeDash?: unknown; shape?: unknown } }
  expect(bar.encoding.strokeDash).toBeUndefined()
  expect(bar.encoding.shape).toBeUndefined()
})

it('does not add a redundant-encoding field when the chart has no series', () => {
  const spec = compileChartIntent({ mark: 'line', title: 't', x: 'x', y: 'y' }, [
    { x: 1, y: 2 },
  ]) as { encoding: { strokeDash?: unknown } }
  expect(spec.encoding.strokeDash).toBeUndefined()
})

it('wraps the series legend into columns once the domain exceeds 10 values', () => {
  const wideRows = Array.from({ length: 12 }, (_, i) => ({ x: i, y: i, segment: `S${i}` }))
  const wide = compileChartIntent(
    { mark: 'line', title: 't', x: 'x', y: 'y', series: 'segment' },
    wideRows,
  ) as { encoding: { color: { legend: { columns: number } } } }
  expect(wide.encoding.color.legend).toEqual({ columns: 2 })

  const narrowRows = [
    { x: 1, y: 2, segment: 'A' },
    { x: 2, y: 3, segment: 'B' },
  ]
  const narrow = compileChartIntent(
    { mark: 'line', title: 't', x: 'x', y: 'y', series: 'segment' },
    narrowRows,
  ) as { encoding: { color: { legend?: unknown } } }
  expect(narrow.encoding.color.legend).toBeUndefined()
})

it('folds query-time warnings into the chart title subtitle so they travel with the image', () => {
  const rows = [
    { x: 1, y: 2 },
    { x: 2, y: 3 },
  ]
  const withWarnings = compileChartIntent(
    { mark: 'bar', title: 'Net sales', x: 'x', y: 'y' },
    rows,
    {
      warnings: ['currency-mix-risk: orders.currency mixes EUR, USD'],
    },
  ) as { title: { text: string; subtitle: string } }
  expect(withWarnings.title).toEqual({
    text: 'Net sales',
    subtitle: 'currency-mix-risk: orders.currency mixes EUR, USD',
    anchor: 'start',
  })

  const withoutWarnings = compileChartIntent(
    { mark: 'bar', title: 'Net sales', x: 'x', y: 'y' },
    rows,
  ) as { title: string }
  expect(withoutWarnings.title).toBe('Net sales')

  const kpi = compileChartIntent({ mark: 'kpi', title: 'Total', y: 'y' }, [{ y: 2 }], {
    warnings: ['currency-mix-risk: orders.currency mixes EUR, USD'],
  }) as { title: { text: string; subtitle: string } }
  expect(kpi.title.subtitle).toBe('currency-mix-risk: orders.currency mixes EUR, USD')

  const tableRows = [{ region: 'North', revenue: 80 }]
  const table = compileChartIntent(
    { mark: 'table', title: 'Rows', x: 'region', y: 'revenue' },
    tableRows,
    {
      warnings: ['currency-mix-risk: orders.currency mixes EUR, USD'],
    },
  ) as { title: { subtitle: string } }
  expect(table.title.subtitle).toContain('currency-mix-risk: orders.currency mixes EUR, USD')
})

it('renders a chart carrying a query-time warning and a wide series legend as self-contained SVG', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ x: i, y: i, segment: `S${i}` }))
  const svg = await renderChartSvg(
    compileChartIntent(
      { mark: 'line', title: 'Net sales', x: 'x', y: 'y', series: 'segment' },
      rows,
      { warnings: ['currency-mix-risk: orders.currency mixes EUR, USD'] },
    ),
  )
  expect(svg).toContain('<svg')
  expect(svg).toContain('Net sales')
  expect(svg).toContain('currency-mix-risk')
  expect(svg).not.toMatch(/<script|<image|(?:href|src)=["']https?:/)
})

it('swaps horizontal bars axes without changing data or sorting meaning', async () => {
  const rows = [
    { region: 'Lower', revenue: 2 },
    { region: 'Higher', revenue: 9 },
  ]
  const spec = compileChartIntent(
    {
      mark: 'bar',
      title: 'Comparison',
      x: 'region',
      y: 'revenue',
      sort: { field: 'revenue', direction: 'descending' },
      format: {
        orientation: 'horizontal',
        color: '#123456',
        xLabel: 'Region',
        yLabel: 'Revenue',
        decimals: 2,
      },
    },
    rows,
  ) as { encoding: Record<string, unknown>; data: { values: unknown[] } }
  expect(spec.encoding.x).toMatchObject({
    field: 'revenue',
    title: 'Revenue',
    axis: { format: ',.2f' },
  })
  expect(spec.encoding.y).toMatchObject({
    field: 'region',
    title: 'Region',
    sort: { field: 'revenue', order: 'descending' },
  })
  expect(spec.data.values).toEqual(rows)
  const svg = await renderChartSvg(spec as Parameters<typeof renderChartSvg>[0])
  expect(svg).toContain('#123456')
  const labels = [...svg.matchAll(/<text[^>]*>(Higher|Lower)<\/text>/g)].map((match) => match[1])
  expect(labels).toEqual(['Higher', 'Lower'])
})

it('uses explicit year axes without changing years or inventing fractional tick labels', async () => {
  const spec = compileChartIntent(
    {
      mark: 'line',
      title: 'Annual incidents',
      x: 'year',
      y: 'incidents',
      format: { xTicks: 'year' },
    },
    [
      { year: 2015, incidents: 4 },
      { year: 2016, incidents: 5 },
    ],
  ) as { encoding: Record<string, unknown> }
  expect(spec.encoding.x).toMatchObject({
    axis: { format: 'd', tickMinStep: 1 },
    scale: { zero: false, nice: false },
  })
  const svg = await renderChartSvg(spec as Parameters<typeof renderChartSvg>[0])
  expect(svg).toContain('>2015</text>')
  expect(svg).not.toContain('>2,015</text>')
  const temporal = compileChartIntent(
    { mark: 'line', title: 'Dates', x: 'date', y: 'count', format: { xTicks: 'year' } },
    [{ date: '2015-01-01', count: 1 }],
  ) as { encoding: Record<string, unknown> }
  expect(temporal.encoding.x).toMatchObject({ type: 'temporal', axis: { format: '%Y' } })
})

it('infers integer X ticks for omitted/auto xTicks when all X values are safe integers', () => {
  const rows = [
    { bedrooms: 1, median_price: 100 },
    { bedrooms: 2, median_price: 200 },
    { bedrooms: 3, median_price: 300 },
  ]
  for (const format of [undefined, { xTicks: 'auto' as const }]) {
    const spec = compileChartIntent(
      {
        mark: 'bar',
        title: 'Median price by bedrooms',
        x: 'bedrooms',
        y: 'median_price',
        ...(format ? { format } : {}),
      },
      rows,
    ) as { encoding: { x: Record<string, unknown> } }
    expect(spec.encoding.x).toMatchObject({
      axis: { format: 'd', tickMinStep: 1 },
      scale: { nice: false },
    })
  }
})

it('does not infer integer X ticks when any X value is fractional', () => {
  const spec = compileChartIntent(
    {
      mark: 'bar',
      title: 'By baths',
      x: 'baths',
      y: 'price',
      format: { xTicks: 'auto' },
    },
    [
      { baths: 1, price: 100 },
      { baths: 1.5, price: 150 },
    ],
  ) as { encoding: { x: Record<string, unknown> } }
  expect(spec.encoding.x.axis).toBeUndefined()
  expect(spec.encoding.x.scale).toBeUndefined()
})

it('uses explicit integer X ticks with nice disabled on quantitative axes', () => {
  const spec = compileChartIntent(
    {
      mark: 'bar',
      title: 'By bedrooms',
      x: 'bedrooms',
      y: 'price',
      format: { xTicks: 'integer' },
    },
    [
      { bedrooms: 1, price: 100 },
      { bedrooms: 2, price: 200 },
    ],
  ) as { encoding: { x: Record<string, unknown> } }
  expect(spec.encoding.x).toMatchObject({
    axis: { format: 'd', tickMinStep: 1 },
    scale: { nice: false },
  })
})

it('rejects integer/year tick formats when values cannot support those labels', () => {
  for (const x of ['Country', '2015', 2015.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() =>
      compileChartIntent(
        { mark: 'line', title: 'Bad axis', x: 'x', y: 'y', format: { xTicks: 'integer' } },
        [{ x, y: 1 }],
      ),
    ).toThrow(/Integer ticks/)
  }
  for (const x of ['Country', 2015.5, 10000]) {
    expect(() =>
      compileChartIntent(
        { mark: 'line', title: 'Bad year', x: 'x', y: 'y', format: { xTicks: 'year' } },
        [{ x, y: 1 }],
      ),
    ).toThrow(/Year ticks/)
  }
})

it('retains explicit typed series colours after filtering and rejects unsafe presentation values', () => {
  const intent = {
    mark: 'bar' as const,
    title: 'Groups',
    x: 'x',
    y: 'y',
    series: 'segment',
    format: {
      seriesColors: [
        { value: 0, color: '#112233' },
        { value: 1, color: '#445566' },
      ],
    },
  }
  const spec = compileChartIntent(intent, [{ x: 1, y: 2, segment: 1 }]) as {
    encoding: Record<string, unknown>
  }
  expect(spec.encoding.color).toMatchObject({ scale: { domain: [1], range: ['#445566'] } })
  expect(() =>
    compileChartIntent({ ...intent, format: { color: 'url(https://evil.example)' } }, [
      { x: 1, y: 2, segment: 1 },
    ]),
  ).toThrow()
  expect(() =>
    compileChartIntent(
      {
        ...intent,
        format: {
          seriesColors: Array.from({ length: 21 }, (_, value) => ({ value, color: '#123456' })),
        },
      },
      [{ x: 1, y: 2, segment: 1 }],
    ),
  ).toThrow()
})

it('applies offered vertical formatting to both measures of a layered chart', async () => {
  const spec = compileChartIntent(
    {
      mark: 'line',
      title: 'Measures',
      x: 'year',
      y: 'a',
      y2: 'b',
      format: { yLabel: 'Observed count', decimals: 1, xTicks: 'year' },
    },
    [{ year: 2014, a: 12.5, b: 20.5 }],
  ) as unknown as { layer: Array<{ encoding: { y: unknown } }> }
  for (const layer of spec.layer)
    expect(layer.encoding.y).toMatchObject({ title: 'Observed count', axis: { format: ',.1f' } })
  expect(await renderChartSvg(spec as never)).toContain('Observed count')
})

it('groups mean and median series without implying additivity', async () => {
  const rows = [
    { statistic: 'mean', label: '0', amount: 88.29 },
    { statistic: 'mean', label: '1', amount: 122.21 },
    { statistic: 'median', label: '0', amount: 22 },
    { statistic: 'median', label: '1', amount: 9.25 },
  ]
  const intent = {
    mark: 'bar' as const,
    title: 'Amounts',
    x: 'statistic',
    y: 'amount',
    series: 'label',
  }
  for (const orientation of ['vertical', 'horizontal'] as const) {
    const compiled = compileChartIntent({ ...intent, format: { orientation } }, rows)
    const spec = compiled as unknown as {
      encoding: Record<string, Record<string, unknown>>
    }
    expect(spec.encoding[orientation === 'horizontal' ? 'yOffset' : 'xOffset']).toEqual({
      field: 'label',
      type: 'nominal',
    })
    expect(spec.encoding[orientation === 'horizontal' ? 'x' : 'y']?.stack).toBeNull()
    expect(await renderChartSvg(compiled)).toContain('<svg')
  }
})

it('renders imbalanced rates with counts and an explicitly additive stack', async () => {
  const rates = compileChartIntent(
    {
      mark: 'table',
      title: 'Observed rates with counts',
    },
    [
      { group: 'small', numerator: 1, denominator: 2, rate: 0.5 },
      { group: 'large', numerator: 9, denominator: 98, rate: 9 / 98 },
      { group: 'overall', numerator: 10, denominator: 100, rate: 0.1 },
    ],
  )
  const rateSvg = await renderChartSvg(rates)
  expect(rateSvg).toContain('Observed rates with counts')
  expect(rateSvg).toContain('numerator')
  expect(rateSvg).toContain('denominator')
  expect(rateSvg).toContain('0.1')

  const additiveRows = [
    { region: 'North', segment: 'Consumer', order_count: 80 },
    { region: 'North', segment: 'Corporate', order_count: 20 },
    { region: 'South', segment: 'Consumer', order_count: 30 },
    { region: 'South', segment: 'Corporate', order_count: 10 },
  ]
  const stacked = compileChartIntent(
    {
      mark: 'bar',
      title: 'Orders by region and segment',
      x: 'region',
      y: 'order_count',
      series: 'segment',
      stack: 'zero',
      format: { yLabel: 'Orders (count)', decimals: 0 },
    },
    additiveRows,
  ) as unknown as {
    encoding: Record<string, Record<string, unknown>>
  }
  expect(stacked.encoding.y?.stack).toBe('zero')
  expect(stacked.encoding.xOffset).toBeUndefined()
  expect(stacked.encoding.y?.title).toBe('Orders (count)')
  const stackSvg = await renderChartSvg(stacked as never)
  expect(stackSvg).toContain('Orders (count)')
  expect(stackSvg).toContain('North')
})

describe('chart-title wrapping (follow-on to the deliveryWidthPx-ignored-for-non-faceted-charts fix)', () => {
  // A long chart TITLE (as opposed to a long axis title, which
  // `wrapAxisTitle` already covers) independently forces Vega-Lite to widen
  // the whole rendered canvas to fit it on one line — the same
  // `deliveryWidthPx`-ignored shape `computePlotWidth` fixed for plot width,
  // one level up. These fixtures mirror the live-walkthrough title a model
  // naturally writes when charting two dimensions.
  const rows = [
    {
      parental_education: "associate's degree",
      test_preparation: 'completed',
      avg_math_score: 71.83,
    },
    { parental_education: "associate's degree", test_preparation: 'none', avg_math_score: 65.57 },
    { parental_education: 'high school', test_preparation: 'completed', avg_math_score: 65.0 },
    { parental_education: 'high school', test_preparation: 'none', avg_math_score: 60.99 },
  ]
  const baseIntent = {
    mark: 'bar' as const,
    x: 'parental_education',
    y: 'avg_math_score',
    series: 'test_preparation',
  }
  const shortTitle = 'Scores by education'
  const longTitle = 'Average math score by parental education and test preparation course'

  it('leaves a short title under the wrap threshold as a plain string, unchanged', () => {
    const spec = compileChartIntent({ ...baseIntent, title: shortTitle }, rows, {
      deliveryWidthPx: deliveryWidthPxForProfile('chat-card'),
    }) as unknown as { title: unknown }
    expect(spec.title).toBe(shortTitle)
  })

  it('wraps a long title into multiple lines that join back to the original words, losing nothing', () => {
    const spec = compileChartIntent({ ...baseIntent, title: longTitle }, rows, {
      deliveryWidthPx: deliveryWidthPxForProfile('chat-card'),
    }) as unknown as { title: unknown }
    expect(Array.isArray(spec.title)).toBe(true)
    const lines = spec.title as string[]
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(' ')).toBe(longTitle)
    // No single line should be left as long as the original unwrapped title.
    for (const line of lines) {
      expect(line.length).toBeLessThan(longTitle.length)
    }
  })

  it('wraps into shorter lines at a narrower delivery width than at a wider one', () => {
    const narrowSpec = compileChartIntent({ ...baseIntent, title: longTitle }, rows, {
      deliveryWidthPx: deliveryWidthPxForProfile('chat-card'),
    }) as unknown as { title: unknown }
    const wideSpec = compileChartIntent({ ...baseIntent, title: longTitle }, rows, {
      deliveryWidthPx: deliveryWidthPxForProfile('export'),
    }) as unknown as { title: unknown }
    // The wide delivery may not need to wrap the title at all; the narrow
    // one, sized for the exact reproduction, always does.
    expect(Array.isArray(narrowSpec.title)).toBe(true)
    const narrowLongestLine = Math.max(...(narrowSpec.title as string[]).map((line) => line.length))
    const wideLongestLine = Array.isArray(wideSpec.title)
      ? Math.max(...(wideSpec.title as string[]).map((line) => line.length))
      : (wideSpec.title as string).length
    expect(narrowLongestLine).toBeLessThan(wideLongestLine)
  })

  it('still folds query-warning caveats into the subtitle alongside a wrapped title', () => {
    const spec = compileChartIntent({ ...baseIntent, title: longTitle }, rows, {
      deliveryWidthPx: deliveryWidthPxForProfile('chat-card'),
      warnings: ['Join fan-out risk'],
    }) as unknown as { title: { text: unknown; subtitle: string } }
    expect(Array.isArray(spec.title.text)).toBe(true)
    expect((spec.title.text as string[]).join(' ')).toBe(longTitle)
    expect(spec.title.subtitle).toBe('Join fan-out risk')
  })
})
