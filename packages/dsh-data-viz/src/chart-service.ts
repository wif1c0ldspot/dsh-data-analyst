/**
 * Chart artifact service for `make_chart`: resolve a stored query result,
 * compile a constrained intent, render SVG, and write the artifact under the
 * workspace. Model output is identifiers only — never raw SVG in the tool return.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import {
  ChartIntentSchema,
  type ChartDeliveryProfile,
  type ChartLayoutValidation,
  type ChartRefinementAttempt,
} from 'dsh-data-core/contracts'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import {
  compileChartIntent,
  deliveryWidthPxForProfile,
  renderChartSvg,
  renderEmptyResultSvg,
  toChartNumber,
  type ChartIntent,
  type ChartRow,
} from './chart.js'
import { validateChartLayoutSvg } from './chart-layout-validator.js'
import { proposeChartRefinement } from './chart-refinement.js'

export interface MakeChartRequest {
  resultId: string
  intent: unknown
  resultStoreDir: string
  artifactStoreDir: string
  /**
   * Named delivery context. A model or client selects only this bounded
   * enum — never a raw pixel width; `deliveryWidthPxForProfile` (`chart.ts`)
   * resolves it server-side. Defaults to `'chat-card'` when omitted.
   */
  deliveryProfile?: ChartDeliveryProfile
  /** Caller cancellation (dsh `exec.signal`); checked before IO / render. */
  signal?: AbortSignal
  /**
   * Walkthrough observability. Optional so unit tests that construct a `MakeChartRequest` directly (with
   * no metadata catalog on disk) keep working unchanged; `make_chart`
   * (`dsh-data-viz/index.ts`) always passes the workspace catalog path.
   */
  catalogPath?: string
}

export interface MakeChartResult {
  artifactId: string
  analysisRevisionId?: string
  /**
   * Truthful chart-completion state: `rendered` is always `true` here
   * (a failed compile/render throws before this is ever constructed), and
   * `layoutValidation` is the deterministic layout validator's own verdict on
   * the exact SVG just written to the artifact store — computed here,
   * server-side, right after `renderChartSvg`/`renderEmptyResultSvg`
   * produces it, never left for a caller to compute later or for a model to
   * assert on its own.
   */
  rendered: true
  layoutValidation: ChartLayoutValidation
  /**
   * Bounded automatic refinement attempt: whether a single deterministic
   * recompile was tried against the first render's diagnostics, what it
   * changed, and which issue codes it actually resolved. `layoutValidation`
   * above always reflects whichever render (original or retry) was kept.
   */
  refinement: ChartRefinementAttempt
}

interface StoredResult {
  resultId: string
  datasetVersionId?: string
  columns: Array<{ name: string; logicalType: string }>
  rows: unknown[][]
  /** Query-time caveats (e.g. join fan-out / currency-mix-risk) already computed at query time. */
  warnings?: string[]
}

/**
 * Thrown for a known, describable reason a chart couldn't be compiled from
 * already-authorized data (bad field/mark combination, an unsafe/imprecise
 * numeric value, a KPI shape violation, …) — every `chart.ts` validation
 * throw already carries a specific, non-sensitive message. Distinguishing
 * this from an unexpected Vega-internal render failure lets a caller (e.g.
 * `rechart.ts`) surface the actual reason instead of one generic message
 * for every failure cause.
 */
export class ChartValidationError extends Error {}

const RESULT_ID_RE = /^res_[a-z0-9]+$/i

/** Resolve `res_…` under resultStoreDir; reject invalid ids and path traversal. */
export function resolveSafeResult(resultStoreDir: string, resultId: string): string | null {
  if (!RESULT_ID_RE.test(resultId)) return null
  if (
    resultId.includes('..') ||
    resultId.includes('/') ||
    resultId.includes('\\') ||
    resultId.includes('\0')
  ) {
    return null
  }
  const root = resolve(resultStoreDir)
  const candidate = resolve(join(root, `${resultId}.json`))
  if (candidate !== root && !candidate.startsWith(root + sep)) return null
  return candidate
}

