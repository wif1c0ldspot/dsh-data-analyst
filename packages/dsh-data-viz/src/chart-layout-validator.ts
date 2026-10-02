/**
 * Deterministic post-render layout validation. Inspects the trusted SVG
 * geometry that `renderChartSvg` already produced — never a screenshot, never
 * a model judgement — and reports bounded, typed diagnostics: text that
 * collides with the plotted marks, labels that spill outside the canvas,
 * blank/zero-width legend entries, and canvases that are far larger than the
 * content they carry. This module never fixes anything (that is the facet
 * layout policy, label/legend handling, and refinement retry logic
 * elsewhere); it only tells the caller whether a rendered chart is safe to
 * call "delivery verified".
 *
 * Pure string/geometry analysis: no DOM, no canvas, no filesystem or network
 * access, and bounded input size/tag count so a pathological SVG cannot make
 * this run unboundedly long.
 */
import {
  ChartLayoutDiagnosticSchema,
  ChartLayoutValidationSchema,
  type ChartLayoutDiagnostic,
  type ChartLayoutValidation,
} from 'dsh-data-core/contracts'

export type { ChartLayoutDiagnostic, ChartLayoutValidation } from 'dsh-data-core/contracts'

/** Hard bounds so a pathological/oversized SVG cannot make validation run unboundedly long. */
const MAX_SVG_CHARS = 4_000_000
const MAX_TAGS = 20_000

/** Sans-serif average glyph width as a fraction of font-size; a deterministic estimate, not real text metrics. */
const AVG_CHAR_WIDTH_RATIO = 0.55
/** Approximate cap-height/line-height band around a text baseline, as a fraction of font-size. */
const ASCENT_RATIO = 0.8
const DESCENT_RATIO = 0.3

/** A canvas below this stays exempt from the oversized-canvas check even with a wide legend/labels. */
const MAX_CANVAS_WIDTH = 950
const MAX_CANVAS_HEIGHT = 1100

/**
 * Blocking under-fill floor: the plotted panel(s) plus legend boxes must cover at
 * least this share of the canvas.
 *
 * This replaced a `(content + chrome) * 1.3` budget whose "content" also counted
 * the *estimated text-box area* of every label, which made the verdict a coin
 * flip on label character count: two live charts with one identical 560x320
 * panel and canvases within 0.6% of each other landed on opposite sides of the
 * line (canvas/(content+chrome) 1.355 vs 1.297) because one carried ~3.5k px^2
 * more tick-label area — and the chart that passed was the broken one, while a
 * correct 117-point line was refused. Panel share is what this check was always
 * trying to measure; labels belong to the collision/overflow checks.
 */
const MIN_PANEL_CANVAS_RATIO = 0.25

/** Bar/rect marks packed into (nearly) one geometry = an aggregate that emitted a mark per row. */
const DEGENERATE_MARK_COUNT = 50
const DEGENERATE_DUPLICATE_RATIO = 10

/** An axis title longer than this estimated pixel run is disproportionate to any bounded facet/single panel. */
const MAX_AXIS_TITLE_RUN = 320

/** Two text boxes must overlap by at least this fraction of the smaller box's area to count as a collision. */
const COLLISION_AREA_RATIO = 0.2
/** Slack for rounding noise before a label counts as outside the view box. */
const OUT_OF_BOUNDS_TOLERANCE = 0.5

interface Matrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  }
}

function applyPoint(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
}

/** Parse an SVG `transform="translate(..) rotate(..) ..."` attribute into one composed matrix. */
function parseTransform(value: string | undefined): Matrix {
  if (!value) return IDENTITY
  let matrix = IDENTITY
  const functionRe = /(translate|rotate|scale)\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = functionRe.exec(value))) {
    const args = match[2]!.split(',').map((part) => parseFloat(part.trim()))
    let next: Matrix = IDENTITY
    if (match[1] === 'translate') {
      next = { a: 1, b: 0, c: 0, d: 1, e: args[0] ?? 0, f: args[1] ?? 0 }
    } else if (match[1] === 'rotate') {
      const rad = ((args[0] ?? 0) * Math.PI) / 180
      next = { a: Math.cos(rad), b: Math.sin(rad), c: -Math.sin(rad), d: Math.cos(rad), e: 0, f: 0 }
    } else if (match[1] === 'scale') {
      const sx = args[0] ?? 1
      const sy = args[1] ?? sx
      next = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }
    }
    matrix = multiply(matrix, next)
  }
  return matrix
}

