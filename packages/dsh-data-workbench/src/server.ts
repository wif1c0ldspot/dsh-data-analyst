/**
 * Test-only HTTP adapter for the legacy HTMX handler coverage. It is not
 * exported by the product plugin entrypoint (`index.ts`, which registers
 * `ui-routes.ts`'s native-sidebar routes instead) or shipped as an analyst
 * server. Binds loopback by default; serves
 * dataset list, policy-gated query+chart (isolated worker), equality filters,
 * saved analyses, HTML export, and authorized artifact downloads. Its CSRF/
 * browser-trust check delegates to `browser-trust.ts` — the one policy the
 * shipped routes also use — rather than keeping its own copy.
 */
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  listAnalysisRevisions,
  loadAnalysisRevision,
  saveAnalysisRevision,
} from 'dsh-data-core/analysis-store'
import { renderResultCsv } from 'dsh-data-core/csv-export'
import { openMetadataStore } from 'dsh-data-core/catalog'
import type { FeedbackKind, ReviewStatus } from 'dsh-data-core/contracts'
import { isValidJobTransition } from 'dsh-data-core/migrations'
import { applyEqualityFilter } from 'dsh-data-core/query-filter'
import { renderHtmlReport } from 'dsh-data-core/report-template'
import { getEffectiveSemantics } from 'dsh-data-core/semantics'
import { resolveWorkspacePaths, type WorkspacePaths } from 'dsh-data-core/workspace-paths'
import { executeIsolatedQuery } from 'dsh-data-duckdb/query-worker'
import { fixtureSqlGenerator, runAnalystQuestion } from 'dsh-data-duckdb/nl-loop'
import { resolveHttpSqlGeneratorFromEnv } from 'dsh-data-duckdb/sql-generators'
import { createChartArtifact, resolveSafeResult } from 'dsh-data-viz/chart-service'
import { createPngFromSvg } from 'dsh-data-viz/png-export'
import { resolveSafeArtifact } from './artifact-path.js'
import { isTrustedBrowserRequest } from './browser-trust.js'
import { applyDashboardSharedFilter } from './plugin-tools.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATIC_ROOT = join(PACKAGE_ROOT, 'static')
import {
  renderAliasesPage,
  renderAnalysesPage,
  renderAnalysisPage,
  renderArtifactsPage,
  renderDashboardPage,
  renderDatasetPage,
  renderHomePage,
  renderImportsPage,
  type DashboardCardView,
  type DatasetSummary,
} from './pages.js'

export interface WorkbenchServerOptions {
  workspace?: WorkspacePaths
  host?: string
  port?: number
}

interface StoredResultJson {
  resultId: string
  datasetVersionId: string
  semanticRevisionId: string
  sql: string
  columns: Array<{ name: string; logicalType: string }>
  preview: unknown[][]
  /** Full authorized result rows when persisted by the query service. */
  rows?: unknown[][]
  rowCount: number
  previewTruncated: boolean
  warnings?: string[]
}

const OPERATOR_ACTOR_ID = 'operator-local'

function recoverCatalogAtStartup(workspace: WorkspacePaths): void {
  const store = openMetadataStore(workspace.catalogPath)
  store.close()
}

function listDatasets(workspace: WorkspacePaths): DatasetSummary[] {
  const store = openMetadataStore(workspace.catalogPath)
  try {
    return store.listCurrentDatasetVersions().map((current) => ({
      datasetId: current.datasetId,
      datasetVersionId: current.datasetVersionId,
      tables: current.tables,
      semantics: getEffectiveSemantics(current.datasetId, store),
    }))
  } finally {
    store.close()
  }
}

function listCurrentSemantics(store: ReturnType<typeof openMetadataStore>) {
  return store
    .listCurrentDatasetVersions()
    .map((current) => getEffectiveSemantics(current.datasetId, store))
    .filter((revision): revision is NonNullable<typeof revision> => revision !== undefined)
}

function buildDashboardCards(
  workspace: WorkspacePaths,
  dashboardId: string | undefined,
): {
  dashboards: ReturnType<ReturnType<typeof openMetadataStore>['listDashboards']>
  cards: DashboardCardView[]
  selectedId?: string
} {
  const store = openMetadataStore(workspace.catalogPath)
  try {
    const dashboards = store.listDashboards()
    const selected = (dashboardId ? store.loadDashboard(dashboardId) : undefined) ?? dashboards[0]
    if (!selected) return { dashboards, cards: [] }
    const cards: DashboardCardView[] = selected.layout.slots.map((slot) => {
      const analysis = store.loadAnalysisRevision(slot.analysisId, slot.revision)
      return {
        slot,
        analysis,
        artifactId: analysis?.artifactIds[0],
      }
    })
    return { dashboards, cards, selectedId: selected.dashboardId }
  } finally {
    store.close()
  }
}

