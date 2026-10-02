/**
 * Chart compilation and server SVG rendering. Compiles
 * a constrained ChartIntent plus already-authorized tabular data into
 * Vega-Lite, then renders SVG through Vega. No URLs, external data sources,
 * image marks, or executable expressions are accepted.
 */
import { isPayloadPreviewWarning } from 'dsh-data-core/result-warnings'
import { compile, type TopLevelSpec } from 'vega-lite'
import { parse, View, scheme } from 'vega'
import BigNumber from 'bignumber.js'
import {
  ChartIntentSchema,
  type ChartDeliveryProfile,
  type ChartIntent,
} from 'dsh-data-core/contracts'

export type { ChartIntent } from 'dsh-data-core/contracts'

/** A chartable row: string/number/boolean/null only, never a raw native DB value. */
export type ChartRow = Record<string, string | number | boolean | null>

const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER
const SAFE_INTEGER_MIN = Number.MIN_SAFE_INTEGER

/**
 * Convert a DECIMAL/BIGINT display string into a chart number only when the
 * decimal value survives a Number/string round trip. This checks decimal
 * precision, not exact binary representation (ordinary 88.29 remains usable).
 * Throws instead of silently coercing an unsafe integer or losing digits.
 */
export function toChartNumber(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite chart value: ${value}`)
    return value
  }
  if (!/^-?\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Value is not a plain decimal/integer string: ${JSON.stringify(value)}`)
  }
  const asNumber = Number(value)
  if (!Number.isFinite(asNumber))
    throw new Error(`Value overflowed to a non-finite number: ${value}`)
  if (Number.isInteger(asNumber) && (asNumber > SAFE_INTEGER_MAX || asNumber < SAFE_INTEGER_MIN)) {
    throw new Error(`Integer value ${value} exceeds the JS safe-integer range; keep it as a string`)
  }
  // Compare the original decimal with the display number's decimal form.
  // Comparing two already-coerced Numbers cannot detect lost fractional digits.
  if (!new BigNumber(value).isEqualTo(new BigNumber(asNumber.toString()))) {
    throw new Error(`Value ${value} loses decimal precision as a chart number; keep it as a string`)
  }
  return asNumber
}

function fieldType(sample: unknown): 'nominal' | 'quantitative' | 'temporal' {
  if (typeof sample === 'number') return 'quantitative'
  if (typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sample)) return 'temporal'
  return 'nominal'
}

function sampleValue(rows: ChartRow[], field: string): ChartRow[string] | undefined {
  return rows.find((row) => row[field] !== null && row[field] !== undefined)?.[field]
}

function xValuesAreSafeIntegers(rows: ChartRow[], field: string): boolean {
  return rows.every((row) => {
    const value = row[field]
    return value == null || (typeof value === 'number' && Number.isSafeInteger(value))
  })
}

function assertFieldsExist(intent: ChartIntent, rows: ChartRow[], fields: string[]): void {
  const known = new Set(rows.flatMap((row) => Object.keys(row)))
  for (const field of fields) {
    if (!known.has(field)) {
      throw new Error(`Chart field "${field}" is not present in the authorized result`)
    }
  }
  if (intent.sort && !known.has(intent.sort.field)) {
    throw new Error(
      `Chart sort field "${intent.sort.field}" is not present in the authorized result`,
    )
  }
}

/**
 * Fold caveats (query warnings, e.g. fan-out/currency-mix risk) into a chart
 * title's `subtitle` so they travel with the rendered image itself — an
 * exported or screenshotted chart otherwise carries no visual cue that its
 * evidence is qualified, undercutting the computed-findings-vs-interpretation
 * separation the analyst review flow is built around.
 *
 * The title text itself is first wrapped to `availableTitleWidthPx` (see
 * `wrapChartTitle`) — the caller's own estimate of the chart's actual
 * rendered width — a long, natural title (e.g. one naming two charted
 * dimensions) otherwise forces Vega-Lite to widen the whole rendered canvas
 * to fit it on one line, silently reintroducing the same
 * `deliveryWidthPx`-ignored failure that `computePlotWidth`/`withFacet`
 * fixed for plot width. Wrapping (not truncating) keeps the full title on
 * the image itself — the only place some callers ever show it (see
 * `dashboard-slot-title.ts`) — so it never becomes information the analyst
 * can no longer see.
 */
function withCaveats(
  title: string,
  warnings: readonly string[] | undefined,
  availableTitleWidthPx: number,
) {
  const wrappedTitle = wrapChartTitle(title, availableTitleWidthPx)
  // A payload-transport notice ("Preview capped at N of M rows") says how much of
  // the result the *model* was shown, not something about the chart, so it never
  // belongs in a caption — including for results stored before the notice was
  // split out of the persisted caveats.
  const caveats = (warnings ?? []).filter((warning) => !isPayloadPreviewWarning(warning))
  if (caveats.length === 0) return wrappedTitle
  return { text: wrappedTitle, subtitle: caveats.join(' · '), anchor: 'start' as const }
}

