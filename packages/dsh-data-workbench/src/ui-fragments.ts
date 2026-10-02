import type { AnalysisRevision, Dashboard } from 'dsh-data-core/contracts'
import { stripFilterCaption, unwrapEqualityFilter } from 'dsh-data-core/dashboard-filters'
import { escapeHtml } from 'dsh-data-core/report-template'
import type { ExportPackResult, DashboardExportResult } from './export-pack.js'
import { dashboardSlotTitle } from './dashboard-slot-title.js'

const fragmentStyles = `<style>
:is(.analyst-analysis-fragment,.analyst-dashboard-fragment,.analyst-export-fragment) { font:14px/1.55 system-ui,sans-serif;padding:12px;margin:10px 0;border:1px solid var(--dsw-alias-border,#ccc);border-radius:8px; }
:is(.analyst-analysis-fragment,.analyst-dashboard-fragment) h2 { font-size:18px;line-height:1.3;margin:0 0 10px; }
:is(.analyst-analysis-fragment,.analyst-dashboard-fragment) h3 { font-size:15px;margin:12px 0 8px; }
:is(.analyst-analysis-fragment,.analyst-dashboard-fragment) p { margin:8px 0; }
:is(.analyst-analysis-fragment,.analyst-dashboard-fragment) form { display:flex;align-items:end;gap:10px;flex-wrap:wrap;margin:12px 0; }
:is(.analyst-analysis-fragment,.analyst-dashboard-fragment) label { display:grid;gap:5px;font-size:13px; }
:is(.analyst-analysis-fragment,.analyst-dashboard-fragment) :is(input,select,button,textarea) { font:inherit;min-height:36px;padding:6px 10px;max-width:100%;border:1px solid var(--dsw-alias-border,#aaa);border-radius:5px;color:inherit;background:transparent; }
:is(.analyst-analysis-fragment,.analyst-dashboard-fragment) button:disabled { opacity:.5;cursor:default; }
:is(.analyst-analysis-fragment,.analyst-dashboard-fragment,.analyst-export-fragment) :focus-visible { outline:2px solid var(--dsw-alias-state-info-primary,#3875cb);outline-offset:2px; }
:is(.analyst-analysis-fragment,.analyst-dashboard-fragment) summary { cursor:pointer;padding:6px 0;font-weight:500; }
.analyst-dashboard-fragment .analyst-filter-scopes { list-style:none;padding:0;display:grid;gap:8px; }
.analyst-dashboard-fragment .analyst-filter-scopes li { border:1px solid var(--dsw-alias-border,#ccc);border-radius:6px;padding:8px 10px; }
.analyst-dashboard-fragment article { padding:10px;border:1px solid var(--dsw-alias-border,#ccc);border-radius:6px; }
</style>`

const reportTemplateControl =
  '<label>Report template <select name="template"><option value="analytical-brief">Analytical brief</option><option value="comparison">Comparison</option><option value="executive-summary">Executive summary</option></select></label>'

/** Render the trusted, fragment-only analysis composition surface. */
export function renderAnalysisFragment(analysis: AnalysisRevision, version: string): string {
  const chartTitle = analysis.chart.title ?? 'Chart'
  const review = analysis.interpretationReview
  const reviewStatus = review?.status ?? 'unreviewed'
  const reviewLabel =
    reviewStatus === 'approved' && review?.resultId === analysis.resultId
      ? 'approved'
      : reviewStatus === 'rejected'
        ? 'rejected'
        : 'unreviewed'
  const findingsText = (analysis.interpretation?.findings ?? []).join('\n')
  const caveatsText = (analysis.interpretation?.caveats ?? []).join('\n')
  const nextStepsText = (analysis.interpretation?.nextSteps ?? []).join('\n')
  const includeInterpretationAllowed = reviewLabel === 'approved'
  return `<section class="analyst-analysis-fragment" aria-label="Analysis composition" data-analysis-id="${escapeHtml(analysis.analysisId)}" data-resource-version="${escapeHtml(version)}">
  ${fragmentStyles}
  <header><h2>${escapeHtml(chartTitle)}</h2></header>
  <details><summary>Analysis context and source caveats</summary><p>${escapeHtml(analysis.question)}</p></details>
  <dl aria-label="Analysis details">
    <div><dt>Revision</dt><dd>${escapeHtml(String(analysis.revision))}</dd></div>
    <div><dt>Result</dt><dd>${escapeHtml(analysis.resultId)}</dd></div>
    <div><dt>Interpretation review</dt><dd>${escapeHtml(reviewLabel)}</dd></div>
  </dl>
  <section aria-label="Generated interpretation">
    <h3>Generated interpretation</h3>
    <p>Not verified facts. Approve only after checking exact values and scope. Human approval means reviewed, not independently proven.</p>
    <form data-analyst-action="interpretation-review" data-analyst-url="/api/analyst/interpretation/review" method="post">
      <input type="hidden" name="analysisId" value="${escapeHtml(analysis.analysisId)}">
      <input type="hidden" name="expectedRevision" value="${analysis.revision}">
      <label>Findings <textarea name="findings" rows="3">${escapeHtml(findingsText)}</textarea></label>
      <label>Caveats <textarea name="caveats" rows="2">${escapeHtml(caveatsText)}</textarea></label>
      <label>Next steps <textarea name="nextSteps" rows="2">${escapeHtml(nextStepsText)}</textarea></label>
      <button type="submit" name="status" value="approved">Approve interpretation</button>
      <button type="submit" name="status" value="rejected">Remove / reject</button>
      <button type="submit" name="status" value="unreviewed">Save draft</button>
    </form>
  </section>
  <form data-analyst-action="export" data-analyst-url="/api/analyst/ui/analysis/export" method="post">
    <input type="hidden" name="analysisId" value="${escapeHtml(analysis.analysisId)}">
    <input type="hidden" name="expectedRevision" value="${analysis.revision}">
    ${reportTemplateControl}
    ${
      includeInterpretationAllowed
        ? '<label><input type="checkbox" name="includeInterpretation" value="1"> Include approved interpretation</label>'
        : '<p>Facts-only export (interpretation not approved for this result).</p>'
    }
    <button type="submit">Preview and export report</button>
  </form>
</section>`
}