function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
  return match?.[1]
}

/**
 * Split a `<text>` element's inner markup into its rendered lines. A
 * multi-line title/axis-title (from `wrapAxisTitle` here, or an equivalent
 * chart-title wrap) renders as one `<text>` whose lines are separate
 * `<tspan>` children — e.g. `<tspan>Line one</tspan><tspan
 * dy="15">Line two</tspan>` — not as literal newlines. Treating that raw
 * inner markup as one line's text (the previous behavior) counted the
 * `<tspan ...>`/`</tspan>` markup itself as visible characters, wildly
 * inflating the estimated text-box width for every wrapped title and firing
 * false `oversized-axis-title`/`label-out-of-bounds` diagnostics against a
 * title that Vega-Lite actually rendered as several short, harmless lines.
 * A single-line `<text>` (no `<tspan>` children) still returns its own
 * trimmed content as the one line, unchanged from before.
 */
function parseTextLines(rawContent: string): { lines: string[]; lineHeight: number } {
  const tspanRe = /<tspan([^>]*)>([^<]*)<\/tspan>/g
  const lines: string[] = []
  let lineHeight = 0
  let match: RegExpExecArray | null
  while ((match = tspanRe.exec(rawContent))) {
    lines.push(match[2]!.trim())
    const dy = parseFloat(attr(match[1] ?? '', 'dy') ?? '')
    if (Number.isFinite(dy) && dy > 0) lineHeight = dy
  }
  if (lines.length === 0) {
    const trimmed = rawContent.trim()
    return { lines: trimmed ? [trimmed] : [], lineHeight: 0 }
  }
  return { lines, lineHeight }
}

interface Box {
  x1: number
  y1: number
  x2: number
  y2: number
}

function boxArea(box: Box): number {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1)
}

function boxOverlapArea(a: Box, b: Box): number {
  const x1 = Math.max(a.x1, b.x1)
  const y1 = Math.max(a.y1, b.y1)
  const x2 = Math.min(a.x2, b.x2)
  const y2 = Math.min(a.y2, b.y2)
  if (x2 <= x1 || y2 <= y1) return 0
  return (x2 - x1) * (y2 - y1)
}

type Role = 'axis-title' | 'axis-label' | 'facet-title' | 'legend' | 'chart-title' | 'canvas'

interface TextNode {
  role: Role
  legendKind?: 'label' | 'title'
  content: string
  box: Box
  fontSize: number
  /** Rendered line count (1 for an ordinary single-line label; >1 for a wrapped title/axis-title). */
  lineCount: number
}

interface PlotRect {
  box: Box
}

interface LegendRect {
  box: Box
}

/**
 * Walk the SVG's `<g>`/`<text>`/plot-background tags in document order,
 * composing ancestor `transform`s into one absolute matrix per text node so
 * bounding boxes can be computed and compared without a DOM.
 */