/**
 * Default delivery width (px) assumed when a caller doesn't pass an explicit
 * `deliveryWidthPx` or `deliveryProfile` (kept for backward compatibility
 * with existing internal callers — dashboard-filter recompiles, rechart
 * without a profile — that predate the named delivery profiles below). Roughly the
 * previous fixed 560px chart width plus margins.
 */
const DEFAULT_DELIVERY_WIDTH_PX = 640

/**
 * Service-owned delivery-width profiles: a small, bounded set of
 * named delivery contexts, each mapped to a fixed internal pixel width. A
 * model or client selects a profile (`ChartDeliveryProfileSchema`); only
 * this module ever decides the actual pixel width — no tool parameter
 * anywhere accepts a raw number.
 */
const DELIVERY_PROFILE_WIDTH_PX: Record<ChartDeliveryProfile, number> = {
  'chat-card': 420,
  'sidebar-narrow': 480,
  'sidebar-wide': 760,
  export: 900,
}

/** Resolve a delivery profile to its fixed internal pixel width. */
export function deliveryWidthPxForProfile(profile: ChartDeliveryProfile): number {
  return DELIVERY_PROFILE_WIDTH_PX[profile]
}

/**
 * Margin reserved around a single (non-faceted) plot's own axis
 * labels/ticks/title — separate from `FACET_SIDE_MARGIN` below, which covers
 * a whole faceted grid. Chosen so the default 640px delivery width
 * (`DEFAULT_DELIVERY_WIDTH_PX`) continues to resolve to the previous fixed
 * 560px plot width for existing callers that never passed a delivery width.
 */
const PLOT_SIDE_MARGIN = 80
/**
 * Extra width a right/left-oriented series legend costs beyond the plot
 * itself (swatches + label text + Vega-Lite's own legend padding). Only
 * charged when the legend actually consumes horizontal space (see
 * `legendConsumesWidth`) — a bottom legend or a suppressed one doesn't need
 * this reserved.
 */
const LEGEND_WIDTH_ALLOWANCE = 170
/** A single-panel plot narrower than this becomes unreadable regardless of delivery width. */
const MIN_PLOT_WIDTH = 320
/** A single-panel plot wider than this wastes space once the delivery context is wide enough to allow it — same ceiling as the previous fixed default. */
const MAX_PLOT_WIDTH = 560
/** Height floor for a horizontal bar chart whose series legend has at most two entries — see `smallLegendHeightFloor` below for why. */
const SMALL_LEGEND_HORIZONTAL_HEIGHT_FLOOR = 200

/** Does this chart's series legend consume horizontal space (as opposed to sitting below the plot, or being suppressed)? */
function legendConsumesWidth(intent: ChartIntent): boolean {
  if (!intent.series) return false
  const orient = intent.format?.legend
  if (orient === 'none' || orient === 'bottom') return false
  return true
}

/**
 * Resolve the single-panel plot width a non-faceted chart should request so
 * its *rendered* canvas (plot + axis margins + legend, if any) lands close to
 * the actual delivery width instead of a fixed constant that ignores it.
 * Bounded to stay readable (`MIN_PLOT_WIDTH`) and to avoid wasting space once
 * the delivery context is wide enough to allow the previous fixed default
 * (`MAX_PLOT_WIDTH`).
 */
function computePlotWidth(deliveryWidthPx: number, hasLegend: boolean): number {
  const margin = PLOT_SIDE_MARGIN + (hasLegend ? LEGEND_WIDTH_ALLOWANCE : 0)
  const available = deliveryWidthPx - margin
  return Math.min(MAX_PLOT_WIDTH, Math.max(MIN_PLOT_WIDTH, available))
}

/** A facet panel narrower than this becomes unreadable regardless of delivery width. */
const MIN_FACET_PANEL_WIDTH = 150
/** A facet panel wider than this wastes space once only a couple of columns fit. */
const MAX_FACET_PANEL_WIDTH = 260
/** Horizontal gap Vega-Lite leaves between facet columns, used to size columns to the delivery width. */
const FACET_COLUMN_SPACING = 12
/** Rough allowance for the shared y-axis/legend/margins around the facet grid itself. */
const FACET_SIDE_MARGIN = 90
/** Bound total grid height for a high-cardinality facet field by widening the column count. */
const MAX_FACET_GRID_ROWS = 8

/**
 * Responsive facet layout policy: compute panel width, column count
 * and panel height from the delivery width and facet cardinality, instead of
 * the previous fixed 220x180-per-facet grid that ignored where the chart
 * would actually render. Never drops facet values to fit — a high-cardinality
 * facet still widens its column count (bounded grid rows) rather than
 * shrinking below a readable panel width.
 */
