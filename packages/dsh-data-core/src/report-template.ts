import { z } from 'zod'
import type { ResultEvidence } from './result-evidence.js'
import { ComputedFindingSchema } from './computed-finding.js'

/**
 * Fixed, server-owned HTML report template. This is not a template
 * engine: there are three reviewed compositions, every value is escaped, and there is no
 * user-authored markup, script, or remote resource. See docs/architecture.md
 * "Export contract" and docs/contracts.md "Result and rendering boundary".
 */

export interface ReportTableColumn {
  name: string
  logicalType: string
  unit?: string
}

export const ReportTemplateSchema = z.enum(['analytical-brief', 'comparison', 'executive-summary'])
export type ReportTemplate = z.infer<typeof ReportTemplateSchema>
/**
 * Report narrative with computed findings distinct from generated interpretation.
 * Legacy `findings` string arrays load as unreviewed interpretation.
 */
export const ReportNarrativeSchema = z.strictObject({
  /** Service-resolved computed findings (default shareable facts). */
  computedFindings: z.array(ComputedFindingSchema).max(20).optional(),
  /**
   * Generated interpretation / free-text findings. Not verified by result id alone.
   * @deprecated Prefer computedFindings for shareable facts; retained for legacy packs.
   */
  findings: z.array(z.string().trim().min(1).max(1_000)).max(10).optional(),
  caveats: z.array(z.string().trim().min(1).max(1_000)).max(10).optional(),
  nextSteps: z.array(z.string().trim().min(1).max(1_000)).max(10).optional(),
  /** When true, include interpretation sections in shareable output. */
  includeInterpretation: z.boolean().optional(),
  /**
   * Analyst review of interpretation against an exact analysis revision.
   * Absent or legacy free text is treated as unreviewed.
   */
  interpretationReview: z
    .strictObject({
      status: z.enum(['unreviewed', 'approved', 'rejected']),
      analysisId: z.string().min(1).max(128).optional(),
      analysisRevision: z.number().int().nonnegative().optional(),
      reviewedAt: z.string().min(1).max(64).optional(),
    })
    .optional(),
})
export type ReportNarrative = z.infer<typeof ReportNarrativeSchema>
const templateLabels: Record<ReportTemplate, string> = {
  'analytical-brief': 'Analytical brief',
  comparison: 'Comparison',
  'executive-summary': 'Executive summary',
}

export interface ReportInput {
  template?: ReportTemplate
  title: string
  evidence?: ResultEvidence
  sql?: string
  parameters?: Array<{ logicalType: string; value: unknown }>
  /** Inline, already-rendered SVG markup (trusted output of our own renderer). */
  svgMarkup: string
  columns: ReportTableColumn[]
  /** Every value pre-formatted as a display string; no native DB values. */
  rows: string[][]
  /** Optional presentation strings; exact `rows` remain available below them. */
  displayRows?: string[][]
  rowCount: number
  previewTruncated: boolean
  sourceCaption: string
  datasetVersionId: string
  semanticRevisionId: string
  generatedAt: string
  warnings: string[]
  narrative?: ReportNarrative
}