function renderAliases(workspace: WorkspacePaths, message?: string, error?: string): string {
  const store = openMetadataStore(workspace.catalogPath)
  try {
    return renderAliasesPage(listCurrentSemantics(store), store.listAliasCandidates(), {
      message,
      error,
    })
  } finally {
    store.close()
  }
}

function renderDashboard(
  workspace: WorkspacePaths,
  options: { id?: string; message?: string; error?: string } = {},
): string {
  const { dashboards, cards, selectedId } = buildDashboardCards(workspace, options.id)
  return renderDashboardPage(dashboards, cards, {
    selectedId,
    message: options.message,
    error: options.error,
  })
}

async function renderAnalysisDetail(
  workspace: WorkspacePaths,
  analysisId: string,
  options: { message?: string; error?: string } = {},
): Promise<string> {
  const analysis = await loadAnalysisRevision(workspace.catalogPath, analysisId)
  const store = openMetadataStore(workspace.catalogPath)
  try {
    return renderAnalysisPage(analysis, datasetIdFromVersion(analysis.datasetVersionId), {
      dashboards: store.listDashboards(),
      feedback: store.listFeedback(analysisId),
      message: options.message,
      error: options.error,
    })
  } finally {
    store.close()
  }
}

/** Resolve a file under static/; reject path traversal. */
export function resolveSafeStatic(fileName: string): string | null {
  if (
    fileName.includes('..') ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0')
  ) {
    return null
  }
  const candidate = resolve(join(STATIC_ROOT, fileName))
  if (candidate !== STATIC_ROOT && !candidate.startsWith(STATIC_ROOT + sep)) return null
  return candidate
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function parseForm(body: string): Record<string, string> {
  const params = new URLSearchParams(body)
  const out: Record<string, string> = {}
  for (const [key, value] of params.entries()) out[key] = value
  return out
}

function datasetIdFromVersion(datasetVersionId: string): string {
  // Prefer catalog lookup when available; fall back to prefix before first version segment.
  const dash = datasetVersionId.indexOf('-v')
  if (dash > 0) return datasetVersionId.slice(0, dash)
  const parts = datasetVersionId.split('-')
  return parts.length > 1 ? parts.slice(0, -1).join('-') : datasetVersionId
}

/**
 * Browser trust for state-changing routes (CSRF / connection-style Origin/Host).
 * This package has one trust policy, implemented once in `browser-trust.ts`
 * (used by the shipped native-sidebar routes in `ui-routes.ts`); this adapts
 * Node's `IncomingMessage` headers to the WHATWG `Request` shape that policy
 * expects, so this HTTP-server test harness enforces the exact same rule
 * rather than a second, independently-maintained copy of it.
 */
export function isTrustedStateChangingRequest(req: IncomingMessage): boolean {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) headers.set(name, value.join(', '))
  }
  return isTrustedBrowserRequest(new Request('http://placeholder.invalid/', { headers }))
}

function rejectForbidden(res: ServerResponse): void {
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Forbidden')
}