function computeFacetLayout(
  distinctFacetCount: number,
  requestedColumns: number | undefined,
  deliveryWidthPx: number,
): { columns: number; panelWidth: number; panelHeight: number; rows: number } {
  const availableWidth = Math.max(deliveryWidthPx - FACET_SIDE_MARGIN, MIN_FACET_PANEL_WIDTH)
  const maxColumnsForWidth = Math.max(
    1,
    Math.floor(
      (availableWidth + FACET_COLUMN_SPACING) / (MIN_FACET_PANEL_WIDTH + FACET_COLUMN_SPACING),
    ),
  )
  const columnsForRowCap = Math.max(1, Math.ceil(distinctFacetCount / MAX_FACET_GRID_ROWS))
  const naturalColumns = Math.min(Math.max(distinctFacetCount, 1), maxColumnsForWidth)
  // Never go below the row cap (avoid an unbounded-tall grid for high
  // cardinality), but otherwise prefer the width-driven column count so a
  // narrow sidebar gets fewer, wider-relative columns than a wide one.
  const columns = requestedColumns ?? Math.max(columnsForRowCap, naturalColumns)
  const panelWidth = Math.min(
    MAX_FACET_PANEL_WIDTH,
    Math.max(
      MIN_FACET_PANEL_WIDTH,
      Math.floor(
        (availableWidth - FACET_COLUMN_SPACING * Math.max(0, columns - 1)) / Math.max(1, columns),
      ),
    ),
  )
  const rows = Math.max(1, Math.ceil(distinctFacetCount / columns))
  const panelHeight = rows > 4 ? 140 : 180
  return { columns, panelWidth, panelHeight, rows }
}

function withFacet(
  intent: ChartIntent,
  rows: ChartRow[],
  chartSpec: Record<string, unknown>,
  warnings?: readonly string[],
  deliveryWidthPx: number = DEFAULT_DELIVERY_WIDTH_PX,
): TopLevelSpec {
  if (!intent.facet) {
    // Bound the plot width by the actual delivery context instead of the
    // previous hardcoded 560px, which silently ignored `deliveryWidthPx` for
    // every non-faceted chart (the majority of real chart shapes — see the
    // git history of this file for the reproduction that found this). A
    // caller-provided `chartSpec.width` (e.g. `narrowCategoryWidth` above,
    // sized purely from category count) is honored when it's already
    // narrower than what the delivery context allows, but never wider —
    // otherwise a narrow chat-card delivery would still render an
    // oversized, validation-failing canvas.
    const requestedWidth =
      typeof chartSpec.width === 'number' ? (chartSpec.width as number) : undefined
    const maxPlotWidth = computePlotWidth(deliveryWidthPx, legendConsumesWidth(intent))
    const width =
      requestedWidth === undefined ? maxPlotWidth : Math.min(requestedWidth, maxPlotWidth)
    // Wrap the chart title against the plot's own *rendered* width (plot +
    // side margins + legend, if any) rather than the raw `deliveryWidthPx` —
    // `computePlotWidth` clamps to `MIN_PLOT_WIDTH`/`MAX_PLOT_WIDTH`, so the
    // actual canvas width doesn't track `deliveryWidthPx` linearly (e.g. a
    // 480px sidebar-narrow delivery and a 420px chat-card delivery both
    // floor to the same 320px plot). Wrapping against `deliveryWidthPx`
    // directly under-wraps whenever that floor/ceiling applies.
    const estimatedCanvasWidthPx =
      width +
      PLOT_SIDE_MARGIN +
      (legendConsumesWidth(intent) ? LEGEND_WIDTH_ALLOWANCE : 0) +
      TITLE_ESTIMATE_PADDING_PX
    return {
      $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
      title: withCaveats(intent.title, warnings, estimatedCanvasWidthPx),
      data: { values: rows },
      height: 320,
      ...chartSpec,
      width,
    } as TopLevelSpec
  }
  const common = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { values: rows },
  }
  const distinctFacetCount = new Set(rows.map((row) => row[intent.facet!])).size
  const {
    columns,
    panelWidth,
    panelHeight,
    rows: gridRows,
  } = computeFacetLayout(distinctFacetCount, intent.facetColumns, deliveryWidthPx)
  // Wrap the chart title against the whole faceted grid's own rendered
  // width, same rationale as the non-faceted branch above.
  const estimatedFacetGridWidthPx =
    columns * panelWidth +
    Math.max(0, columns - 1) * FACET_COLUMN_SPACING +
    FACET_SIDE_MARGIN +
    TITLE_ESTIMATE_PADDING_PX
  const title = withCaveats(intent.title, warnings, estimatedFacetGridWidthPx)
  // Duplicate shared row-header title: a wrap facet grid with more
  // than one row renders an independent row-header (with its own axis
  // title) per row, exactly like the column-footer repeats the shared 'x'
  // channel's title once per column. Whatever chart template built
  // `chartSpec` always assigns the row-wrap-facing channel to the `y` key
  // (bar/line/area/heatmap all funnel through this one `withFacet` call, and
  // the y2/two-measure template's own layers each carry a `y` key too) — so
  // nulling `encoding.y.title` here, generically, whenever the grid wraps to
  // more than one row, covers every mark template without needing to know
  // which field an individual template put there. Same never-truncated
  // rationale as the column-footer fix: the field stays available via the
  // per-mark tooltip and analysis text/an accessible table.
  if (gridRows > 1) {
    const encoding = (chartSpec as { encoding?: { y?: { title?: unknown } } }).encoding
    if (encoding?.y && encoding.y.title) encoding.y.title = null
    const layers = (chartSpec as { layer?: Array<{ encoding?: { y?: { title?: unknown } } }> })
      .layer
    if (Array.isArray(layers)) {
      for (const layer of layers) {
        if (layer.encoding?.y && layer.encoding.y.title) layer.encoding.y.title = null
      }
    }
  }
  return {
    ...common,
    title,
    facet: {
      field: intent.facet,
      type: fieldType(sampleValue(rows, intent.facet)),
      title: intent.facet,
    },
    // `columns` (the wrap directive) must sit at the top level, a sibling of
    // `facet`/`spec` — Vega-Lite silently ignores it when nested inside the
    // facet field definition instead, laying every distinct facet value out
    // in one unwrapped row regardless of `computeFacetLayout`'s chosen
    // column count. That bug was invisible against the original reproduction
    // fixtures (only 2 distinct facet values, so wrapped vs. unwrapped looked
    // identical) and only surfaces at higher facet cardinality.
    columns,
    spec: { width: panelWidth, height: panelHeight, ...chartSpec },
  } as unknown as TopLevelSpec
}