/** Minimal, dependency-free HTML escaping for a fixed, fully controlled template. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function tableMarkup(columns: ReportTableColumn[], rows: string[][], className = ''): string {
  const head = columns
    .map((column) => {
      const unit = column.unit ? ` (${escapeHtml(column.unit)})` : ''
      return `<th scope="col">${escapeHtml(column.name)}${unit}</th>`
    })
    .join('')
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('')
  return `<table${className ? ` class="${className}"` : ''}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

function renderTable(
  columns: ReportTableColumn[],
  rows: string[][],
  displayRows?: string[][],
): string {
  if (!displayRows || JSON.stringify(displayRows) === JSON.stringify(rows)) {
    return tableMarkup(columns, rows)
  }
  return `${tableMarkup(columns, displayRows, 'display-values')}
<details class="exact-values"><summary>Exact values</summary>${tableMarkup(columns, rows, 'raw-values')}</details>`
}

function renderNarrative(narrative?: ReportNarrative): string {
  if (!narrative) return ''
  const section = (title: string, items?: string[], className = 'narrative') =>
    items?.length
      ? `<section class="${className}"><h2>${title}</h2><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>`
      : ''
  const computed = narrative.computedFindings?.map((finding) => finding.sentence)
  const review = narrative.interpretationReview
  const reviewLabel = review
    ? `Interpretation review: ${review.status}${
        review.analysisRevision !== undefined ? ` (revision ${review.analysisRevision})` : ''
      }`
    : 'Interpretation review: unreviewed'
  const includeInterpretation = narrative.includeInterpretation === true
  const interpretationBlocks = includeInterpretation
    ? `${section('Generated interpretation', narrative.findings, 'interpretation')}${section('Caveats', narrative.caveats, 'interpretation')}${section('Next steps', narrative.nextSteps, 'interpretation')}<p class="interpretation-review">${escapeHtml(reviewLabel)}</p>`
    : narrative.findings?.length || narrative.caveats?.length || narrative.nextSteps?.length
      ? `<p class="interpretation-omitted">${escapeHtml(
          'Generated interpretation omitted from this shareable report (facts-only). ' +
            reviewLabel,
        )}</p>`
      : ''
  return `${section('Computed findings', computed, 'computed-findings')}${interpretationBlocks}`
}

function renderParameters(parameters?: Array<{ logicalType: string; value: unknown }>): string {
  if (!parameters) return '<p>Parameter provenance unavailable.</p>'
  if (parameters.length === 0) return '<p>Query has no bound parameters.</p>'
  return `<h3>Bound query parameters (in order)</h3><ol>${parameters.map((parameter) => `<li>${escapeHtml(parameter.logicalType)}: <code>${escapeHtml(JSON.stringify(parameter.value))}</code></li>`).join('')}</ol>`
}

function renderEvidence(evidence?: ResultEvidence): string {
  if (!evidence) return ''
  const facts = evidence.facts
    .map(
      (fact) =>
        `<li><strong>${escapeHtml(fact.column)}</strong>: minimum ${escapeHtml(String(fact.minimum))} (row ${fact.minimumRow + 1}); maximum ${escapeHtml(String(fact.maximum))} (row ${fact.maximumRow + 1}); ${fact.nonNullCount} non-null values.</li>`,
    )
    .join('')
  return `<aside class="evidence"><h3>Verified result facts</h3><p>${escapeHtml(evidence.scope)}</p>${facts ? `<ul>${facts}</ul>` : '<p>No numeric facts available.</p>'}${evidence.warnings.length ? `<ul class="warnings">${evidence.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : ''}<details><summary>Evidence provenance</summary><p>Result ${escapeHtml(evidence.resultId)}${evidence.analysisId ? ` · Analysis ${escapeHtml(evidence.analysisId)} · Revision ${escapeHtml(String(evidence.revision))}` : ''}${evidence.filter ? ` · Filter: ${escapeHtml(evidence.filter)}` : ''}</p></details></aside>`
}

const reportLayoutCss = `
  * { box-sizing: border-box; }
  body { line-height: 1.5; margin: 2rem auto; padding: 0 1rem; max-width: 72rem; }
  figure { overflow-x: auto; }
  svg { max-width: 100%; height: auto; }
  table { width: 100%; font-variant-numeric: tabular-nums; }
  td { overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .evidence { background: #f4f7fa; border-left: 3px solid #315b7d; padding: .75rem 1rem; margin: 1rem 0; }
  .evidence h3 { margin-top: 0; }
  .report-kind { font-size: .85rem; color: #555; }
  .comparison-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; align-items: start; }
  .comparison-grid section { min-width: 0; overflow-x: auto; }
  @media (max-width: 800px) { .comparison-grid { grid-template-columns: 1fr; } }
  @media print { .comparison-grid { display: block; } }
  @media (max-width: 600px) { body { margin: 1rem auto; } th, td { font-size: .8rem; padding: .2rem; } }
  @media print { body { max-width: none; margin: 0; padding: 0; color: #000; } figure, .evidence, .kpi { break-inside: avoid; } thead { display: table-header-group; } tr { break-inside: avoid; } section { border: 0; padding: 0; } details > * { display: block; } }
`

/**
 * Render a fixed, self-contained, offline-openable HTML report. No CDN, script,
 * external stylesheet, or remote image reference is emitted. The caller supplies
 * already-rendered SVG and pre-formatted display values; this function performs
 * no data computation and no unsafe coercion.
 */