function rowsToChartRows(
  columns: Array<{ name: string; logicalType: string }>,
  rows: unknown[][],
  intent: ChartIntent,
): ChartRow[] {
  // `y` is a quantitative axis for every mark except heatmap, where it's the
  // second categorical axis (the actual quantitative field there is
  // `value`, driving the color encoding) — see `compileChartIntent`'s
  // heatmap branch in chart.ts. Forcing `y` through `toChartNumber`
  // regardless of mark broke every heatmap whose y field was categorical
  // (e.g. "Accountant" or "Normal" rejected as "not a plain decimal/integer
  // string"), no matter which field was mapped to x vs y.
  const numericFields = new Set(
    [intent.mark === 'heatmap' ? undefined : intent.y, intent.y2, intent.value].filter(
      (name): name is string => typeof name === 'string',
    ),
  )
  return rows.map((row) => {
    const object: ChartRow = {}
    for (let index = 0; index < columns.length; index++) {
      const column = columns[index]!
      const value = row[index]
      if (value === null || value === undefined) {
        object[column.name] = null
      } else if (
        (numericFields.has(column.name) ||
          (column.name === intent.x &&
            /^(?:U?(?:TINY|SMALL|BIG|HUGE)?INT(?:EGER)?|FLOAT|REAL|DOUBLE|DECIMAL(?:\(.+\))?)$/i.test(
              column.logicalType,
            ))) &&
        (typeof value === 'string' || typeof value === 'number')
      ) {
        object[column.name] = toChartNumber(value)
      } else if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        object[column.name] = value
      } else {
        object[column.name] = String(value)
      }
    }
    return object
  })
}

