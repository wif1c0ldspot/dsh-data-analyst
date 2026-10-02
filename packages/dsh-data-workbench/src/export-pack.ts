/**
 * Trusted export pack bound to an authorized result + chart artifact.
 * Offline HTML embeds SVG; no CDN, credentials, or server-backed HTMX.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadAnalysisRevision, saveAnalysisRevision } from 'dsh-data-core/analysis-store'
import { interpretationApprovedForExport } from 'dsh-data-core/interpretation-review'
import {
  ChartIntentSchema,
  QueryRequestSchema,
  type AnalysisRevision,
  type QueryRequest,
} from 'dsh-data-core/contracts'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { randomUUID } from 'node:crypto'
import { renderResultCsv } from 'dsh-data-core/csv-export'
import { deriveResultEvidence } from 'dsh-data-core/result-evidence'
import { loadStoredQueryResult } from 'dsh-data-core/stored-result'
import {
  ReportTemplateSchema,
  ReportNarrativeSchema,
  type ReportNarrative,
  type ReportTemplate,
  renderHtmlDashboardReport,
  renderHtmlReport,
} from 'dsh-data-core/report-template'
import { formatDisplayNumber } from 'dsh-data-core/display-format'
import type { WorkspacePaths } from 'dsh-data-core/workspace-paths'
import { createPngFromSvg } from 'dsh-data-viz/png-export'
import { toChartNumber } from 'dsh-data-viz/chart'
import { ZipFile } from 'yazl'
import { resolveSafeArtifact } from './artifact-path.js'
import { dashboardSlotTitle } from './dashboard-slot-title.js'

export interface ExportPackRequest {
  template?: ReportTemplate
  workspace: WorkspacePaths
  resultId: string
  artifactId: string
  title?: string
  question?: string
  analysisId?: string
  narrative?: ReportNarrative
}

export interface ExportPackResult {
  reportId: string
  analysisId?: string
  downloads: Record<string, string>
  files: {
    html: string
    svg: string
    csv: string
    png: string
    specification: string
    analysis?: string
  }
}

function reportRows(
  rows: unknown[][],
  columns: Array<{ name: string; logicalType: string }>,
  intent: { y?: string; y2?: string; value?: string; format?: { decimals?: number } },
): { exact: string[][]; display: string[][] } {
  const exact = rows.map((row) => row.map((cell) => (cell === null ? 'NULL' : String(cell))))
  const decimals = intent.format?.decimals
  if (decimals === undefined) {
    // No explicit rounding was requested, but display still groups digits so the
    // supporting-values table reads like the chart axis above it. `exact` keeps
    // stored values untouched for downloads and provenance.
    return {
      exact,
      display: rows.map((row) =>
        row.map((cell, index) => {
          if (cell === null) return '—'
          const column = columns[index]
          if (!column || !/INT|DECIMAL|DOUBLE|FLOAT|REAL|NUMERIC/i.test(column.logicalType)) {
            return String(cell)
          }
          return formatDisplayNumber(String(cell))
        }),
      ),
    }
  }
  const quantitative = new Set([intent.y, intent.y2, intent.value].filter(Boolean))
  const formatter = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  const display = rows.map((row) =>
    row.map((cell, index) => {
      if (cell === null) return '—'
      const column = columns[index]
      if (
        !column ||
        !quantitative.has(column.name) ||
        !/INT|DECIMAL|DOUBLE|FLOAT|REAL|NUMERIC/i.test(column.logicalType)
      )
        return String(cell)
      try {
        return formatter.format(toChartNumber(cell as string | number))
      } catch {
        return String(cell)
      }
    }),
  )
  return { exact, display }
}

export async function assertArtifactMatchesResult(
  artifactsDir: string,
  artifactId: string,
  resultId: string,
): Promise<{ intent?: unknown; vegaLiteSpec?: unknown; renderer?: unknown }> {
  if (!/^art_[a-z0-9]+$/i.test(artifactId)) {
    throw new Error('Invalid artifact id')
  }
  const sidecarPath = resolveSafeArtifact(artifactsDir, `${artifactId}.json`)
  if (!sidecarPath) throw new Error('Invalid artifact path')
  const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
    resultId?: string
    intent?: unknown
    vegaLiteSpec?: unknown
    renderer?: unknown
  }
  if (sidecar.resultId !== resultId) {
    throw new Error('Artifact resultId mismatch')
  }
  return sidecar
}

function sourceCaption(
  catalogPath: string,
  datasetVersionId: string,
  semanticRevisionId: string,
): string {
  const store = new MetadataStore(catalogPath)
  try {
    const source = store.getDatasetVersion(datasetVersionId)?.source
    return source
      ? `${source.slug} · source version ${source.version} · ${source.url} · retrieved ${source.retrievedAt}`
      : `${datasetVersionId} / ${semanticRevisionId} · source attribution unavailable`
  } finally {
    store.close()
  }
}

export async function writeExportPack(request: ExportPackRequest): Promise<ExportPackResult> {
  const template = ReportTemplateSchema.parse(request.template ?? 'analytical-brief')
  const { workspace } = request
  const result = await loadStoredQueryResult(workspace.resultsDir, request.resultId)
  const sidecar = await assertArtifactMatchesResult(
    workspace.artifactsDir,
    request.artifactId,
    request.resultId,
  )
  const svgPath = resolveSafeArtifact(workspace.artifactsDir, `${request.artifactId}.svg`)
  if (!svgPath) throw new Error('Invalid chart artifact')
  const svgMarkup = await readFile(svgPath, 'utf8')
  if (!result.rows || !Array.isArray(result.rows)) {
    throw new Error('Stored result missing full authorized rows for export')
  }
  const intent = ChartIntentSchema.parse(sidecar.intent)
  const existing = request.analysisId
    ? await loadAnalysisRevision(workspace.catalogPath, request.analysisId)
    : undefined
  if (
    existing &&
    (existing.resultId !== request.resultId || !existing.artifactIds.includes(request.artifactId))
  ) {
    throw new Error('Saved analysis does not match the selected result and chart')
  }
  const parameters = existing?.query.parameters ?? result.parameters
  if (!parameters) {
    throw new Error(
      'Query parameter provenance unavailable; rerun the query before exporting this unsaved result',
    )
  }
  const query = QueryRequestSchema.parse({
    datasetVersionId: result.datasetVersionId,
    semanticRevisionId: result.semanticRevisionId,
    sql: result.sql,
    parameters,
  })
  const title = request.title?.trim() || intent.title
  const exportRows = reportRows(result.rows, result.columns, intent)
  const report = renderHtmlReport({
    template,
    title,
    evidence: deriveResultEvidence(result, {
      analysisId: existing?.analysisId,
      revision: existing?.revision,
    }),
    svgMarkup: intent.mark === 'table' ? '' : svgMarkup,
    columns: result.columns,
    rows: exportRows.exact,
    displayRows: exportRows.display,
    rowCount: result.rowCount,
    previewTruncated: false,
    sourceCaption: sourceCaption(
      request.workspace.catalogPath,
      result.datasetVersionId,
      result.semanticRevisionId,
    ),
    datasetVersionId: result.datasetVersionId,
    semanticRevisionId: result.semanticRevisionId,
    generatedAt: new Date().toISOString(),
    warnings: result.warnings ?? [],
    sql: result.sql,
    parameters: query.parameters,
    narrative: request.narrative ? ReportNarrativeSchema.parse(request.narrative) : undefined,
  })
  const csv = renderResultCsv(result.columns, result.rows)
  const png = createPngFromSvg(svgMarkup)
  const specification = {
    kind: 'dsh-data-analysis-specification',
    resultId: request.resultId,
    artifactId: request.artifactId,
    datasetVersionId: result.datasetVersionId,
    semanticRevisionId: result.semanticRevisionId,
    sql: result.sql,
    parameters: query.parameters,
    intent: sidecar.intent,
    vegaLite: sidecar.vegaLiteSpec,
    renderer: sidecar.renderer ?? {
      vegaLiteSchema: 'https://vega.github.io/schema/vega-lite/v6.json',
    },
    exportedAt: new Date().toISOString(),
  }

  await mkdir(workspace.artifactsDir, { recursive: true })
  const packId = `export_${randomUUID().replace(/-/g, '')}`
  const htmlName = `${packId}.html`
  const csvName = `${packId}.csv`
  const pngName = `${packId}.png`
  const specName = `${packId}_spec.json`
  await writeFile(join(workspace.artifactsDir, htmlName), report, 'utf8')
  await writeFile(join(workspace.artifactsDir, csvName), csv, 'utf8')
  await writeFile(join(workspace.artifactsDir, pngName), png)
  await writeFile(
    join(workspace.artifactsDir, specName),
    `${JSON.stringify(specification, null, 2)}\n`,
    'utf8',
  )

  const saved =
    existing ??
    (await saveAnalysisRevision(workspace.catalogPath, {
      datasetVersionId: result.datasetVersionId,
      semanticRevisionId: result.semanticRevisionId,
      question: request.question ?? title,
      query,
      resultId: request.resultId,
      chart: intent,
      artifactIds: [request.artifactId],
    }))
  const analysisFile = `${packId}_analysis.json`
  const svgName = `${packId}.svg`
  await writeFile(
    join(workspace.artifactsDir, analysisFile),
    `${JSON.stringify(saved, null, 2)}\n`,
    'utf8',
  )
  await writeFile(join(workspace.artifactsDir, svgName), svgMarkup, 'utf8')
  const files = {
    html: htmlName,
    svg: svgName,
    csv: csvName,
    png: pngName,
    specification: specName,
    analysis: analysisFile,
  }
  const registry = new MetadataStore(workspace.catalogPath)
  try {
    registry.recordReportExport({
      reportId: packId,
      title,
      source: {
        kind: 'analysis',
        analysisId: saved.analysisId,
        revision: saved.revision,
        resultId: saved.resultId,
        datasetVersionId: saved.datasetVersionId,
        semanticRevisionId: saved.semanticRevisionId,
      },
      files,
    })
  } finally {
    registry.close()
  }
  return {
    reportId: packId,
    analysisId: saved.analysisId,
    files,
    downloads: Object.fromEntries(
      Object.entries(files).map(([format, file]) => [
        format,
        `/api/analyst/reports?file=${encodeURIComponent(file)}`,
      ]),
    ),
  }
}

/** Cap rows per dashboard section so a combined report stays a bounded summary. */
const DASHBOARD_SECTION_ROW_LIMIT = 20

