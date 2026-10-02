import type { AnalysisRevision, Dashboard } from 'dsh-data-core/contracts'
import { expect, it } from 'vitest'
import { renderAnalysisFragment, renderDashboardFragment } from '../src/ui-fragments.js'

const analysis = {
  contractVersion: 1,
  analysisId: 'ana_1',
  revision: 1,
  datasetVersionId: 'ds_1',
  semanticRevisionId: 'sem_1',
  question: '<script>x</script>',
  query: { datasetVersionId: 'ds_1', semanticRevisionId: 'sem_1', sql: 'SELECT 1', parameters: [] },
  resultId: 'result_1',
  chart: { mark: 'bar', title: 'Sales', x: 'region', y: 'sales' },
  artifactIds: ['artifact_1'],
  createdAt: '2026-09-15T00:00:00.000Z',
} satisfies AnalysisRevision

const dashboard: Dashboard = {
  dashboardId: 'dash_1',
  title: '<Dashboard>',
  layout: {
    slots: [
      {
        analysisId: analysis.analysisId,
        revision: analysis.revision,
        title: '<Card>',
        sharedFilterKeys: ['region'],
      },
    ],
  },
  archived: false,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T01:00:00.000Z',
}

it('escapes analysis question text in fragment', () => {
  const html = renderAnalysisFragment(analysis, '1')
  expect(html).not.toContain('<script>')
  expect(html).toContain('&lt;script&gt;')
  expect(html).toContain('aria-label="Analysis composition"')
  expect(html).not.toContain('Datasets')
})

it('renders analysis export control targeting the UI export route', () => {
  const html = renderAnalysisFragment(analysis, '1')
  expect(html).toContain('data-analyst-action="export"')
  expect(html).toContain('data-analyst-url="/api/analyst/ui/analysis/export"')
  expect(html).toMatch(/<button[^>]*>Preview and export report<\/button>/)
})

it('renders a dashboard fragment with escaped card content and no app navigation', () => {
  const html = renderDashboardFragment(dashboard, [analysis], '2026-09-15T01:00:00.000Z')
  expect(html).toContain('aria-label="Dashboard shared filters"')
  expect(html).toContain('aria-label="Dashboard analysis cards"')
  expect(html).toContain('&lt;Dashboard&gt;')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('Imports')
  expect(html).toContain('&lt;Card&gt;')
  expect(html).not.toContain('<h3>Sales</h3>')
})

it('uses the chart title only for the legacy question-as-title default', () => {
  const legacy = {
    ...dashboard,
    layout: {
      slots: [{ ...dashboard.layout.slots[0]!, title: analysis.question }],
    },
  }
  const html = renderDashboardFragment(legacy, [analysis], '2026-09-15T01:00:00.000Z')
  expect(html).toContain('<h3>Sales</h3>')
  expect(html).toContain('Analysis context and source caveats')
})

it('renders dashboard filter, pin, and map-keys composition controls', () => {
  const html = renderDashboardFragment(dashboard, [analysis], '2026-09-15T01:00:00.000Z')
  expect(html).toContain('data-analyst-action="filter"')
  expect(html).toContain('data-analyst-url="/api/analyst/ui/dashboard/filter"')
  expect(html).toContain('name="column"')
  expect(html).toContain('name="value"')
  expect(html).toContain('data-analyst-action="pin"')
  expect(html).toContain('name="dashboardId"')
  expect(html).toContain('name="analysisId"')
  expect(html).toContain('data-analyst-action="map-keys"')
  expect(html).toContain('data-analyst-url="/api/analyst/ui/dashboard/map-keys"')
  expect(html).toContain('name="keys"')
})

it('offers a schema-backed column selector for the shared filter when cards mapped keys', () => {
  const html = renderDashboardFragment(dashboard, [analysis], '2026-09-15T01:00:00.000Z')
  expect(html).toContain('<select name="column" required>')
  expect(html).toContain('<option value="region">region</option>')
  expect(html).not.toContain('name="column" type="text"')
})

it('disables shared filtering until a card has a mapped field', () => {
  const noKeys: Dashboard = {
    ...dashboard,
    layout: { slots: [{ ...dashboard.layout.slots[0]!, sharedFilterKeys: [] }] },
  }
  const html = renderDashboardFragment(noKeys, [analysis], '2026-09-15T01:00:00.000Z')
  expect(html).toContain('<select name="column" disabled>')
  expect(html).toContain('disabled>Apply shared filter</button>')
  expect(html).not.toContain('name="column" type="text"')
})

it('renders persisted active-filter scope, counts, and clear control', () => {
  const filtered: Dashboard = {
    ...dashboard,
    activeFilter: {
      column: 'region',
      value: '<North>',
      scope: 'saved-result',
      appliedDashboardVersion: dashboard.updatedAt,
      cards: [
        {
          analysisId: analysis.analysisId,
          baseRevision: 1,
          filteredRevision: 2,
          status: 'changed',
        },
        { analysisId: 'ana_2', baseRevision: 1, status: 'unmapped' },
      ],
    },
  }
  const html = renderDashboardFragment(filtered, [analysis], filtered.updatedAt)
  expect(html).toContain('Active filter:')
  expect(html).toContain('region = &lt;North&gt;')
  expect(html).toContain('Scope: saved result rows')
  expect(html).toContain('Current cards: 1 changed · 0 unmapped')
  expect(html).toContain('1 card was removed since this filter was applied')
  expect(html).toContain('Clear ignores removed cards')
  expect(html).toContain('data-analyst-action="filter-clear"')
})

it('discloses legacy filtered revisions without offering an unsafe clear', () => {
  const legacyAnalysis: AnalysisRevision = {
    ...analysis,
    question: 'Sales [filter region=North]',
    query: {
      ...analysis.query,
      sql: `WITH _analysis_filter AS (SELECT 1) SELECT * FROM _analysis_filter WHERE "region" = 'North'`,
    },
  }
  const html = renderDashboardFragment(dashboard, [legacyAnalysis], dashboard.updatedAt)
  expect(html).toContain('without trustworthy base metadata')
  expect(html).toContain('analysis history')
  expect(html).not.toContain('data-analyst-action="filter-clear"')
})