function rejectBadRequest(res: ServerResponse, message: string): void {
  res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

async function loadStoredResult(resultsDir: string, resultId: string): Promise<StoredResultJson> {
  if (!/^res_[a-z0-9]+$/i.test(resultId)) {
    throw new Error('Invalid result id')
  }
  const raw = await readFile(join(resultsDir, `${resultId}.json`), 'utf8')
  const parsed = JSON.parse(raw) as Partial<StoredResultJson>
  if (
    typeof parsed.datasetVersionId !== 'string' ||
    typeof parsed.semanticRevisionId !== 'string' ||
    typeof parsed.sql !== 'string'
  ) {
    throw new Error('Stored result missing revision binding fields')
  }
  return parsed as StoredResultJson
}

async function assertArtifactMatchesResult(
  artifactsDir: string,
  artifactId: string,
  resultId: string,
): Promise<void> {
  if (!/^art_[a-z0-9]+$/i.test(artifactId)) {
    throw new Error('Invalid artifact id')
  }
  const sidecarPath = resolveSafeArtifact(artifactsDir, `${artifactId}.json`)
  if (!sidecarPath) {
    throw new Error('Invalid artifact path')
  }
  const raw = await readFile(sidecarPath, 'utf8')
  const sidecar = JSON.parse(raw) as { resultId?: string }
  if (sidecar.resultId !== resultId) {
    throw new Error('Artifact resultId mismatch')
  }
}

export function createWorkbenchServer(options: WorkbenchServerOptions = {}): Server {
  const workspace = options.workspace ?? resolveWorkspacePaths()
  recoverCatalogAtStartup(workspace)
  return createServer(async (req, res) => {
    try {
      await handle(req, res, workspace)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(error instanceof Error ? error.message : String(error))
    }
  })
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  workspace: WorkspacePaths,
): Promise<void> {
  const host = req.headers.host ?? '127.0.0.1'
  const url = new URL(req.url ?? '/', `http://${host}`)
  const method = req.method ?? 'GET'

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    html(res, renderHomePage(listDatasets(workspace)))
    return
  }

  if (method === 'GET' && url.pathname === '/imports') {
    const store = openMetadataStore(workspace.catalogPath)
    try {
      html(res, renderImportsPage(store.listImportJobs()))
    } finally {
      store.close()
    }
    return
  }

  const cancelImportMatch = url.pathname.match(/^\/imports\/([^/]+)\/cancel$/)
  if (method === 'POST' && cancelImportMatch) {
    if (!isTrustedStateChangingRequest(req)) {
      rejectForbidden(res)
      return
    }
    const jobId = decodeURIComponent(cancelImportMatch[1]!)
    const store = openMetadataStore(workspace.catalogPath)
    try {
      const job = store.getImportJob(jobId)
      if (!job) {
        html(res, renderImportsPage(store.listImportJobs(), { error: `Unknown job ${jobId}` }))
        return
      }
      if (!isValidJobTransition(job.status, 'cancelled')) {
        html(
          res,
          renderImportsPage(store.listImportJobs(), {
            error: `Cannot cancel job in status "${job.status}"`,
          }),
        )
        return
      }
      store.updateImportJobStatus(jobId, 'cancelled')
      html(res, renderImportsPage(store.listImportJobs(), { message: `Cancelled ${jobId}` }))
    } finally {
      store.close()
    }
    return
  }

  const staticMatch = url.pathname.match(/^\/static\/([^/]+)$/)
  if (method === 'GET' && staticMatch) {
    const path = resolveSafeStatic(decodeURIComponent(staticMatch[1]!))
    if (!path) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Invalid static path')
      return
    }
    try {
      const info = await stat(path)
      if (!info.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Missing static file')
        return
      }
      const type =
        extname(path) === '.js'
          ? 'application/javascript; charset=utf-8'
          : extname(path) === '.css'
            ? 'text/css; charset=utf-8'
            : 'application/octet-stream'
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(info.size),
        'cache-control': 'public, max-age=86400',
      })
      createReadStream(path).pipe(res)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Missing static file')
    }
    return
  }

  if (method === 'GET' && url.pathname === '/artifacts') {
    const names = (await readdir(workspace.artifactsDir).catch(() => [])).filter((n) =>
      n.endsWith('.svg'),
    )
    html(res, renderArtifactsPage(names.sort().reverse()))
    return
  }

  if (method === 'GET' && url.pathname === '/analyses') {
    html(res, renderAnalysesPage(await listAnalysisRevisions(workspace.catalogPath)))
    return
  }

  if (method === 'GET' && url.pathname === '/dashboard') {
    html(res, renderDashboard(workspace, { id: url.searchParams.get('id') ?? undefined }))
    return
  }

  if (method === 'POST' && url.pathname === '/dashboard/create') {
    if (!isTrustedStateChangingRequest(req)) {
      rejectForbidden(res)
      return
    }
    const form = parseForm(await readBody(req))
    const title = (form.title ?? '').trim()
    if (!title) {
      html(res, renderDashboard(workspace, { error: 'Title is required' }))
      return
    }
    const store = openMetadataStore(workspace.catalogPath)
    let created
    try {
      created = store.saveDashboard({ title })
    } finally {
      store.close()
    }
    html(
      res,
      renderDashboard(workspace, {
        id: created.dashboardId,
        message: `Created dashboard ${created.dashboardId}`,
      }),
    )
    return
  }

  const dashboardPinMatch = url.pathname.match(/^\/dashboard\/([^/]+)\/pin$/)
  if (method === 'POST' && dashboardPinMatch) {
    if (!isTrustedStateChangingRequest(req)) {
      rejectForbidden(res)
      return
    }
    const pathDashboardId = decodeURIComponent(dashboardPinMatch[1]!)
    const form = parseForm(await readBody(req))
    const dashboardId = (form.dashboardId ?? pathDashboardId).trim()
    const analysisId = (form.analysisId ?? '').trim()
    const title = (form.title ?? '').trim() || undefined
    const revisionRaw = (form.revision ?? '').trim()
    if (!analysisId) {
      html(res, renderDashboard(workspace, { id: dashboardId, error: 'analysisId is required' }))
      return
    }
    const store = openMetadataStore(workspace.catalogPath)
    try {
      const analysis =
        revisionRaw !== ''
          ? store.loadAnalysisRevision(analysisId, Number(revisionRaw))
          : store.loadAnalysisRevision(analysisId)
      if (!analysis) {
        html(res, renderDashboard(workspace, { id: dashboardId, error: 'Unknown analysis' }))
        return
      }
      store.pinAnalysisToDashboard(
        dashboardId,
        analysisId,
        analysis.revision,
        title ?? analysis.question,
      )
    } catch (error) {
      html(
        res,
        renderDashboard(workspace, {
          id: dashboardId,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return
    } finally {
      store.close()
    }
    html(
      res,
      renderDashboard(workspace, {
        id: dashboardId,
        message: `Pinned ${analysisId}`,
      }),
    )
    return
  }

  const dashboardFilterMatch = url.pathname.match(/^\/dashboard\/([^/]+)\/filter$/)
  if (method === 'POST' && dashboardFilterMatch) {
    if (!isTrustedStateChangingRequest(req)) {
      rejectForbidden(res)
      return
    }
    const dashboardId = decodeURIComponent(dashboardFilterMatch[1]!)
    const form = parseForm(await readBody(req))
    const column = (form.column ?? '').trim()
    const value = form.value ?? ''
    if (!column) {
      html(res, renderDashboard(workspace, { id: dashboardId, error: 'column is required' }))
      return
    }
    try {
      const result = await applyDashboardSharedFilter(workspace, dashboardId, { column, value })
      const summary = `Applied ${column}=${value}: ${result.applied.length} card(s) updated, ${result.unsupported.length} unsupported.`
      html(res, renderDashboard(workspace, { id: dashboardId, message: summary }))
    } catch (error) {
      html(
        res,
        renderDashboard(workspace, {
          id: dashboardId,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
    return
  }

  if (method === 'GET' && url.pathname === '/aliases') {
    html(res, renderAliases(workspace))
    return
  }

  if (method === 'POST' && url.pathname === '/aliases/propose') {
    if (!isTrustedStateChangingRequest(req)) {
      rejectForbidden(res)
      return
    }
    const form = parseForm(await readBody(req))
    const datasetId = (form.datasetId ?? '').trim()
    const term = (form.term ?? '').trim()
    const expression = (form.expression ?? '').trim()
    const description = (form.description ?? '').trim()
    const tableId = (form.tableId ?? '').trim()
    if (!datasetId || !term || !expression || !description || !tableId) {
      html(res, renderAliases(workspace, undefined, 'All alias fields are required'))
      return
    }
    const store = openMetadataStore(workspace.catalogPath)
    try {
      store.createAliasCandidate({
        datasetId,
        term,
        expression,
        description,
        tableId,
        actorId: OPERATOR_ACTOR_ID,
      })
    } finally {
      store.close()
    }
    html(res, renderAliases(workspace, `Proposed alias candidate "${term}"`))
    return
  }

  const aliasStatusMatch = url.pathname.match(/^\/aliases\/([^/]+)\/status$/)
  if (method === 'POST' && aliasStatusMatch) {
    if (!isTrustedStateChangingRequest(req)) {
      rejectForbidden(res)
      return
    }
    const candidateId = decodeURIComponent(aliasStatusMatch[1]!)
    const form = parseForm(await readBody(req))
    const status = (form.status ?? '').trim() as ReviewStatus
    if (status !== 'approved' && status !== 'revoked' && status !== 'candidate') {
      html(res, renderAliases(workspace, undefined, 'Invalid status'))
      return
    }
    const store = openMetadataStore(workspace.catalogPath)
    try {
      store.setAliasCandidateStatus(candidateId, status)
    } catch (error) {
      html(
        res,
        renderAliases(workspace, undefined, error instanceof Error ? error.message : String(error)),
      )
      return
    } finally {
      store.close()
    }
    html(res, renderAliases(workspace, `Candidate ${candidateId} marked ${status}`))
    return
  }

  const analysisMatch = url.pathname.match(/^\/analyses\/([^/]+)$/)
  if (method === 'GET' && analysisMatch) {
    const analysisId = decodeURIComponent(analysisMatch[1]!)
    try {
      html(res, await renderAnalysisDetail(workspace, analysisId))
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Unknown analysis')
    }
    return
  }

  const analysisFeedbackMatch = url.pathname.match(/^\/analyses\/([^/]+)\/feedback$/)
  if (method === 'POST' && analysisFeedbackMatch) {
    if (!isTrustedStateChangingRequest(req)) {
      rejectForbidden(res)
      return
    }
    const analysisId = decodeURIComponent(analysisFeedbackMatch[1]!)
    const form = parseForm(await readBody(req))
    const kind = (form.kind ?? '').trim() as FeedbackKind
    const comment = (form.comment ?? '').trim()
    const allowedKinds: FeedbackKind[] = [
      'preference',
      'sql-correction',
      'semantic-correction',
      'vote',
    ]
    if (!allowedKinds.includes(kind) || !comment) {
      try {
        html(
          res,
          await renderAnalysisDetail(workspace, analysisId, {
            error: 'kind and comment are required',
          }),
        )
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Unknown analysis')
      }
      return
    }
    const store = openMetadataStore(workspace.catalogPath)
    try {
      const analysis = store.loadAnalysisRevision(analysisId)
      if (!analysis) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Unknown analysis')
        return
      }
      store.createFeedback({
        analysisId,
        analysisRevision: analysis.revision,
        kind,
        actorId: OPERATOR_ACTOR_ID,
        comment,
      })
    } finally {
      store.close()
    }
    html(
      res,
      await renderAnalysisDetail(workspace, analysisId, {
        message: `Feedback recorded (${kind})`,
      }),
    )
    return
  }

  const datasetMatch = url.pathname.match(/^\/dataset\/([^/]+)$/)
  if (method === 'GET' && datasetMatch) {
    const datasetId = decodeURIComponent(datasetMatch[1]!)
    const dataset = listDatasets(workspace).find((d) => d.datasetId === datasetId)
    if (!dataset) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Unknown dataset')
      return
    }
    html(res, renderDatasetPage(dataset))
    return
  }

  const exportMatch = url.pathname.match(/^\/dataset\/([^/]+)\/export$/)
  if (method === 'GET' && exportMatch) {
    const datasetId = decodeURIComponent(exportMatch[1]!)
    const dataset = listDatasets(workspace).find((d) => d.datasetId === datasetId)
    if (!dataset) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Unknown dataset')
      return
    }
    const resultId = url.searchParams.get('resultId') ?? ''
    const artifactId = url.searchParams.get('artifactId') ?? ''
    const title = url.searchParams.get('title') ?? 'Analysis'
    const svgPath = resolveSafeArtifact(workspace.artifactsDir, `${artifactId}.svg`)
    if (!svgPath || !/^res_[a-z0-9]+$/i.test(resultId)) {
      rejectBadRequest(res, 'Invalid export ids')
      return
    }
    let result: StoredResultJson
    try {
      result = await loadStoredResult(workspace.resultsDir, resultId)
      await assertArtifactMatchesResult(workspace.artifactsDir, artifactId, resultId)
    } catch (error) {
      rejectBadRequest(res, error instanceof Error ? error.message : String(error))
      return
    }
    const svgMarkup = await readFile(svgPath, 'utf8')
    const exportRows = (result.rows ?? result.preview).map((row) =>
      row.map((cell) => String(cell ?? '')),
    )
    const report = renderHtmlReport({
      title,
      svgMarkup,
      columns: result.columns,
      rows: exportRows,
      rowCount: result.rowCount,
      previewTruncated: result.previewTruncated && !result.rows,
      sourceCaption: `${dataset.datasetId} (${result.datasetVersionId})`,
      datasetVersionId: result.datasetVersionId,
      semanticRevisionId: result.semanticRevisionId,
      generatedAt: new Date().toISOString(),
      warnings: result.warnings ?? [],
    })
    await mkdir(workspace.artifactsDir, { recursive: true })
    const reportName = `report_${resultId}.html`
    await writeFile(join(workspace.artifactsDir, reportName), report, 'utf8')
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-disposition': `attachment; filename="${reportName}"`,
    })
    res.end(report)
    return
  }

  const exportSpecMatch = url.pathname.match(/^\/dataset\/([^/]+)\/export\.specification\.json$/)
  if (method === 'GET' && exportSpecMatch) {
    const datasetId = decodeURIComponent(exportSpecMatch[1]!)
    const dataset = listDatasets(workspace).find((d) => d.datasetId === datasetId)
    if (!dataset) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Unknown dataset')
      return
    }
    const resultId = url.searchParams.get('resultId') ?? ''
    const artifactId = url.searchParams.get('artifactId') ?? ''
    if (!/^res_[a-z0-9]+$/i.test(resultId) || !/^art_[a-z0-9]+$/i.test(artifactId)) {
      rejectBadRequest(res, 'Invalid export ids')
      return
    }
    let result: StoredResultJson
    let sidecar: {
      artifactId?: string
      resultId?: string
      intent?: unknown
      vegaLiteSpec?: unknown
      renderer?: unknown
    }
    try {
      result = await loadStoredResult(workspace.resultsDir, resultId)
      await assertArtifactMatchesResult(workspace.artifactsDir, artifactId, resultId)
      const sidecarPath = resolveSafeArtifact(workspace.artifactsDir, `${artifactId}.json`)
      if (!sidecarPath) {
        rejectBadRequest(res, 'Missing artifact sidecar')
        return
      }
      sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as typeof sidecar
    } catch (error) {
      rejectBadRequest(res, error instanceof Error ? error.message : String(error))
      return
    }
    if (!sidecar.vegaLiteSpec) {
      rejectBadRequest(res, 'Artifact sidecar lacks vegaLiteSpec; re-render chart')
      return
    }
    const payload = {
      kind: 'dsh-data-analysis-specification',
      datasetId,
      resultId,
      artifactId,
      datasetVersionId: result.datasetVersionId,
      semanticRevisionId: result.semanticRevisionId,
      sql: result.sql,
      intent: sidecar.intent,
      vegaLite: sidecar.vegaLiteSpec,
      renderer: sidecar.renderer ?? {
        vegaLiteSchema: 'https://vega.github.io/schema/vega-lite/v6.json',
      },
      exportedAt: new Date().toISOString(),
    }
    const body = `${JSON.stringify(payload, null, 2)}\n`
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="spec_${resultId}.json"`,
    })
    res.end(body)
    return
  }

  const csvMatch = url.pathname.match(/^\/dataset\/([^/]+)\/export\.csv$/)
  if (method === 'GET' && csvMatch) {
    const datasetId = decodeURIComponent(csvMatch[1]!)
    const dataset = listDatasets(workspace).find((d) => d.datasetId === datasetId)
    if (!dataset) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Unknown dataset')
      return
    }
    const resultId = url.searchParams.get('resultId') ?? ''
    let result: StoredResultJson
    try {
      result = await loadStoredResult(workspace.resultsDir, resultId)
    } catch (error) {
      rejectBadRequest(res, error instanceof Error ? error.message : String(error))
      return
    }
    if (!result.rows || !Array.isArray(result.rows)) {
      rejectBadRequest(res, 'Stored result missing full authorized rows for CSV export')
      return
    }
    const csv = renderResultCsv(result.columns, result.rows)
    const fileName = `result_${resultId}.csv`
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${fileName}"`,
      'cache-control': 'no-store',
    })
    res.end(csv)
    return
  }

  const queryMatch = url.pathname.match(/^\/dataset\/([^/]+)\/query$/)
  if (method === 'POST' && queryMatch) {
    if (!isTrustedStateChangingRequest(req)) {
      rejectForbidden(res)
      return
    }
    const datasetId = decodeURIComponent(queryMatch[1]!)
    const dataset = listDatasets(workspace).find((d) => d.datasetId === datasetId)
    if (!dataset) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Unknown dataset')
      return
    }
    const form = parseForm(await readBody(req))
    const baseSql = form.sql ?? ''
    const filterColumn = form.filterColumn ?? ''
    const filterValue = form.filterValue ?? ''
    let sql = baseSql
    try {
      if (filterColumn.trim()) {
        sql = applyEqualityFilter(baseSql, filterColumn, filterValue)
      }
      const store = openMetadataStore(workspace.catalogPath)
      let manifest
      let semantics
      try {
        manifest = store.getDatasetVersion(dataset.datasetVersionId)
        if (!manifest) throw new Error('Dataset version missing from catalog')
        semantics = getEffectiveSemantics(manifest.datasetId, store)
        if (!semantics) throw new Error(`No semantics for dataset "${manifest.datasetId}"`)
      } finally {
        store.close()
      }
      const summary = await executeIsolatedQuery({
        datasetPath: workspace.datasetFile(manifest.datasetVersionId, manifest.datasetId),
        datasetVersionId: manifest.datasetVersionId,
        semanticRevisionId: semantics.semanticRevisionId,
        sql,
        parameters: [],
        allowedTables: manifest.tables.map((t) => t.id),
        resultStoreDir: workspace.resultsDir,
      })
      const chart = await createChartArtifact({
        resultId: summary.resultId,
        intent: {
          mark: 'bar',
          title: form.title || 'Analysis',
          x: form.x || summary.columns[0]?.name,
          y: form.y || summary.columns[1]?.name,
          sort: form.y ? { field: form.y, direction: 'descending' } : undefined,
        },
        resultStoreDir: workspace.resultsDir,
        artifactStoreDir: workspace.artifactsDir,
      })
      html(
        res,
        renderDatasetPage(dataset, {
          sql: baseSql,
          filterColumn,
          filterValue,
          title: form.title,
          x: form.x,
          y: form.y,
          preview: {
            columns: summary.columns.map((c) => c.name),
            rows: summary.preview.map((row) => row.map((cell) => String(cell ?? ''))),
            resultId: summary.resultId,
            artifactId: chart.artifactId,
          },
        }),
      )
    } catch (error) {
      html(
        res,
        renderDatasetPage(dataset, {
          sql: baseSql,
          filterColumn,
          filterValue,
          title: form.title,
          x: form.x,
          y: form.y,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
    return
  }

  const chartMatch = url.pathname.match(/^\/dataset\/([^/]+)\/chart$/)
  if (method === 'POST' && chartMatch) {
    if (!isTrustedStateChangingRequest(req)) {
      rejectForbidden(res)
      return
    }
    const datasetId = decodeURIComponent(chartMatch[1]!)
    const dataset = listDatasets(workspace).find((d) => d.datasetId === datasetId)
    if (!dataset) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Unknown dataset')
      return
    }
    const form = parseForm(await readBody(req))
    const resultId = form.resultId ?? ''
    const markRaw = (form.mark ?? 'bar').toLowerCase()
    const mark =
      markRaw === 'line' ||
      markRaw === 'point' ||
      markRaw === 'bar' ||
      markRaw === 'area' ||
      markRaw === 'boxplot'
        ? markRaw
        : null
    const x = form.x ?? ''
    const y = form.y ?? ''
    try {
      if (!resultId) throw new Error('resultId is required for mark refinement')
      if (!mark) throw new Error('mark must be bar, line, point, area, or boxplot')
      if (!x || !y) throw new Error('x and y fields are required')
      const chart = await createChartArtifact({
        resultId,
        intent: {
          mark,
          title: form.title || 'Analysis',
          x,
          y,
          sort: { field: y, direction: 'descending' },
        },
        resultStoreDir: workspace.resultsDir,
        artifactStoreDir: workspace.artifactsDir,
      })
      // Re-read stored result for table preview without re-querying DuckDB.
      const resultPath = resolveSafeResult(workspace.resultsDir, resultId)
      if (!resultPath) throw new Error('Invalid or unauthorized resultId')
      const stored = JSON.parse(await readFile(resultPath, 'utf8')) as {
        columns: Array<{ name: string }>
        rows?: unknown[][]
        preview?: unknown[][]
      }
      const rows = (stored.preview ?? stored.rows ?? []).slice(0, 20)
      html(
        res,
        renderDatasetPage(dataset, {
          sql: form.sql,
          filterColumn: form.filterColumn,
          filterValue: form.filterValue,
          title: form.title,
          question: form.question,
          x,
          y,
          mark,
          analystTurns: form.priorTurns ? Number(form.priorTurns) : undefined,
          turnsRemaining:
            form.priorTurns !== undefined && form.priorTurns !== ''
              ? Math.max(0, 2 - Number(form.priorTurns))
              : undefined,
          message: `Mark refined to ${mark} without re-query (presentation-only).`,
          preview: {
            columns: stored.columns.map((c) => c.name),
            rows: rows.map((row) => row.map((cell) => String(cell ?? ''))),
            resultId,
            artifactId: chart.artifactId,
          },
        }),
      )
    } catch (error) {
      html(
        res,
        renderDatasetPage(dataset, {
          sql: form.sql,
          filterColumn: form.filterColumn,
          filterValue: form.filterValue,
          title: form.title,
          question: form.question,
          x: form.x,
          y: form.y,
          mark: form.mark,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
    return
  }

  const askMatch = url.pathname.match(/^\/dataset\/([^/]+)\/ask$/)
  if (method === 'POST' && askMatch) {
    if (!isTrustedStateChangingRequest(req)) {
      rejectForbidden(res)
      return
    }
    const datasetId = decodeURIComponent(askMatch[1]!)
    const dataset = listDatasets(workspace).find((d) => d.datasetId === datasetId)
    if (!dataset) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Unknown dataset')
      return
    }
    const form = parseForm(await readBody(req))
    const question = form.question ?? ''
    const priorTurnsRaw = Number(form.priorTurns ?? '0')
    const priorTurns =
      Number.isFinite(priorTurnsRaw) && priorTurnsRaw > 0 ? Math.floor(priorTurnsRaw) : 0
    try {
      // fixture|echo → reviewed golden map; http → OpenAI-compatible API (no dsh session rows).
      const mode = (process.env.DSH_NL_GENERATOR ?? 'fixture').toLowerCase()
      const httpGenerator = mode === 'http' ? resolveHttpSqlGeneratorFromEnv() : null
      if (mode !== 'fixture' && mode !== 'echo' && mode !== 'http') {
        throw new Error(
          `Unsupported DSH_NL_GENERATOR="${mode}". Use fixture (default), echo, or http.`,
        )
      }
      const result = await runAnalystQuestion({
        workspace,
        datasetId,
        question,
        generator: httpGenerator ?? fixtureSqlGenerator,
        priorTurns,
      })
      if (result.kind !== 'answer') {
        html(
          res,
          renderDatasetPage(dataset, {
            question,
            analystTurns: result.analystTurns,
            turnsRemaining: result.turnsRemaining,
            ...(result.kind === 'clarify'
              ? { message: result.message }
              : { error: result.message }),
          }),
        )
        return
      }
      const x = result.summary.columns[0]?.name
      const y = result.summary.columns[1]?.name
      html(
        res,
        renderDatasetPage(dataset, {
          sql: result.sql,
          question,
          title: question || 'Analysis',
          x,
          y,
          analystTurns: result.analystTurns,
          turnsRemaining: result.turnsRemaining,
          preview: {
            columns: result.summary.columns.map((c) => c.name),
            rows: result.summary.preview.map((row) => row.map((cell) => String(cell ?? ''))),
            resultId: result.summary.resultId,
            artifactId: result.chartArtifactId,
          },
        }),
      )
    } catch (error) {
      html(
        res,
        renderDatasetPage(dataset, {
          question,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
    return
  }

  const saveMatch = url.pathname.match(/^\/dataset\/([^/]+)\/save$/)
  if (method === 'POST' && saveMatch) {
    if (!isTrustedStateChangingRequest(req)) {
      rejectForbidden(res)
      return
    }
    const datasetId = decodeURIComponent(saveMatch[1]!)
    const dataset = listDatasets(workspace).find((d) => d.datasetId === datasetId)
    if (!dataset) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Unknown dataset')
      return
    }
    const form = parseForm(await readBody(req))
    const resultId = form.resultId ?? ''
    const artifactId = form.artifactId ?? ''
    let stored: StoredResultJson
    try {
      stored = await loadStoredResult(workspace.resultsDir, resultId)
      if (artifactId) {
        await assertArtifactMatchesResult(workspace.artifactsDir, artifactId, resultId)
      }
    } catch (error) {
      rejectBadRequest(res, error instanceof Error ? error.message : String(error))
      return
    }
    const filterColumn = form.filterColumn ?? ''
    const filterValue = form.filterValue ?? ''
    const saved = await saveAnalysisRevision(workspace.catalogPath, {
      datasetVersionId: stored.datasetVersionId,
      semanticRevisionId: stored.semanticRevisionId,
      question: form.question || form.title || 'Analysis',
      query: {
        datasetVersionId: stored.datasetVersionId,
        semanticRevisionId: stored.semanticRevisionId,
        sql: stored.sql,
        parameters: [],
      },
      resultId,
      chart: {
        mark: 'bar',
        title: form.title || 'Analysis',
        x: form.x,
        y: form.y,
      },
      artifactIds: artifactId ? [artifactId] : [],
      filter: filterColumn.trim() ? { column: filterColumn, value: filterValue } : undefined,
    })
    html(
      res,
      renderDatasetPage(dataset, {
        sql: stored.sql,
        filterColumn,
        filterValue,
        title: form.title,
        x: form.x,
        y: form.y,
        message: `Saved ${saved.analysisId} revision ${saved.revision}`,
        preview: {
          columns: [],
          rows: [],
          resultId,
          artifactId,
          analysisId: saved.analysisId,
        },
      }),
    )
    return
  }

  const pngMatch = url.pathname.match(/^\/analyst\/artifacts\/([^/]+)\/png$/)
  if (method === 'GET' && pngMatch) {
    const artifactId = decodeURIComponent(pngMatch[1]!)
    const svgPath = resolveSafeArtifact(workspace.artifactsDir, artifactId)
    if (!svgPath) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Invalid artifact id')
      return
    }
    try {
      const svg = await readFile(svgPath, 'utf8')
      const png = createPngFromSvg(svg)
      const baseName = artifactId.replace(/\.svg$/i, '')
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-disposition': `attachment; filename="${baseName}.png"`,
        'content-length': String(png.length),
        'cache-control': 'no-store',
      })
      res.end(png)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Missing artifact')
        return
      }
      throw error
    }
    return
  }

  const downloadMatch = url.pathname.match(/^\/analyst\/artifacts\/([^/]+)\/download$/)
  const viewMatch = url.pathname.match(/^\/analyst\/artifacts\/([^/]+)$/)
  const art = downloadMatch ?? viewMatch
  if (method === 'GET' && art) {
    const path = resolveSafeArtifact(workspace.artifactsDir, decodeURIComponent(art[1]!))
    if (!path) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Invalid artifact id')
      return
    }
    const info = await stat(path)
    if (!info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Missing artifact')
      return
    }
    const type =
      extname(path) === '.svg'
        ? 'image/svg+xml; charset=utf-8'
        : extname(path) === '.html'
          ? 'text/html; charset=utf-8'
          : extname(path) === '.json'
            ? 'application/json; charset=utf-8'
            : 'application/octet-stream'
    const headers: Record<string, string> = {
      'content-type': type,
      'content-length': String(info.size),
      'cache-control': 'no-store',
    }
    if (downloadMatch) {
      headers['content-disposition'] = `attachment; filename="${path.split('/').pop()}"`
    }
    res.writeHead(200, headers)
    createReadStream(path).pipe(res)
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Not found')
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}

export async function listenWorkbench(
  options: WorkbenchServerOptions = {},
): Promise<{ server: Server; url: string }> {
  const host = options.host ?? process.env.DSH_WORKBENCH_BIND ?? '127.0.0.1'
  const port = options.port ?? Number(process.env.DSH_WORKBENCH_PORT ?? 8790)
  const server = createWorkbenchServer(options)
  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()))
  return { server, url: `http://${host}:${port}/` }
}
