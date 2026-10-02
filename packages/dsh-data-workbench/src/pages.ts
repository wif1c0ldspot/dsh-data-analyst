/**
 * Test-only HTML page builders for the legacy standalone workbench adapter
 * (`server.ts`). Not used by the product plugin UI path (dsh toolviews +
 * `/api/analyst/ui/*` fragments).
 */
import { escapeHtml } from 'dsh-data-core/report-template'
import type {
  AnalysisRevision,
  Dashboard,
  DatasetManifest,
  Feedback,
  SemanticAliasCandidate,
} from 'dsh-data-core/contracts'
import type { ImportJob } from 'dsh-data-core/metadata-store'
import type { SemanticRevision } from 'dsh-data-core/semantics'

const TERMINAL_JOB_STATUSES = new Set(['ready', 'failed', 'cancelled'])

function artifactDownloadLinks(artifactId: string): string {
  const id = encodeURIComponent(artifactId)
  return `<a href="/analyst/artifacts/${id}/download">Download SVG</a>
         · <a href="/analyst/artifacts/${id}/png">Download PNG</a>`
}

export interface DatasetSummary {
  datasetId: string
  datasetVersionId: string
  tables: DatasetManifest['tables']
  semantics?: SemanticRevision
}

export interface DashboardCardView {
  slot: Dashboard['layout']['slots'][number]
  analysis?: AnalysisRevision
  artifactId?: string
}