/** Render the trusted, fragment-only dashboard shared-filter and card surface. */
export function renderDashboardFragment(
  dashboard: Dashboard,
  cards: readonly AnalysisRevision[],
  version: string,
  unsupported: readonly { analysisId: string; reason: string }[] = [],
  studio = false,
): string {
  const filters = [...new Set(dashboard.layout.slots.flatMap((slot) => slot.sharedFilterKeys))]
  const filterColumnControl =
    filters.length > 0
      ? `<select name="column" required>${filters.map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(key)}</option>`).join('')}</select>`
      : '<select name="column" disabled><option>No mapped filter fields</option></select>'
  const filterList = filters
    .map((key) => {
      const targets = dashboard.layout.slots.filter((slot) => slot.sharedFilterKeys.includes(key))
      return `<li>${escapeHtml(key)} — applies to ${targets.length} of ${dashboard.layout.slots.length} charts: ${targets
        .map((slot) =>
          escapeHtml(
            dashboardSlotTitle(
              slot,
              cards.find((card) => card.analysisId === slot.analysisId),
            ),
          ),
        )
        .join('; ')}</li>`
    })
    .join('')
  const cardMarkup = dashboard.layout.slots
    .map((slot) => {
      const analysis = cards.find((card) => card.analysisId === slot.analysisId)
      const title = dashboardSlotTitle(slot, analysis)
      const question = analysis?.question ?? 'Analysis unavailable'
      const mapped = slot.sharedFilterKeys.join(', ')
      return `<article style="grid-column: span ${slot.width === 2 ? 2 : 1}; min-width: 0" data-analysis-id="${escapeHtml(slot.analysisId)}" aria-label="Dashboard analysis card">
  <h3>${escapeHtml(title)}</h3><details><summary>Analysis context and source caveats</summary><p>${escapeHtml(question)}</p></details>
  ${analysis?.artifactIds[0] ? `<img style="width:100%;height:auto" alt="${escapeHtml(title)}" src="/api/analyst/artifacts?id=${encodeURIComponent(analysis.artifactIds[0])}&amp;format=svg">` : ''}
  ${
    studio
      ? ''
      : `<form data-analyst-action="map-keys" data-analyst-url="/api/analyst/ui/dashboard/map-keys" method="post">
    <input type="hidden" name="dashboardId" value="${escapeHtml(dashboard.dashboardId)}">
    <input type="hidden" name="analysisId" value="${escapeHtml(slot.analysisId)}">
    <label>Shared filter keys <input name="keys" type="text" value="${escapeHtml(mapped)}" autocomplete="off"></label>
    <button type="submit">Map filter keys</button>
  </form>`
  }