function collectGeometry(svg: string): {
  texts: TextNode[]
  plotRects: PlotRect[]
  legendRects: LegendRect[]
  markRects: PlotRect[]
  truncated: boolean
} {
  const tagRe = /<(\/)?([a-zA-Z][\w:-]*)((?:\s+[a-zA-Z][\w:-]*="[^"]*")*)\s*(\/)?>/g
  const stack: Array<{ tag: string; matrix: Matrix; roleClass: string }> = [
    { tag: '__root__', matrix: IDENTITY, roleClass: '' },
  ]
  const texts: TextNode[] = []
  const plotRects: PlotRect[] = []
  const legendRects: LegendRect[] = []
  const markRects: PlotRect[] = []
  let match: RegExpExecArray | null
  let tagCount = 0
  let truncated = false

  const currentRole = (): { role: Role; legendKind?: 'label' | 'title' } => {
    for (let index = stack.length - 1; index >= 0; index--) {
      const cls = stack[index]!.roleClass
      if (!cls) continue
      if (cls.includes('role-legend-label')) return { role: 'legend', legendKind: 'label' }
      if (cls.includes('role-legend-title')) return { role: 'legend', legendKind: 'title' }
      if (cls.includes('facet-title')) return { role: 'facet-title' }
      if (cls.includes('role-axis-title')) return { role: 'axis-title' }
      if (cls.includes('role-axis-label')) return { role: 'axis-label' }
      if (cls.includes('role-title-text') || cls.includes('mark-group role-title')) {
        const insideCell = stack
          .slice(0, index)
          .some((frame) => frame.roleClass.includes('role-scope'))
        return { role: insideCell ? 'facet-title' : 'chart-title' }
      }
    }
    return { role: 'chart-title' }
  }

  while ((match = tagRe.exec(svg))) {
    tagCount++
    if (svg.length > MAX_SVG_CHARS || tagCount > MAX_TAGS) {
      truncated = true
      break
    }
    const isClose = match[1] === '/'
    const name = match[2]!
    const attrs = match[3] ?? ''
    const isSelfClose = Boolean(match[4])

    if (isClose) {
      if (name === 'g' && stack.length > 1) {
        stack.pop()
      }
      continue
    }

    if (name === 'g') {
      const parentMatrix = stack[stack.length - 1]!.matrix
      const localMatrix = parseTransform(attr(attrs, 'transform'))
      const roleClass = attr(attrs, 'class') ?? ''
      const frame = { tag: 'g', matrix: multiply(parentMatrix, localMatrix), roleClass }
      if (!isSelfClose) stack.push(frame)
      continue
    }

    if (name === 'path' && attr(attrs, 'class') !== 'background') {
      // Rect-like marks (bars, bins, boxes): Vega emits each as a path whose `d`
      // is a single M...h...v...h box. Line/point/area marks use curve commands,
      // so they are never boxes and never reach this collector.
      const markBox = /M([\d.eE+-]+),([\d.eE+-]+)h([\d.eE+-]+)v([\d.eE+-]+)h/.exec(
        attr(attrs, 'd') ?? '',
      )
      if (markBox) {
        const markWidth = parseFloat(markBox[3]!)
        const markHeight = parseFloat(markBox[4]!)
        if (markWidth > 0 && markHeight > 0) {
          const markMatrix = stack[stack.length - 1]!.matrix
          const markX = parseFloat(markBox[1]!)
          const markY = parseFloat(markBox[2]!)
          const markP1 = applyPoint(markMatrix, markX, markY)
          const markP2 = applyPoint(markMatrix, markX + markWidth, markY + markHeight)
          markRects.push({
            box: {
              x1: Math.min(markP1.x, markP2.x),
              y1: Math.min(markP1.y, markP2.y),
              x2: Math.max(markP1.x, markP2.x),
              y2: Math.max(markP1.y, markP2.y),
            },
          })
        }
      }
    }

    if (name === 'path' && attr(attrs, 'class') === 'background') {
      // The view/facet-cell background carries a `stroke` (the Vega-Lite view
      // border) — axis and title backgrounds are strokeless placeholders,
      // mostly zero-size `M0,0h0v0h0Z`. The legend's own background is a real
      // non-zero box too, without a stroke; track it separately (content, not
      // a "plot" a label could collide with) so a legend's own labels sitting
      // inside its own background aren't misread as a collision.
      const isPlot = Boolean(attr(attrs, 'stroke'))
      const isLegend = stack.some((frame) => frame.roleClass.includes('role-legend'))
      const d = attr(attrs, 'd') ?? ''
      const boxMatch = /M([\d.-]+),([\d.-]+)h([\d.-]+)v([\d.-]+)h/.exec(d)
      if (boxMatch && (isPlot || isLegend)) {
        const [, xStr, yStr, wStr, hStr] = boxMatch
        const w = parseFloat(wStr!)
        const h = parseFloat(hStr!)
        if (w > 0 && h > 0) {
          const parentMatrix = stack[stack.length - 1]!.matrix
          const x = parseFloat(xStr!)
          const y = parseFloat(yStr!)
          const p1 = applyPoint(parentMatrix, x, y)
          const p2 = applyPoint(parentMatrix, x + w, y + h)
          const box: Box = {
            x1: Math.min(p1.x, p2.x),
            y1: Math.min(p1.y, p2.y),
            x2: Math.max(p1.x, p2.x),
            y2: Math.max(p1.y, p2.y),
          }
          if (isPlot) plotRects.push({ box })
          else legendRects.push({ box })
        }
      }
      continue
    }

    if (name === 'text' && !isSelfClose) {
      const opacity = attr(attrs, 'opacity')
      if (opacity !== undefined && parseFloat(opacity) === 0) {
        // Vega itself suppressed this label (e.g. a secondary time-axis tier
        // hidden to avoid overlap) — it never reaches the page, so it cannot
        // collide with anything a viewer can see.
        continue
      }
      const parentMatrix = stack[stack.length - 1]!.matrix
      const localMatrix = parseTransform(attr(attrs, 'transform'))
      const matrix = multiply(parentMatrix, localMatrix)
      const fontSize = parseFloat(attr(attrs, 'font-size') ?? '10') || 10
      const { role, legendKind } = currentRole()
      const anchor = attr(attrs, 'text-anchor') ?? 'start'
      const contentStart = tagRe.lastIndex
      const closeMatch = /<\/text>/.exec(svg.slice(contentStart, contentStart + 2000))
      const content = closeMatch ? svg.slice(contentStart, contentStart + closeMatch.index) : ''
      const { lines, lineHeight } = parseTextLines(content)
      const trimmed = lines.join(' ')
      const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0)
      const estWidth = longestLine * fontSize * AVG_CHAR_WIDTH_RATIO
      const x0 = anchor === 'end' ? -estWidth : anchor === 'middle' ? -estWidth / 2 : 0
      const x1 = x0 + estWidth
      const yTop = -fontSize * ASCENT_RATIO
      // Extra wrapped lines extend the box downward by each line's actual
      // rendered spacing (the `dy` Vega itself put on the `<tspan>`, when
      // present) beyond the first line's own descent.
      const extraLines = Math.max(0, lines.length - 1)
      const yBottom = fontSize * DESCENT_RATIO + extraLines * (lineHeight || fontSize * 1.2)
      const corners = [
        applyPoint(matrix, x0, yTop),
        applyPoint(matrix, x1, yTop),
        applyPoint(matrix, x1, yBottom),
        applyPoint(matrix, x0, yBottom),
      ]
      const xs = corners.map((p) => p.x)
      const ys = corners.map((p) => p.y)
      texts.push({
        role,
        legendKind,
        content: trimmed,
        fontSize,
        lineCount: Math.max(1, lines.length),
        box: { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) },
      })
    }
  }

  return { texts, plotRects, legendRects, markRects, truncated }
}

