/**
 * P2 Core DoD A UI path (automated BI acceptance):
 * ingest → query+equality filter → save → dashboard pin → CSV (formula-safe) +
 * HTML export → PNG → server restart → reopen analysis+dashboard on the same
 * datasetVersionId → feedback + alias propose/approve → getEffectiveSemantics.
 *
 * Operator sign-off for model/session enablement remains separate.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import * as yazl from 'yazl'
import { expect, it } from 'vitest'
import { listAnalysisRevisions } from '../../dsh-data-core/src/analysis-store.js'
import { MetadataStore } from '../../dsh-data-core/src/metadata-store.js'
import { RETAIL_FIXTURE_RECIPE } from '../../dsh-data-core/src/recipes/retail-fixture.js'
import { getEffectiveSemantics, resolveAlias } from '../../dsh-data-core/src/semantics.js'
import { resolveWorkspacePaths } from '../../dsh-data-core/src/workspace-paths.js'
import { runIngestFromArchive } from '../../dsh-data-duckdb/src/ingest-pipeline.js'
// The standalone server is retained only as a direct test adapter. Product
// code reaches these handlers through the dsh plugin and ui-routes lifecycle.
import { createWorkbenchServer } from '../src/server.js'

async function buildFixtureArchive(destination: string): Promise<string> {
  const fixtureCsvPath = fileURLToPath(
    new URL('../../../tests/fixtures/retail.csv', import.meta.url),
  )
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(await readFile(fixtureCsvPath), 'retail.csv')
  const archivePath = join(destination, 'source.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return archivePath
}

async function closeServer(server: ReturnType<typeof createWorkbenchServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}

async function listenTestAdapter(
  workspace: ReturnType<typeof resolveWorkspacePaths>,
): Promise<{ server: ReturnType<typeof createWorkbenchServer>; origin: string; port: number }> {
  const server = createWorkbenchServer({ workspace })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return {
    server,
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
  }
}

function originHeaders(origin: string): Record<string, string> {
  return {
    'content-type': 'application/x-www-form-urlencoded',
    Origin: origin,
  }
}

it('Core DoD A UI path: filter, save, dashboard, export, restart, alias overlay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wb-bi-accept-'))
  const previousWorkspace = process.env.DSH_DATA_WORKSPACE
  process.env.DSH_DATA_WORKSPACE = directory

  try {
    const datasetWorkspace = join(directory, 'workspaces', 'retail-fixture')
    await mkdir(join(datasetWorkspace, 'sources'), { recursive: true })
    const archivePath = await buildFixtureArchive(directory)
    const catalogPath = join(directory, 'catalog.sqlite')

    // 1. Ingest/publish retail-fixture from fixture archive
    const first = await runIngestFromArchive({
      archivePath,
      workspaceDir: datasetWorkspace,
      catalogPath,
      recipe: RETAIL_FIXTURE_RECIPE,
      slug: 'test/fixture-retail',
      sourceVersion: '1',
      idempotencyKey: 'workbench-bi-accept-v1',
    })
    const originalVersionId = first.datasetVersionId

    // 2. Start workbench
    const workspace = resolveWorkspacePaths(directory)
    let listening = await listenTestAdapter(workspace)
    let server = listening.server
    let origin = listening.origin

    // 3. Query with equality filter (+ formula-leading cell for CSV safety)
    const queryBody = new URLSearchParams({
      sql: `SELECT region, round(SUM(amount), 2) AS revenue, CAST('=1+1' AS VARCHAR) AS probe FROM retail GROUP BY region ORDER BY revenue DESC`,
      filterColumn: 'region',
      filterValue: 'North',
      title: 'North revenue',
      x: 'region',
      y: 'revenue',
    })
    const queryRes = await fetch(`${origin}/dataset/retail-fixture/query`, {
      method: 'POST',
      headers: originHeaders(origin),
      body: queryBody,
    })
    expect(queryRes.status).toBe(200)
    const queryHtml = await queryRes.text()
    expect(queryHtml).toMatch(/North/i)
    expect(queryHtml).toMatch(/80/)
    expect(queryHtml).toContain('Save analysis')
    const resultId = queryHtml.match(/name="resultId" value="(res_[a-z0-9]+)"/i)?.[1]
    const artifactId = queryHtml.match(/name="artifactId" value="(art_[a-z0-9]+)"/i)?.[1]
    expect(resultId).toBeTruthy()
    expect(artifactId).toBeTruthy()

    // 4. Save analysis
    const saveBody = new URLSearchParams({
      sql: queryBody.get('sql')!,
      resultId: resultId!,
      artifactId: artifactId!,
      title: 'North revenue',
      question: 'North revenue',
      x: 'region',
      y: 'revenue',
      filterColumn: 'region',
      filterValue: 'North',
    })
    const saveRes = await fetch(`${origin}/dataset/retail-fixture/save`, {
      method: 'POST',
      headers: originHeaders(origin),
      body: saveBody,
    })
    expect(saveRes.status).toBe(200)
    const saveHtml = await saveRes.text()
    const analysisFromHtml = saveHtml.match(/Saved (ana_[a-z0-9]+)/i)?.[1]
    const listed = await listAnalysisRevisions(catalogPath)
    expect(listed).toHaveLength(1)
    const analysisId = analysisFromHtml ?? listed[0]!.analysisId
    expect(analysisId).toMatch(/^ana_/)
    expect(listed[0]!.datasetVersionId).toBe(originalVersionId)
    expect(listed[0]!.resultId).toBe(resultId)
    expect(listed[0]!.artifactIds).toContain(artifactId)

    // 5. Create dashboard + pin analysis
    const createDash = await fetch(`${origin}/dashboard/create`, {
      method: 'POST',
      headers: originHeaders(origin),
      body: new URLSearchParams({ title: 'BI acceptance board' }).toString(),
      redirect: 'manual',
    })
    expect([200, 302, 303]).toContain(createDash.status)

    let dashboardId: string
    {
      const store = new MetadataStore(catalogPath)
      try {
        const dashboards = store.listDashboards()
        expect(dashboards).toHaveLength(1)
        dashboardId = dashboards[0]!.dashboardId
      } finally {
        store.close()
      }
    }

    const pinRes = await fetch(`${origin}/dashboard/${dashboardId}/pin`, {
      method: 'POST',
      headers: originHeaders(origin),
      body: new URLSearchParams({
        analysisId,
        revision: '1',
        title: 'North revenue card',
      }).toString(),
    })
    expect(pinRes.status).toBe(200)
    const pinHtml = await pinRes.text()
    expect(pinHtml).toContain('North revenue card')
    expect(pinHtml).toContain(analysisId)
    expect(pinHtml).toContain(artifactId)

    // 6. Export CSV (formula-safe) and HTML
    const csvRes = await fetch(
      `${origin}/dataset/retail-fixture/export.csv?resultId=${encodeURIComponent(resultId!)}`,
    )
    expect(csvRes.status).toBe(200)
    expect(csvRes.headers.get('content-type')).toMatch(/text\/csv/)
    const csv = await csvRes.text()
    expect(csv).toContain('region')
    expect(csv).toContain('North')
    expect(csv).toContain("'=1+1")

    const exportRes = await fetch(
      `${origin}/dataset/retail-fixture/export?resultId=${encodeURIComponent(resultId!)}&artifactId=${encodeURIComponent(artifactId!)}&title=${encodeURIComponent('North revenue')}`,
    )
    expect(exportRes.status).toBe(200)
    const exportHtml = await exportRes.text()
    expect(exportHtml).toContain(originalVersionId)
    expect(exportHtml).toMatch(/North/i)

    // 7. Download PNG + SVG + specification JSON for chart artifact
    const pngRes = await fetch(`${origin}/analyst/artifacts/${encodeURIComponent(artifactId!)}/png`)
    expect(pngRes.status).toBe(200)
    expect(pngRes.headers.get('content-type')).toBe('image/png')
    const pngBytes = Buffer.from(await pngRes.arrayBuffer())
    expect(pngBytes.length).toBeGreaterThan(0)
    expect(pngBytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true)

    const svgRes = await fetch(
      `${origin}/analyst/artifacts/${encodeURIComponent(artifactId!)}/download`,
    )
    expect(svgRes.status).toBe(200)
    const svgBody = await svgRes.text()
    expect(svgBody).toMatch(/<svg[\s>]/i)

    const specRes = await fetch(
      `${origin}/dataset/retail-fixture/export.specification.json?resultId=${encodeURIComponent(resultId!)}&artifactId=${encodeURIComponent(artifactId!)}`,
    )
    expect(specRes.status).toBe(200)
    expect(specRes.headers.get('content-type')).toMatch(/application\/json/)
    const spec = (await specRes.json()) as {
      kind: string
      datasetVersionId: string
      semanticRevisionId: string
      vegaLite: unknown
      intent: unknown
      sql: string
    }
    expect(spec.kind).toBe('dsh-data-analysis-specification')
    expect(spec.datasetVersionId).toBe(originalVersionId)
    expect(spec.semanticRevisionId).toBeTruthy()
    expect(spec.vegaLite).toBeTruthy()
    expect(spec.intent).toBeTruthy()
    expect(spec.sql.toLowerCase()).toContain('select')

    await closeServer(server)

    // Publish a newer catalog pointer so reopen must prove revision binding
    const second = await runIngestFromArchive({
      archivePath,
      workspaceDir: datasetWorkspace,
      catalogPath,
      recipe: RETAIL_FIXTURE_RECIPE,
      slug: 'test/fixture-retail',
      sourceVersion: '2',
      idempotencyKey: 'workbench-bi-accept-v2',
    })
    expect(second.datasetVersionId).not.toBe(originalVersionId)
    {
      const store = new MetadataStore(catalogPath)
      try {
        expect(store.getCurrentDatasetVersion('retail-fixture')?.datasetVersionId).toBe(
          second.datasetVersionId,
        )
      } finally {
        store.close()
      }
    }

    // 8. Restart server → reopen analysis + dashboard still on originalVersionId
    listening = await listenTestAdapter(workspace)
    server = listening.server
    origin = listening.origin

    const analysesRes = await fetch(`${origin}/analyses`)
    expect(analysesRes.status).toBe(200)
    const analysesHtml = await analysesRes.text()
    expect(analysesHtml).toContain(analysisId)
    expect(analysesHtml).toContain(originalVersionId)
    expect(analysesHtml).not.toContain(second.datasetVersionId)

    const detailRes = await fetch(`${origin}/analyses/${encodeURIComponent(analysisId)}`)
    expect(detailRes.status).toBe(200)
    const detailHtml = await detailRes.text()
    expect(detailHtml).toContain(originalVersionId)
    expect(detailHtml).not.toContain(second.datasetVersionId)
    expect(detailHtml).toMatch(/region.*North|filter/i)

    const dashRes = await fetch(`${origin}/dashboard?id=${encodeURIComponent(dashboardId)}`)
    expect(dashRes.status).toBe(200)
    const dashHtml = await dashRes.text()
    expect(dashHtml).toContain('BI acceptance board')
    expect(dashHtml).toContain('North revenue card')
    expect(dashHtml).toContain(analysisId)
    expect(dashHtml).toContain(artifactId)

    const exportAfterRestart = await fetch(
      `${origin}/dataset/retail-fixture/export?resultId=${encodeURIComponent(resultId!)}&artifactId=${encodeURIComponent(artifactId!)}&title=${encodeURIComponent('North revenue')}`,
    )
    expect(exportAfterRestart.status).toBe(200)
    const exportAfterHtml = await exportAfterRestart.text()
    expect(exportAfterHtml).toContain(originalVersionId)
    expect(exportAfterHtml).not.toContain(second.datasetVersionId)

    // 9. Feedback + alias candidate → approve → getEffectiveSemantics
    const feedbackRes = await fetch(`${origin}/analyses/${analysisId}/feedback`, {
      method: 'POST',
      headers: originHeaders(origin),
      body: new URLSearchParams({
        kind: 'preference',
        comment: 'Prefer clearer North label',
      }).toString(),
    })
    expect(feedbackRes.status).toBe(200)
    {
      const store = new MetadataStore(catalogPath)
      try {
        const feedback = store.listFeedback(analysisId)
        expect(feedback).toHaveLength(1)
        expect(feedback[0]?.status).toBe('candidate')
        expect(feedback[0]?.kind).toBe('preference')
      } finally {
        store.close()
      }
    }

    const propose = await fetch(`${origin}/aliases/propose`, {
      method: 'POST',
      headers: originHeaders(origin),
      body: new URLSearchParams({
        datasetId: 'retail-fixture',
        term: 'avg_order',
        expression: 'SUM(amount)/COUNT(*)',
        description: 'Average order amount',
        tableId: 'retail',
      }).toString(),
    })
    expect(propose.status).toBe(200)

    let candidateId: string
    {
      const store = new MetadataStore(catalogPath)
      try {
        const candidates = store.listAliasCandidates('retail-fixture', 'candidate')
        expect(candidates).toHaveLength(1)
        candidateId = candidates[0]!.candidateId
      } finally {
        store.close()
      }
    }

    const approve = await fetch(`${origin}/aliases/${candidateId}/status`, {
      method: 'POST',
      headers: originHeaders(origin),
      body: new URLSearchParams({ status: 'approved' }).toString(),
    })
    expect(approve.status).toBe(200)
    const approveHtml = await approve.text()
    expect(approveHtml).toContain('approved')
    expect(approveHtml).toContain('avg_order')
    expect(approveHtml).toMatch(/sem-workspace-.+\+aliases\./)

    {
      const store = new MetadataStore(catalogPath)
      try {
        const effective = getEffectiveSemantics('retail-fixture', store)
        expect(effective).toBeDefined()
        expect(effective!.semanticRevisionId).toMatch(/^sem-workspace-.+\+aliases\./)
        expect(resolveAlias(effective!, 'avg_order')?.expression).toBe('SUM(amount)/COUNT(*)')
        expect(resolveAlias(effective!, 'revenue')).toBeUndefined()
      } finally {
        store.close()
      }
    }

    await closeServer(server)
  } finally {
    if (previousWorkspace === undefined) delete process.env.DSH_DATA_WORKSPACE
    else process.env.DSH_DATA_WORKSPACE = previousWorkspace
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