export async function createChartArtifact(request: MakeChartRequest): Promise<MakeChartResult> {
  request.signal?.throwIfAborted()
  const intent = ChartIntentSchema.parse(request.intent)
  const resultPath = resolveSafeResult(request.resultStoreDir, request.resultId)
  if (!resultPath) {
    throw new Error(`Invalid result id "${request.resultId}"`)
  }
  const storedRaw = await readFile(resultPath, 'utf8')
  request.signal?.throwIfAborted()
  const stored = JSON.parse(storedRaw) as StoredResult
  // Resolve the named delivery profile to its fixed internal pixel
  // width server-side. Omitted only preserves the default
  // (`compileChartIntent`'s own DEFAULT_DELIVERY_WIDTH_PX) for internal
  // callers that don't pass a profile (e.g. dashboard-filter recompiles).
  const deliveryProfile = request.deliveryProfile
  const deliveryWidthPx =
    deliveryProfile !== undefined ? deliveryWidthPxForProfile(deliveryProfile) : undefined
  const compileOptions = {
    warnings: stored.warnings,
    ...(deliveryWidthPx !== undefined ? { deliveryWidthPx } : {}),
  }
  let chartRows: ChartRow[]
  let vegaLiteSpec: import('vega-lite').TopLevelSpec
  try {
    chartRows = rowsToChartRows(stored.columns, stored.rows, intent)
    vegaLiteSpec =
      chartRows.length === 0
        ? ({
            $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
            title: intent.title,
            width: 400,
            height: 120,
            data: { values: [{ label: 'No rows returned for this query' }] },
            mark: 'text' as const,
            encoding: { text: { field: 'label', type: 'nominal' as const } },
          } satisfies import('vega-lite').TopLevelSpec)
        : compileChartIntent(intent, chartRows, compileOptions)
  } catch (error) {
    // rowsToChartRows (toChartNumber) and compileChartIntent throw a
    // specific, safe-to-surface message for every validation failure —
    // re-thrown typed so a caller can tell this apart from an unexpected
    // Vega-internal render failure below.
    throw new ChartValidationError(error instanceof Error ? error.message : String(error))
  }
  let svg =
    chartRows.length === 0
      ? await renderEmptyResultSvg(intent.title)
      : await renderChartSvg(vegaLiteSpec)

  request.signal?.throwIfAborted()
  let layoutValidation = validateChartLayoutSvg(svg)

  // Exactly one bounded, deterministic recompile — never a loop, never
  // a re-query — when the first render fails layout validation. The retry
  // reuses the same authorized `chartRows` (result identity and data values
  // never change); only the chart template/spec can change. Whichever
  // render is actually kept below is the only one ever written to the
  // artifact store — a caller never sees an artifact for the rejected one.
  let refinement: ChartRefinementAttempt = {
    attempted: false,
    changes: [],
    resolvedCodes: [],
    remainingDiagnostics: layoutValidation.diagnostics,
  }
  if (!layoutValidation.ok && chartRows.length > 0) {
    const proposal = proposeChartRefinement(intent, layoutValidation.diagnostics)
    if (proposal) {
      request.signal?.throwIfAborted()
      try {
        const retrySpec = compileChartIntent(proposal.intent, chartRows, compileOptions)
        const retrySvg = await renderChartSvg(retrySpec)
        const retryValidation = validateChartLayoutSvg(retrySvg)
        const originalCodes = new Set(layoutValidation.diagnostics.map((d) => d.code))
        const retryCodes = new Set(retryValidation.diagnostics.map((d) => d.code))
        const strictlyBetter =
          retryValidation.ok ||
          retryValidation.diagnostics.length < layoutValidation.diagnostics.length
        if (strictlyBetter) {
          svg = retrySvg
          vegaLiteSpec = retrySpec
          refinement = {
            attempted: true,
            changes: proposal.changes,
            resolvedCodes: [...originalCodes].filter((code) => !retryCodes.has(code)),
            remainingDiagnostics: retryValidation.diagnostics,
            // Only on the kept branch: the other two keep the original render, so
            // nothing the caller asked for was overridden there.
            ...(proposal.overrodeRequestedFormat ? { overrodeRequestedFormat: true } : {}),
          }
          layoutValidation = retryValidation
        } else {
          // The retry did not improve on the original — keep the original
          // render and report the honest, unresolved diagnostics rather
          // than adopting a change that made things no better (or worse).
          refinement = {
            attempted: true,
            changes: proposal.changes,
            resolvedCodes: [],
            remainingDiagnostics: layoutValidation.diagnostics,
          }
        }
      } catch {
        // The proposed template change itself failed to compile/render for
        // this intent/data — keep the original (already-rendered) chart and
        // report the attempt as unresolved instead of throwing away a
        // working, if imperfect, artifact.
        refinement = {
          attempted: true,
          changes: proposal.changes,
          resolvedCodes: [],
          remainingDiagnostics: layoutValidation.diagnostics,
        }
      }
    }
  }

  const artifactId = `art_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  await mkdir(request.artifactStoreDir, { recursive: true })
  await writeFile(join(request.artifactStoreDir, `${artifactId}.svg`), svg, 'utf8')
  await writeFile(
    join(request.artifactStoreDir, `${artifactId}.json`),
    JSON.stringify({
      artifactId,
      resultId: request.resultId,
      intent,
      vegaLiteSpec,
      svgBytes: Buffer.byteLength(svg),
      renderer: { vegaLiteSchema: 'https://vega.github.io/schema/vega-lite/v6.json' },
      // The resolved delivery profile/pixel width travel with the
      // artifact's own provenance record, not just the render-time request —
      // a later reader (export, rechart, an audit) can see which profile
      // actually produced this artifact. `deliveryProfile` is omitted (not
      // null) when the caller didn't select one, matching the
      // default-width path.
      ...(deliveryProfile !== undefined ? { deliveryProfile } : {}),
      ...(deliveryWidthPx !== undefined ? { deliveryWidthPx } : {}),
      // The validator's own verdict for whichever render was kept,
      // attached at render time so it travels with the artifact's
      // provenance record — not recomputed or asserted later by a caller.
      layoutValidation,
      // The bounded automatic refinement attempt that produced (or
      // failed to fully resolve) this artifact.
      refinement,
    }),
    'utf8',
  )
  // "chart rendered" is a service-observed fact recorded right after
  // the artifact and its sidecar are durably written — never inferred from
  // model text, and never carrying the SVG/spec itself, only its id.
  if (request.catalogPath && stored.datasetVersionId) {
    const store = new MetadataStore(request.catalogPath)
    try {
      store.recordWorkflowMilestone({
        milestone: 'chart_rendered',
        actor: 'service',
        datasetVersionId: stored.datasetVersionId,
        receiptId: artifactId,
      })
    } finally {
      store.close()
    }
  }
  return { artifactId, rendered: true, layoutValidation, refinement }
}
