/**
 * End-to-end walkthrough assertion: drives a realistic
 * analyst walkthrough through the actual production tool/route code paths —
 * no mocks of the milestone-recording call sites themselves — and asserts
 * the resulting `workflow_trail` has one milestone per step, in order, with
 * the right actor:
 *
 *   preview_ingest_source (agent)   -> preview_proposed
 *   ingest-recipe-review route (UI) -> analyst_approved
 *   ingest_dataset (service)        -> dataset_published
 *   duckdb_query (service)          -> query_completed
 *   createChartArtifact (service)   -> chart_rendered
 *   save_analysis (service)         -> analysis_persisted
 *   check_studio_availability (svc) -> studio_opened
 *
 * No network/Kaggle credentials: the fixture archive is pre-placed exactly
 * where a completed Kaggle download would land it, the same no-network
 * pattern already used by
 * packages/dsh-data-duckdb/tests/preview-ingest.integration.test.ts and
 * plugin-tools-preview-single-flight.integration.test.ts.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MetadataStore } from '../packages/dsh-data-core/dist/metadata-store.js'
import { resolveWorkspacePaths } from '../packages/dsh-data-core/dist/workspace-paths.js'
import { downloadDestinationForSlug } from '../packages/dsh-data-kaggle/dist/download-job.js'
import { DuckdbAnalystService } from '../packages/dsh-data-duckdb/dist/plugin-service.js'
import { registerDuckdbAnalystTools } from '../packages/dsh-data-duckdb/dist/plugin-tools.js'
import { registerWorkbenchAnalystTools } from '../packages/dsh-data-workbench/dist/plugin-tools.js'
import { handleIngestRecipeReviewRequest } from '../packages/dsh-data-workbench/dist/ingest-recipe-review.js'
import { createChartArtifact } from '../packages/dsh-data-viz/dist/chart-service.js'

const SLUG = 'someone/workflow-trail-widgets'
const VERSION = '1'

interface CapturedTool {
  name: string
  execute(
    args: unknown,
    exec: { signal: AbortSignal; session?: { user?: { id?: string } } },
  ): Promise<unknown>
}

function fakeToolsContext(captured: Map<string, CapturedTool>): Context {
  return {
    tools: {
      register: (definition: CapturedTool) => {
        captured.set(definition.name, definition)
      },
    },
  } as unknown as Context
}

let directory: string
let previousWorkspaceEnv: string | undefined

async function buildFixtureArchive(destination: string): Promise<string> {
  const fixtureCsvPath = fileURLToPath(
    new URL('./fixtures/propose-ingest/orders.csv', import.meta.url),
  )
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(await readFile(fixtureCsvPath), 'orders.csv')
  const path = join(destination, 'source.zip')
  const writeStream = createWriteStream(path)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return path
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-p1-4-walkthrough-'))
  await mkdir(join(directory, 'sources'), { recursive: true })
  previousWorkspaceEnv = process.env.DSH_DATA_WORKSPACE
  // dsh-data-workbench's tools resolve the workspace from this env var
  // (no explicit-workspace constructor parameter), matching how the real
  // dsh host process configures it.
  process.env.DSH_DATA_WORKSPACE = directory
})

afterEach(async () => {
  if (previousWorkspaceEnv === undefined) delete process.env.DSH_DATA_WORKSPACE
  else process.env.DSH_DATA_WORKSPACE = previousWorkspaceEnv
  await rm(directory, { recursive: true, force: true })
})

it('records one milestone per walkthrough step, in order, with the correct actor', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const destinationDir = downloadDestinationForSlug(workspace.sourcesDir, SLUG, VERSION)
  await mkdir(destinationDir, { recursive: true })
  await buildFixtureArchive(destinationDir)

  const duckdbService = new DuckdbAnalystService(workspace)
  const duckdbTools = new Map<string, CapturedTool>()
  registerDuckdbAnalystTools(fakeToolsContext(duckdbTools), duckdbService)
  const workbenchTools = new Map<string, CapturedTool>()
  registerWorkbenchAnalystTools(fakeToolsContext(workbenchTools))

  // 1. Agent proposes a candidate ingest recipe (preview_ingest_source).
  const previewResult = (await duckdbTools
    .get('preview_ingest_source')!
    .execute({ slug: SLUG, sourceVersion: VERSION }, { signal: new AbortController().signal })) as {
    pinId: string
    datasetId: string
  }
  expect(previewResult.pinId).toMatch(/^pin_/)

  // 2. Analyst approves via the authenticated Studio review route — never a
  // model tool argument.
  const approval = await handleIngestRecipeReviewRequest(
    new Request('http://localhost/api/analyst/ingest-recipes/review', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pinId: previewResult.pinId, status: 'approved', expectedRevision: 1 }),
    }),
    workspace.catalogPath,
  )
  expect(approval.status).toBe(200)

  // 3. Agent runs the full reviewed ingest (ingest_dataset), publishing.
  const ingestResult = (await duckdbTools
    .get('ingest_dataset')!
    .execute({ slug: SLUG }, { signal: new AbortController().signal })) as {
    status: string
    datasetVersionId: string
    datasetId: string
  }
  expect(ingestResult.status).toBe('ready')

  // 4. Agent queries the published dataset (duckdb_query).
  const queryResult = (await duckdbTools.get('duckdb_query')!.execute(
    {
      datasetId: ingestResult.datasetId,
      // `orders.csv` deliberately has one non-numeric `sales` row (used
      // elsewhere to exercise ingestion rejection/cast-null tracking) —
      // excluded here so this chart-render step has clean numeric data.
      sql: "SELECT region, sales FROM orders WHERE region <> 'South'",
      parameters: [],
    },
    { signal: new AbortController().signal, session: { user: { id: 'analyst-session' } } },
  )) as { resultId: string; datasetVersionId: string }
  expect(queryResult.resultId).toMatch(/^res_/)

  // 5. Agent renders a chart from the authorized result (make_chart's own
  // production render path — createChartArtifact — with the workspace
  // catalog wired the same way dsh-data-viz's `make_chart` tool wires it).
  const chartResult = await createChartArtifact({
    resultId: queryResult.resultId,
    intent: { mark: 'bar', title: 'Sales by region', x: 'region', y: 'sales' },
    resultStoreDir: workspace.resultsDir,
    artifactStoreDir: workspace.artifactsDir,
    catalogPath: workspace.catalogPath,
  })
  expect(chartResult.rendered).toBe(true)

  // 6. Agent saves the analysis (save_analysis).
  const saveResult = (await workbenchTools.get('save_analysis')!.execute(
    {
      resultId: queryResult.resultId,
      question: 'Sales by region',
      artifactId: chartResult.artifactId,
    },
    { signal: new AbortController().signal },
  )) as { analysisId: string; revision: number }
  expect(saveResult.analysisId).toMatch(/^ana_/)

  // 7. Agent independently confirms Studio availability
  // (check_studio_availability).
  const availability = (await workbenchTools
    .get('check_studio_availability')!
    .execute(
      { analysisId: saveResult.analysisId, revision: saveResult.revision },
      { signal: new AbortController().signal },
    )) as { availableInStudio: boolean }
  expect(availability.availableInStudio).toBe(true)

  // Assert the full trail, in order, for this dataset version.
  const store = new MetadataStore(workspace.catalogPath)
  try {
    const datasetTrail = store.listWorkflowTrail({
      datasetVersionId: ingestResult.datasetVersionId,
    })
    expect(datasetTrail.map((entry) => entry.milestone)).toEqual([
      'dataset_published',
      'query_completed',
      'chart_rendered',
      'analysis_persisted',
      'studio_opened',
    ])
    expect(datasetTrail.map((entry) => entry.actor)).toEqual([
      'service',
      'service',
      'service',
      'service',
      'service',
    ])

    // preview_proposed/analyst_approved are keyed by the prospective
    // datasetId (before any version existed) — the same identifier
    // `ingestResult.datasetId` carries once published.
    const proposalTrail = store.listWorkflowTrail({ datasetVersionId: ingestResult.datasetId })
    expect(proposalTrail.map((entry) => entry.milestone)).toEqual([
      'preview_proposed',
      'analyst_approved',
    ])
    // The exact distinction the plan calls out: UI approval is
    // structurally different from the agent's own suggestion.
    expect(proposalTrail[0]!.actor).toBe('agent')
    expect(proposalTrail[1]!.actor).toBe('analyst-ui')

    // get_workflow_trail (the model-facing bounded read tool) returns the
    // same analysis-scoped entries.
    const trailTool = workbenchTools.get('get_workflow_trail')!
    const trailToolResult = (await trailTool.execute(
      { analysisId: saveResult.analysisId },
      { signal: new AbortController().signal },
    )) as { trail: Array<{ milestone: string }> }
    expect(trailToolResult.trail.map((entry) => entry.milestone)).toEqual([
      'analysis_persisted',
      'studio_opened',
    ])
  } finally {
    store.close()
  }

  duckdbService.dispose()
})
