/**
 * Executes catalog/ingest/query/chart/save/export tools through the dsh
 * registry against the synthetic retail fixture (no network, no model).
 */
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as DuckDBPlugin from '../packages/dsh-data-duckdb/dist/index.js'
import * as KagglePlugin from '../packages/dsh-data-kaggle/dist/index.js'
import * as VizPlugin from '../packages/dsh-data-viz/dist/index.js'
import * as WorkbenchPlugin from '../packages/dsh-data-workbench/dist/index.js'
import { MetadataStore } from '../packages/dsh-data-core/dist/metadata-store.js'

let directory: string
let archivePath: string
let previousWorkspace: string | undefined
let previousArchive: string | undefined

async function buildFixtureArchive(destination: string): Promise<string> {
  const fixtureCsvPath = fileURLToPath(new URL('./fixtures/retail.csv', import.meta.url))
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(await readFile(fixtureCsvPath), 'retail.csv')
  const path = join(destination, 'source.zip')
  const writeStream = createWriteStream(path)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return path
}

function parseToolJson(result: {
  content: unknown
  isError?: boolean
  value?: unknown
}): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
  expect(result.value).toBeTruthy()
  return result.value as Record<string, unknown>
}

function parseToolObserve(result: { content: unknown }): Record<string, unknown> {
  const content = Array.isArray(result.content) ? result.content : []
  const text = content.find(
    (item): item is { type: 'text'; text: string } =>
      typeof item === 'object' &&
      item !== null &&
      (item as { type?: unknown }).type === 'text' &&
      typeof (item as { text?: unknown }).text === 'string',
  )?.text
  expect(text).toBeTypeOf('string')
  const match = text!.match(/^<<observe kind=catalog>>\n([\s\S]+)\n<<\/observe>>$/)
  expect(match).not.toBeNull()
  return JSON.parse(match![1]!) as Record<string, unknown>
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-r2-tools-'))
  await mkdir(join(directory, 'sources'), { recursive: true })
  archivePath = await buildFixtureArchive(directory)
  previousWorkspace = process.env.DSH_DATA_WORKSPACE
  previousArchive = process.env.DSH_DATA_LOCAL_ARCHIVE
  process.env.DSH_DATA_WORKSPACE = directory
  process.env.DSH_DATA_LOCAL_ARCHIVE = archivePath
})

afterEach(async () => {
  if (previousWorkspace === undefined) delete process.env.DSH_DATA_WORKSPACE
  else process.env.DSH_DATA_WORKSPACE = previousWorkspace
  if (previousArchive === undefined) delete process.env.DSH_DATA_LOCAL_ARCHIVE
  else process.env.DSH_DATA_LOCAL_ARCHIVE = previousArchive
  await rm(directory, { recursive: true, force: true })
})

