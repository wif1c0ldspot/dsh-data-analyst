/**
 * `export_dashboard` / `writeDashboardExportPack`: compose every pinned
 * analysis of a dashboard into one offline HTML report. No network; uses a
 * temp workspace with synthetic stored results and a single chart artifact.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { saveAnalysisRevision } from 'dsh-data-core/analysis-store'
import type { DatasetManifest } from 'dsh-data-core/contracts'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths, type WorkspacePaths } from 'dsh-data-core/workspace-paths'
import { writeDashboardExportPack, writeExportPack } from '../src/export-pack.js'
import { handleDashboardExportRequest } from '../src/ui-routes.js'

let directory: string
let workspace: WorkspacePaths

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-dashboard-export-'))
  workspace = resolveWorkspacePaths(directory)
  await mkdir(workspace.resultsDir, { recursive: true })
  await mkdir(workspace.artifactsDir, { recursive: true })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it.each([0, 1])(
  'preserves workingday=%s binds in single and dashboard exports',
  async (workingday) => {
    const store = new MetadataStore(workspace.catalogPath)
    let dashboardId: string
    try {
      const manifest: DatasetManifest = {
        contractVersion: 1,
        datasetId: 'retail',
        datasetVersionId: 'retail-v1',
        source: {
          slug: 'test/retail',
          version: '1',
          url: 'https://example.invalid',
          retrievedAt: new Date().toISOString(),
          license: null,
        },
        files: [],
        recipeHash: 'test',
        importerVersion: '0.1.0',
        tables: [{ id: 'orders', sourceFile: 'x.csv', rows: 1, rejectedRows: 0 }],
      }
      store.publishDatasetVersion(manifest)

      const withChart = await saveAnalysisRevision(workspace.catalogPath, {
        datasetVersionId: 'retail-v1',
        semanticRevisionId: 'sem-retail-v1',
        question: 'Revenue by region. ' + 'Important scope caveat. '.repeat(20),
        query: {
          datasetVersionId: 'retail-v1',
          semanticRevisionId: 'sem-retail-v1',
          sql: 'SELECT region FROM orders WHERE workingday = ?',
          parameters: [{ logicalType: 'INTEGER', value: workingday }],
        },
        resultId: 'res_chart',
        chart: {
          mark: 'bar',
          x: 'region',
          y: 'revenue',
          title: 'Revenue by region',
          format: { decimals: 2 },
        },
        artifactIds: ['art_chart'],
      })
      const tableOnly = await saveAnalysisRevision(workspace.catalogPath, {
        datasetVersionId: 'retail-v1',
        semanticRevisionId: 'sem-retail-v1',
        question: 'Top products',
        query: {
          datasetVersionId: 'retail-v1',
          semanticRevisionId: 'sem-retail-v1',
          sql: 'SELECT product FROM orders LIMIT 5',
          parameters: [],
        },
        resultId: 'res_table',
        chart: { mark: 'table', title: 'Top products' },
        artifactIds: [],
      })

      await writeFile(
        join(workspace.resultsDir, 'res_chart.json'),
        JSON.stringify({
          resultId: 'res_chart',
          datasetVersionId: 'retail-v1',
          semanticRevisionId: 'sem-retail-v1',
          sql: 'SELECT region FROM orders WHERE workingday = ?',
          columns: [
            { name: 'region', logicalType: 'VARCHAR' },
            { name: 'revenue', logicalType: 'DECIMAL(18,3)' },
            { name: 'recorded_on', logicalType: 'DATE' },
          ],
          preview: [
            ['North', '1000.125', '2026-01-02'],
            ['South', null, '2026-01-03'],
          ],
          rows: [
            ['North', '1000.125', '2026-01-02'],
            ['South', null, '2026-01-03'],
          ],
          rowCount: 2,
          previewTruncated: false,
          warnings: [],
        }),
        'utf8',
      )
      await writeFile(
        join(workspace.resultsDir, 'res_table.json'),
        JSON.stringify({
          resultId: 'res_table',
          datasetVersionId: 'retail-v1',
          semanticRevisionId: 'sem-retail-v1',
          sql: 'SELECT product FROM orders LIMIT 5',
          columns: [{ name: 'product', logicalType: 'VARCHAR' }],
          preview: [['Widget']],
          rows: [['Widget']],
          rowCount: 5,
          previewTruncated: false,
          warnings: [],
        }),
        'utf8',
      )

      await writeFile(
        join(workspace.artifactsDir, 'art_chart.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><text>chart</text></svg>',
        'utf8',
      )
      await writeFile(
        join(workspace.artifactsDir, 'art_chart.json'),
        JSON.stringify({
          resultId: 'res_chart',
          intent: {
            mark: 'bar',
            x: 'region',
            y: 'revenue',
            title: 'Revenue by region',
            format: { decimals: 2 },
          },
        }),
        'utf8',
      )

      const single = await writeExportPack({
        workspace,
        analysisId: withChart.analysisId,
        resultId: 'res_chart',
        artifactId: 'art_chart',
      })
      const singleHtml = await readFile(join(workspace.artifactsDir, single.files.html), 'utf8')
      expect(singleHtml).toContain('<h1>Revenue by region</h1>')
      expect(singleHtml).toContain('<td>1,000.13</td>')
      expect(singleHtml).toContain('<td>1000.125</td>')
      expect(singleHtml).toContain('<td>—</td>')
      expect(singleHtml).toContain('<td>NULL</td>')
      expect(singleHtml).toContain('<td>2026-01-02</td>')
      expect(singleHtml).toContain(`INTEGER: <code>${workingday}</code>`)
      const specification = JSON.parse(
        await readFile(join(workspace.artifactsDir, single.files.specification), 'utf8'),
      )
      expect(specification.parameters).toEqual([{ logicalType: 'INTEGER', value: workingday }])
      // Missing bind metadata must not become an invented empty parameter array.
      await expect(
        writeExportPack({ workspace, resultId: 'res_chart', artifactId: 'art_chart' }),
      ).rejects.toThrow('parameter provenance unavailable')

      const dashboard = store.saveDashboard({ title: 'Quarterly review' })
      dashboardId = dashboard.dashboardId
      store.pinAnalysisToDashboard(
        dashboardId,
        withChart.analysisId,
        withChart.revision,
        'Revenue by region. ' + 'Important scope caveat. '.repeat(20),
      )
      store.pinAnalysisToDashboard(
        dashboardId,
        tableOnly.analysisId,
        tableOnly.revision,
        'Analyst curated products',
      )
    } finally {
      store.close()
    }

    const exported = await writeDashboardExportPack({
      workspace,
      dashboardId,
      summary: 'Revenue grew 12% QoQ.',
    })

    expect(exported.dashboardId).toBe(dashboardId)
    expect(exported.slotCount).toBe(2)
    expect(exported.slots).toEqual([
      expect.objectContaining({
        revision: 1,
        resultId: 'res_chart',
        sharedFilterKeys: [],
      }),
      expect.objectContaining({
        revision: 1,
        resultId: 'res_table',
        sharedFilterKeys: [],
      }),
    ])
    expect(exported.downloads.html).toMatch(
      /^\/api\/analyst\/reports\?file=export_[a-f0-9]{32}\.html$/,
    )
    const registryBeforeMutation = new MetadataStore(workspace.catalogPath)
    const registered = registryBeforeMutation.listReportExports()
    expect(registered).toHaveLength(2)
    expect(registered[0]).toMatchObject({
      reportId: exported.reportId,
      title: 'Quarterly review',
      source: {
        kind: 'dashboard',
        dashboardId,
        slots: [
          { analysisId: expect.any(String), revision: 1, resultId: 'res_chart' },
          { analysisId: expect.any(String), revision: 1, resultId: 'res_table' },
        ],
      },
    })
    expect(registered[1]).toMatchObject({
      reportId: expect.any(String),
      title: 'Revenue by region',
      source: { kind: 'analysis', revision: 1, resultId: 'res_chart' },
    })
    registryBeforeMutation.renameDashboard(dashboardId, 'Renamed after export')
    expect(registryBeforeMutation.listReportExports()[0]).toEqual(registered[0])
    registryBeforeMutation.close()

    const html = await readFile(join(workspace.artifactsDir, exported.files.html), 'utf8')
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Quarterly review')
    // Facts-only: a generated summary without an approved interpretation is
    // withheld, and the report says so, instead of printing both.
    expect(html).not.toContain('Revenue grew 12% QoQ.')
    expect(html).not.toContain('<aside class="summary">')
    expect(html).toContain('class="interpretation-omitted"')
    expect(html).toContain('Interpretation review: unreviewed')
    expect(html).toContain('<h2>Revenue by region</h2>')
    expect(html).toContain('<p class="analysis-context">Revenue by region. Important scope caveat.')
    const catalog = new MetadataStore(workspace.catalogPath)
    const expectedVersion = catalog.loadDashboard(dashboardId)!.updatedAt
    catalog.close()
    const response = await handleDashboardExportRequest(
      new Request('http://localhost/api/analyst/ui/dashboard/export', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
          host: 'localhost',
        },
        body: JSON.stringify({ dashboardId, expectedVersion, template: 'executive-summary' }),
      }),
      workspace.catalogPath,
    )
    expect(response.status).toBe(200)
    const fragment = await response.text()
    const previewFile = fragment.match(/file=(export_[^"]+\.html)/)?.[1]
    expect(previewFile).toBeDefined()
    expect(await readFile(join(workspace.artifactsDir, previewFile!), 'utf8')).toContain(
      'data-report-template="executive-summary"',
    )

    expect(html).toContain(`INTEGER: <code>${workingday}</code>`)
    // Facts-only again on the second read: the summary never reaches the file.
    expect(html).not.toContain('Revenue grew 12% QoQ.')
    expect(html).toContain('class="interpretation-omitted"')
    expect(html).toContain('Revenue by region')
    expect(html).toContain('Analyst curated products')
    expect(html).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><text>chart</text></svg>',
    )
    expect(html).toContain('<td>Widget</td>')
    // Self-contained: no script and no remote src/href resource (the SVG xmlns
    // namespace URI is a namespace identifier, not a fetched resource).
    expect(html).not.toMatch(/<script|(?:src|href)="https?:/i)

    // Stakeholder ZIP bundles the report + per-section artifacts.
    expect(exported.downloads.zip).toMatch(
      /^\/api\/analyst\/reports\?file=export_[a-f0-9]{32}\.zip$/,
    )
    const zipBytes = await readFile(join(workspace.artifactsDir, exported.files.zip))
    expect(zipBytes.length).toBeGreaterThan(0)
    const zipHeader = zipBytes.subarray(0, 4).toString('ascii')
    expect(zipHeader).toBe('PK\u0003\u0004') // local file header signature

    // Opting in is necessary but not sufficient: the pinned revisions are still
    // unreviewed, so the generated summary stays out of the shareable report.
    const optedIn = await writeDashboardExportPack({
      workspace,
      dashboardId,
      summary: 'Revenue grew 12% QoQ.',
      narrative: { includeInterpretation: true },
    })
    const optedInHtml = await readFile(join(workspace.artifactsDir, optedIn.files.html), 'utf8')
    expect(optedInHtml).not.toContain('Revenue grew 12% QoQ.')
    expect(optedInHtml).not.toContain('<aside class="summary">')
    expect(optedInHtml).toContain('class="interpretation-omitted"')
  },
)

it('rejects an unknown dashboard and a dashboard with no pinned analyses', async () => {
  const store = new MetadataStore(workspace.catalogPath)
  try {
    const empty = store.saveDashboard({ title: 'Empty' })
    await expect(
      writeDashboardExportPack({ workspace, dashboardId: empty.dashboardId }),
    ).rejects.toThrow(/no pinned analyses/)
    await expect(
      writeDashboardExportPack({ workspace, dashboardId: 'dash_missing' }),
    ).rejects.toThrow(/Unknown dashboard/)
    expect(store.listReportExports()).toEqual([])
  } finally {
    store.close()
  }
})