/**
 * Hover tooltips for the bounded marks: every encoded field the analyst asked
 * to plot, deduplicated. Compiled into `<title>` elements by Vega so hovering
 * a mark shows its values natively in the browser.
 */
function tooltipEncoding(
  intent: ChartIntent,
  rows: ChartRow[],
  extraFields: string[] = [],
): Array<{ field: string; type: 'nominal' | 'quantitative' | 'temporal' }> {
  const seen = new Set<string>()
  const tips: Array<{ field: string; type: 'nominal' | 'quantitative' | 'temporal' }> = []
  for (const field of [intent.x, intent.y, intent.value, intent.series, ...extraFields]) {
    if (!field || seen.has(field)) continue
    seen.add(field)
    const sample = sampleValue(rows, field)
    tips.push({ field, type: sample === undefined ? 'nominal' : fieldType(sample) })
  }
  return tips
}

/**
 * Hover tooltips for a histogram.
 *
 * A histogram is `x: {bin: true}` + `y: {aggregate: 'count'}`, and in Vega-Lite
 * **any non-aggregated field carried by an encoding joins the aggregation
 * group-by**. Putting the raw binned field in `tooltip` therefore counted each
 * `(bin, raw value)` pair instead of each bin: with a near-unique continuous
 * field every count came out as 1, the count axis collapsed to 0…1 and the
 * renderer emitted one full-height mark per input row — measured on the live
 * bitcoin dataset as 2,454 marks (all 320px tall) and a 626 KB SVG instead of
 * ~6 bars and 9 KB. Carrying the *binned* field keeps the group-by at one row
 * per bin while still giving an interactive view the bin range on hover.
 */
function histogramTooltipEncoding(
  intent: ChartIntent,
  rows: ChartRow[],
): Array<{ field: string; type: 'nominal' | 'quantitative' | 'temporal'; bin?: true }> {
  const field = intent.x
  if (!field) return []
  const sample = sampleValue(rows, field)
  return [{ field, type: sample === undefined ? 'nominal' : fieldType(sample), bin: true }]
}

export interface CompileChartOptions {
  /** Query-time caveats (e.g. join fan-out / currency-mix-risk warnings) to fold into the chart title. */
  warnings?: readonly string[]
  /**
   * Delivery width (px) this chart will actually render at (chat card,
   * narrow/wide Studio sidebar, export). Drives facet column count/panel
   * size. Callers may pass an approximate width and this
   * defaults to `DEFAULT_DELIVERY_WIDTH_PX` when omitted.
   */
  deliveryWidthPx?: number
}

/** Longer than this, an axis title line is disproportionate to a bounded panel — wrap instead of letting one long run dominate the layout. */
const MAX_AXIS_TITLE_LINE_CHARS = 40

/**
 * Wrap `title` into lines of at most `maxLineChars` characters instead of
 * leaving one disproportionately long run. Vega-Lite accepts a mark/chart
 * `title` as a string or an array of lines, one line per array entry. A
 * title already at or under the limit is returned unchanged (as a plain
 * string, not a one-element array) so short titles keep rendering exactly as
 * before.
 */
function wrapTitleLines(title: string, maxLineChars: number): string | string[] {
  if (title.length <= maxLineChars) return title
  const words = title.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > maxLineChars && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines
}

/**
 * Wrap a long axis title into multiple shorter lines instead of leaving one
 * disproportionately long run on the axis ("wrap or limit titles").
 */
function wrapAxisTitle(title: string): string | string[] {
  return wrapTitleLines(title, MAX_AXIS_TITLE_LINE_CHARS)
}