export interface DashboardExportRequest {
  expectedVersion?: string
  template?: ReportTemplate
  workspace: WorkspacePaths
  dashboardId: string
  title?: string
  /** Analyst-authored executive summary; escaped verbatim in the report. */
  summary?: string
  /** Number-backed key figures shown as cards above the chart sections. */
  kpis?: Array<{ label: string; value: string; note?: string }>
  narrative?: ReportNarrative
}

export interface DashboardExportResult {
  reportId: string
  dashboardId: string
  slotCount: number
  slots: Array<{
    analysisId: string
    revision: number
    resultId: string
    title: string
    sharedFilterKeys: string[]
  }>
  files: { html: string; zip: string }
  downloads: Record<string, string>
}

interface DashboardSectionExport {
  index: number
  question: string
  analysisId: string
  resultId: string
  revision: number
  datasetVersionId: string
  semanticRevisionId: string
  svgMarkup: string | undefined
  columns: Array<{ name: string; logicalType: string; unit?: string }>
  fullRows: unknown[][]
  rowCount: number
  sql: string
  parameters: QueryRequest['parameters']
  intent: unknown
}

/**
 * Compose every pinned analysis of a dashboard into one self-contained,
 * offline-openable HTML report (title + optional executive summary + one
 * section per chart/table) and a stakeholder ZIP bundling the report with each
 * section's chart.svg/png, full CSV, and specification JSON. Charts reuse the
 * already-rendered SVG artifacts; HTML tables are bounded per section but the
 * ZIP carries full rows. No CDN/script/remote resource.
 */
