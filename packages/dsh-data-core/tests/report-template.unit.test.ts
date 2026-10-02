import { describe, expect, it } from 'vitest'
import { escapeHtml, renderHtmlDashboardReport, renderHtmlReport } from '../src/report-template.js'

describe('renderHtmlReport', () => {
  const base = {
    title: 'Net sales by region',
    svgMarkup: '<svg><text>North</text></svg>',
    columns: [
      { name: 'region', logicalType: 'VARCHAR' },
      { name: 'revenue', logicalType: 'DECIMAL(18,2)', unit: 'USD' },
    ],
    rows: [
      ['North', '80.00'],
      ['South', '50.00'],
    ],
    rowCount: 2,
    previewTruncated: false,
    sourceCaption: 'Synthetic retail fixture (development split)',
    datasetVersionId: 'synthetic-retail-v1',
    semanticRevisionId: 'retail-semantics-v1',
    generatedAt: '2026-09-13T00:00:00.000Z',
    warnings: [],
  }

  it('embeds the SVG, table, and source caption; opens as a self-contained document', () => {
    const html = renderHtmlReport(base)
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('<svg><text>North</text></svg>')
    expect(html).toContain('Synthetic retail fixture (development split)')
    expect(html).toContain('<td>North</td>')
    expect(html).toContain('<td>80.00</td>')
    expect(html).toContain('synthetic-retail-v1')
    // Self-contained: no remote script, stylesheet, or image reference.
    expect(html).not.toMatch(/<script|https?:\/\//)
  })

  it('escapes untrusted-looking values instead of interpreting them as markup', () => {
    const html = renderHtmlReport({
      ...base,
      title: '<script>alert(1)</script>',
      rows: [['<b>North</b>', '80.00']],
      warnings: ['"quoted" & <tagged> warning'],
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<b>North</b>')
    expect(html).toContain('&lt;b&gt;North&lt;/b&gt;')
    expect(html).toContain('&quot;quoted&quot; &amp; &lt;tagged&gt; warning')
  })

  it('surfaces an explicit empty-result notice instead of an implicit zero', () => {
    const html = renderHtmlReport({ ...base, rows: [], rowCount: 0 })
    expect(html).toContain('This query returned no rows')
  })

  it('surfaces a preview-truncation notice distinct from an empty result', () => {
    const html = renderHtmlReport({ ...base, previewTruncated: true })
    expect(html).toContain('Preview truncated')
    expect(html).not.toContain('This query returned no rows')
  })

  it('defaults to facts-only narrative and includes interpretation only when requested', () => {
    const factsOnly = renderHtmlReport({
      ...base,
      narrative: {
        computedFindings: [
          {
            reference: {
              resultId: 'res_test',
              datasetVersionId: 'synthetic-retail-v1',
              semanticRevisionId: 'retail-semantics-v1',
              operation: 'row_count',
            },
            exactValue: '2',
            sentence: 'Stored result row count is 2 (scoped to the stored query result).',
            complete: true,
            rowCount: 2,
          },
        ],
        findings: ['North led by <12%>'],
        caveats: ['Nulls remain missing'],
        nextSteps: ['Review the exact values'],
      },
      rows: [
        ['North', '1000.125'],
        ['Empty', ''],
        ['Zero', '0'],
        ['Missing', 'NULL'],
      ],
      displayRows: [
        ['North', '1,000.13'],
        ['Empty', ''],
        ['Zero', '0.00'],
        ['Missing', '—'],
      ],
      rowCount: 4,
    })
    expect(factsOnly).toContain('<h2>Computed findings</h2>')
    expect(factsOnly).toContain('Stored result row count is 2')
    expect(factsOnly).toContain('Generated interpretation omitted')
    expect(factsOnly).not.toContain('<h2>Generated interpretation</h2>')
    expect(factsOnly).toContain('class="display-values"')
    expect(factsOnly).toContain('<td>1,000.13</td>')
    expect(factsOnly).toContain('<summary>Exact values</summary>')
    expect(factsOnly).toContain('<td>1000.125</td>')

    const withInterpretation = renderHtmlReport({
      ...base,
      narrative: {
        findings: ['North led by <12%>'],
        caveats: ['Nulls remain missing'],
        nextSteps: ['Review the exact values'],
        includeInterpretation: true,
        interpretationReview: { status: 'approved', analysisRevision: 3 },
      },
    })
    expect(withInterpretation).toContain('<h2>Generated interpretation</h2>')
    expect(withInterpretation).toContain('North led by &lt;12%&gt;')
    expect(withInterpretation).toContain('<h2>Caveats</h2>')
    expect(withInterpretation).toContain('<h2>Next steps</h2>')
    expect(withInterpretation).toContain('Interpretation review: approved (revision 3)')
  })
})

describe('renderHtmlDashboardReport', () => {
  const sections = [
    {
      question: 'Sales by region',
      svgMarkup: '<svg><text>North</text></svg>',
      columns: [{ name: 'region', logicalType: 'VARCHAR' }],
      rows: [['North']],
      rowCount: 1,
      sourceCaption: 'retail-v1 / semantics-v1',
    },
    {
      question: 'Top products',
      columns: [{ name: 'product', logicalType: 'VARCHAR' }],
      rows: [['Widget']],
      rowCount: 5,
      sourceCaption: 'retail-v1 / semantics-v1',
      sql: 'SELECT product FROM retail LIMIT 5',
    },
  ]

  it('composes the title, executive summary, and one section per card', () => {
    const html = renderHtmlDashboardReport({
      title: 'Quarterly review',
      summary: 'Revenue grew 12% QoQ.',
      interpretationApproved: true,
      sections,
      generatedAt: '2026-09-15T00:00:00.000Z',
    })
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Quarterly review')
    expect(html).toContain('Revenue grew 12% QoQ.')
    // Approved interpretation is labelled as generated, not as analyst-authored.
    expect(html).toContain('<h2>Generated interpretation</h2>')
    expect(html).not.toContain('interpretation-omitted')
    expect(html).toContain('Sales by region')
    expect(html).toContain('Top products')
    expect(html).toContain('<svg><text>North</text></svg>')
    expect(html).toContain('<td>Widget</td>')
    // Self-contained: no remote script, stylesheet, or image reference.
    expect(html).not.toMatch(/<script|https?:\/\//)
  })

  it('withholds an unapproved interpretation instead of printing it above a note claiming it was omitted', () => {
    // The live bitcoin export shipped the generated interpretation in
    // <aside class="summary"> directly above "Generated interpretation omitted
    // from this shareable report (facts-only). Interpretation review: unreviewed".
    const html = renderHtmlDashboardReport({
      title: 'BTC daily returns',
      summary: 'The distribution is sharply peaked just below zero.',
      sections,
      generatedAt: '2026-09-15T00:00:00.000Z',
    })
    expect(html).not.toContain('<aside class="summary">')
    expect(html).not.toContain('sharply peaked')
    expect(html).toContain('class="interpretation-omitted"')
    expect(html).toContain('Interpretation review: unreviewed')
  })

  it('does not let a direct caller print an unapproved interpretation, and says what was withheld', () => {
    // The export route derives `interpretationApproved` and the narrative flag from the
    // stored review, but a direct caller could pass `includeInterpretation: true` with an
    // unapproved summary: the narrative printed anyway while the summary vanished with no
    // note. `interpretationApproved` is authoritative now.
    const html = renderHtmlDashboardReport({
      title: 'BTC daily returns',
      summary: 'Summary that must not ship.',
      narrative: { findings: ['Finding text.'], includeInterpretation: true },
      sections,
      generatedAt: '2026-09-15T00:00:00.000Z',
    })
    expect(html).not.toContain('<aside class="summary">')
    expect(html).not.toContain('Summary that must not ship.')
    expect(html).not.toContain('Finding text.')
    expect(html).not.toContain('<h2>Generated interpretation</h2>')
    expect(html.match(/interpretation-omitted/g)).toHaveLength(1)
  })

  it('never turns an explicit includeInterpretation:false into printed interpretation', () => {
    // Approval is a ceiling, not an instruction. Forcing the flag in both directions
    // would print interpretation a caller deliberately left out.
    const html = renderHtmlDashboardReport({
      title: 'BTC daily returns',
      summary: 'Approved summary.',
      interpretationApproved: true,
      narrative: { findings: ['Finding text.'], includeInterpretation: false },
      sections,
      generatedAt: '2026-09-15T00:00:00.000Z',
    })
    expect(html).toContain('Approved summary.')
    expect(html).not.toContain('Finding text.')
    expect(html.match(/interpretation-omitted/g)).toHaveLength(1)
  })

  it('emits the withheld note once when the narrative already carries interpretation', () => {
    const html = renderHtmlDashboardReport({
      title: 'BTC daily returns',
      summary: 'Summary that must not ship.',
      narrative: { findings: ['Finding text.'], nextSteps: ['Next step.'] },
      sections,
      generatedAt: '2026-09-15T00:00:00.000Z',
    })
    expect(html).not.toContain('Summary that must not ship.')
    expect(html).not.toContain('Finding text.')
    expect(html.match(/interpretation-omitted/g)).toHaveLength(1)
  })

  it('renders number-backed KPI cards above the chart sections and escapes them', () => {
    const html = renderHtmlDashboardReport({
      title: 'Quarterly review',
      kpis: [
        { label: 'Total incidents', value: '11,650', note: '1988–2017' },
        { label: 'Fatalities', value: '<b>12,758</b>' },
      ],
      sections,
      generatedAt: '2026-09-15T00:00:00.000Z',
    })
    expect(html).toContain('class="kpis"')
    expect(html).toContain('>11,650<')
    expect(html).toContain('Total incidents')
    expect(html).toContain('1988–2017')
    expect(html).not.toContain('<b>12,758</b>')
    expect(html).toContain('&lt;b&gt;12,758&lt;/b&gt;')
  })

  it('omits the figure for a table-only card', () => {
    const html = renderHtmlDashboardReport({
      title: 'T',
      sections: [sections[1]!],
      generatedAt: '2026-09-15T00:00:00.000Z',
    })
    expect(html).toContain('Top products')
    expect(html).not.toContain('<figure>')
  })

  it('escapes the summary, question, and cell values instead of interpreting markup', () => {
    const html = renderHtmlDashboardReport({
      title: 'T',
      summary: '<img src=x onerror=alert(1)>',
      sections: [
        {
          question: '<b>bold</b>',
          context: '<script>context</script>',
          columns: [{ name: 'c', logicalType: 'VARCHAR' }],
          rows: [['<script>bad()</script>']],
          rowCount: 1,
          sourceCaption: 'src',
        },
      ],
      generatedAt: '2026-09-15T00:00:00.000Z',
    })
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<b>bold</b>')
    expect(html).toContain('&lt;script&gt;context&lt;/script&gt;')
    expect(html).not.toContain('<script>bad()</script>')
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;')
  })
})

describe('escapeHtml', () => {
  it('escapes the five reserved characters', () => {
    expect(escapeHtml(`<a href="x">it's & "that"</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; &quot;that&quot;&lt;/a&gt;',
    )
  })
})

it('prints verified full-result evidence, revision provenance, and bounded table disclosure offline', () => {
  const html = renderHtmlDashboardReport({
    title: 'Demand',
    generatedAt: '2026-09-16',
    sections: [
      {
        question: 'Hourly demand',
        columns: [{ name: 'mean', logicalType: 'DOUBLE' }],
        rows: [['10']],
        rowCount: 48,
        sourceCaption: 'Bike demand',
        evidence: {
          resultId: 'res_bike',
          datasetVersionId: 'bike-v1',
          semanticRevisionId: 'sem-v1',
          analysisId: 'ana_bike',
          revision: 3,
          filter: 'workingday = 1',
          scope: 'Stored query rows only',
          complete: true,
          rowCount: 48,
          warnings: [],
          facts: [
            {
              column: 'mean',
              minimum: 10,
              maximum: 525.29,
              minimumRow: 0,
              maximumRow: 41,
              nonNullCount: 48,
              integerDomain: false,
              distinctCount: 2,
            },
          ],
        },
      },
    ],
  })
  expect(html).toContain('525.29 (row 42)')
  expect(html).toContain('Revision 3')
  expect(html).toContain('workingday = 1')
  expect(html).toContain('Showing 1;')
  expect(html).toContain('@media print')
  expect(html).not.toMatch(/<script|https?:\/\//)
})

it('uses distinct versioned report compositions without fabricating cross-view comparisons', () => {
  const sections = [
    {
      question: 'Workdays',
      columns: [{ name: 'hour', logicalType: 'INTEGER' }],
      rows: [['17']],
      rowCount: 1,
      sourceCaption: 'Bike source · workingday = 1',
      sql: 'SELECT hour WHERE workingday = $1',
      parameters: [{ logicalType: 'INTEGER', value: 1 }],
    },
  ]
  for (const template of ['analytical-brief', 'comparison', 'executive-summary'] as const) {
    const html = renderHtmlDashboardReport({
      template,
      title: 'Bike review',
      sections,
      generatedAt: '2026-09-16',
    })
    expect(html).toContain(`data-report-template="${template}" data-template-version="1"`)
    expect(html).toContain('workingday = $1')
    expect(html).toContain('INTEGER: <code>1</code>')
    expect(html).not.toMatch(/<script|<iframe|<button/)
    if (template === 'comparison') {
      expect(html).toContain('class="report-sections comparison-grid"')
      expect(html).toContain('no cross-view difference is inferred')
    }
    if (template === 'executive-summary') {
      expect(html.indexOf('Verified findings')).toBeLessThan(html.indexOf('class="report-sections'))
      expect(html).toContain('No verified numeric facts available')
    }
  }
})

it('rejects unknown template names at the renderer boundary', () => {
  expect(() =>
    renderHtmlDashboardReport({
      template: 'custom-html' as never,
      title: 'T',
      sections: [],
      generatedAt: 'now',
    }),
  ).toThrow()
})