/**
 * Rough average rendered width, in px, of one chart-title character at the
 * chart-title font size Vega-Lite's default config uses — a deterministic
 * estimate (not real text metrics), same spirit as
 * `chart-layout-validator.ts`'s own `AVG_CHAR_WIDTH_RATIO`.
 */
// The chart title renders bold (Vega-Lite's default title font weight),
// noticeably wider per character than the plain axis/legend labels
// `chart-layout-validator.ts`'s own 0.55-of-fontSize estimate is calibrated
// against — measured empirically against this file's own reproduction
// fixture (see `chart-layout-validator.unit.test.ts`'s
// `deliveryWidthPx-ignored-for-non-faceted-charts reproduction`): an
// unwrapped 68-character bold title at 13px rendered ~698px wide, well
// above the ~0.55 ratio's ~486px prediction.
const TITLE_CHAR_PX = 10.5
/**
 * Fixed padding folded into the chart-title width estimate on top of the
 * plot/facet-grid's own margin and legend allowances — Vega-Lite's own
 * default title/view padding and rounding that isn't attributable to any
 * one of `PLOT_SIDE_MARGIN`/`LEGEND_WIDTH_ALLOWANCE`/`FACET_SIDE_MARGIN`
 * individually. Calibrated against the same reproduction fixture: without
 * it, the title-width estimate undershoots the chart's real rendered width
 * enough that two delivery widths landing on the same clamped plot width
 * (e.g. chat-card and sidebar-narrow both floor to `MIN_PLOT_WIDTH`) can
 * still disagree on whether a given title needs to wrap.
 */
const TITLE_ESTIMATE_PADDING_PX = 84
/** A chart title wrapped to fewer characters per line than this becomes unreadably narrow regardless of how tight the delivery width is. */
const MIN_TITLE_LINE_CHARS = 24
/** A chart title line longer than this wastes space once the delivery context is wide enough to allow it — keeps a wide export delivery from wrapping titles that would fit on one line anyway. */
const MAX_TITLE_LINE_CHARS = 100

/**
 * Max chart-title line length (chars) for a given delivery width, scaled the
 * same way `computePlotWidth` scales the plot itself: a narrow chat-card
 * delivery needs a shorter max line (more aggressive wrapping) than a wide
 * export delivery, or a title that fits comfortably at export width would
 * still wrap unnecessarily at chat-card width.
 */
function maxChartTitleLineChars(availableTitleWidthPx: number): number {
  return Math.min(
    MAX_TITLE_LINE_CHARS,
    Math.max(MIN_TITLE_LINE_CHARS, Math.floor(availableTitleWidthPx / TITLE_CHAR_PX)),
  )
}

/**
 * Wrap a chart's own top-level title across multiple lines bounded by
 * `deliveryWidthPx` instead of letting Vega-Lite widen the whole rendered
 * canvas to fit one long line — the same "wrap instead of letting the
 * layout stretch" policy `wrapAxisTitle` already applies to axis titles,
 * generalized here to the chart title with a delivery-width-scaled
 * threshold (an axis title's threshold is fixed because an axis is always
 * bounded by its own panel, not by the overall delivery width).
 *
 * Wrapping, not truncating: nothing charted here is the *only* place the
 * full title exists — dashboards and other analyst-facing text still show
 * `intent.title` in full (see `dashboard-slot-title.ts`) — but the rendered
 * image is the one place a reader sees the chart without that surrounding
 * context, so the on-image title should never lose words, only line breaks.
 */
function wrapChartTitle(title: string, availableTitleWidthPx: number): string | string[] {
  return wrapTitleLines(title, maxChartTitleLineChars(availableTitleWidthPx))
}

/** Longer than this average/max categorical label length, vertical bars force rotated labels into the plot — use horizontal bars instead. */
const LONG_CATEGORY_AVG_CHARS = 8
const LONG_CATEGORY_MAX_CHARS = 12

/**
 * Deterministic chart-choice policy: does a nominal field's distinct values
 * run long enough that a vertical bar chart would need to rotate its axis
 * labels to fit? Checked by real distinct value length, not sampling,
 * so the policy is stable regardless of row order.
 */
function categoricalLabelsAreLong(rows: ChartRow[], field: string): boolean {
  const values = [...new Set(rows.map((row) => row[field]).filter((value) => value != null))].map(
    (value) => String(value),
  )
  if (values.length === 0) return false
  const avg = values.reduce((sum, value) => sum + value.length, 0) / values.length
  const max = Math.max(...values.map((value) => value.length))
  return avg > LONG_CATEGORY_AVG_CHARS || max > LONG_CATEGORY_MAX_CHARS
}