it('runs resolve → ingest → query → chart → save → export through dsh tools', async () => {
  const ctx = new Context()
  const prompt = ctx.plugin(SystemPrompt)
  await prompt
  const runtime = ctx.plugin(ToolRuntime)
  await runtime
  const plugins = [
    ctx.plugin(DuckDBPlugin),
    ctx.plugin(KagglePlugin),
    ctx.plugin(VizPlugin),
    ctx.plugin(WorkbenchPlugin),
  ]
  try {
    await Promise.all(plugins)
    const signal = new AbortController().signal

    const withoutPin = await ctx.tools.execute({
      name: 'resolve_kaggle_source',
      callId: ToolCallId('resolve-no-pin'),
      arguments: { slug: 'vivek468/superstore-dataset-final' },
      signal,
    })
    expect(withoutPin.isError).toBe(true)

    const { RETAIL_FIXTURE_RECIPE } =
      await import('../packages/dsh-data-core/dist/recipes/retail-fixture.js')
    const store = new MetadataStore(join(directory, 'catalog.sqlite'))
    try {
      const created = store.createWorkspaceSourcePin({
        slug: 'test/fixture-retail',
        sourceVersion: '1',
        recipe: RETAIL_FIXTURE_RECIPE,
        actorId: 'analyst-session',
      })
      store.setWorkspaceSourcePinStatus(created.pinId, 'approved', created.revision)
    } finally {
      store.close()
    }

    const resolved = await ctx.tools.execute({
      name: 'resolve_kaggle_source',
      callId: ToolCallId('resolve-fixture'),
      arguments: { slug: 'test/fixture-retail' },
      signal,
    })
    const pin = parseToolJson(resolved)
    expect(pin.datasetId).toBe('retail-fixture')
    expect(pin.sourceVersion).toBe('1')

    const unsupported = await ctx.tools.execute({
      name: 'resolve_kaggle_source',
      callId: ToolCallId('resolve-bad'),
      arguments: { slug: 'owner/not-reviewed' },
      signal,
    })
    expect(unsupported.isError).toBe(true)

    const ingested = await ctx.tools.execute({
      name: 'ingest_dataset',
      callId: ToolCallId('ingest-fixture'),
      arguments: { slug: 'test/fixture-retail' },
      signal,
    })
    const ingest = parseToolJson(ingested)
    expect(ingest.status).toBe('ready')
    expect(ingest.datasetId).toBe('retail-fixture')

    const listed = parseToolJson(
      await ctx.tools.execute({
        name: 'list_datasets',
        callId: ToolCallId('list'),
        arguments: {},
        signal,
      }),
    )
    expect(JSON.stringify(listed)).toMatch(/retail-fixture/)

    const queried = parseToolJson(
      await ctx.tools.execute({
        name: 'duckdb_query',
        callId: ToolCallId('query'),
        arguments: {
          datasetId: 'retail-fixture',
          sql: 'SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region ORDER BY revenue DESC, region',
          parameters: [],
        },
        signal,
      }),
    )
    expect(queried.resultId).toMatch(/^res_/)
    expect(queried.preview).toEqual([
      ['North', '80.00'],
      ['South', '50.00'],
    ])

    const charted = parseToolJson(
      await ctx.tools.execute({
        name: 'make_chart',
        callId: ToolCallId('chart'),
        arguments: {
          resultId: queried.resultId,
          intent: { mark: 'point', title: 'Revenue by region', x: 'region', y: 'revenue' },
        },
        signal,
      }),
    )
    expect(charted.artifactId).toMatch(/^art_/)

    const saved = parseToolJson(
      await ctx.tools.execute({
        name: 'save_analysis',
        callId: ToolCallId('save'),
        arguments: {
          resultId: queried.resultId,
          artifactId: charted.artifactId,
          question: 'Revenue by region',
        },
        signal,
      }),
    )
    expect(saved.analysisId).toMatch(/^ana_/)
    expect(saved).toMatchObject({ persisted: true, revision: 1 })

    const savedCards = [saved]
    for (const question of ['Revenue by region detail', 'Revenue by region comparison']) {
      const result = await ctx.tools.execute({
        name: 'save_analysis',
        callId: ToolCallId(`save-${savedCards.length + 1}`),
        arguments: {
          resultId: queried.resultId,
          artifactId: charted.artifactId,
          question,
        },
        signal,
      })
      const value = parseToolJson(result)
      expect(parseToolObserve(result)).toMatchObject({ persisted: true, revision: 1 })
      savedCards.push(value)
    }
    const reopened = parseToolJson(
      await ctx.tools.execute({
        name: 'get_analysis',
        callId: ToolCallId('reopen'),
        arguments: { analysisId: saved.analysisId },
        signal,
      }),
    )
    expect(reopened.chart).toMatchObject({ mark: 'point', x: 'region', y: 'revenue' })

    const analyses = parseToolJson(
      await ctx.tools.execute({
        name: 'list_analyses',
        callId: ToolCallId('list-analyses'),
        arguments: {},
        signal,
      }),
    ).analyses as Array<Record<string, unknown>>
    expect(analyses).toContainEqual(
      expect.objectContaining({ analysisId: saved.analysisId, question: 'Revenue by region' }),
    )

    const correction = parseToolJson(
      await ctx.tools.execute({
        name: 'propose_sql_correction',
        callId: ToolCallId('propose-correction'),
        arguments: {
          analysisId: saved.analysisId,
          correctedSql:
            'SELECT region, ROUND(SUM(amount), 2) AS revenue FROM retail GROUP BY region ORDER BY revenue DESC, region',
        },
        signal,
      }),
    )
    expect(correction).toMatchObject({ status: 'candidate', analysisId: saved.analysisId })
    const beforeApproval = parseToolJson(
      await ctx.tools.execute({
        name: 'get_learning_examples',
        callId: ToolCallId('learning-before-approval'),
        arguments: { datasetId: 'retail-fixture' },
        signal,
      }),
    )
    expect(beforeApproval.examples).toEqual([])
    const metadata = new MetadataStore(join(directory, 'catalog.sqlite'))
    metadata.setLearningExampleStatus(String(correction.proposalId), 'approved')
    metadata.close()
    const afterApproval = parseToolJson(
      await ctx.tools.execute({
        name: 'get_learning_examples',
        callId: ToolCallId('learning-after-approval'),
        arguments: { datasetId: 'retail-fixture' },
        signal,
      }),
    )
    expect(afterApproval.examples).toEqual([
      expect.objectContaining({ question: 'Revenue by region', correctedSql: expect.any(String) }),
    ])

    const createdResult = await ctx.tools.execute({
      name: 'create_dashboard',
      callId: ToolCallId('dashboard-create'),
      arguments: { title: 'Regional revenue' },
      signal,
    })
    const dashboard = parseToolJson(createdResult)
    expect(dashboard).toMatchObject({ persisted: true, slotCount: 0, slots: [] })
    expect(parseToolObserve(createdResult)).toMatchObject({ persisted: true, slotCount: 0 })

    const failedPin = await ctx.tools.execute({
      name: 'add_to_dashboard',
      callId: ToolCallId('dashboard-failed-pin'),
      arguments: { analysisId: 'ana_missing', dashboardId: dashboard.dashboardId },
      signal,
    })
    expect(failedPin.isError).toBe(true)
    expect(JSON.stringify(failedPin.content)).not.toContain('"persisted":true')

    for (const [index, card] of savedCards.entries()) {
      const pinResult = await ctx.tools.execute({
        name: 'add_to_dashboard',
        callId: ToolCallId(`dashboard-add-${index + 1}`),
        arguments: { analysisId: card.analysisId, dashboardId: dashboard.dashboardId },
        signal,
      })
      expect(parseToolJson(pinResult)).toMatchObject({ persisted: true, slotCount: index + 1 })
      expect(parseToolObserve(pinResult)).toMatchObject({ persisted: true, slotCount: index + 1 })
    }

    const titleStore = new MetadataStore(join(directory, 'catalog.sqlite'))
    titleStore.pinAnalysisToDashboard(
      String(dashboard.dashboardId),
      String(saved.analysisId),
      Number(saved.revision),
      'Analyst edited regional title',
    )
    titleStore.close()
    const repinResult = await ctx.tools.execute({
      name: 'add_to_dashboard',
      callId: ToolCallId('dashboard-repin'),
      arguments: { analysisId: saved.analysisId, dashboardId: dashboard.dashboardId },
      signal,
    })
    expect(parseToolObserve(repinResult)).toMatchObject({ persisted: true, slotCount: 3 })
    const dashboards = parseToolJson(
      await ctx.tools.execute({
        name: 'list_dashboards',
        callId: ToolCallId('list-dashboards'),
        arguments: {},
        signal,
      }),
    ).dashboards as Array<Record<string, unknown>>
    expect(dashboards).toContainEqual(
      expect.objectContaining({ dashboardId: dashboard.dashboardId, slotCount: 3 }),
    )
    const reopenedDashboard = parseToolJson(
      await ctx.tools.execute({
        name: 'get_dashboard',
        callId: ToolCallId('get-dashboard'),
        arguments: { dashboardId: dashboard.dashboardId },
        signal,
      }),
    )
    expect(reopenedDashboard.slots).toHaveLength(3)
    expect(reopenedDashboard.slots).toContainEqual(
      expect.objectContaining({
        analysisId: saved.analysisId,
        revision: 1,
        title: 'Analyst edited regional title',
        resultId: queried.resultId,
        artifactIds: [charted.artifactId],
      }),
    )

    const exported = parseToolJson(
      await ctx.tools.execute({
        name: 'export_report',
        callId: ToolCallId('export'),
        arguments: {
          resultId: queried.resultId,
          artifactId: charted.artifactId,
          analysisId: saved.analysisId,
          title: 'Revenue by region',
        },
        signal,
      }),
    )
    expect(exported.ready).toBe(true)
    const files = exported.files as Record<string, string>
    expect(files.html).toMatch(/\.html$/)
    const html = await readFile(join(directory, 'artifacts', files.html), 'utf8')
    expect(html).toMatch(/Revenue by region/)
    expect(html).not.toMatch(/https?:\/\/cdn/)
    expect(html).toContain('SELECT region')
    const analysis = JSON.parse(
      await readFile(join(directory, 'artifacts', files.analysis!), 'utf8'),
    )
    expect(analysis.chart.mark).toBe('point')
    expect(analysis.analysisId).toBe(saved.analysisId)
    const { handleReportRequest } =
      await import('../packages/dsh-data-workbench/src/report-fetch.js')
    const downloads = exported.downloads as Record<string, string>
    for (const url of Object.values(downloads)) {
      const response = await handleReportRequest(
        new Request(`http://localhost${url}`),
        join(directory, 'artifacts'),
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('content-disposition')).toContain('attachment')
    }
    for (let revision = 2; revision <= 8; revision++) {
      const revised = parseToolJson(
        await ctx.tools.execute({
          name: 'save_analysis',
          callId: ToolCallId(`save-current-${revision}`),
          arguments: {
            analysisId: saved.analysisId,
            resultId: queried.resultId,
            artifactId: charted.artifactId,
            question: 'Revenue by region',
          },
          signal,
        }),
      )
      expect(revised.revision).toBe(revision)
    }
    await ctx.tools.execute({
      name: 'add_to_dashboard',
      callId: ToolCallId('dashboard-repin-current'),
      arguments: { analysisId: saved.analysisId, dashboardId: dashboard.dashboardId },
      signal,
    })
    await ctx.tools.execute({
      name: 'map_dashboard_filters',
      callId: ToolCallId('map-filters-before-export'),
      arguments: {
        dashboardId: dashboard.dashboardId,
        analysisId: saved.analysisId,
        keys: ['region'],
      },
      signal,
    })
    const dashboardExportResult = await ctx.tools.execute({
      name: 'export_dashboard',
      callId: ToolCallId('export-dashboard'),
      arguments: { dashboardId: dashboard.dashboardId },
      signal,
    })
    expect(parseToolJson(dashboardExportResult)).toMatchObject({
      ready: true,
      dashboardId: dashboard.dashboardId,
      slotCount: 3,
      slots: expect.arrayContaining([
        expect.objectContaining({
          analysisId: saved.analysisId,
          revision: 8,
          resultId: queried.resultId,
          sharedFilterKeys: ['region'],
        }),
      ]),
    })
    expect(parseToolObserve(dashboardExportResult)).toMatchObject({
      ready: true,
      dashboardId: dashboard.dashboardId,
      slotCount: 3,
      slots: expect.arrayContaining([
        expect.objectContaining({
          analysisId: saved.analysisId,
          revision: 8,
          resultId: queried.resultId,
          sharedFilterKeys: ['region'],
        }),
      ]),
    })
    const bad = await handleReportRequest(
      new Request('http://localhost/api/analyst/reports?file=../catalog.sqlite'),
      join(directory, 'artifacts'),
    )
    expect(bad.status).toBe(400)

    // Shared dashboard filters: map "region" onto the pinned card,
    // then re-query it through the isolated worker; the dashboard-add card
    // above never mapped keys, so this exercises the map/apply tool pair
    // end-to-end after the export flow already proved the revision-1 pack.
    const mapped = parseToolJson(
      await ctx.tools.execute({
        name: 'map_dashboard_filters',
        callId: ToolCallId('map-filters'),
        arguments: {
          dashboardId: dashboard.dashboardId,
          analysisId: saved.analysisId,
          keys: ['region'],
        },
        signal,
      }),
    )
    expect(mapped).toMatchObject({
      dashboardId: dashboard.dashboardId,
      analysisId: saved.analysisId,
      sharedFilterKeys: ['region'],
    })

    const applied = parseToolJson(
      await ctx.tools.execute({
        name: 'apply_dashboard_filters',
        callId: ToolCallId('apply-filters'),
        arguments: {
          dashboardId: dashboard.dashboardId,
          column: 'region',
          value: 'North',
        },
        signal,
      }),
    )
    expect(applied.dashboardId).toBe(dashboard.dashboardId)
    expect(applied.applied).toEqual([
      expect.objectContaining({ analysisId: saved.analysisId, revision: 9 }),
    ])
    expect(applied.unsupported).toHaveLength(2)
    expect(applied.unsupported).toEqual(
      expect.arrayContaining(
        savedCards.slice(1).map((card) => ({
          analysisId: card.analysisId,
          reason: 'no-shared-filter-keys',
        })),
      ),
    )

    const dashboardAfterFilter = parseToolJson(
      await ctx.tools.execute({
        name: 'get_dashboard',
        callId: ToolCallId('get-dashboard-after-filter'),
        arguments: { dashboardId: dashboard.dashboardId },
        signal,
      }),
    )
    expect(dashboardAfterFilter.slots).toHaveLength(3)
    expect(dashboardAfterFilter.slots).toContainEqual(
      expect.objectContaining({ analysisId: saved.analysisId, revision: 9 }),
    )
  } finally {
    for (const plugin of plugins.reverse()) await plugin.dispose()
    await runtime.dispose()
    await prompt.dispose()
  }
})