export function renderHtmlReport(input: ReportInput): string {
  const template = ReportTemplateSchema.parse(input.template ?? 'analytical-brief')
  const findings = renderEvidence(input.evidence)
  const warningsMarkup = input.warnings.length
    ? `<ul class="warnings">${input.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`
    : ''
  const truncationNotice = input.previewTruncated
    ? '<p class="truncated">Preview truncated; export the full result for the complete authorized dataset.</p>'
    : ''
  const emptyNotice =
    input.rowCount === 0
      ? '<p class="empty-result">This query returned no rows. The chart above reflects an empty result, not a computed zero.</p>'
      : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #111; }
  figure { margin: 0 0 1.5rem; }
  table { border-collapse: collapse; margin-top: 0.5rem; }
  th, td { border: 1px solid #ccc; padding: 0.25rem 0.5rem; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  caption, figcaption { text-align: left; color: #444; font-size: 0.85rem; }
  .warnings { color: #7a4b00; }
  .truncated, .empty-result { color: #7a4b00; font-style: italic; }
${reportLayoutCss}
</style>
</head>
<body data-report-template="${template}" data-template-version="1">
<p class="report-kind">${templateLabels[template]} · Offline snapshot</p>
<h1>${escapeHtml(input.title)}</h1>
${template === 'executive-summary' ? findings : ''}
${input.svgMarkup ? `<figure>\n${input.svgMarkup}\n<figcaption>${escapeHtml(input.sourceCaption)}</figcaption>\n</figure>` : `<p>${escapeHtml(input.sourceCaption)}</p>`}
${renderNarrative(input.narrative)}
${emptyNotice}
${template !== 'executive-summary' ? findings : ''}
<h2>${template === 'comparison' ? 'Compare exact values' : 'Supporting values'}</h2>
${template === 'comparison' ? '<p>Compare only values with compatible units, populations and time periods. No cross-row difference is inferred.</p>' : ''}
${renderTable(input.columns, input.rows, input.displayRows)}
${truncationNotice}
${input.sql ? `<h2>Query and filters</h2><pre>${escapeHtml(input.sql)}</pre>${renderParameters(input.parameters)}` : ''}
${warningsMarkup}
<dl>
  <dt>Dataset version</dt><dd>${escapeHtml(input.datasetVersionId)}</dd>
  <dt>Semantic revision</dt><dd>${escapeHtml(input.semanticRevisionId)}</dd>
  <dt>Row count</dt><dd>${escapeHtml(String(input.rowCount))}</dd>
  <dt>Generated</dt><dd>${escapeHtml(input.generatedAt)}</dd>
</dl>
</body>
</html>
`
}

export interface DashboardReportSection {
  /** Short chart/card heading. */
  question: string
  /** Full analyst question and interpretation context, separate from the heading. */
  context?: string
  /** Inline, already-rendered SVG; omitted for table-only cards. */
  svgMarkup?: string
  columns: ReportTableColumn[]
  /** Every value pre-formatted as a display string; no native DB values. */
  rows: string[][]
  displayRows?: string[][]
  rowCount: number
  sourceCaption: string
  evidence?: ResultEvidence
  sql?: string
  parameters?: Array<{ logicalType: string; value: unknown }>
}

export interface DashboardReportInput {
  template?: ReportTemplate
  title: string
  /**
   * Model-authored executive summary, escaped verbatim (no markup executed).
   * Rendered only when {@link DashboardReportInput.interpretationApproved} is
   * true — see that field for why.
   */
  summary?: string
  /**
   * Whether the interpretation behind `summary`/`narrative` was reviewed and
   * approved for a shareable export (`interpretationApprovedForExport`).
   *
   * A summary supplied without approval is withheld and the report says so —
   * the same facts-only rule `renderNarrative` already applies to findings,
   * caveats and next steps. Without this the shareable report printed the
   * unreviewed interpretation in `<aside class="summary">` directly above the
   * sentence claiming it had been omitted (observed on a live export).
   */
  interpretationApproved?: boolean
  narrative?: ReportNarrative
  /** Number-backed key figures shown as cards above the chart sections. */
  kpis?: Array<{ label: string; value: string; note?: string }>
  sections: DashboardReportSection[]
  generatedAt: string
}

/**
 * Render a self-contained, offline-openable dashboard report: one title, an
 * optional executive summary, then one section per pinned analysis (chart +
 * bounded data table + provenance). Same trust rules as {@link renderHtmlReport}:
 * no CDN, script, external stylesheet, or remote image; every value escaped.
 */
export function renderHtmlDashboardReport(input: DashboardReportInput): string {
  const template = ReportTemplateSchema.parse(input.template ?? 'analytical-brief')
  const summaryApproved = input.interpretationApproved === true
  const summaryMarkup =
    input.summary && summaryApproved
      ? `<aside class="summary"><h2>Generated interpretation</h2><p>${escapeHtml(input.summary)}</p></aside>`
      : ''
  // `interpretationApproved` is authoritative, not the narrative's own
  // `includeInterpretation` flag: a direct caller (anything other than the export
  // route, which derives both from the stored review) could otherwise print an
  // unapproved interpretation while the summary was dropped without a note.
  // Approval is a ceiling, not an instruction: it can only ever withhold
  // interpretation, never print interpretation a caller asked to leave out.
  // Forcing the flag in both directions would have overridden an explicit
  // `includeInterpretation: false` into printing it — harmless while the export
  // route is the only caller (it derives both from the same review), and exactly
  // the kind of silent reversal that stops being harmless when a second one appears.
  const narrativeMarkup = renderNarrative(
    input.narrative
      ? {
          ...input.narrative,
          includeInterpretation: summaryApproved && input.narrative.includeInterpretation !== false,
        }
      : input.narrative,
  )
  // One withheld-interpretation note, whichever path withheld something: the
  // narrative's own note (emitted by `renderNarrative`) already covers the case
  // where findings/caveats/next steps were supplied, so only add one when the
  // summary was the sole interpretation bearing content.
  const narrativeCarriedInterpretation = Boolean(
    input.narrative?.findings?.length ||
    input.narrative?.caveats?.length ||
    input.narrative?.nextSteps?.length,
  )
  const withheldSummaryMarkup =
    input.summary && !summaryApproved && !narrativeCarriedInterpretation
      ? `<p class="interpretation-omitted">${escapeHtml(
          'Generated interpretation omitted from this shareable report (facts-only). ' +
            'Interpretation review: unreviewed',
        )}</p>`
      : ''
  const kpisMarkup = (input.kpis ?? [])
    .map(
      (kpi) =>
        `<div class="kpi"><span class="kpi-value">${escapeHtml(kpi.value)}</span><span class="kpi-label">${escapeHtml(kpi.label)}</span>${kpi.note ? `<span class="kpi-note">${escapeHtml(kpi.note)}</span>` : ''}</div>`,
    )
    .join('\n')
  const sectionsMarkup = input.sections
    .map((section) => {
      const figure = section.svgMarkup
        ? `<figure>\n${section.svgMarkup}\n<figcaption>${escapeHtml(section.sourceCaption)}</figcaption>\n</figure>`
        : `<p>${escapeHtml(section.sourceCaption)}</p>`
      const sql = section.sql
        ? `<details><summary>Query</summary><pre>${escapeHtml(section.sql)}</pre>${renderParameters(section.parameters)}</details>`
        : ''
      return `<section>
<h2>${escapeHtml(section.question)}</h2>
${section.context ? `<p class="analysis-context">${escapeHtml(section.context)}</p>` : ''}
${figure}
${template === 'executive-summary' ? '' : renderEvidence(section.evidence)}
${renderTable(section.columns, section.rows, section.displayRows)}
<p class="rowcount">${escapeHtml(String(section.rowCount))} row(s).${section.rows.length < section.rowCount ? ` Showing ${section.rows.length}; complete stored rows are included in the ZIP when available.` : ''}</p>
${sql}
</section>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #111; max-width: 64rem; }
  h1 { border-bottom: 2px solid #333; padding-bottom: 0.5rem; }
  section { margin: 2rem 0; padding: 1rem; border: 1px solid #e0e0e0; border-radius: 4px; }
  figure { margin: 0 0 1rem; }
  table { border-collapse: collapse; margin-top: 0.5rem; }
  th, td { border: 1px solid #ccc; padding: 0.25rem 0.5rem; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  figcaption { text-align: left; color: #444; font-size: 0.85rem; }
  .summary { font-size: 1.05rem; background: #f4f4f4; padding: 0.75rem 1rem; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.75rem; margin: 1.25rem 0; }
  .kpi { border: 1px solid #e0e0e0; border-radius: 4px; padding: 0.75rem 1rem; display: flex; flex-direction: column; }
  .kpi-value { font-size: 1.5rem; font-weight: 600; }
  .kpi-label { font-size: 0.8rem; color: #444; text-transform: uppercase; letter-spacing: 0.03em; }
  .kpi-note { font-size: 0.75rem; color: #666; }
  .rowcount { color: #444; font-size: 0.8rem; }
  footer { color: #888; font-size: 0.8rem; margin-top: 2rem; }
  pre { white-space: pre-wrap; background: #fafafa; padding: 0.5rem; }
${reportLayoutCss}
</style>
</head>
<body data-report-template="${template}" data-template-version="1">
<p class="report-kind">${templateLabels[template]} · Offline snapshot</p>
<h1>${escapeHtml(input.title)}</h1>
${summaryMarkup}
${withheldSummaryMarkup}
${narrativeMarkup}
${kpisMarkup ? `<div class="kpis">${kpisMarkup}</div>` : ''}
${template === 'executive-summary' ? `<h2>Verified findings</h2>${input.sections.map((section) => `<div><h3>${escapeHtml(section.question)}</h3>${renderEvidence(section.evidence) || '<p>No verified numeric facts available.</p>'}</div>`).join('')}` : ''}
${template === 'comparison' ? '<p>Views are shown side by side. Check each source, filter and denominator before comparing; no cross-view difference is inferred.</p>' : ''}
<div class="report-sections ${template === 'comparison' ? 'comparison-grid' : ''}">${sectionsMarkup}</div>
<footer>Generated ${escapeHtml(input.generatedAt)}</footer>
</body>
</html>
`
}