export async function writeDashboardExportPack(
  request: DashboardExportRequest,
): Promise<DashboardExportResult> {
  const store = new MetadataStore(request.workspace.catalogPath)
  try {
    const dashboard = store.loadDashboard(request.dashboardId)
    if (!dashboard) throw new Error(`Unknown dashboard "${request.dashboardId}"`)
    if (request.expectedVersion !== undefined && request.expectedVersion !== dashboard.updatedAt)
      throw new Error('Dashboard changed; refresh before exporting')
    if (dashboard.layout.slots.length === 0) {
      throw new Error('Dashboard has no pinned analyses to export')
    }

    const sections: Parameters<typeof renderHtmlDashboardReport>[0]['sections'] = []
    const sectionExports: DashboardSectionExport[] = []
    const pinnedAnalyses: AnalysisRevision[] = []
    for (const [index, slot] of dashboard.layout.slots.entries()) {
      const analysis = store.loadAnalysisRevision(slot.analysisId, slot.revision)
      if (!analysis) {
        throw new Error(`Dashboard slot references unknown analysis "${slot.analysisId}"`)
      }
      pinnedAnalyses.push(analysis)
      const result = await loadStoredQueryResult(request.workspace.resultsDir, analysis.resultId)
      if (!Array.isArray(result.rows)) {
        throw new Error('Stored result missing full authorized rows for dashboard export')
      }
      const rows = result.rows
      const exportRows = reportRows(
        rows.slice(0, DASHBOARD_SECTION_ROW_LIMIT),
        result.columns,
        analysis.chart,
      )

      let svgMarkup: string | undefined
      const artifactId = analysis.artifactIds[0]
      if (artifactId) {
        await assertArtifactMatchesResult(
          request.workspace.artifactsDir,
          artifactId,
          analysis.resultId,
        )
        const svgPath = resolveSafeArtifact(request.workspace.artifactsDir, `${artifactId}.svg`)
        if (!svgPath) throw new Error('Invalid chart artifact')
        svgMarkup = await readFile(svgPath, 'utf8')
      }

      const question = dashboardSlotTitle(slot, analysis)
      sections.push({
        question,
        context: analysis.question !== question ? analysis.question : undefined,
        evidence: deriveResultEvidence(result, {
          analysisId: analysis.analysisId,
          revision: analysis.revision,
        }),
        svgMarkup: analysis.chart.mark === 'table' ? undefined : svgMarkup,
        columns: result.columns,
        rows: exportRows.exact,
        displayRows: exportRows.display,
        rowCount: result.rowCount,
        sourceCaption: sourceCaption(
          request.workspace.catalogPath,
          result.datasetVersionId,
          result.semanticRevisionId,
        ),
        sql: result.sql,
        parameters: analysis.query.parameters,
      })
      sectionExports.push({
        index: index + 1,
        question,
        analysisId: analysis.analysisId,
        resultId: analysis.resultId,
        revision: analysis.revision,
        datasetVersionId: result.datasetVersionId,
        semanticRevisionId: result.semanticRevisionId,
        svgMarkup,
        columns: result.columns,
        fullRows: rows,
        rowCount: result.rowCount,
        sql: result.sql,
        parameters: analysis.query.parameters,
        intent: analysis.chart,
      })
    }

    const reportTitle = request.title?.trim() || dashboard.title
    // Facts-only rule: `summary`/`narrative` are generated interpretation, so they
    // ship only when the caller opted in *and* every pinned revision's
    // interpretation was reviewed and approved for export — the same gate the
    // Studio applies before offering "include interpretation". Without it a
    // shareable report printed the unreviewed interpretation while claiming it
    // had been left out.
    const interpretationApproved =
      request.narrative?.includeInterpretation === true &&
      pinnedAnalyses.length > 0 &&
      pinnedAnalyses.every((analysis) => interpretationApprovedForExport(analysis))
    const report = renderHtmlDashboardReport({
      template: ReportTemplateSchema.parse(request.template ?? 'analytical-brief'),
      title: reportTitle,
      summary: request.summary?.trim() || undefined,
      interpretationApproved,
      kpis: request.kpis,
      narrative: request.narrative
        ? ReportNarrativeSchema.parse({
            ...request.narrative,
            includeInterpretation: interpretationApproved,
          })
        : undefined,
      sections,
      generatedAt: new Date().toISOString(),
    })

    await mkdir(request.workspace.artifactsDir, { recursive: true })
    const packId = `export_${randomUUID().replace(/-/g, '')}`
    const htmlName = `${packId}.html`
    const zipName = `${packId}.zip`
    await writeFile(join(request.workspace.artifactsDir, htmlName), report, 'utf8')

    const zip = new ZipFile()
    zip.addBuffer(Buffer.from(report, 'utf8'), 'report.html')
    for (const section of sectionExports) {
      const prefix = `section_${section.index}`
      if (section.svgMarkup) {
        zip.addBuffer(Buffer.from(section.svgMarkup, 'utf8'), `${prefix}/chart.svg`)
        zip.addBuffer(createPngFromSvg(section.svgMarkup), `${prefix}/chart.png`)
      }
      zip.addBuffer(
        Buffer.from(renderResultCsv(section.columns, section.fullRows), 'utf8'),
        `${prefix}/data.csv`,
      )
      zip.addBuffer(
        Buffer.from(
          `${JSON.stringify(
            {
              kind: 'dsh-data-analysis-specification',
              question: section.question,
              analysisId: section.analysisId,
              resultId: section.resultId,
              revision: section.revision,
              datasetVersionId: section.datasetVersionId,
              semanticRevisionId: section.semanticRevisionId,
              sql: section.sql,
              parameters: section.parameters,
              intent: section.intent,
              rowCount: section.rowCount,
              exportedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          'utf8',
        ),
        `${prefix}/specification.json`,
      )
    }
    const zipPath = join(request.workspace.artifactsDir, zipName)
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(zipPath)
      zip.outputStream.pipe(stream)
      zip.outputStream.on('error', reject)
      stream.on('close', resolve)
      stream.on('error', reject)
      zip.end()
    })

    const files = { html: htmlName, zip: zipName }
    store.recordReportExport({
      reportId: packId,
      title: reportTitle,
      source: {
        kind: 'dashboard',
        dashboardId: dashboard.dashboardId,
        version: dashboard.updatedAt,
        slots: sectionExports.map((section) => ({
          analysisId: section.analysisId,
          revision: section.revision,
          resultId: section.resultId,
        })),
      },
      files,
    })

    const receiptSlots = sectionExports.map((section, index) => ({
      analysisId: section.analysisId,
      revision: section.revision,
      resultId: section.resultId,
      title: section.question,
      sharedFilterKeys: dashboard.layout.slots[index]!.sharedFilterKeys,
    }))
    return {
      reportId: packId,
      dashboardId: request.dashboardId,
      slotCount: receiptSlots.length,
      slots: receiptSlots,
      files,
      downloads: {
        html: `/api/analyst/reports?file=${encodeURIComponent(htmlName)}`,
        zip: `/api/analyst/reports?file=${encodeURIComponent(zipName)}`,
      },
    }
  } finally {
    store.close()
  }
}