function issue(
  code: ChartLayoutDiagnostic['code'],
  role: ChartLayoutDiagnostic['role'],
  message: string,
  remediation: string,
): ChartLayoutDiagnostic {
  return ChartLayoutDiagnosticSchema.parse({ code, role, message, remediation })
}

/**
 * Validate a rendered chart SVG's geometry. Never throws on malformed input:
 * an SVG that cannot be parsed at all comes back as a single `unreadable-svg`
 * diagnostic rather than a crash, so a caller can always treat the result as
 * an explicit non-verified outcome instead of a misleading success receipt.
 */
export function validateChartLayoutSvg(svg: string): ChartLayoutValidation {
  const rootMatch = /<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"/.exec(svg)
  if (svg.length > MAX_SVG_CHARS || !rootMatch) {
    return ChartLayoutValidationSchema.parse({
      ok: false,
      diagnostics: [
        issue(
          'unreadable-svg',
          'canvas',
          'Chart SVG was missing a readable root width/height or exceeded the bounded input size.',
          'Re-render the chart before treating it as delivery verified.',
        ),
      ],
      bounds: { width: 0, height: 0 },
    })
  }
  const width = parseFloat(rootMatch[1]!)
  const height = parseFloat(rootMatch[2]!)
  const { texts, plotRects, legendRects, markRects, truncated } = collectGeometry(svg)

  const diagnostics: ChartLayoutDiagnostic[] = []
  const MAX_DIAGNOSTICS = 20

  if (truncated) {
    diagnostics.push(
      issue(
        'unreadable-svg',
        'canvas',
        'Chart SVG exceeded the bounded element count before validation finished.',
        'Reduce chart complexity (fewer facets/series) or re-render before treating it as delivery verified.',
      ),
    )
  }

  // Excessive output bounds: either an absolute cap independent of content
  // (catches a pathological/unbounded canvas regardless of what renders inside
  // it), or a canvas whose plotted panels + legend cover too little of it
  // (catches the "fixed canvas leaves excessive blank space" shape, e.g. a short
  // legend reserving a tall, mostly-empty right margin).
  // Plot panels and legend boxes are the chart's actual content. Estimated
  // label text boxes are deliberately NOT counted here: `texts` area is what
  // made the old `(content + chrome) * slack` budget a coin flip on label
  // character count (see MIN_PANEL_CANVAS_RATIO), and a label that is too long
  // for its space is already covered by the collision and out-of-bounds checks.
  const panelArea =
    plotRects.reduce((sum, rect) => sum + boxArea(rect.box), 0) +
    legendRects.reduce((sum, rect) => sum + boxArea(rect.box), 0)
  const canvasArea = width * height
  const exceedsAbsoluteCap = width > MAX_CANVAS_WIDTH || height > MAX_CANVAS_HEIGHT
  // Only weigh "wasted space" against an actual plotted panel (bar/line/
  // heatmap/…) — KPI, table and empty-result templates are deliberately
  // sparse, fixed-size text layouts with no axis/plot view to be proportional to.
  const panelShare = canvasArea > 0 ? panelArea / canvasArea : 1
  // Exclusive to axis-bearing charts: KPI, table and empty-result templates are
  // deliberately sparse text layouts whose "background" box is a frame, not a
  // plot to be proportional to.
  const hasAxisGroup = svg.includes('mark-group role-axis')
  const exceedsPanelFloor =
    plotRects.length > 0 && hasAxisGroup && panelShare < MIN_PANEL_CANVAS_RATIO
  if (exceedsAbsoluteCap || exceedsPanelFloor) {
    diagnostics.push(
      issue(
        'excessive-output-bounds',
        'canvas',
        exceedsAbsoluteCap
          ? `Rendered canvas is ${width}x${height}px, exceeding the ${MAX_CANVAS_WIDTH}x${MAX_CANVAS_HEIGHT}px bound.`
          : `Rendered canvas (${Math.round(canvasArea)}px^2) carries only ${Math.round(panelShare * 100)}% plot/legend area (${Math.round(panelArea)}px^2), leaving excessive blank space.`,
        'Cap panel/legend size, reduce facet columns, or reflow the legend instead of letting the canvas grow to accommodate mostly blank space.',
      ),
    )
  }

  // Duplicate shared axis title: the same axis-title text rendered more than
  // once (one copy per facet column/row) instead of once, shared, is the
  // exact "repeated titles" shape from the walkthrough.
  const axisTitleCounts = new Map<string, number>()
  for (const text of texts) {
    if (text.role !== 'axis-title' || !text.content) continue
    axisTitleCounts.set(text.content, (axisTitleCounts.get(text.content) ?? 0) + 1)
  }
  for (const [content, count] of axisTitleCounts) {
    if (count > 1) {
      diagnostics.push(
        issue(
          'duplicate-shared-title',
          'axis-title',
          `Axis title "${content}" is rendered ${count} times instead of once shared across facets.`,
          'Resolve the shared axis title once (e.g. Vega-Lite facet/axis resolve: "shared") instead of letting every facet panel render its own copy.',
        ),
      )
    }
    if (diagnostics.length >= MAX_DIAGNOSTICS) break
  }

  // Oversized axis title: an estimated text run far longer than any bounded
  // facet/single panel can display without dominating the layout.
  for (const text of texts) {
    if (text.role !== 'axis-title') continue
    const estRun = text.content.length * text.fontSize * AVG_CHAR_WIDTH_RATIO
    if (estRun > MAX_AXIS_TITLE_RUN) {
      diagnostics.push(
        issue(
          'oversized-axis-title',
          'axis-title',
          `Axis title "${text.content}" is estimated at ~${Math.round(estRun)}px, disproportionate to a bounded panel.`,
          'Shorten or wrap the axis title, or move the full text into analysis text/an accessible table instead of the axis.',
        ),
      )
      if (diagnostics.length >= MAX_DIAGNOSTICS) break
    }
  }

  // Text-vs-plot collisions: any label whose box intersects a plotted panel's
  // background by more than the overlap threshold has entered the marks it
  // is supposed to sit outside of (e.g. a rotated category label riding up
  // into the bars above the axis).
  for (const text of texts) {
    if (text.role !== 'axis-label' && text.role !== 'legend') continue
    for (const plot of plotRects) {
      const overlap = boxOverlapArea(text.box, plot.box)
      if (overlap <= 0) continue
      const textArea = boxArea(text.box)
      if (textArea > 0 && overlap / textArea >= COLLISION_AREA_RATIO) {
        diagnostics.push(
          issue(
            'text-collision',
            text.role === 'legend' ? 'legend' : 'axis-label',
            `Label "${text.content}" overlaps the plotted panel area instead of sitting outside it.`,
            'Reserve enough margin for the label (e.g. horizontal bars for long categories, or a taller axis footer) instead of letting it intrude into the marks.',
          ),
        )
        break
      }
    }
    if (diagnostics.length >= MAX_DIAGNOSTICS) break
  }

  // Label-vs-label collisions: two independent text boxes (not the same
  // duplicated shared title already reported above) overlapping each other.
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!
      const b = texts[j]!
      if (a.content === b.content && a.role === b.role) continue // already covered by duplicate-shared-title
      const overlap = boxOverlapArea(a.box, b.box)
      if (overlap <= 0) continue
      const smaller = Math.min(boxArea(a.box), boxArea(b.box))
      if (smaller > 0 && overlap / smaller >= COLLISION_AREA_RATIO) {
        diagnostics.push(
          issue(
            'text-collision',
            a.role === 'legend' || b.role === 'legend' ? 'legend' : 'axis-label',
            `Labels "${a.content}" and "${b.content}" overlap each other.`,
            'Increase spacing, rotate/abbreviate one label, or reduce label density (e.g. fewer legend columns).',
          ),
        )
      }
      if (diagnostics.length >= MAX_DIAGNOSTICS) break
    }
    if (diagnostics.length >= MAX_DIAGNOSTICS) break
  }

  // Out-of-bounds labels: any text bounding box extending past the declared
  // view box.
  for (const text of texts) {
    if (
      text.box.x1 < -OUT_OF_BOUNDS_TOLERANCE ||
      text.box.y1 < -OUT_OF_BOUNDS_TOLERANCE ||
      text.box.x2 > width + OUT_OF_BOUNDS_TOLERANCE ||
      text.box.y2 > height + OUT_OF_BOUNDS_TOLERANCE
    ) {
      diagnostics.push(
        issue(
          'label-out-of-bounds',
          text.role === 'legend'
            ? 'legend'
            : text.role === 'axis-title'
              ? 'axis-title'
              : 'axis-label',
          `Label "${text.content}" extends outside the ${width}x${height}px canvas.`,
          'Widen the canvas/margins or shorten the label so it stays within the delivered view box.',
        ),
      )
      if (diagnostics.length >= MAX_DIAGNOSTICS) break
    }
  }

  // Blank/zero-width legend labels: a legend entry whose text is empty or
  // whitespace only cannot be read regardless of layout.
  for (const text of texts) {
    if (text.role === 'legend' && text.legendKind === 'label' && text.content.length === 0) {
      diagnostics.push(
        issue(
          'blank-legend-label',
          'legend',
          'A legend entry has a blank/zero-width label.',
          'Ensure every series value maps to a non-empty legend label before rendering.',
        ),
      )
      if (diagnostics.length >= MAX_DIAGNOSTICS) break
    }
  }

  // Aggregation that collapsed into a repeated geometry: a chart meant to carry a
  // handful of counted bins emitted one mark per input row instead. Measured on a
  // live 2,454-row histogram: 2,454 marks sharing 5 geometries, every one 92x320
  // (a full-height bar per row) — which the geometry checks reported as
  // layout-valid while refusing a correct 117-point line chart.
  const markGeometries = new Set(
    markRects.map(
      (rect) =>
        `${rect.box.x1.toFixed(1)},${rect.box.y1.toFixed(1)},${rect.box.x2.toFixed(1)},${rect.box.y2.toFixed(1)}`,
    ),
  )
  if (
    markRects.length >= DEGENERATE_MARK_COUNT &&
    markRects.length >= DEGENERATE_DUPLICATE_RATIO * Math.max(markGeometries.size, 1)
  ) {
    diagnostics.push(
      issue(
        'degenerate-aggregate',
        'marks',
        `${markRects.length} bar/rect marks share only ${markGeometries.size} distinct geometries — the encoded aggregate looks like one mark per input row instead of one per group.`,
        'Check the encoding that carries the aggregate: a non-aggregated field encoded alongside it (for example a tooltip field) splits the group-by, so every group counts once.',
      ),
    )
  }

  return ChartLayoutValidationSchema.parse({
    ok: diagnostics.length === 0,
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    bounds: { width, height },
  })
}