function navLinks(): string {
  return `<nav class="nav">
    <a href="/">Datasets</a>
    <a href="/imports">Imports</a>
    <a href="/analyses">Analyses</a>
    <a href="/dashboard">Dashboard</a>
    <a href="/aliases">Feedback/Aliases</a>
    <a href="/artifacts">Artifacts</a>
  </nav>`
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>
:root{--ink:#1a1a1a;--muted:#5c5c5c;--line:#d8d8d8;--bg:#f7f5f1;--accent:#0b5fff}
*{box-sizing:border-box}body{margin:0;font:16px/1.45 "IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;color:var(--ink);background:var(--bg)}
header{padding:1.25rem 1.5rem;border-bottom:1px solid var(--line);background:#fff}
main{padding:1.5rem;max-width:64rem;margin:0 auto}
h1{font-size:1.35rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:1.5rem 0 .5rem}
p,label{color:var(--muted)}a{color:var(--accent)}
.nav{display:flex;gap:1rem;flex-wrap:wrap;margin-top:.75rem;font-size:.95rem}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid var(--line)}
th,td{padding:.45rem .6rem;border-bottom:1px solid var(--line);text-align:left;font-size:.92rem}
form{display:grid;gap:.75rem;background:#fff;border:1px solid var(--line);padding:1rem;margin:1rem 0}
textarea,select,input,button{font:inherit}textarea{width:100%;min-height:7rem}
button{background:var(--ink);color:#fff;border:0;padding:.55rem 1rem;cursor:pointer}
.chart{background:#fff;border:1px solid var(--line);padding:1rem;margin:1rem 0;overflow:auto}
.err{color:#9b1c1c;background:#fde8e8;padding:.75rem;border:1px solid #f5c2c2}
.ok{color:#0f5132;background:#d1e7dd;padding:.75rem;border:1px solid #badbcc}
.note{color:#664d03;background:#fff3cd;padding:.75rem;border:1px solid #ffecb5}
.progress{color:#084298;background:#cfe2ff;padding:.35rem .55rem;border:1px solid #9ec5fe;display:inline-block}
.failed{color:#9b1c1c}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em}
.actions{display:flex;gap:.5rem;flex-wrap:wrap}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))}
.card{background:#fff;border:1px solid var(--line);padding:1rem}
.card img{max-width:100%;height:auto}
</style>
<script src="/static/htmx.min.js" defer></script>
</head>
<body hx-boost="true">
<header>
  <h1>dsh-data-analyst workbench</h1>
  <p>Server-owned HTMX surface (ADR 001). Queries and charts go through the same policy services as the tools — no model-authored HTML.</p>
  ${navLinks()}
</header>
<main>${body}</main>
</body></html>`
}

export function renderHomePage(datasets: DatasetSummary[], message?: string): string {
  const rows = datasets
    .map((dataset) => {
      const tables = dataset.tables.map((t) => `${escapeHtml(t.id)} (${t.rows})`).join(', ')
      const sem = dataset.semantics
        ? escapeHtml(dataset.semantics.semanticRevisionId)
        : '<em>none</em>'
      const aliases = dataset.semantics
        ? dataset.semantics.aliases.map((a) => escapeHtml(a.term)).join(', ')
        : '—'
      return `<tr>
        <td><a href="/dataset/${encodeURIComponent(dataset.datasetId)}">${escapeHtml(dataset.datasetId)}</a></td>
        <td><code>${escapeHtml(dataset.datasetVersionId)}</code></td>
        <td>${tables}</td>
        <td>${sem}<br/><small>${aliases}</small></td>
      </tr>`
    })
    .join('')
  const banner = message ? `<p class="ok">${escapeHtml(message)}</p>` : ''
  return layout(
    'Analyst workbench',
    `${banner}
    <h2>Published datasets</h2>
    <table>
      <thead><tr><th>Dataset</th><th>Version</th><th>Tables</th><th>Semantics</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No published datasets. Run <code>npm run ingest</code> first.</td></tr>'}</tbody>
    </table>
    <p><a href="/imports">Import jobs</a> · <a href="/analyses">Saved analyses</a> · <a href="/dashboard">Dashboard</a> · <a href="/aliases">Feedback/Aliases</a> · <a href="/artifacts">Artifacts</a></p>`,
  )
}

export function renderImportsPage(
  jobs: ImportJob[],
  options: { message?: string; error?: string } = {},
): string {
  const msg = options.message ? `<p class="ok">${escapeHtml(options.message)}</p>` : ''
  const err = options.error ? `<p class="err">${escapeHtml(options.error)}</p>` : ''
  const rows = jobs
    .map((job) => {
      const inProgress = !TERMINAL_JOB_STATUSES.has(job.status)
      const statusCell = inProgress
        ? `<span class="progress">In progress — ${escapeHtml(job.status)}</span>`
        : job.status === 'failed'
          ? `<span class="failed">${escapeHtml(job.status)}</span>`
          : escapeHtml(job.status)
      const errorCell =
        job.status === 'failed' && job.errorMessage
          ? `<td class="failed">${escapeHtml(job.errorMessage)}</td>`
          : `<td>${escapeHtml(job.errorMessage ?? '—')}</td>`
      const cancel = inProgress
        ? `<form method="post" action="/imports/${encodeURIComponent(job.jobId)}/cancel" style="border:0;padding:0;margin:0;background:transparent">
               <button type="submit">Cancel</button>
             </form>`
        : '—'
      return `<tr>
        <td><code>${escapeHtml(job.jobId)}</code></td>
        <td>${escapeHtml(job.slug)}</td>
        <td>${statusCell}</td>
        <td><code>${escapeHtml(job.datasetVersionId ?? '—')}</code></td>
        ${errorCell}
        <td>${escapeHtml(job.updatedAt)}</td>
        <td>${cancel}</td>
      </tr>`
    })
    .join('')
  return layout(
    'Import jobs',
    `<p><a href="/">← datasets</a></p>
     <h2>Import jobs</h2>
     ${err}${msg}
     <table>
       <thead><tr><th>Job</th><th>Slug</th><th>Status</th><th>Dataset version</th><th>Error</th><th>Updated</th><th></th></tr></thead>
       <tbody>${rows || '<tr><td colspan="7">No import jobs yet.</td></tr>'}</tbody>
     </table>`,
  )
}

export function renderDatasetPage(
  dataset: DatasetSummary,
  options: {
    sql?: string
    question?: string
    filterColumn?: string
    filterValue?: string
    title?: string
    x?: string
    y?: string
    mark?: string
    analystTurns?: number
    turnsRemaining?: number
    preview?: {
      columns: string[]
      rows: string[][]
      resultId?: string
      artifactId?: string
      analysisId?: string
    }
    error?: string
    message?: string
  } = {},
): string {
  const defaultSql =
    options.sql ??
    (dataset.datasetId === 'superstore'
      ? 'SELECT region, round(SUM(sales), 2) AS revenue FROM orders GROUP BY region ORDER BY revenue DESC'
      : dataset.datasetId === 'online-retail'
        ? 'SELECT country, COUNT(*) AS line_items FROM online_retail GROUP BY country ORDER BY line_items DESC LIMIT 5'
        : dataset.datasetId === 'retail-fixture'
          ? 'SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region ORDER BY revenue DESC, region'
          : 'SELECT order_status, COUNT(*) AS orders FROM orders GROUP BY order_status ORDER BY orders DESC')
  const err = options.error ? `<p class="err">${escapeHtml(options.error)}</p>` : ''
  const msg = options.message ? `<p class="ok">${escapeHtml(options.message)}</p>` : ''
  const defaultX =
    options.x ??
    (dataset.datasetId === 'superstore'
      ? 'region'
      : dataset.datasetId === 'online-retail'
        ? 'country'
        : dataset.datasetId === 'retail-fixture'
          ? 'region'
          : 'order_status')
  const defaultY =
    options.y ??
    (dataset.datasetId === 'superstore'
      ? 'revenue'
      : dataset.datasetId === 'online-retail'
        ? 'line_items'
        : dataset.datasetId === 'retail-fixture'
          ? 'revenue'
          : 'orders')
  let resultBlock = ''
  if (options.preview) {
    const head = options.preview.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')
    const body = options.preview.rows
      .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
      .join('')
    const chart = options.preview.artifactId
      ? `<div class="chart"><img alt="chart" src="/analyst/artifacts/${encodeURIComponent(options.preview.artifactId)}.svg"/>
         <p>${artifactDownloadLinks(options.preview.artifactId)}
         · result <code>${escapeHtml(options.preview.resultId ?? '')}</code>
         · mark <code>${escapeHtml(options.mark ?? 'bar')}</code></p>
         ${
           options.preview.resultId
             ? `<form method="post" action="/dataset/${encodeURIComponent(dataset.datasetId)}/chart" class="actions">
            <input type="hidden" name="resultId" value="${escapeHtml(options.preview.resultId)}"/>
            <input type="hidden" name="sql" value="${escapeHtml(defaultSql)}"/>
            <input type="hidden" name="filterColumn" value="${escapeHtml(options.filterColumn ?? '')}"/>
            <input type="hidden" name="filterValue" value="${escapeHtml(options.filterValue ?? '')}"/>
            <input type="hidden" name="title" value="${escapeHtml(options.title ?? 'Analysis')}"/>
            <input type="hidden" name="x" value="${escapeHtml(defaultX)}"/>
            <input type="hidden" name="y" value="${escapeHtml(defaultY)}"/>
            <input type="hidden" name="question" value="${escapeHtml(options.question ?? '')}"/>
            <input type="hidden" name="priorTurns" value="${escapeHtml(String(options.analystTurns ?? 0))}"/>
            <label>Mark
              <select name="mark">
                <option value="bar"${(options.mark ?? 'bar') === 'bar' ? ' selected' : ''}>bar</option>
                <option value="line"${options.mark === 'line' ? ' selected' : ''}>line</option>
                <option value="point"${options.mark === 'point' ? ' selected' : ''}>point</option>
                <option value="area"${options.mark === 'area' ? ' selected' : ''}>area</option>
                <option value="boxplot"${options.mark === 'boxplot' ? ' selected' : ''}>boxplot</option>
              </select>
            </label>
            <button type="submit">Change mark (no re-query)</button>
          </form>`
             : ''
         }</div>`
      : ''
    const saveForm =
      options.preview.resultId && options.preview.artifactId
        ? `<form method="post" action="/dataset/${encodeURIComponent(dataset.datasetId)}/save" class="actions">
            <input type="hidden" name="sql" value="${escapeHtml(defaultSql)}"/>
            <input type="hidden" name="filterColumn" value="${escapeHtml(options.filterColumn ?? '')}"/>
            <input type="hidden" name="filterValue" value="${escapeHtml(options.filterValue ?? '')}"/>
            <input type="hidden" name="title" value="${escapeHtml(options.title ?? 'Analysis')}"/>
            <input type="hidden" name="x" value="${escapeHtml(defaultX)}"/>
            <input type="hidden" name="y" value="${escapeHtml(defaultY)}"/>
            <input type="hidden" name="resultId" value="${escapeHtml(options.preview.resultId)}"/>
            <input type="hidden" name="artifactId" value="${escapeHtml(options.preview.artifactId)}"/>
            <label>Save as question <input name="question" value="${escapeHtml(options.title ?? 'Analysis')}"/></label>
            <button type="submit">Save analysis</button>
            <a href="/dataset/${encodeURIComponent(dataset.datasetId)}/export?resultId=${encodeURIComponent(options.preview.resultId)}&amp;artifactId=${encodeURIComponent(options.preview.artifactId)}&amp;title=${encodeURIComponent(options.title ?? 'Analysis')}">Export HTML</a>
            · <a href="/dataset/${encodeURIComponent(dataset.datasetId)}/export.csv?resultId=${encodeURIComponent(options.preview.resultId)}">Export CSV</a>
            · <a href="/dataset/${encodeURIComponent(dataset.datasetId)}/export.specification.json?resultId=${encodeURIComponent(options.preview.resultId)}&amp;artifactId=${encodeURIComponent(options.preview.artifactId)}">Export specification</a>
            · <a href="/analyst/artifacts/${encodeURIComponent(options.preview.artifactId)}/download">Download SVG</a>
          </form>`
        : ''
    resultBlock = `${chart}${saveForm}<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  }
  const turnBudget =
    options.analystTurns !== undefined
      ? `<p class="meta">Analyst turns: <code>${escapeHtml(String(options.analystTurns))}</code> / 2 · remaining <code>${escapeHtml(String(options.turnsRemaining ?? 0))}</code></p>`
      : ''
  const defaultQuestion =
    options.question ??
    (dataset.datasetId === 'retail-fixture'
      ? 'revenue by region'
      : dataset.datasetId === 'superstore'
        ? 'sales by region'
        : '')
  return layout(
    dataset.datasetId,
    `<p><a href="/">← datasets</a> · <a href="/analyses">saved analyses</a> · <a href="/imports">imports</a></p>
    <h2>${escapeHtml(dataset.datasetId)}</h2>
    <p>Version <code>${escapeHtml(dataset.datasetVersionId)}</code>
    · semantics <code>${escapeHtml(dataset.semantics?.semanticRevisionId ?? 'none')}</code></p>
    ${err}${msg}${turnBudget}
    <form method="post" action="/dataset/${encodeURIComponent(dataset.datasetId)}/ask">
      <h2>Ask (NL → SQL)</h2>
      <p class="note">Default generator is fixture SQL (<code>DSH_NL_GENERATOR=fixture</code>).
      Set <code>DSH_NL_GENERATOR=echo</code> to keep the same fixture path until a model generator is plugged in.
      Core budget: ≤2 analyst turns per answerable thread.</p>
      <label>Question
        <input name="question" value="${escapeHtml(defaultQuestion)}" placeholder="revenue by region" required/>
      </label>
      <input type="hidden" name="priorTurns" value="${escapeHtml(String(options.analystTurns ?? 0))}"/>
      <button type="submit">Ask</button>
    </form>
    <form method="post" action="/dataset/${encodeURIComponent(dataset.datasetId)}/query">
      <label>SQL (policy-gated SELECT only)
        <textarea name="sql">${escapeHtml(defaultSql)}</textarea>
      </label>
      <label>Equality filter column (optional)
        <input name="filterColumn" value="${escapeHtml(options.filterColumn ?? '')}" placeholder="region"/>
      </label>
      <label>Equality filter value
        <input name="filterValue" value="${escapeHtml(options.filterValue ?? '')}" placeholder="West"/>
      </label>
      <label>Chart title <input name="title" value="${escapeHtml(options.title ?? 'Analysis')}"/></label>
      <label>X field <input name="x" value="${escapeHtml(defaultX)}"/></label>
      <label>Y field <input name="y" value="${escapeHtml(defaultY)}"/></label>
      <button type="submit">Run query + chart</button>
    </form>
    ${resultBlock}`,
  )
}

export function renderAnalysesPage(analyses: AnalysisRevision[]): string {
  const rows = analyses
    .map(
      (a) => `<tr>
      <td><a href="/analyses/${encodeURIComponent(a.analysisId)}"><code>${escapeHtml(a.analysisId)}</code></a></td>
      <td>r${a.revision}</td>
      <td>${escapeHtml(a.question)}</td>
      <td><code>${escapeHtml(a.datasetVersionId)}</code></td>
      <td>${escapeHtml(a.createdAt)}</td>
    </tr>`,
    )
    .join('')
  return layout(
    'Saved analyses',
    `<p><a href="/">← datasets</a></p>
     <h2>Saved analyses</h2>
     <table>
       <thead><tr><th>Id</th><th>Rev</th><th>Question</th><th>Dataset</th><th>Saved</th></tr></thead>
       <tbody>${rows || '<tr><td colspan="5">None yet — run a query and click Save analysis.</td></tr>'}</tbody>
     </table>`,
  )
}

export function renderAnalysisPage(
  analysis: AnalysisRevision,
  datasetId: string,
  options: {
    dashboards?: Dashboard[]
    feedback?: Feedback[]
    message?: string
    error?: string
  } = {},
): string {
  const artifact = analysis.artifactIds[0]
  const chart = artifact
    ? `<div class="chart"><img alt="chart" src="/analyst/artifacts/${encodeURIComponent(artifact)}.svg"/>
       <p>${artifactDownloadLinks(artifact)}
       · <a href="/dataset/${encodeURIComponent(datasetId)}/export?resultId=${encodeURIComponent(analysis.resultId)}&amp;artifactId=${encodeURIComponent(artifact)}&amp;title=${encodeURIComponent(analysis.question)}">Export HTML</a>
       · <a href="/dataset/${encodeURIComponent(datasetId)}/export.csv?resultId=${encodeURIComponent(analysis.resultId)}">Export CSV</a>
       · <a href="/dataset/${encodeURIComponent(datasetId)}/export.specification.json?resultId=${encodeURIComponent(analysis.resultId)}&amp;artifactId=${encodeURIComponent(artifact)}">Export specification</a>
       · <a href="/analyst/artifacts/${encodeURIComponent(artifact)}/download">Download SVG</a></p></div>`
    : ''
  const msg = options.message ? `<p class="ok">${escapeHtml(options.message)}</p>` : ''
  const err = options.error ? `<p class="err">${escapeHtml(options.error)}</p>` : ''
  const dashboardOptions = (options.dashboards ?? [])
    .map(
      (d) =>
        `<option value="${escapeHtml(d.dashboardId)}">${escapeHtml(d.title)} (${escapeHtml(d.dashboardId)})</option>`,
    )
    .join('')
  const pinForm =
    options.dashboards && options.dashboards.length > 0
      ? `<form method="post" action="/dashboard/${encodeURIComponent(options.dashboards[0]!.dashboardId)}/pin">
           <h2>Pin to dashboard</h2>
           <input type="hidden" name="analysisId" value="${escapeHtml(analysis.analysisId)}"/>
           <input type="hidden" name="revision" value="${analysis.revision}"/>
           <label>Dashboard
             <select name="dashboardId" onchange="this.form.action='/dashboard/'+encodeURIComponent(this.value)+'/pin'">
               ${dashboardOptions}
             </select>
           </label>
           <label>Card title <input name="title" value="${escapeHtml(analysis.question)}"/></label>
           <button type="submit">Pin analysis</button>
         </form>`
      : `<p class="note">Create a dashboard first, then pin this analysis from <a href="/dashboard">Dashboard</a>.</p>`
  const feedbackRows = (options.feedback ?? [])
    .map(
      (f) => `<tr>
        <td><code>${escapeHtml(f.feedbackId)}</code></td>
        <td>${escapeHtml(f.kind)}</td>
        <td>${escapeHtml(f.status)}</td>
        <td>${escapeHtml(f.comment)}</td>
        <td>${escapeHtml(f.createdAt)}</td>
      </tr>`,
    )
    .join('')
  const feedbackForm = `<form method="post" action="/analyses/${encodeURIComponent(analysis.analysisId)}/feedback">
      <h2>Submit feedback</h2>
      <label>Kind
        <select name="kind">
          <option value="vote">vote</option>
          <option value="preference">preference</option>
          <option value="sql-correction">sql-correction</option>
          <option value="semantic-correction">semantic-correction</option>
        </select>
      </label>
      <label>Comment <textarea name="comment" required></textarea></label>
      <button type="submit">Submit feedback</button>
    </form>
    <h2>Feedback history</h2>
    <table>
      <thead><tr><th>Id</th><th>Kind</th><th>Status</th><th>Comment</th><th>At</th></tr></thead>
      <tbody>${feedbackRows || '<tr><td colspan="5">No feedback yet.</td></tr>'}</tbody>
    </table>`
  return layout(
    analysis.analysisId,
    `<p><a href="/analyses">← saved analyses</a>
     · <a href="/dataset/${encodeURIComponent(datasetId)}">open dataset</a>
     · <a href="/dashboard">dashboard</a></p>
     <h2>${escapeHtml(analysis.question)}</h2>
     <p>Analysis <code>${escapeHtml(analysis.analysisId)}</code> revision ${analysis.revision}
     · dataset <code>${escapeHtml(analysis.datasetVersionId)}</code>
     · semantics <code>${escapeHtml(analysis.semanticRevisionId)}</code>
     · result <code>${escapeHtml(analysis.resultId)}</code></p>
     ${err}${msg}
     <h2>SQL</h2>
     <pre><code>${escapeHtml(analysis.query.sql)}</code></pre>
     ${chart}
     ${pinForm}
     ${feedbackForm}`,
  )
}

export function renderDashboardPage(
  dashboards: Dashboard[],
  cards: DashboardCardView[],
  options: { message?: string; error?: string; selectedId?: string } = {},
): string {
  const msg = options.message ? `<p class="ok">${escapeHtml(options.message)}</p>` : ''
  const err = options.error ? `<p class="err">${escapeHtml(options.error)}</p>` : ''
  const listRows = dashboards
    .map((d) => {
      const selected = d.dashboardId === options.selectedId ? ' (showing)' : ''
      return `<tr>
        <td><a href="/dashboard?id=${encodeURIComponent(d.dashboardId)}">${escapeHtml(d.title)}</a>${selected}</td>
        <td><code>${escapeHtml(d.dashboardId)}</code></td>
        <td>${d.layout.slots.length} cards</td>
        <td>${escapeHtml(d.updatedAt)}</td>
      </tr>`
    })
    .join('')
  const cardHtml = cards
    .map((card) => {
      const sharedNote =
        card.slot.sharedFilterKeys.length === 0
          ? `<p class="note">Shared filters unsupported for this card (no sharedFilterKeys mapped).</p>`
          : `<p>Shared filter keys: ${card.slot.sharedFilterKeys.map((k) => `<code>${escapeHtml(k)}</code>`).join(', ')}</p>`
      const chart = card.artifactId
        ? `<img alt="chart" src="/analyst/artifacts/${encodeURIComponent(card.artifactId)}.svg"/>`
        : '<p><em>No chart artifact</em></p>'
      const caption = card.analysis
        ? `<p><small>${escapeHtml(card.analysis.question)}</small></p>`
        : ''
      return `<article class="card">
        <h3>${escapeHtml(card.slot.title)}</h3>
        <p><a href="/analyses/${encodeURIComponent(card.slot.analysisId)}"><code>${escapeHtml(card.slot.analysisId)}</code></a> r${card.slot.revision}</p>
        ${chart}
        ${caption}
        ${sharedNote}
      </article>`
    })
    .join('')
  const filterForm =
    options.selectedId && cards.length > 0
      ? `<form method="post" action="/dashboard/${encodeURIComponent(options.selectedId)}/filter">
           <h2>Shared filter</h2>
           <p class="note">Re-queries every card that mapped the column; cards without a mapped key keep showing "Shared filters unsupported".</p>
           <label>Column <input name="column" required placeholder="region"/></label>
           <label>Value <input name="value" required placeholder="West"/></label>
           <button type="submit">Apply filter</button>
         </form>`
      : ''
  return layout(
    'Dashboard',
    `<p><a href="/">← datasets</a></p>
     <h2>Dashboards</h2>
     ${err}${msg}
     <form method="post" action="/dashboard/create">
       <label>New dashboard title <input name="title" required placeholder="Ops overview"/></label>
       <button type="submit">Create dashboard</button>
     </form>
     <table>
       <thead><tr><th>Title</th><th>Id</th><th>Slots</th><th>Updated</th></tr></thead>
       <tbody>${listRows || '<tr><td colspan="4">No dashboards yet.</td></tr>'}</tbody>
     </table>
     ${filterForm}
     <h2>Pinned cards</h2>
     <div class="grid">${cardHtml || '<p>Pin a saved analysis from its detail page or POST to <code>/dashboard/:id/pin</code>.</p>'}</div>`,
  )
}

export function renderAliasesPage(
  semantics: SemanticRevision[],
  candidates: SemanticAliasCandidate[],
  options: { message?: string; error?: string } = {},
): string {
  const msg = options.message ? `<p class="ok">${escapeHtml(options.message)}</p>` : ''
  const err = options.error ? `<p class="err">${escapeHtml(options.error)}</p>` : ''
  const currentRows = semantics
    .flatMap((revision) =>
      revision.aliases.map(
        (alias) => `<tr>
          <td>${escapeHtml(revision.datasetId)}</td>
          <td><code>${escapeHtml(revision.semanticRevisionId)}</code></td>
          <td>${escapeHtml(alias.term)}</td>
          <td><code>${escapeHtml(alias.expression)}</code></td>
          <td>${escapeHtml(alias.tableId)}</td>
          <td>${escapeHtml(alias.description)}</td>
        </tr>`,
      ),
    )
    .join('')
  const candidateRows = candidates
    .map(
      (c) => `<tr>
        <td><code>${escapeHtml(c.candidateId)}</code></td>
        <td>${escapeHtml(c.datasetId)}</td>
        <td>${escapeHtml(c.term)}</td>
        <td><code>${escapeHtml(c.expression)}</code></td>
        <td>${escapeHtml(c.status)}</td>
        <td>${escapeHtml(c.actorId)}</td>
        <td>
          <form method="post" action="/aliases/${encodeURIComponent(c.candidateId)}/status" class="actions" style="border:0;padding:0;margin:0;background:transparent">
            <input type="hidden" name="status" value="approved"/>
            <button type="submit">Approve</button>
          </form>
          <form method="post" action="/aliases/${encodeURIComponent(c.candidateId)}/status" class="actions" style="border:0;padding:0;margin:0;background:transparent">
            <input type="hidden" name="status" value="revoked"/>
            <button type="submit">Revoke</button>
          </form>
        </td>
      </tr>`,
    )
    .join('')
  return layout(
    'Feedback/Aliases',
    `<p><a href="/">← datasets</a></p>
     <h2>Current semantics aliases</h2>
     <p class="note">Runtime resolution uses in-code revisions plus <strong>approved</strong>
     SQLite alias overlays (<code>getEffectiveSemantics</code>). Candidate and revoked rows
     never apply. Approving still requires a human in this UI — it does not auto-mutate
     in-code SUPERSTORE_SEMANTICS constants.</p>
     ${err}${msg}
     <table>
       <thead><tr><th>Dataset</th><th>Revision</th><th>Term</th><th>Expression</th><th>Table</th><th>Description</th></tr></thead>
       <tbody>${currentRows || '<tr><td colspan="6">No current semantics.</td></tr>'}</tbody>
     </table>
     <h2>Propose alias candidate</h2>
     <form method="post" action="/aliases/propose">
       <label>Dataset id <input name="datasetId" value="superstore" required/></label>
       <label>Term <input name="term" required placeholder="margin"/></label>
       <label>Expression <input name="expression" required placeholder="SUM(profit)/NULLIF(SUM(sales),0)"/></label>
       <label>Description <input name="description" required/></label>
       <label>Table id <input name="tableId" value="orders" required/></label>
       <button type="submit">Propose candidate</button>
     </form>
     <h2>Alias candidates</h2>
     <table>
       <thead><tr><th>Id</th><th>Dataset</th><th>Term</th><th>Expression</th><th>Status</th><th>Actor</th><th>Review</th></tr></thead>
       <tbody>${candidateRows || '<tr><td colspan="7">No candidates yet.</td></tr>'}</tbody>
     </table>`,
  )
}

export function renderArtifactsPage(names: string[]): string {
  const list = names
    .map(
      (name) =>
        `<li><a href="/analyst/artifacts/${encodeURIComponent(name)}">${escapeHtml(name)}</a>
         · <a href="/analyst/artifacts/${encodeURIComponent(name.replace(/\.svg$/i, ''))}/download">download</a></li>`,
    )
    .join('')
  return layout(
    'Artifacts',
    `<p><a href="/">← datasets</a></p>
     <h2>Chart artifacts</h2>
     <ul>${list || '<li>None yet</li>'}</ul>`,
  )
}