/** Compile a ChartIntent and already-authorized rows into a Vega-Lite spec. */
export function compileChartIntent(
  intent: ChartIntent,
  rows: ChartRow[],
  options: CompileChartOptions = {},
): TopLevelSpec {
  intent = ChartIntentSchema.parse(intent)
  const { warnings, deliveryWidthPx = DEFAULT_DELIVERY_WIDTH_PX } = options
  const fields = [intent.x, intent.y, intent.y2, intent.value, intent.series, intent.facet].filter(
    (field): field is string => Boolean(field),
  )
  assertFieldsExist(intent, rows, fields)
  if (intent.mark === 'kpi') {
    if (
      rows.length !== 1 ||
      !intent.y ||
      typeof rows[0]?.[intent.y] !== 'number' ||
      !Number.isFinite(rows[0]?.[intent.y])
    ) {
      throw new Error('KPI requires exactly one row and a finite numeric y field')
    }
  }
  if (intent.mark === 'table') {
    const allColumns = Object.keys(rows[0] ?? {})
    const columns = allColumns.slice(0, 12)
    const visibleRows = rows.slice(0, 50)
    const cells = visibleRows.flatMap((row, rowIndex) =>
      columns.map((column) => ({
        column,
        row: rowIndex + 1,
        text: row[column] == null ? '—' : String(row[column]),
      })),
    )
    const limited = rows.length > visibleRows.length || allColumns.length > columns.length
    return {
      $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
      title: {
        text: intent.title,
        subtitle: [
          `${visibleRows.length} of ${rows.length} rows · ${columns.length} of ${allColumns.length} columns${limited ? ' · Full values in CSV' : ''} · Long cells may be clipped`,
          ...(warnings ?? []),
        ].join(' · '),
        anchor: 'start',
      },
      width: { step: 150 },
      height: { step: 25 },
      data: { values: cells },
      mark: { type: 'text', align: 'left', dx: -70, fontSize: 12, limit: 140 },
      encoding: {
        x: {
          field: 'column',
          type: 'ordinal',
          sort: columns,
          axis: { orient: 'top', title: null, labelAngle: 0, labelLimit: 140, ticks: false },
        },
        y: {
          field: 'row',
          type: 'ordinal',
          sort: 'ascending',
          axis: { title: 'Row', ticks: false },
        },
        text: { field: 'text', type: 'nominal' },
      },
      config: { view: { stroke: '#d9dfe6' } },
    } as TopLevelSpec
  }
  if (intent.mark === 'kpi') {
    return {
      $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
      // KPI's own canvas is a fixed 400px regardless of delivery context, so
      // wrap against whichever of that fixed width or the delivery width is
      // narrower rather than against `deliveryWidthPx` alone.
      title: withCaveats(intent.title, warnings, Math.min(400, deliveryWidthPx)),
      width: 400,
      height: 140,
      data: { values: rows },
      mark: { type: 'text', fontSize: 42, fontWeight: 'bold' },
      encoding: {
        text: {
          field: intent.y!,
          type: 'quantitative',
          ...(intent.format?.decimals !== undefined
            ? { format: `,.${intent.format.decimals}f` }
            : {}),
        },
      },
    } as TopLevelSpec
  }
  if (!intent.x || (intent.mark !== 'histogram' && !intent.y)) {
    throw new Error(
      `Chart mark "${intent.mark}" requires ${intent.mark === 'histogram' ? 'an x field' : 'both x and y fields'}`,
    )
  }
  if (intent.mark === 'heatmap' && !intent.value) {
    throw new Error('Chart mark "heatmap" requires a quantitative value field')
  }
  const xType = fieldType(sampleValue(rows, intent.x))
  // Deterministic chart-choice policy: an explicit orientation always
  // wins, but absent one, long nominal category labels get horizontal bars
  // automatically instead of rotating labels into the plot.
  const horizontal =
    intent.mark === 'bar' &&
    (intent.format?.orientation === 'horizontal' ||
      (intent.format?.orientation !== 'vertical' &&
        xType === 'nominal' &&
        categoricalLabelsAreLong(rows, intent.x)))
  const requestedTicks = intent.format?.xTicks
  const effectiveTicks =
    requestedTicks === 'year' || requestedTicks === 'integer'
      ? requestedTicks
      : intent.x && xType === 'quantitative' && xValuesAreSafeIntegers(rows, intent.x)
        ? 'integer'
        : requestedTicks === 'auto'
          ? 'auto'
          : undefined
  const tickAxis =
    effectiveTicks === 'year'
      ? xType === 'temporal'
        ? { format: '%Y' }
        : { format: 'd', tickMinStep: 1 }
      : effectiveTicks === 'integer'
        ? { format: 'd', tickMinStep: 1 }
        : undefined
  if (
    requestedTicks === 'year' &&
    xType !== 'temporal' &&
    rows.some(
      (row) =>
        row[intent.x!] != null &&
        (typeof row[intent.x!] !== 'number' ||
          !Number.isInteger(row[intent.x!]) ||
          Number(row[intent.x!]) < 0 ||
          Number(row[intent.x!]) > 9999),
    )
  ) {
    throw new Error('Year ticks require dates or integer years between 0 and 9999')
  }
  if (
    requestedTicks === 'integer' &&
    rows.some(
      (row) =>
        row[intent.x!] != null &&
        (typeof row[intent.x!] !== 'number' || !Number.isSafeInteger(row[intent.x!])),
    )
  ) {
    throw new Error('Integer ticks require safe integer values on the x field')
  }
  // Vega-Lite has no literal "histogram" mark: a histogram is a bar mark with
  // a binned x-field and a counted y-field, computed by the trusted compiler,
  // never by an arbitrary model-authored bin expression.
  const xEncoding: Record<string, unknown> = {
    field: intent.x,
    type: xType,
    ...(tickAxis ? { axis: tickAxis } : {}),
    ...(effectiveTicks === 'year' && xType === 'quantitative'
      ? { scale: { zero: false, nice: false } }
      : effectiveTicks === 'integer' && xType === 'quantitative'
        ? { scale: { nice: false } }
        : {}),
    ...(horizontal && xType === 'nominal' ? { axis: { labelLimit: 260 } } : {}),
    title: wrapAxisTitle(intent.format?.xLabel ?? intent.xLabel ?? intent.x),
    ...(intent.mark === 'histogram' ? { bin: true } : {}),
    ...(intent.sort
      ? {
          sort: { field: intent.sort.field, order: intent.sort.direction },
        }
      : {}),
  }
  const yEncoding: Record<string, unknown> = {
    ...(intent.mark === 'histogram' ? {} : { field: intent.y }),
    type: 'quantitative',
    ...(intent.format?.decimals !== undefined
      ? { axis: { format: `,.${intent.format.decimals}f` } }
      : {}),
    ...(() => {
      const rawTitle = intent.format?.yLabel ?? intent.yLabel ?? intent.y
      return rawTitle !== undefined ? { title: wrapAxisTitle(rawTitle) } : {}
    })(),
    ...(intent.mark === 'histogram' ? { aggregate: 'count' } : {}),
    ...(intent.stack
      ? { stack: intent.stack }
      : intent.mark === 'bar' && intent.series
        ? { stack: null }
        : {}),
  }
  if (intent.mark === 'heatmap') {
    return withFacet(
      intent,
      rows,
      {
        mark: 'rect',
        encoding: {
          x: xEncoding,
          y: {
            field: intent.y,
            type: fieldType(sampleValue(rows, intent.y!)),
            title: intent.format?.yLabel ?? intent.yLabel ?? intent.y,
          },
          color: {
            field: intent.value,
            type: 'quantitative',
            title: intent.valueLabel ?? intent.value,
          },
          tooltip: tooltipEncoding(intent, rows),
        },
      },
      warnings,
      deliveryWidthPx,
    )
  }
  if (intent.y2) {
    const layer = (field: string, title: string) => ({
      mark: intent.mark === 'area' ? { type: 'area', opacity: 0.45 } : { type: 'line' },
      encoding: {
        x: xEncoding,
        y: {
          field,
          type: 'quantitative',
          title: intent.format?.yLabel ?? intent.yLabel ?? 'Value',
          ...(intent.format?.decimals !== undefined
            ? { axis: { format: `,.${intent.format.decimals}f` } }
            : {}),
        },
        color: { datum: title, type: 'nominal', title: 'Measure' },
        tooltip: tooltipEncoding(intent, rows, [field]),
      },
    })
    return withFacet(
      intent,
      rows,
      {
        layer: [
          layer(intent.y!, intent.yLabel ?? intent.y!),
          layer(intent.y2, intent.y2Label ?? intent.y2),
        ],
      },
      warnings,
      deliveryWidthPx,
    )
  }
  const palette = intent.format?.palette ?? 'colorblind'
  const paletteColors: string[] =
    palette === 'colorblind'
      ? ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#F0E442', '#000000']
      : (scheme(palette) as string[])
  const seriesDomain = intent.series
    ? [...new Set(rows.map((row) => row[intent.series!]).filter((value) => value != null))].sort(
        (a, b) => String(a).localeCompare(String(b)),
      )
    : []
  const colorScale = {
    domain: seriesDomain,
    range: seriesDomain.map(
      (value, index) =>
        intent.format?.seriesColors?.find((item) => item.value === value)?.color ??
        paletteColors[index % paletteColors.length],
    ),
  }
  // Faceted charts: whichever encoding lands on the shared 'x'
  // channel below repeats its axis footer once per facet column/row, and
  // Vega-Lite has no built-in way to render that footer only once for a
  // wrapped facet grid. Folding the removed text into the chart
  // title/subtitle was tried and rejected: Vega-Lite sizes the *overall*
  // canvas to fit a long single-line title/subtitle even when every facet
  // panel itself is small, which silently reintroduces the same
  // excessive-output-bounds problem this policy exists to fix and defeats
  // delivery-width-driven sizing entirely. So the duplicated title is
  // dropped from the rendered chart image instead (never truncated
  // silently mid-chart — the field's full semantics stay available via the
  // per-mark tooltip already built by `tooltipEncoding` and via analysis
  // text/an accessible table, per this policy's own remediation guidance).
  // The 'y' channel already renders once (shared row header) in a wrapped
  // facet, so it keeps its normal axis title.
  if (intent.facet) {
    const xChannelEncoding = horizontal ? yEncoding : xEncoding
    if (xChannelEncoding.title) xChannelEncoding.title = null
  }
  // Excessive blank space: a fixed 560px-wide vertical bar chart with
  // only a handful of nominal categories wastes most of its canvas on
  // margin. Size the chart to its actual category count instead (bounded,
  // same "adjust size, never drop data" approach as the horizontal-bar
  // height cap below). The upper bound is also capped by `withFacet`'s own
  // delivery-width-derived plot width below, in case a caller's narrow
  // delivery width would allow an even smaller max than 560.
  const narrowCategoryWidth =
    !intent.facet && !horizontal && xType === 'nominal'
      ? Math.min(560, Math.max(280, new Set(rows.map((row) => row[intent.x!])).size * 130))
      : undefined
  // A horizontal bar's fixed 320px height floor was tuned for a legend with
  // several entries stacked alongside the plot (a wide legend needs real
  // vertical room even for few categories). A small (<=2-value) legend needs
  // far less — at a narrow delivery width the full 320px floor paired with
  // the now-delivery-bounded (and therefore narrower) plot width from
  // `computePlotWidth` leaves disproportionate blank canvas around the
  // content, tripping `excessive-output-bounds`. Only shrink the floor for
  // that specific small-legend shape; a chart with more legend entries (or
  // none at all) keeps the original 320px floor unchanged.
  const smallLegendHeightFloor =
    intent.series && seriesDomain.length <= 2 ? SMALL_LEGEND_HORIZONTAL_HEIGHT_FLOOR : undefined
  return withFacet(
    intent,
    rows,
    {
      ...(horizontal && xType === 'nominal'
        ? {
            height: Math.min(
              960,
              Math.max(
                smallLegendHeightFloor ?? 320,
                new Set(rows.map((row) => row[intent.x!])).size * 26,
              ),
            ),
          }
        : {}),
      ...(narrowCategoryWidth !== undefined ? { width: narrowCategoryWidth } : {}),
      mark:
        intent.mark === 'histogram'
          ? intent.format?.color
            ? { type: 'bar', color: intent.format.color }
            : 'bar'
          : intent.mark === 'boxplot'
            ? {
                type: 'boxplot',
                extent: 'min-max',
                ...(intent.format?.color ? { color: intent.format.color } : {}),
              }
            : !intent.series && intent.format?.color
              ? { type: intent.mark, color: intent.format.color }
              : intent.mark,
      encoding: {
        x: horizontal ? yEncoding : xEncoding,
        y: horizontal ? xEncoding : yEncoding,
        ...(intent.mark === 'bar' && intent.series && !intent.stack && xType === 'nominal'
          ? { [horizontal ? 'yOffset' : 'xOffset']: { field: intent.series, type: 'nominal' } }
          : {}),
        ...(intent.series
          ? {
              color: {
                field: intent.series,
                type: 'nominal',
                scale: intent.format?.seriesColors?.length
                  ? colorScale
                  : palette === 'colorblind'
                    ? { range: paletteColors }
                    : { scheme: palette },
                ...(intent.format?.legend
                  ? {
                      legend:
                        intent.format.legend === 'none'
                          ? null
                          : {
                              orient: intent.format.legend,
                              ...(seriesDomain.length > 10 ? { columns: 2 } : {}),
                            },
                    }
                  : seriesDomain.length > 10
                    ? { legend: { columns: 2 } }
                    : {}),
              },
            }
          : {}),
        // Redundant non-colour encoding for series, so lines/areas/points stay
        // distinguishable without colour (chart-and-delivery.md: "do not
        // encode meaning with colour alone"). Suppress the duplicate legend
        // colour already provides one for the same field.
        ...(intent.series && (intent.mark === 'line' || intent.mark === 'area')
          ? { strokeDash: { field: intent.series, type: 'nominal', legend: null } }
          : {}),
        ...(intent.series && intent.mark === 'point'
          ? { shape: { field: intent.series, type: 'nominal', legend: null } }
          : {}),
        tooltip:
          intent.mark === 'histogram'
            ? histogramTooltipEncoding(intent, rows)
            : tooltipEncoding(intent, rows),
      },
    },
    warnings,
    deliveryWidthPx,
  )
}

/** Render a compiled Vega-Lite spec to a self-contained SVG string (no external assets). */
export async function renderChartSvg(spec: TopLevelSpec): Promise<string> {
  const { spec: vegaSpec } = compile(spec)
  const view = new View(parse(vegaSpec), { renderer: 'none' })
  try {
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

/** Render an explicit empty-result placeholder instead of a misleading empty chart. */
export async function renderEmptyResultSvg(title: string): Promise<string> {
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    title,
    width: 400,
    height: 120,
    data: { values: [{ label: 'No rows returned for this query' }] },
    mark: 'text',
    encoding: { text: { field: 'label', type: 'nominal' } },
  }
  return renderChartSvg(spec)
}
