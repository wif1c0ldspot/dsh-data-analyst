/**
 * One-click display refinement (mark switcher): rechart a saved analysis with a
 * different mark, reusing the same authorized result — never re-querying. Only
 * marks valid for the existing chart encodings are accepted, mirroring the
 * client's button set so a rechart never reaches `createChartArtifact` with an
 * incompatible mark.
 */
import { loadAnalysisRevision, saveAnalysisRevision } from 'dsh-data-core/analysis-store'
import {
  ChartDeliveryProfileSchema,
  ChartFormatSchema,
  ChartIntentSchema,
  type ChartDeliveryProfile,
  type ChartIntent,
} from 'dsh-data-core/contracts'
import { carryInterpretationReview } from 'dsh-data-core/interpretation-review'
import { AnalysisNotFoundError, AnalysisRevisionConflictError } from 'dsh-data-core/metadata-store'
import { loadStoredQueryResult } from 'dsh-data-core/stored-result'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { ChartValidationError, createChartArtifact } from './chart-service.js'

const ANALYSIS_ID_RE = /^ana_[a-zA-Z0-9]+$/
const MARKS = ['bar', 'line', 'point', 'area', 'heatmap', 'table', 'kpi'] as const
export type RechartMark = (typeof MARKS)[number]

/** Marks valid for a chart intent's existing encodings (shared with client.js). */
export function allowedMarksForChart(chart: ChartIntent, rowCount?: number): RechartMark[] {
  const marks: RechartMark[] = ['table']
  if (rowCount === 1 && chart.y) marks.push('kpi')
  if (chart.x && chart.y) marks.push('bar', 'line', 'point', 'area')
  if (chart.value) marks.push('heatmap')
  return marks.filter((mark) => ChartIntentSchema.safeParse({ ...chart, mark }).success)
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin')
  const requestHost = request.headers.get('host') ?? new URL(request.url).host
  let originHost = ''
  try {
    originHost = origin ? new URL(origin).host : ''
  } catch {
    // Invalid origins fail the comparison below.
  }
  return originHost !== '' && originHost === requestHost
}

export async function handleChartRechartRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!isSameOriginRequest(request)) return json({ error: 'Same-origin request required' }, 403)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400)
  const {
    analysisId,
    expectedRevision,
    mark,
    title,
    format,
    deliveryProfile: rawDeliveryProfile,
    preview,
  } = body as Record<string, unknown>
  if (typeof analysisId !== 'string' || !ANALYSIS_ID_RE.test(analysisId)) {
    return json({ error: 'Invalid analysis id' }, 400)
  }
  if (
    mark !== undefined &&
    (typeof mark !== 'string' || !(MARKS as readonly string[]).includes(mark))
  ) {
    return json({ error: 'Invalid mark' }, 400)
  }
  if (
    title !== undefined &&
    (typeof title !== 'string' || !title.trim() || title.trim().length > 200)
  ) {
    return json({ error: 'Invalid title' }, 400)
  }
  if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1) {
    return json({ error: 'Invalid expected revision' }, 400)
  }
  if (preview !== undefined && typeof preview !== 'boolean') {
    return json({ error: 'Invalid preview flag' }, 400)
  }

  const parsedFormat = ChartFormatSchema.optional().safeParse(format)
  if (!parsedFormat.success) return json({ error: 'Invalid chart formatting' }, 400)

  // Studio may probe a different delivery-width profile (e.g. to
  // preview how a chart looks in a wider export) without that alone
  // mutating the saved analysis — see the `preview` branch below, which
  // renders but never calls `saveAnalysisRevision`. Only this bounded enum
  // is accepted here too; never a raw pixel width.
  const parsedDeliveryProfile = ChartDeliveryProfileSchema.optional().safeParse(rawDeliveryProfile)
  if (!parsedDeliveryProfile.success) return json({ error: 'Invalid delivery profile' }, 400)

  const workspace = resolveWorkspacePaths()
  let analysis
  try {
    analysis = await loadAnalysisRevision(workspace.catalogPath, analysisId)
  } catch (error) {
    if (error instanceof AnalysisNotFoundError) {
      return json({ error: `Unknown analysis "${analysisId}"` }, 404)
    }
    throw error
  }

  const selectedMark = (mark ?? analysis.chart.mark) as RechartMark
  const result = await loadStoredQueryResult(workspace.resultsDir, analysis.resultId)
  if (!allowedMarksForChart(analysis.chart, result.rows?.length).includes(selectedMark)) {
    return json({ error: `Mark "${mark}" is not valid for this chart's encodings` }, 400)
  }
  if (analysis.revision !== expectedRevision) {
    return json(
      {
        error: `Analysis revision conflict: expected ${String(expectedRevision)}, current ${analysis.revision}`,
      },
      409,
    )
  }

  const chart = {
    ...analysis.chart,
    mark: selectedMark,
    ...(typeof title === 'string' ? { title: title.trim() } : {}),
    ...(parsedFormat.data !== undefined ? { format: parsedFormat.data } : {}),
  }
  const deliveryProfile: ChartDeliveryProfile | undefined = parsedDeliveryProfile.data
  let artifact
  try {
    artifact = await createChartArtifact({
      resultId: analysis.resultId,
      intent: chart,
      deliveryProfile,
      resultStoreDir: workspace.resultsDir,
      artifactStoreDir: workspace.artifactsDir,
      signal: request.signal,
    })
  } catch (error) {
    return json(
      {
        error:
          error instanceof ChartValidationError
            ? `This display could not be rendered: ${error.message}. Your saved analysis is unchanged; choose another display or formatting option.`
            : 'This display could not be rendered. Your saved analysis is unchanged; choose another display or formatting option.',
      },
      422,
    )
  }

  // A `preview` probe (e.g. Studio checking how the chart looks at a
  // different delivery profile) reuses the same authorized result and
  // renders a real artifact, but must never advance the saved analysis — no
  // `saveAnalysisRevision` call, no new revision. Only an explicit,
  // non-preview rechart (the existing behavior below) persists.
  if (preview === true) {
    return json({
      artifactId: artifact.artifactId,
      analysisId,
      resultId: analysis.resultId,
      revision: analysis.revision,
      chart,
      preview: true,
    })
  }

  try {
    const saved = await saveAnalysisRevision(workspace.catalogPath, {
      analysisId,
      expectedRevision: Number(expectedRevision),
      datasetVersionId: analysis.datasetVersionId,
      semanticRevisionId: analysis.semanticRevisionId,
      question: analysis.question,
      query: analysis.query,
      resultId: analysis.resultId,
      chart,
      artifactIds: [artifact.artifactId],
      interpretation: analysis.interpretation,
      interpretationReview: carryInterpretationReview(analysis, {
        resultId: analysis.resultId,
        interpretation: analysis.interpretation,
      }),
    })
    return json({
      artifactId: artifact.artifactId,
      analysisId,
      resultId: saved.resultId,
      revision: saved.revision,
      chart: saved.chart,
      interpretationReview: saved.interpretationReview,
    })
  } catch (error) {
    if (error instanceof AnalysisRevisionConflictError) {
      return json({ error: error.message }, 409)
    }
    throw error
  }
}