</article>`
    })
    .join('')
  const unsupportedMarkup =
    unsupported.length > 0
      ? `<aside aria-label="Unsupported shared filters"><h3>Shared filters unsupported</h3><ul>${unsupported.map((item) => `<li data-analysis-id="${escapeHtml(item.analysisId)}">${escapeHtml(item.reason)}</li>`).join('')}</ul></aside>`
      : ''
  const activeFilter = dashboard.activeFilter
  const currentSlotIds = new Set(dashboard.layout.slots.map((slot) => slot.analysisId))
  const currentFilterCards =
    activeFilter?.cards.filter((card) => currentSlotIds.has(card.analysisId)) ?? []
  const changedCount = currentFilterCards.filter((card) => card.status === 'changed').length
  const unmappedCount = currentFilterCards.filter((card) => card.status === 'unmapped').length
  const unsupportedCount = currentFilterCards.filter((card) => card.status === 'unsupported').length
  const removedCount = (activeFilter?.cards.length ?? 0) - currentFilterCards.length
  const activeMarkup = activeFilter
    ? `<aside aria-label="Active shared filter"><p><strong>Active filter:</strong> <code>${escapeHtml(activeFilter.column)} = ${escapeHtml(activeFilter.value)}</code> <span>Scope: saved result rows</span></p><p>Current cards: ${changedCount} changed · ${unmappedCount} unmapped${unsupportedCount ? ` · ${unsupportedCount} unsupported` : ''}</p>${removedCount ? `<p role="note">${removedCount} card${removedCount === 1 ? ' was' : 's were'} removed since this filter was applied. Clear ignores removed cards.</p>` : ''}${dashboard.updatedAt !== activeFilter.appliedDashboardVersion ? '<p role="note">Dashboard layout changed after this filter was applied. Clear preserves newer cards and mappings.</p>' : ''}<form data-analyst-action="filter-clear" data-analyst-url="/api/analyst/ui/dashboard/filter" method="post"><input type="hidden" name="dashboardId" value="${escapeHtml(dashboard.dashboardId)}"><button type="submit">Clear shared filter</button></form></aside>`
    : ''
  const legacyFiltered =
    !activeFilter &&
    cards.some(
      (card) =>
        unwrapEqualityFilter(card.query.sql) !== card.query.sql ||
        stripFilterCaption(card.question) !== card.question,
    )
  const legacyMarkup = legacyFiltered
    ? '<aside aria-label="Legacy filter recovery"><p>Filtered revisions without trustworthy base metadata cannot be cleared automatically. Restore the intended revision from analysis history and re-pin it.</p></aside>'
    : ''
  return `<section class="analyst-dashboard-fragment" aria-label="Dashboard composition" data-dashboard-id="${escapeHtml(dashboard.dashboardId)}" data-resource-version="${escapeHtml(version)}">
  <style>.analyst-dashboard-cards { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem; } .analyst-dashboard-fragment { container-type:inline-size; } @container (max-width:600px) { .analyst-dashboard-cards { grid-template-columns:1fr; } .analyst-dashboard-cards > article { grid-column:span 1 !important; } }</style>
  ${fragmentStyles}
  <header><h2>${escapeHtml(dashboard.title)}</h2></header>
  <form data-analyst-action="export-dashboard" data-analyst-url="/api/analyst/ui/dashboard/export" method="post">
    <input type="hidden" name="dashboardId" value="${escapeHtml(dashboard.dashboardId)}">
    ${reportTemplateControl}
    <button type="submit">Preview and export dashboard report</button>
  </form>
  <section aria-label="Dashboard shared filters">
    <h3>Shared filters</h3>
    ${activeMarkup}${legacyMarkup}
    <ul class="analyst-filter-scopes">${filterList || '<li>No filter fields mapped. Choose target fields in Studio first.</li>'}</ul>
    <form data-analyst-action="filter" data-analyst-url="/api/analyst/ui/dashboard/filter" method="post">
      <input type="hidden" name="dashboardId" value="${escapeHtml(dashboard.dashboardId)}">
      <label>Column ${filterColumnControl}</label>
      <label>Value <input name="value" type="text" required autocomplete="off"${filters.length ? '' : ' disabled'}></label>
      <button type="submit"${filters.length ? '' : ' disabled'}>Apply shared filter</button>
    </form>
  </section>
  ${unsupportedMarkup}
  ${
    studio
      ? ''
      : `<section aria-label="Pin analysis">
    <h3>Pin analysis</h3>
    <form data-analyst-action="pin" data-analyst-url="/api/analyst/ui/dashboard/pin" method="post">
      <input type="hidden" name="dashboardId" value="${escapeHtml(dashboard.dashboardId)}">
      <label>Analysis id <input name="analysisId" type="text" required pattern="ana_[A-Za-z0-9]+" autocomplete="off"></label>
      <button type="submit">Pin analysis</button>
    </form>
  </section>`
  }
  <section aria-label="Dashboard analysis cards"><h3>Analysis cards</h3><div class="analyst-dashboard-cards">${cardMarkup || '<p>No analyses pinned.</p>'}</div></section>
</section>`
}

/** Render trusted links for a completed analysis export pack. */
export function renderExportFragment(pack: ExportPackResult | DashboardExportResult): string {
  const links = Object.entries(pack.downloads)
    .map(
      ([format, href]) => `<a href="${escapeHtml(href)}">${escapeHtml(format.toUpperCase())}</a>`,
    )
    .join(' · ')
  return `<section class="analyst-export-fragment" aria-label="Report downloads" data-export-pack-id="${escapeHtml(pack.files.html.replace(/\.html$/, ''))}">
  ${fragmentStyles}
  <strong>Report ready</strong>
  <p><a href="${escapeHtml(pack.downloads.html!)}&amp;preview=1" rel="noopener noreferrer">Open report</a></p>
  <p>Read-only snapshot with chart values and source details.</p>
  <details><summary>Offline downloads</summary><p>${links}</p></details>
</section>`
}
