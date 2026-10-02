const dshDataVizClientModule = {
  // The registration id MUST be the package name (`dsh-data-analyst`), the
  // same entry the bundle patch inserts; a mismatched id is never materialized.
  id: 'dsh-data-analyst',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { createElement, useEffect, useState, useRef } = React

    const FETCH_PATH = '/api/analyst/artifacts'
    const ARTIFACT_ID_RE = /^art_[a-z0-9]+$/i
    const REPORT_DOWNLOAD_PATH =
      /^\/api\/analyst\/reports\?file=export_[a-f0-9]{32}(?:_(?:spec|analysis))?\.(?:html|svg|png|csv|json|zip)$/
    const inject = ['slots']
    let openStudio = null
    let openDashboard = null
    let openColumnReview = null
    let openImportReview = null
    const RESOURCE_VERSION_HEADER = 'X-Analyst-Resource-Version'

    /** Relative or loopback-absolute report download URLs only. */
    function isSafeReportDownloadUrl(url) {
      if (typeof url !== 'string' || url.length === 0) return false
      if (url.startsWith('/')) return REPORT_DOWNLOAD_PATH.test(url)
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
        const host = parsed.hostname
        if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false
        return REPORT_DOWNLOAD_PATH.test(`${parsed.pathname}${parsed.search}`)
      } catch {
        return false
      }
    }

    function analysisLabel(analysis) {
      const label = String(analysis.title?.trim() || analysis.question || 'Saved analysis')
        .replace(/\s+/g, ' ')
        .trim()
      return label.length > 100 ? `${label.slice(0, 99)}…` : label
    }

    /** Humanize a byte count for the archive file inventory. */
    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return 'unknown size'
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
      return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
    }

    /** Marks valid for a chart intent's encodings (mirrors server rechart.ts). */
    function allowedMarksForChart(chart, rowCount) {
      const marks = ['table']
      if (rowCount === 1) marks.push('kpi')
      if (chart && chart.x && chart.y) marks.push('bar', 'line', 'point', 'area')
      if (chart && chart.value) marks.push('heatmap')
      return marks
    }

    /** Reviewed column types an analyst may pick when revising a proposal. */
    const REVISABLE_TYPES = [
      'VARCHAR',
      'BOOLEAN',
      'BIGINT',
      'INTEGER',
      'DOUBLE',
      'DATE',
      'TIMESTAMP',
      'DECIMAL(18,2)',
      'DECIMAL(18,4)',
    ]

    /**
     * Mount a trusted, authenticated server fragment into a disposable
     * toolview-owned container. The server escapes untrusted values before
     * producing the fragment; keeping the response as HTML preserves its
     * fragment semantics without putting it into model context.
     */
    function readFormFields(form) {
      const fields = {}
      const elements = form.elements
      if (elements && typeof elements.length === 'number') {
        for (let i = 0; i < elements.length; i += 1) {
          const el = elements[i]
          if (el && typeof el.name === 'string' && el.name !== '') {
            fields[el.name] = String(el.value ?? '')
          }
        }
        return fields
      }
      if (typeof FormData !== 'undefined' && form && form.tagName === 'FORM') {
        for (const [key, value] of new FormData(form).entries()) {
          if (typeof value === 'string') fields[key] = value
        }
      }
      return fields
    }

    function resolveMutationUrl(form) {
      return form.getAttribute('data-analyst-url')
    }

    function buildMutationBody(action, fields, expectedVersion) {
      if (action === 'filter') {
        return {
          expectedVersion,
          dashboardId: fields.dashboardId,
          column: fields.column,
          value: fields.value,
        }
      }
      if (action === 'filter-clear') {
        return {
          expectedVersion,
          dashboardId: fields.dashboardId,
          operation: 'clear',
        }
      }
      if (action === 'map-keys') {
        const keys = String(fields.keys ?? '')
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
        return {
          expectedVersion,
          dashboardId: fields.dashboardId,
          analysisId: fields.analysisId,
          keys,
        }
      }
      if (action === 'pin') {
        return {
          expectedVersion,
          dashboardId: fields.dashboardId,
          analysisId: fields.analysisId,
        }
      }
      if (action === 'export' || action === 'export-dashboard') {
        const body = fields.dashboardId
          ? { dashboardId: fields.dashboardId }
          : { analysisId: fields.analysisId }
        if (action === 'export-dashboard') body.expectedVersion = expectedVersion
        if (fields.template) body.template = fields.template
        if (fields.expectedRevision) body.expectedRevision = Number(fields.expectedRevision)
        if (fields.title) body.title = fields.title
        return body
      }
      return null
    }

    /**
     * Event-delegate composition form submits on a fragment mount node.
     * Survives innerHTML replacement; POSTs JSON to `/api/analyst/ui/*`.
     */
    function ensureAnalystFragmentControls(container) {
      if (!container || typeof container.addEventListener !== 'function') return
      if (container.dataset.analystControlsBound === '1') return
      container.dataset.analystControlsBound = '1'
      container.addEventListener('submit', (event) => {
        const form = event.target
        if (!form || typeof form.getAttribute !== 'function') return undefined
        const action = form.getAttribute('data-analyst-action')
        if (!action) return undefined
        if (typeof event.preventDefault === 'function') event.preventDefault()
        const fields = readFormFields(form)
        const url = resolveMutationUrl(form)
        const expectedVersion = container.dataset.resourceVersion
        if (!url) return undefined
        if (action !== 'export' && action !== 'export-dashboard' && !expectedVersion)
          return undefined
        const body = buildMutationBody(action, fields, expectedVersion)
        if (!body) return undefined
        return fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(async (response) => {
          if (!(response.ok || response.status === 409)) {
            throw new Error(`Analyst fragment HTTP ${response.status}`)
          }
          const html = await response.text()
          const version = response.headers.get(RESOURCE_VERSION_HEADER)
          container.innerHTML = html
          if (version) container.dataset.resourceVersion = version
          if (response.ok && typeof container.dispatchEvent === 'function') {
            container.dispatchEvent(
              new CustomEvent(
                action === 'export' || action === 'export-dashboard'
                  ? 'analyst:export'
                  : 'analyst:mutation',
              ),
            )
          }
          return { html, version }
        })
      })
    }

    async function mountAnalystFragment(container, options) {
      const response = await fetch(options.url, {
        credentials: 'same-origin',
        signal: options.signal,
      })
      if (!response.ok) throw new Error(`Analyst fragment HTTP ${response.status}`)
      const html = await response.text()
      const version = response.headers.get(RESOURCE_VERSION_HEADER)
      container.innerHTML = html
      if (version) container.dataset.resourceVersion = version
      ensureAnalystFragmentControls(container)
      return { html, version }
    }

    function parseArtifactId(text) {
      const trimmed = String(text ?? '').trim()
      if (ARTIFACT_ID_RE.test(trimmed)) return trimmed
      // `make_chart` renders a delimited `<<observe kind=chart>>` payload; parse
      // it the same way the other toolviews do (raw JSON also accepted).
      const parsed = parseObservePayload(trimmed)
      const id = parsed && parsed.artifactId
      if (typeof id === 'string' && ARTIFACT_ID_RE.test(id)) return id
      return null
    }

    function resultText(block) {
      if (!('kind' in block)) return null
      const parts = []
      for (const item of block.content ?? []) {
        parts.push(item.type === 'text' ? item.text : '')
      }
      return parts.join('\n') || null
    }

    /**
     * Extract the redacted message from an errored tool block. Analyst tool
     * errors render as an `<<observe kind=error>>` document (optionally
     * prefixed with `Error: ` by dsh-tools); parse the bounded `message`
     * field and fall back to the raw text when the shape differs.
     */
    function errorText(block) {
      const output = resultText(block)
      if (!output) return null
      const match = output.match(/<<observe kind=error>>\s*([\s\S]*?)\s*<<\/observe>>/)
      if (match) {
        try {
          const parsed = JSON.parse(match[1])
          if (typeof parsed.message === 'string' && parsed.message !== '') return parsed.message
        } catch {
          /* fall through to the raw text */
        }
      }
      return output.trim() || null
    }

    function intentTitle(block) {
      const raw = 'kind' in block ? (block.call?.argsRaw ?? '') : (block.argsRaw ?? '')
      try {
        const parsed = JSON.parse(raw)
        const title = parsed?.intent?.title
        if (typeof title === 'string' && title !== '') return title
      } catch {
        /* keep fallback */
      }
      return 'Chart'
    }

    function ChartToolRow(props) {
      const block = props.block
      const settled = 'kind' in block
      const output = resultText(block)
      const artifactId = output ? parseArtifactId(output) : null
      const title = intentTitle(block)
      const failed = settled && block.isError
      const [src, setSrc] = useState(null)
      const [error, setError] = useState(null)

      useEffect(() => {
        if (!artifactId || failed) {
          setSrc(null)
          return undefined
        }
        const controller = new AbortController()
        let objectUrl = null
        const url = `${FETCH_PATH}?id=${encodeURIComponent(artifactId)}&format=svg`
        fetch(url, { credentials: 'same-origin', signal: controller.signal })
          .then(async (response) => {
            if (!response.ok) throw new Error(`Chart artifact HTTP ${response.status}`)
            return response.blob()
          })
          .then((blob) => {
            objectUrl = URL.createObjectURL(blob)
            setSrc(objectUrl)
            setError(null)
          })
          .catch((err) => {
            if (controller.signal.aborted) return
            setError(err instanceof Error ? err.message : String(err))
            setSrc(null)
          })
        return () => {
          controller.abort()
          if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
      }, [artifactId, failed])

      const summary = !settled
        ? 'Rendering chart'
        : failed
          ? 'Chart failed'
          : artifactId
            ? title
            : 'Chart created'
      const download = (format) =>
        artifactId
          ? `${FETCH_PATH}?id=${encodeURIComponent(artifactId)}&format=${format}&download=1`
          : null

      return createElement(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            minWidth: 0,
          },
        },
        createElement(
          'div',
          {
            style: {
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 14,
              lineHeight: '24px',
            },
          },
          summary,
        ),
        src
          ? createElement('img', {
              src,
              alt: title,
              style: { maxWidth: '100%', height: 'auto', display: 'block' },
            })
          : null,
        error
          ? createElement(
              'div',
              {
                style: {
                  color: 'var(--dsw-alias-state-error-primary)',
                  fontSize: 13,
                },
              },
              error,
            )
          : null,
        artifactId && !failed
          ? createElement(
              'p',
              {
                style: {
                  margin: 0,
                  fontSize: 12,
                  color: 'var(--dsw-alias-label-tertiary)',
                },
              },
              createElement('a', { href: download('svg') }, 'Download SVG'),
              ' · ',
              createElement('a', { href: download('png') }, 'Download PNG'),
            )
          : null,
      )
    }

    /**
     * `get_schema` (and other `catalog`/`schema`-kind tools) render their
     * model observation as `<<observe kind=...>>\n{...}\n<</observe>>` (see
     * `renderObserve` in dsh-data-core). Strip the delimiters when present
     * so the toolview can parse the same bounded JSON the model sees —
     * no extra fetch, matching `ChartToolRow`'s "data is in the tool
     * result" pattern.
     */
    function parseObservePayload(text) {
      if (text == null) return null
      const trimmed = String(text).trim()
      const match = trimmed.match(/^<<observe kind=\w+>>\n([\s\S]*)\n<<\/observe>>$/)
      try {
        return JSON.parse(match ? match[1] : trimmed)
      } catch {
        return null
      }
    }

    function SchemaToolRow({ block }) {
      const output = resultText(block)
      const schema = parseObservePayload(output)
      const failed = 'kind' in block && block.isError

      if (failed) {
        return createElement('p', { role: 'alert' }, 'Schema lookup failed')
      }
      if (!schema) {
        return createElement('p', null, 'Loading schema')
      }

      const tables = Array.isArray(schema.tables) ? schema.tables : []
      const relationships = Array.isArray(schema.relationships) ? schema.relationships : []
      // `aliases` here is always the analyst-approved overlay
      // (`getEffectiveSemantics`) — candidate/pending terms never reach this
      // slice, so nothing here needs a client-side approval filter.
      const aliases = Array.isArray(schema.aliases) ? schema.aliases : []
      // Reviewed date/currency notes (see metric-rules.ts) — read-only,
      // shown for analyst context alongside the measures they inform.
      const rules = Array.isArray(schema.rules) ? schema.rules : []

      const grainLabel = (grain) =>
        grain ? `${grain.grainDescription} (PK: ${(grain.primaryKey ?? []).join(', ')})` : '—'
      const columnsLabel = (columns) =>
        (columns ?? []).map((column) => `${column.name}: ${column.type}`).join(', ')

      return createElement(
        'section',
        { 'aria-label': 'Dataset schema' },
        createElement('strong', null, schema.datasetId ? `Schema: ${schema.datasetId}` : 'Schema'),
        createElement(
          'table',
          null,
          createElement(
            'thead',
            null,
            createElement(
              'tr',
              null,
              createElement('th', null, 'Table'),
              createElement('th', null, 'Grain'),
              createElement('th', null, 'Columns'),
            ),
          ),
          createElement(
            'tbody',
            null,
            ...tables.map((table) =>
              createElement(
                'tr',
                { key: table.id },
                createElement('td', null, table.id),
                createElement('td', null, grainLabel(table.grain)),
                createElement('td', null, columnsLabel(table.columns)),
              ),
            ),
          ),
        ),
        createElement('strong', null, 'Relationships'),
        relationships.length
          ? createElement(
              'ul',
              null,
              ...relationships.map((rel, index) =>
                createElement(
                  'li',
                  { key: index },
                  `${rel.fromTable}(${(rel.fromColumns ?? []).join(', ')}) → ` +
                    `${rel.toTable}(${(rel.toColumns ?? []).join(', ')}) [${rel.cardinality}]`,
                ),
              ),
            )
          : createElement('p', null, 'No modeled relationships'),
        createElement('strong', null, 'Approved measures'),
        aliases.length
          ? createElement(
              'ul',
              null,
              ...aliases.map((alias) =>
                createElement(
                  'li',
                  { key: alias.term },
                  `${alias.term}: ${alias.expression} (${alias.tableId})`,
                ),
              ),
            )
          : createElement('p', null, 'No approved measures yet'),
        createElement('strong', null, 'Metric rules'),
        rules.length
          ? createElement(
              'ul',
              null,
              ...rules.map((rule, index) =>
                createElement(
                  'li',
                  { key: index },
                  `${rule.tableId}.${rule.column} (${rule.kind}): ${rule.note}`,
                ),
              ),
            )
          : createElement('p', null, 'No reviewed metric rules'),
      )
    }

    /**
     * One-click display refinement: switch the mark of a saved analysis,
     * reusing its result (the rechart route never re-queries). Only marks valid
     * for the existing encodings are offered; the result becomes a new artifact.
     */
    function MarkSwitcher({ analysis, onSaved }) {
      const initialChart =
        analysis && analysis.chart && typeof analysis.chart === 'object' ? analysis.chart : {}
      const [chart, setChart] = useState(initialChart)
      const [revision, setRevision] = useState(analysis?.revision)
      const marks = allowedMarksForChart(chart, analysis.rowCount)
      const [artifactId, setArtifactId] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      const rechart = (mark) => {
        if (
          busy ||
          typeof analysis?.analysisId !== 'string' ||
          !Number.isInteger(revision) ||
          revision < 1
        )
          return
        setBusy(true)
        setError(null)
        fetch('/api/analyst/charts/rechart', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            analysisId: analysis.analysisId,
            expectedRevision: revision,
            mark,
          }),
        })
          .then(async (response) => {
            const value = await response.json()
            if (!response.ok) throw new Error(value.error || `Rechart HTTP ${response.status}`)
            setArtifactId(value.artifactId)
            setChart(value.chart)
            setRevision(value.revision)
            if (typeof onSaved === 'function') onSaved(value)
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false))
      }

      if (marks.length <= 1) return null

      return createElement(
        'div',
        { style: { marginTop: '0.5rem' } },
        createElement('span', null, 'Display as: '),
        ...marks.map((mark) =>
          createElement(
            'button',
            {
              type: 'button',
              key: mark,
              disabled: busy || mark === chart.mark,
              onClick: () => rechart(mark),
            },
            mark,
          ),
        ),
        artifactId
          ? createElement('img', {
              src: `${FETCH_PATH}?id=${encodeURIComponent(artifactId)}&format=svg`,
              alt: 'Refined chart',
              style: { maxWidth: '100%', height: 'auto', display: 'block', marginTop: '0.5rem' },
            })
          : null,
        error ? createElement('p', { role: 'alert' }, error) : null,
      )
    }

    function AnalysisToolRow({ block }) {
      const output = resultText(block)
      const analysis = parseObservePayload(output)
      const failed = 'kind' in block && block.isError
      const [savedRevision, setSavedRevision] = useState(analysis?.revision)

      if (failed) {
        return createElement('p', { role: 'alert' }, 'Analysis lookup failed')
      }
      if (!analysis) {
        return createElement('p', null, 'Loading analysis')
      }
      const sql = typeof analysis.sql === 'string' ? analysis.sql : ''
      const question =
        typeof analysis.question === 'string' && analysis.question !== ''
          ? analysis.question
          : 'Saved analysis'
      if (typeof analysis.analysisId === 'string') {
        return createElement(
          'section',
          { 'aria-label': 'Saved analysis SQL' },
          createElement(FragmentToolRow, {
            url: `/api/analyst/ui/analysis?analysisId=${encodeURIComponent(analysis.analysisId)}`,
            label: 'Analysis composition',
            refreshKey: savedRevision,
          }),
          createElement(
            'button',
            { type: 'button', onClick: () => openStudio?.(analysis.analysisId) },
            'Open in Analysis Studio',
          ),
          createElement('strong', null, question),
          sql
            ? createElement('pre', { style: { whiteSpace: 'pre-wrap' } }, sql)
            : createElement('p', null, 'No SQL stored for this revision'),
          createElement(
            'p',
            {
              style: {
                margin: 0,
                fontSize: 12,
                color: 'var(--dsw-alias-label-tertiary)',
              },
            },
            'Disagree? Propose a correction',
          ),
          createElement(MarkSwitcher, {
            analysis,
            onSaved: (saved) => setSavedRevision(saved.revision),
          }),
        )
      }

      return createElement(
        'section',
        { 'aria-label': 'Saved analysis SQL' },
        createElement('strong', null, question),
        sql
          ? createElement('pre', { style: { whiteSpace: 'pre-wrap' } }, sql)
          : createElement('p', null, 'No SQL stored for this revision'),
        createElement(
          'p',
          {
            style: {
              margin: 0,
              fontSize: 12,
              color: 'var(--dsw-alias-label-tertiary)',
            },
          },
          'Disagree? Propose a correction',
        ),
      )
    }

    function DashboardToolRow({ block }) {
      const dashboard = parseObservePayload(resultText(block))
      if (block.isError) return createElement('p', { role: 'alert' }, 'Dashboard lookup failed')
      if (!dashboard) return createElement('p', null, 'Loading dashboard')
      if (
        typeof dashboard.dashboardId !== 'string' ||
        !/^dash_[a-z0-9]+$/i.test(dashboard.dashboardId)
      )
        return createElement('p', { role: 'alert' }, 'Dashboard reference unavailable')
      const count =
        Array.isArray(dashboard.slots) && !dashboard.warnings?.includes('truncated')
          ? dashboard.slots.length
          : null
      return createElement(
        'section',
        {
          'aria-label': 'Saved dashboard',
          style: {
            padding: 14,
            margin: '10px 0',
            border: '1px solid var(--dsw-alias-border-l3,#ccc)',
            borderRadius: 8,
            display: 'grid',
            gap: 10,
            fontSize: 14,
            lineHeight: 1.5,
          },
        },
        createElement(
          'strong',
          null,
          analysisLabel({ title: dashboard.title, question: 'Saved dashboard' }),
        ),
        count !== null
          ? createElement(
              'p',
              { style: { margin: 0 } },
              `${count} pinned view${count === 1 ? '' : 's'}${dashboard.archived ? ' · Archived' : ''}`,
            )
          : null,
        createElement(
          'button',
          {
            type: 'button',
            onClick: () => openDashboard?.(dashboard.dashboardId),
            style: { width: 'fit-content', padding: '6px 10px' },
          },
          'Open dashboard in Studio',
        ),
      )
    }

    function PersistedActionToolRow({ block }) {
      const receipt = parseObservePayload(resultText(block))
      if (block.isError) {
        return createElement('p', { role: 'alert' }, 'Save did not complete')
      }
      if (!receipt) return createElement('p', null, 'Loading save result')
      const isAnalysis = Number.isInteger(receipt.revision)
      const slotCount = Number.isInteger(receipt.slotCount) ? receipt.slotCount : null
      const verified = receipt.persisted === true
      return createElement(
        'section',
        {
          'aria-label': 'Persisted action receipt',
          className: 'analyst-action-receipt',
          style: {
            padding: 12,
            margin: '10px 0',
            border: '1px solid var(--dsw-alias-border-l3,#ccc)',
            borderRadius: 8,
            display: 'grid',
            gap: 8,
            fontSize: 14,
          },
        },
        createElement(
          'strong',
          null,
          verified
            ? isAnalysis
              ? 'Analysis saved'
              : 'Dashboard saved'
            : isAnalysis
              ? 'Saved analysis'
              : 'Saved dashboard',
        ),
        createElement(
          'p',
          { role: 'status', style: { margin: 0 } },
          verified
            ? isAnalysis
              ? `Persisted revision ${receipt.revision}`
              : slotCount == null
                ? 'Persisted dashboard'
                : `${slotCount} pinned view${slotCount === 1 ? '' : 's'}`
            : 'Persistence receipt unavailable for this earlier action',
        ),
        typeof receipt.analysisId === 'string' && /^ana_[a-z0-9]+$/i.test(receipt.analysisId)
          ? createElement(
              'button',
              { type: 'button', onClick: () => openStudio?.(receipt.analysisId) },
              'Open analysis in Studio',
            )
          : typeof receipt.dashboardId === 'string' && /^dash_[a-z0-9]+$/i.test(receipt.dashboardId)
            ? createElement(
                'button',
                { type: 'button', onClick: () => openDashboard?.(receipt.dashboardId) },
                'Open dashboard in Studio',
              )
            : null,
      )
    }

    function FragmentToolRow({ url, label, refreshKey, disabled, onMutation, onExport }) {
      let container = null
      const [error, setError] = useState(null)
      useEffect(() => {
        if (!container) return undefined
        const controller = new AbortController()
        mountAnalystFragment(container, { url, signal: controller.signal }).catch((err) => {
          if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
        })
        if (onMutation) container.addEventListener('analyst:mutation', onMutation)
        if (onExport) container.addEventListener('analyst:export', onExport)
        const mountedContainer = container
        return () => {
          controller.abort()
          if (onMutation) mountedContainer.removeEventListener('analyst:mutation', onMutation)
          if (onExport) mountedContainer.removeEventListener('analyst:export', onExport)
        }
      }, [url, refreshKey])
      return createElement(
        'fieldset',
        { 'aria-label': label, disabled, style: { border: 0, padding: 0, margin: 0, minWidth: 0 } },
        disabled
          ? createElement(
              'p',
              { role: 'status' },
              'Save or discard the layout draft before filtering or exporting the saved dashboard.',
            )
          : null,
        createElement('div', {
          ref: (node) => {
            container = node
          },
          className: 'analyst-fragment-mount',
        }),
        error ? createElement('p', { role: 'alert' }, error) : null,
      )
    }

    function ReportToolRow({ block }) {
      const parsed = parseObservePayload(resultText(block)) || {}
      const safeDownloads = Object.entries(parsed.downloads || {}).filter(([, url]) =>
        isSafeReportDownloadUrl(url),
      )
      const htmlCandidate = safeDownloads.find(([, url]) => url.endsWith('.html'))?.[1]
      const html = htmlCandidate
      const analysisId =
        typeof parsed.analysisId === 'string' && /^ana_[a-z0-9]+$/i.test(parsed.analysisId)
          ? parsed.analysisId
          : null
      const dashboardId =
        typeof parsed.dashboardId === 'string' && /^dash_[a-z0-9]+$/i.test(parsed.dashboardId)
          ? parsed.dashboardId
          : null
      return createElement(
        'section',
        {
          'aria-label': 'Report downloads',
          className: 'analyst-report-card',
          style: {
            padding: 18,
            margin: '10px 0',
            border: '1px solid var(--dsw-alias-border-l3,#ccc)',
            borderRadius: 8,
            display: 'grid',
            gap: 10,
            fontSize: 14,
            lineHeight: 1.5,
          },
        },
        createElement(
          'strong',
          null,
          block.isError
            ? 'Report export failed'
            : parsed.ready === true && html
              ? 'Report ready'
              : html
                ? 'Saved report'
                : 'Report downloads unavailable',
        ),
        html
          ? createElement(
              'a',
              {
                href: `${html}&preview=1`,
                rel: 'noopener noreferrer',
                style: {
                  fontWeight: 600,
                  width: 'fit-content',
                  padding: '8px 12px',
                  border: '1px solid currentColor',
                  borderRadius: 5,
                },
              },
              'Open report',
            )
          : null,
        html
          ? createElement(
              'p',
              { style: { margin: 0 } },
              'Read-only snapshot of the saved analysis. Filters and source details travel with the report.',
            )
          : null,
        safeDownloads.length
          ? createElement(
              'details',
              null,
              createElement('summary', { style: { cursor: 'pointer' } }, 'Offline downloads'),
              createElement(
                'ul',
                { style: { margin: '8px 0', paddingLeft: 20 } },
                ...safeDownloads.map(([format, url]) =>
                  createElement(
                    'li',
                    { key: format, style: { margin: '5px 0' } },
                    createElement(
                      'a',
                      { href: url, download: true },
                      `Download ${format.toUpperCase()}`,
                    ),
                  ),
                ),
              ),
            )
          : null,
        analysisId || dashboardId
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: () =>
                  dashboardId ? openDashboard?.(dashboardId) : openStudio?.(analysisId),
                style: { width: 'fit-content', padding: '6px 10px' },
              },
              dashboardId ? 'Open dashboard in Studio' : 'Open analysis in Studio',
            )
          : null,
      )
    }

    function AliasProposalToolRow({ block, onReviewed }) {
      const output = resultText(block)
      let proposal = null
      try {
        proposal = parseObservePayload(output)
      } catch {
        /* pending */
      }
      const [status, setStatus] = useState(proposal?.status ?? 'candidate')
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      useEffect(() => setStatus(proposal?.status ?? 'candidate'), [proposal?.status])

      const review = (nextStatus) => {
        if (!proposal?.proposalId || busy) return
        setBusy(true)
        setError(null)
        fetch('/api/analyst/aliases/review', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ candidateId: proposal.proposalId, status: nextStatus }),
        })
          .then(async (response) => {
            const value = await response.json()
            if (!response.ok) throw new Error(value.error || `Review HTTP ${response.status}`)
            setStatus(value.status)
            onReviewed?.({ kind: 'semantic', status: value.status })
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false))
      }

      if (!proposal)
        return createElement('p', null, block.isError ? 'Proposal failed' : 'Saving proposal')
      return createElement(
        'section',
        { 'aria-label': 'Semantic definition review' },
        createElement('strong', null, `Review “${proposal.term}”`),
        createElement('p', null, `${proposal.expression} on ${proposal.tableId}`),
        createElement('p', null, proposal.description),
        createElement('p', null, `Units: ${proposal.units || 'Not specified'}`),
        createElement(
          'p',
          null,
          `Population rule: ${proposal.inclusion || 'No inclusion/exclusion rule specified'}`,
        ),
        proposal.dateColumn ? createElement('p', null, `Time field: ${proposal.dateColumn}`) : null,
        createElement('p', null, `Status: ${status}`),
        status === 'candidate'
          ? createElement(
              'div',
              null,
              createElement(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => review('approved'),
                  className: 'studio-approve',
                },
                busy ? 'Saving…' : 'Approve definition',
              ),
              ' ',
              createElement(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => review('revoked'),
                  className: 'studio-reject',
                },
                'Reject definition',
              ),
            )
          : null,
        error ? createElement('p', { role: 'alert' }, error) : null,
      )
    }

    /**
     * Batch review for `list_pending_metrics`: every candidate shows its
     * formula and table scope with a checkbox, plus Approve/Reject selected
     * buttons that POST the selected ids to the same-origin batch route.
     */
    function AliasBatchToolRow({ block }) {
      const output = resultText(block)
      const payload = parseObservePayload(output)
      const candidates = Array.isArray(payload?.candidates) ? payload.candidates : []
      const failed = 'kind' in block && block.isError

      const [selected, setSelected] = useState({})
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [reviewedCount, setReviewedCount] = useState(null)

      const toggle = (id) => setSelected((previous) => ({ ...previous, [id]: !previous[id] }))
      const selectedIds = candidates
        .filter((c) => selected[c.candidateId])
        .map((c) => c.candidateId)

      const review = (status) => {
        if (selectedIds.length === 0 || busy) return
        setBusy(true)
        setError(null)
        fetch('/api/analyst/aliases/review-batch', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ candidateIds: selectedIds, status }),
        })
          .then(async (response) => {
            const value = await response.json()
            if (!response.ok) throw new Error(value.error || `Review HTTP ${response.status}`)
            setReviewedCount(value.reviewed.length)
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false))
      }

      if (failed) {
        return createElement('p', { role: 'alert' }, 'Metric list failed')
      }
      if (!payload) {
        return createElement('p', null, 'Loading metric definitions')
      }
      if (candidates.length === 0) {
        return createElement('p', null, 'No pending metric definitions')
      }

      return createElement(
        'section',
        { 'aria-label': 'Metric definitions review' },
        createElement('strong', null, 'Review metric definitions'),
        ...candidates.map((candidate) =>
          createElement(
            'div',
            { key: candidate.candidateId, style: { margin: '0.25rem 0' } },
            createElement(
              'label',
              null,
              createElement('input', {
                type: 'checkbox',
                checked: Boolean(selected[candidate.candidateId]),
                onChange: () => toggle(candidate.candidateId),
              }),
              ` ${candidate.term} = ${candidate.expression} (${candidate.tableId})`,
            ),
            candidate.description
              ? createElement(
                  'p',
                  { style: { margin: '0 0 0 1.4rem', fontSize: 12 } },
                  candidate.description,
                )
              : null,
          ),
        ),
        createElement(
          'div',
          { style: { marginTop: '0.5rem' } },
          createElement(
            'button',
            {
              type: 'button',
              disabled: busy || selectedIds.length === 0,
              onClick: () => review('approved'),
              className: 'studio-approve',
            },
            busy ? 'Saving…' : 'Approve selected',
          ),
          ' ',
          createElement(
            'button',
            {
              type: 'button',
              disabled: busy || selectedIds.length === 0,
              onClick: () => review('revoked'),
              className: 'studio-reject',
            },
            'Reject selected',
          ),
        ),
        reviewedCount !== null
          ? createElement('p', null, `Reviewed ${reviewedCount} definition(s)`)
          : null,
        error ? createElement('p', { role: 'alert' }, error) : null,
      )
    }

    /**
     * `list_pending_structure` (Stage 2b) renders grain/relationship
     * candidates awaiting analyst approval. Each candidate gets its own
     * Approve/Reject pair posting to the same-origin
     * `/api/analyst/structure/review` route (never a model tool).
     */
    function StructureReviewToolRow({ block, onReviewed }) {
      const output = resultText(block)
      const payload = parseObservePayload(output)
      const candidates = Array.isArray(payload?.candidates) ? payload.candidates : []
      const failed = 'kind' in block && block.isError

      const [statuses, setStatuses] = useState({})
      const [busy, setBusy] = useState({})
      const [error, setError] = useState(null)

      const review = (candidateId, status) => {
        if (busy[candidateId]) return
        setBusy((previous) => ({ ...previous, [candidateId]: true }))
        setError(null)
        fetch('/api/analyst/structure/review', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ candidateId, status }),
        })
          .then(async (response) => {
            const value = await response.json()
            if (!response.ok) throw new Error(value.error || `Review HTTP ${response.status}`)
            setStatuses((previous) => ({ ...previous, [candidateId]: value.status }))
            onReviewed?.({ kind: 'structure', status: value.status })
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy((previous) => ({ ...previous, [candidateId]: false })))
      }

      if (failed) return createElement('p', { role: 'alert' }, 'Structure review failed')
      if (!payload) return createElement('p', null, 'Loading structure candidates')
      if (candidates.length === 0) {
        return createElement('p', null, 'No pending structure candidates')
      }

      return createElement(
        'section',
        { 'aria-label': 'Grain and relationship review' },
        createElement('strong', null, 'Review structure candidates'),
        ...candidates.map((candidate) => {
          const reviewed = statuses[candidate.candidateId]
          const isBusy = busy[candidate.candidateId]
          const isGrain = typeof candidate.tableId === 'string'
          const label = isGrain
            ? `Grain: ${candidate.tableId} (${(candidate.primaryKey ?? []).join(', ')}) — ${candidate.grainDescription ?? ''}`
            : `Relationship: ${candidate.fromTable} → ${candidate.toTable} (${candidate.cardinality ?? 'n:n'})`
          const reason =
            candidate.evidence && typeof candidate.evidence.reason === 'string'
              ? candidate.evidence.reason
              : ''
          return createElement(
            'div',
            { key: candidate.candidateId, style: { margin: '0.35rem 0' } },
            createElement('span', null, label),
            reason
              ? createElement('p', { style: { margin: '0 0 0 1.4rem', fontSize: 12 } }, reason)
              : null,
            reviewed
              ? createElement('span', { style: { marginLeft: '0.5rem' } }, `(${reviewed})`)
              : createElement(
                  'span',
                  { style: { marginLeft: '0.5rem' } },
                  createElement(
                    'button',
                    {
                      type: 'button',
                      disabled: isBusy,
                      onClick: () => review(candidate.candidateId, 'approved'),
                      className: 'studio-approve',
                    },
                    isBusy ? 'Saving…' : 'Approve',
                  ),
                  ' ',
                  createElement(
                    'button',
                    {
                      type: 'button',
                      disabled: isBusy,
                      onClick: () => review(candidate.candidateId, 'revoked'),
                      className: 'studio-reject',
                    },
                    'Reject',
                  ),
                ),
          )
        }),
        error ? createElement('p', { role: 'alert' }, error) : null,
      )
    }

    function SqlCorrectionToolRow({ block }) {
      const output = resultText(block)
      let proposal = null
      try {
        proposal = parseObservePayload(output)
      } catch {
        /* pending */
      }
      const [status, setStatus] = useState(proposal?.status ?? 'candidate')
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      useEffect(() => setStatus(proposal?.status ?? 'candidate'), [proposal?.status])
      const review = (nextStatus) => {
        if (!proposal?.proposalId || busy) return
        setBusy(true)
        setError(null)
        fetch('/api/analyst/learning/review', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ exampleId: proposal.proposalId, status: nextStatus }),
        })
          .then(async (response) => {
            const value = await response.json()
            if (!response.ok) throw new Error(value.error || `Review HTTP ${response.status}`)
            setStatus(value.status)
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false))
      }
      if (!proposal)
        return createElement('p', null, block.isError ? 'Correction failed' : 'Saving correction')
      return createElement(
        'section',
        { 'aria-label': 'SQL correction review' },
        createElement('strong', null, 'Review SQL correction'),
        createElement('p', null, proposal.question),
        createElement('pre', { style: { whiteSpace: 'pre-wrap' } }, proposal.correctedSql),
        createElement('p', null, `Status: ${status}`),
        status === 'candidate'
          ? createElement(
              'div',
              null,
              createElement(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => review('approved'),
                  className: 'studio-approve',
                },
                busy ? 'Saving…' : 'Approve correction',
              ),
              ' ',
              createElement(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => review('revoked'),
                  className: 'studio-reject',
                },
                'Reject correction',
              ),
            )
          : null,
        error ? createElement('p', { role: 'alert' }, error) : null,
      )
    }

    /**
     * `preview_ingest_source` (Task 10) renders its model observation as
     * `<<observe kind=catalog>>\n{...}\n<</observe>>`, same as `get_schema`/
     * `get_analysis` — parsed with the shared `parseObservePayload`. The
     * analyst approval action itself is the same-origin
     * `/api/analyst/ingest-recipes/review` route (never a model tool), same
     * pattern as `AliasProposalToolRow` / `SqlCorrectionToolRow`.
     */
    /**
     * Analyst revision of column types on a candidate proposal (Finding 5).
     * Posts only changed columns to the same-origin
     * `/api/analyst/ingest-recipes/revise` route; the parent reloads the
     * revised tables on success.
     */
    /**
     * Publisher-supplied Kaggle text reaches this pane in two shapes: the
     * *stored* block from the authenticated recipe route (`description.text`,
     * `columnDictionary`) and the bounded model-observation projection
     * (`descriptionExcerpt`, `columnNotes`). Both are quoted publisher wording,
     * labelled `publisher-supplied`/`unverified` per entry. These helpers let
     * the review render whichever shape it has without inventing a third one.
     * Publisher text is only ever rendered as text: it is never merged into a
     * proposed storage type, an observed evidence string, or an
     * analyst-approved definition.
     */
    function publisherNotesOf(publisherSupplied) {
      if (!publisherSupplied) return []
      const notes = Array.isArray(publisherSupplied.columnNotes)
        ? publisherSupplied.columnNotes
        : Array.isArray(publisherSupplied.columnDictionary)
          ? publisherSupplied.columnDictionary
          : []
      return notes.filter(
        (note) =>
          note &&
          typeof note.column === 'string' &&
          typeof note.note === 'string' &&
          note.note.length > 0,
      )
    }

    function publisherDescriptionOf(publisherSupplied) {
      if (!publisherSupplied) return null
      const description = publisherSupplied.description || null
      const text =
        typeof publisherSupplied.descriptionExcerpt === 'string'
          ? publisherSupplied.descriptionExcerpt
          : description && typeof description.text === 'string'
            ? description.text
            : ''
      if (!text) return null
      return {
        text,
        truncated: Boolean(
          publisherSupplied.descriptionTruncated || (description && description.truncated),
        ),
        chars:
          typeof publisherSupplied.descriptionChars === 'number'
            ? publisherSupplied.descriptionChars
            : description && typeof description.sourceLength === 'number'
              ? description.sourceLength
              : text.length,
      }
    }

    /** Case/punctuation-insensitive column key, so `Order ID` matches `order_id`. */
    function publisherColumnKey(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
    }

    /**
     * Publisher notes to show against one proposed column. Matched on the
     * publisher's own label versus the proposed name and its original source
     * label; when the note was attributed from the publisher's own markdown
     * heading it is restricted to that table.
     */
    function publisherNotesForColumn(publisherSupplied, tableId, column) {
      const keys = [column.name, column.sourceName]
        .filter(Boolean)
        .map((name) => publisherColumnKey(name))
        .filter((key) => key.length > 0)
      if (keys.length === 0) return []
      return publisherNotesOf(publisherSupplied).filter((note) => {
        if (note.tableId && note.tableId !== tableId) return false
        return keys.includes(publisherColumnKey(note.column))
      })
    }

    /** Publisher notes that match no proposed column at all — still shown, never dropped. */
    function unmatchedPublisherNotes(publisherSupplied, tables) {
      const notes = publisherNotesOf(publisherSupplied)
      if (notes.length === 0) return []
      const matched = new Set()
      for (const table of tables || []) {
        for (const column of table.columns || []) {
          for (const note of publisherNotesForColumn(publisherSupplied, table.tableId, column)) {
            matched.add(note)
          }
        }
      }
      return notes.filter((note) => !matched.has(note))
    }

    function TypeEditor({
      pinId,
      tables,
      publisherSupplied = null,
      expectedRevision,
      sourceVersion,
      sessionId,
      onRevised,
      onDirty,
      onReady,
      onReload,
      locked = false,
    }) {
      /**
       * Date formats the analyst can choose when a source's day/month order is
       * ambiguous. Values are strptime patterns the ingest loader already validates;
       * '' means no format, which keeps those values as text instead of casting every
       * one of them to NULL.
       */
      // With no format chosen the loader still tries a plain cast, so an ISO date
      // still becomes a DATE column; the values stay text only when every one of them
      // fails to parse. The label says that rather than implying dates stay text.
      const DATE_FORMAT_OPTIONS = [
        { value: '', label: 'Auto-detect (unparseable dates stay text)' },
        { value: '%m/%d/%Y', label: 'Month first (MM/DD/YYYY)' },
        { value: '%d/%m/%Y', label: 'Day first (DD/MM/YYYY)' },
        { value: '%Y-%m-%d', label: 'Year first (YYYY-MM-DD)' },
      ]
      // Timestamp columns read `timestampFormat`, not `dateFormat`, so a table whose
      // only temporal columns are timestamps gets its own control.
      const TIMESTAMP_FORMAT_OPTIONS = [
        { value: '', label: 'Auto-detect (unparseable timestamps stay text)' },
        { value: '%Y-%m-%d %H:%M:%S', label: 'ISO (YYYY-MM-DD HH:MM:SS)' },
        { value: '%Y-%m-%dT%H:%M:%S', label: 'ISO with T (YYYY-MM-DDTHH:MM:SS)' },
        { value: '%m/%d/%Y %H:%M:%S', label: 'Month first (MM/DD/YYYY HH:MM:SS)' },
        { value: '%d/%m/%Y %H:%M:%S', label: 'Day first (DD/MM/YYYY HH:MM:SS)' },
      ]

      const [edited, setEdited] = useState({})
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [search, setSearch] = useState('')
      const [selectedTable, setSelectedTable] = useState('')
      const [draftStatus, setDraftStatus] = useState(sessionId ? 'Loading saved draft…' : '')
      const [draftReady, setDraftReady] = useState(!sessionId)
      const [stale, setStale] = useState(false)
      // Chosen date format per table, applied by Save type changes (the route that
      // already carries type revisions). A '' value clears a detected format.
      const [formatEdits, setFormatEdits] = useState({})
      const writes = useRef(Promise.resolve())
      const writeGeneration = useRef(0)
      const base = useRef({ expectedRevision, sourceVersion })
      const editsFor = (next, formatChoices = formatEdits) =>
        tables.flatMap((table) => {
          const columns = (table.columns || [])
            .filter(
              (column) =>
                next[table.tableId]?.[column.name] &&
                next[table.tableId][column.name] !== column.type,
            )
            .map((column) => ({ name: column.name, type: next[table.tableId][column.name] }))
          // The chosen format rides in the same edit entry as the type changes, so the
          // recovery draft keeps it (the review promises to recover unsaved changes).
          // A choice equal to what the table already has is NOT a change: keeping it
          // made onDirty(true) stick while changeCount counted zero, which disabled
          // Approve, Save and Reset at once - and the saved draft restored that
          // deadlock after a reload. Type edits drop the same no-op by comparison.
          const chosen = formatChoices[table.tableId]
          const formats = {}
          for (const key of ['dateFormat', 'timestampFormat']) {
            const value = chosen?.[key]
            if (value === undefined || value === (table[key] ?? '')) continue
            formats[key] = value
          }
          return columns.length || Object.keys(formats).length > 0
            ? [{ tableId: table.tableId, columns, ...formats }]
            : []
        })
      const persist = (draft) => {
        if (!sessionId) return Promise.resolve()
        const operation = writes.current
          .catch(() => {})
          .then(() => studioRequest('studio/review-draft', { sessionId, pinId, draft }))
        writes.current = operation
        return operation
      }
      useEffect(() => {
        if (!sessionId) {
          onReady?.(true)
          return undefined
        }
        let active = true
        setDraftReady(false)
        onReady?.(false)
        studioRequest(
          `studio/review-draft?sessionId=${encodeURIComponent(sessionId)}&pinId=${encodeURIComponent(pinId)}`,
        )
          .then((value) => {
            if (!active) return
            if (value.draft) {
              const restored = {}
              const restoredFormats = {}
              for (const table of value.draft.edits) {
                restored[table.tableId] = Object.fromEntries(
                  table.columns.map((column) => [column.name, column.type]),
                )
                const formats = {}
                if (table.dateFormat !== undefined) formats.dateFormat = table.dateFormat
                if (table.timestampFormat !== undefined) {
                  formats.timestampFormat = table.timestampFormat
                }
                if (Object.keys(formats).length > 0) restoredFormats[table.tableId] = formats
              }
              setEdited(restored)
              setFormatEdits(restoredFormats)
              base.current = {
                expectedRevision: value.draft.expectedRevision,
                sourceVersion: value.draft.sourceVersion,
              }
              setStale(value.stale)
              onDirty?.(true)
              setDraftStatus(
                value.stale
                  ? 'Saved draft is stale. Discard and reload the latest proposal.'
                  : 'Recovered unsaved column changes from this session.',
              )
            } else {
              base.current = { expectedRevision, sourceVersion }
              setDraftStatus('')
            }
            setDraftReady(true)
            onReady?.(true)
          })
          .catch((err) => {
            if (active) {
              setError(`Draft recovery failed: ${err.message}`)
              setDraftStatus('Draft recovery unavailable. Reload before reviewing.')
            }
          })
        return () => {
          active = false
        }
      }, [sessionId, pinId])
      useEffect(() => {
        const changed =
          base.current.expectedRevision !== expectedRevision ||
          base.current.sourceVersion !== sourceVersion
        if (!changed) return
        // A pending format change is pending work too: if the proposal advances in
        // another tab while only a format is unsaved, this review must still say so
        // (saving against a revision it has not seen would be a stale write).
        if (Object.keys(edited).length || Object.keys(formatEdits).length) {
          setStale(true)
          onDirty?.(true)
          setDraftStatus(
            'Proposal changed while you were editing. Discard and reload before continuing.',
          )
        } else if (!stale) base.current = { expectedRevision, sourceVersion }
      }, [expectedRevision, sourceVersion])
      const typeEditsFor = (table) =>
        (table.columns || [])
          .filter(
            (column) =>
              edited[table.tableId]?.[column.name] &&
              edited[table.tableId][column.name] !== column.type,
          )
          .map((column) => ({ name: column.name, type: edited[table.tableId][column.name] }))
      const formatChangedFor = (table) => {
        const chosen = formatEdits[table.tableId]
        if (chosen === undefined) return false
        return (
          (chosen.dateFormat !== undefined && chosen.dateFormat !== (table.dateFormat ?? '')) ||
          (chosen.timestampFormat !== undefined &&
            chosen.timestampFormat !== (table.timestampFormat ?? ''))
        )
      }
      const changedTables = tables.flatMap((table) => {
        const columns = typeEditsFor(table)
        const formatChanged = formatChangedFor(table)
        if (!columns.length && !formatChanged) return []
        return [
          {
            tableId: table.tableId,
            // A format-only change still sends the current types: the route applies
            // per-column overrides and unchanged types are a no-op there.
            columns: columns.length
              ? columns
              : (table.columns || []).map((column) => ({ name: column.name, type: column.type })),
            ...(formatChanged
              ? {
                  ...(formatEdits[table.tableId].dateFormat !== undefined
                    ? { dateFormat: formatEdits[table.tableId].dateFormat }
                    : {}),
                  ...(formatEdits[table.tableId].timestampFormat !== undefined
                    ? { timestampFormat: formatEdits[table.tableId].timestampFormat }
                    : {}),
                }
              : {}),
          },
        ]
      })
      const hasEvidence = tables.some((table) =>
        (table.columns || []).some((column) => column.reason || column.dateFormat),
      )
      // Count what actually changed, so a format-only edit does not read as one
      // unsaved change per column in the table.
      const changeCount =
        tables.reduce((count, table) => count + typeEditsFor(table).length, 0) +
        tables.filter((table) => formatChangedFor(table)).length
      /**
       * A chosen format is an unsaved change exactly like a type edit: only Save type
       * changes applies it. Without the `onDirty(true)` here an analyst could pick a
       * format, see "1 unsaved change", click Approve, and the ingest ran with no
       * format at all - silently back to the all-text fallback on a source like
       * superstore. The parent disables Approve on that same signal.
       */
      const setFormat = (tableId, key, value) => {
        const table = tables.find((entry) => entry.tableId === tableId)
        const settled = { ...(formatEdits[tableId] || {}) }
        // The same rule `editsFor` applies when it builds the draft: a choice equal to
        // the table's current value is not a pending change. Dropping it here too keeps
        // `formatEdits` itself honest, since the unsaved-work count, the save payload
        // and the revision-staleness check all read this map directly — leaving a
        // no-op entry in it counted as pending work for a format the analyst had
        // already switched back.
        if ((value ?? '') === (table?.[key] ?? '')) delete settled[key]
        else settled[key] = value
        const next = { ...formatEdits }
        if (Object.keys(settled).length > 0) next[tableId] = settled
        else delete next[tableId]
        setFormatEdits(next)
        onDirty?.(true)
        setDraftStatus('Saving recovery draft…')
        setError(null)
        const generation = ++writeGeneration.current
        const edits = editsFor(edited, next)
        persist(edits.length ? { ...base.current, edits } : null)
          .then(() => {
            if (generation !== writeGeneration.current) return
            setDraftStatus(edits.length ? 'Unsaved column changes · recovery draft saved' : '')
            onDirty?.(edits.length > 0)
          })
          .catch((err) => {
            if (generation !== writeGeneration.current) return
            setError(`Recovery draft not saved: ${err.message}`)
            setDraftStatus('Unsaved changes — keep this tab open.')
            onDirty?.(true)
          })
      }
      const setType = (tableId, columnName, type) => {
        const generation = ++writeGeneration.current
        const next = { ...edited, [tableId]: { ...(edited[tableId] || {}), [columnName]: type } }
        setEdited(next)
        const edits = editsFor(next)
        onDirty?.(true)
        setDraftStatus('Saving recovery draft…')
        setError(null)
        persist(edits.length ? { ...base.current, edits } : null)
          .then(() => {
            if (generation === writeGeneration.current) {
              setDraftStatus(edits.length ? 'Unsaved column changes · recovery draft saved' : '')
              onDirty?.(edits.length > 0)
            }
          })
          .catch((err) => {
            if (generation !== writeGeneration.current) return
            setError(`Recovery draft not saved: ${err.message}`)
            setDraftStatus('Unsaved changes — keep this tab open.')
            onDirty?.(true)
          })
      }
      const reset = async () => {
        ++writeGeneration.current
        setBusy(true)
        try {
          await persist(null)
          setEdited({})
          setFormatEdits({})
          onDirty?.(false)
          setDraftStatus('')
          setError(null)
          base.current = { expectedRevision, sourceVersion }
          if (stale) onReload?.()
          setStale(false)
        } catch (err) {
          setError(`Could not discard saved draft: ${err.message}`)
          onDirty?.(true)
        } finally {
          setBusy(false)
        }
      }
      const save = async () => {
        if (busy || locked || !draftReady || stale || !changeCount) return
        ++writeGeneration.current
        setBusy(true)
        onReady?.(false)
        setError(null)
        try {
          const value = await studioRequest('ingest-recipes/revise', {
            pinId,
            expectedRevision: base.current.expectedRevision,
            tables: changedTables,
          })
          base.current = { expectedRevision: value.revision, sourceVersion: value.sourceVersion }
          await persist(null)
          setEdited({})
          setFormatEdits({})
          onDirty?.(false)
          setDraftStatus('')
          onRevised?.(value)
        } catch (err) {
          setError(err.message)
          onDirty?.(true)
          setStale(true)
        } finally {
          setBusy(false)
          onReady?.(true)
        }
      }
      /**
       * The warnings still current for one table, rendered beside its columns. The
       * detector's "DATE format not persisted: ambiguous day/month order" is exactly
       * what a chosen format answers, so it stops being current the moment the analyst
       * picks one (pending or saved) - otherwise the review keeps showing a warning
       * the analyst has already resolved.
       */
      const currentWarningsFor = (table) => {
        const warnings = (table.warnings || []).map(String)
        const chosenFormat = formatEdits[table.tableId]?.dateFormat ?? table.dateFormat
        const chosenTimestamp = formatEdits[table.tableId]?.timestampFormat ?? table.timestampFormat
        if (!chosenFormat && !chosenTimestamp) return warnings
        return warnings.filter(
          (warning) => !/date format not persisted|ambiguous day\/month/i.test(warning),
        )
      }
      return createElement(
        'section',
        { className: 'studio-column-review', 'aria-label': 'Column types' },
        createElement(
          'header',
          { className: 'studio-toolbar' },
          createElement('h3', null, 'Column types'),
          createElement(
            'span',
            { role: 'status' },
            `${changeCount} unsaved change${changeCount === 1 ? '' : 's'}`,
          ),
        ),
        createElement(
          'p',
          null,
          'Choose storage types, save changes, then approve. Where a source mixes ambiguous day/month order, choose the date format here and save it with the types.',
        ),
        draftStatus ? createElement('p', { role: 'status' }, draftStatus) : null,
        createElement(
          'label',
          { className: 'studio-search' },
          'Find a column',
          createElement('input', {
            type: 'search',
            value: search,
            onChange: (event) => setSearch(event.target.value),
            placeholder: 'Column or source name',
          }),
        ),
        tables.length > 1
          ? createElement(
              'label',
              { className: 'studio-search' },
              'Table',
              createElement(
                'select',
                {
                  'aria-label': 'Review table',
                  value: selectedTable,
                  onChange: (event) => setSelectedTable(event.target.value),
                },
                createElement('option', { value: '' }, `All tables (${tables.length})`),
                ...tables.map((table) =>
                  createElement(
                    'option',
                    { key: table.tableId, value: table.tableId },
                    `${table.tableId} · ${(table.columns || []).length} columns`,
                  ),
                ),
              ),
            )
          : null,
        ...tables.flatMap((table) => {
          const columns = table.columns || []
          const controls = []
          if (columns.some((column) => /DATE/.test(String(column.type || '')))) {
            controls.push({ key: 'dateFormat', label: 'date format', options: DATE_FORMAT_OPTIONS })
          }
          if (columns.some((column) => /TIMESTAMP/.test(String(column.type || '')))) {
            controls.push({
              key: 'timestampFormat',
              label: 'timestamp format',
              options: TIMESTAMP_FORMAT_OPTIONS,
            })
          }
          return controls.map((control) =>
            createElement(
              'label',
              { key: `${control.key}-${table.tableId}`, className: 'studio-search' },
              `${table.tableId} ${control.label}`,
              createElement(
                'select',
                {
                  'aria-label': `${table.tableId} ${control.label}`,
                  value: formatEdits[table.tableId]?.[control.key] ?? table[control.key] ?? '',
                  onChange: (event) => setFormat(table.tableId, control.key, event.target.value),
                },
                ...control.options.map((option) =>
                  createElement('option', { key: option.value, value: option.value }, option.label),
                ),
              ),
            ),
          )
        }),
        ...tables
          .filter((table) => !selectedTable || table.tableId === selectedTable)
          .map((table) => {
            const columns = (table.columns || []).filter((column) =>
              `${column.name} ${column.sourceName || ''}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            return createElement(
              'section',
              { key: table.tableId, className: 'studio-table-group' },
              createElement('h4', null, table.tableId),
              createElement(
                'p',
                { className: 'studio-muted' },
                `${table.sourceFile || 'Source file unavailable'} · ${table.sourceFormat ?? 'csv'} · ${columns.length} of ${(table.columns || []).length} columns shown`,
              ),
              ...currentWarningsFor(table).map((warning, index) =>
                createElement('p', { key: index, role: 'note' }, String(warning)),
              ),
              createElement(
                'div',
                { className: 'studio-table-scroll' },
                createElement(
                  'table',
                  null,
                  createElement(
                    'caption',
                    { className: 'studio-sr-only' },
                    `${table.tableId} column type review`,
                  ),
                  createElement(
                    'thead',
                    null,
                    createElement(
                      'tr',
                      null,
                      ...[
                        'Column',
                        'Proposed type',
                        'Chosen type',
                        ...(hasEvidence ? ['Available evidence'] : []),
                      ].map((label) => createElement('th', { key: label, scope: 'col' }, label)),
                    ),
                  ),
                  createElement(
                    'tbody',
                    null,
                    ...columns.map((column) => {
                      const value = edited[table.tableId]?.[column.name] ?? column.type
                      return createElement(
                        'tr',
                        { key: column.name, 'data-changed': value !== column.type },
                        createElement(
                          'th',
                          { scope: 'row' },
                          column.name,
                          column.sourceName && column.sourceName !== column.name
                            ? createElement('small', null, `Source: ${column.sourceName}`)
                            : null,
                          // Publisher wording stays visibly separate from the
                          // proposed type and the observed evidence: labelled,
                          // unverified, and never a definition to adopt.
                          ...publisherNotesForColumn(publisherSupplied, table.tableId, column).map(
                            (note, noteIndex) =>
                              createElement(
                                'small',
                                { key: `publisher-note-${noteIndex}`, role: 'note' },
                                `Publisher-supplied (unverified): ${note.note}`,
                              ),
                          ),
                        ),
                        createElement('td', null, column.type),
                        createElement(
                          'td',
                          null,
                          createElement(
                            'select',
                            {
                              'aria-label': `${table.tableId}.${column.name} chosen type`,
                              disabled: busy || locked || !draftReady || stale,
                              value,
                              onChange: (event) =>
                                setType(table.tableId, column.name, event.target.value),
                            },
                            ...[...new Set([column.type, ...REVISABLE_TYPES])].map((type) =>
                              createElement('option', { key: type, value: type }, type),
                            ),
                          ),
                        ),
                        hasEvidence
                          ? createElement(
                              'td',
                              null,
                              column.reason || 'No evidence recorded',
                              column.dateFormat
                                ? createElement('p', null, `Parse format: ${column.dateFormat}`)
                                : null,
                            )
                          : null,
                      )
                    }),
                  ),
                ),
              ),
            )
          }),
        createElement(
          'div',
          { className: 'studio-toolbar' },
          createElement(
            'button',
            {
              type: 'button',
              disabled: busy || locked || !draftReady || stale || !changeCount,
              onClick: save,
            },
            busy ? 'Saving types…' : 'Save type changes',
          ),
          createElement(
            'button',
            {
              type: 'button',
              disabled: busy || !draftReady || (!changeCount && !stale),
              onClick: reset,
            },
            stale ? 'Discard draft and reload' : 'Reset changes',
          ),
        ),
        error ? createElement('p', { role: 'alert' }, error) : null,
      )
    }

    /**
     * `renderObserve('catalog', ...)` caps every model-facing observation at
     * 8 KiB; a proposal with many tables/columns can be shrunk to
     * `warnings: ["truncated"]` with `tables` dropped entirely (see
     * `tool-observe.ts`). The toolview must never let an analyst approve a
     * candidate it never actually rendered — so when the observation looks
     * truncated (or simply has no tables) for a still-pending candidate,
     * this loads the untruncated candidate from the authenticated GET route
     * before Approve/Reject can render at all.
     */
    function IngestRecipeToolRow({
      block,
      sidebar = false,
      onDirty,
      onReviewed,
      reviewBlocked = false,
      sessionId,
      refreshKey = '',
    }) {
      const output = resultText(block)
      const observedProposal = parseObservePayload(output)
      const [loadedProposal, setLoadedProposal] = useState(null)
      const [typesDirty, setTypesDirty] = useState(false)
      const proposal = loadedProposal || observedProposal
      const failed = 'kind' in block && block.isError

      const [status, setStatus] = useState(proposal?.status ?? 'candidate')
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [loadedTables, setLoadedTables] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [reviewReady, setReviewReady] = useState(false)
      const [reloadKey, setReloadKey] = useState(0)
      // Declared last on purpose: the toolview test harness stubs useState positionally,
      // so a new slot in the middle would shift every slot after it.
      const [refreshNotice, setRefreshNotice] = useState('')
      const observedPending = useRef(!observedProposal)
      useEffect(() => {
        if (sidebar) return
        if (!observedProposal) {
          observedPending.current = true
          return
        }
        if (
          observedPending.current &&
          observedProposal.pinId &&
          !observedProposal.alreadyReviewed &&
          !failed
        ) {
          observedPending.current = false
          openColumnReview?.(observedProposal.pinId)
        }
      }, [sidebar, observedProposal?.pinId, failed])

      useEffect(() => setStatus(proposal?.status ?? 'candidate'), [proposal?.status])

      const observeTables = Array.isArray(proposal?.tables) ? proposal.tables : []
      const observeTruncated = Array.isArray(proposal?.warnings)
        ? proposal.warnings.includes('truncated')
        : false
      // A candidate observation this module never sent tables for at all
      // (e.g. every trimmable field was already emptied) looks identical to
      // "no tables proposed" — treat missing tables on a still-pending
      // candidate the same as an explicit truncation warning.
      const needsFullLoad = Boolean(
        sidebar &&
        proposal &&
        proposal.pinId &&
        !proposal.alreadyReviewed &&
        status === 'candidate',
      )

      /**
       * The sidebar's Refresh buttons re-fetch `studio/inbox`, so a proposal revised
       * elsewhere (another tab, or the agent re-previewing the source) arrives as a new
       * `observedProposal`. `loadedProposal` — the full-candidate fallback — then shadows
       * it forever, which is why an open review never noticed a newer revision: the
       * analyst only found out when Approve came back rejected as stale. Compare the two
       * and invalidate the cache so the newest revision is fetched and rendered.
       *
       * Unsaved column edits are not thrown away by that: the cache is dropped and the
       * editor above keeps its own `edited` state, marks itself stale against the new
       * revision and offers "Discard draft and reload" — the same rule the draft path
       * already applies.
       */
      const observedRevision = observedProposal?.revision
      const observedSourceVersion = observedProposal?.sourceVersion
      const loadedRevision = loadedProposal?.revision
      const loadedSourceVersion = loadedProposal?.sourceVersion
      // Reload at most once per observed revision. The two routes (inbox observation,
      // full-candidate GET) can disagree for a moment, and without this the effect
      // re-invalidated on every fetch that came back with a different revision than the
      // observation claimed — an endless reload loop.
      const handledObservedRevision = useRef(undefined)
      useEffect(() => {
        if (!sidebar || loadedProposal === null) return
        if (observedRevision === undefined || observedSourceVersion === undefined) return
        if (observedRevision === loadedRevision && observedSourceVersion === loadedSourceVersion) {
          return
        }
        if (handledObservedRevision.current === observedRevision) return
        handledObservedRevision.current = observedRevision
        setLoadedProposal(null)
        setLoadedTables(null)
        // Dropping the cache is not enough on its own: the load effect below keys on
        // `[needsFullLoad, pinId, reloadKey]`, none of which change when only the
        // revision moved, so the card would sit on "Loading latest source proposal…"
        // forever. Bump the reload key so the fresh revision is actually fetched.
        setReloadKey((value) => value + 1)
        setRefreshNotice(
          typesDirty
            ? `This proposal changed elsewhere — the grid now shows revision ${observedRevision}. Save or discard your column changes before approving.`
            : `Reloaded the latest proposal (revision ${observedRevision}).`,
        )
      }, [
        sidebar,
        loadedProposal,
        observedRevision,
        observedSourceVersion,
        loadedRevision,
        loadedSourceVersion,
        typesDirty,
      ])

      // A refresh that finds nothing new still has to answer the analyst: without this
      // the two Refresh buttons looked like no-ops on a current proposal, which is how
      // "the sidebar doesn't reload anything" got reported in the first place.
      const handledRefreshKey = useRef(refreshKey)
      useEffect(() => {
        if (handledRefreshKey.current === refreshKey) return
        handledRefreshKey.current = refreshKey
        if (!sidebar || loadedProposal === null) return
        if (observedRevision === undefined || observedSourceVersion === undefined) return
        if (observedRevision !== loadedRevision || observedSourceVersion !== loadedSourceVersion) {
          return // the observation-change effect above owns this case
        }
        setRefreshNotice(
          `Proposal is current — revision ${observedRevision}, pinned source version ${observedSourceVersion}.`,
        )
      }, [
        refreshKey,
        sidebar,
        loadedProposal,
        observedRevision,
        observedSourceVersion,
        loadedRevision,
        loadedSourceVersion,
      ])

      useEffect(() => {
        if (!needsFullLoad) return undefined
        const controller = new AbortController()
        const url = '/api/analyst/ingest-recipes?pinId=' + encodeURIComponent(proposal.pinId)
        fetch(url, { credentials: 'same-origin', signal: controller.signal })
          .then(async (response) => {
            const value = await response.json()
            if (!response.ok)
              throw new Error(value.error || `Ingest recipe HTTP ${response.status}`)
            return value
          })
          .then((value) => {
            setLoadedProposal({ ...observedProposal, ...value })
            setStatus(value.status || 'candidate')
            setLoadedTables(Array.isArray(value.tables) ? value.tables : [])
            setLoadError(null)
          })
          .catch((err) => {
            if (controller.signal.aborted) return
            setLoadError(err instanceof Error ? err.message : String(err))
          })
        return () => controller.abort()
      }, [needsFullLoad, proposal?.pinId, reloadKey])

      if (failed) {
        const message = errorText(block)
        return createElement(
          'div',
          null,
          createElement('p', { role: 'alert' }, 'Ingest preview failed'),
          message
            ? createElement(
                'p',
                {
                  style: {
                    whiteSpace: 'pre-wrap',
                    fontSize: 13,
                    color: 'var(--dsw-alias-state-error-primary)',
                  },
                },
                message,
              )
            : null,
        )
      }
      if (!proposal) {
        return createElement('p', null, 'Loading ingest preview')
      }

      if (!sidebar)
        return createElement(
          'section',
          { 'aria-label': 'Ingest preview status' },
          createElement('strong', null, proposal.slug || 'Source preview'),
          createElement(
            'p',
            null,
            proposal.alreadyReviewed
              ? 'Source was reviewed.'
              : 'Column review is available in Analysis Studio.',
          ),
          proposal.pinId
            ? createElement(
                'button',
                { type: 'button', onClick: () => openColumnReview?.(proposal.pinId) },
                'Open column review',
              )
            : null,
        )

      const review = (nextStatus) => {
        if (!proposal.pinId || busy || typesDirty || reviewBlocked || !reviewReady) return
        setBusy(true)
        setError(null)
        fetch('/api/analyst/ingest-recipes/review', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pinId: proposal.pinId,
            status: nextStatus,
            expectedRevision: proposal.revision,
          }),
        })
          .then(async (response) => {
            const value = await response.json()
            if (!response.ok) throw new Error(value.error || `Review HTTP ${response.status}`)
            setStatus(value.status)
            onReviewed?.({ kind: 'source', status: value.status })
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false))
      }

      // `loadedTables` (once the GET resolves) always wins over the
      // possibly-truncated observe tables; `null` means "not loaded yet".
      const tables = loadedTables ?? observeTables
      const unsupportedFiles = Array.isArray(proposal.unsupportedFiles)
        ? proposal.unsupportedFiles
        : []
      // Complete archive inventory (Stage 3b): proposed vs skipped files with
      // reasons, so a size-capped or unsupported lookup table is never silently
      // dropped from review.
      const fileInventory = Array.isArray(proposal.files) ? proposal.files : null
      const skippedFiles = fileInventory
        ? fileInventory.filter((file) => file.status === 'skipped')
        : []
      const proposedFileCount = fileInventory
        ? fileInventory.filter((file) => file.status === 'proposed').length
        : tables.length
      // Still waiting on (or never triggered) the full-candidate load: do
      // not show Approve/Reject until the analyst can see every table.
      const stillTruncatedUnresolved = needsFullLoad && loadedTables === null
      const showActions =
        !proposal.alreadyReviewed &&
        status === 'candidate' &&
        proposal.pinId &&
        !stillTruncatedUnresolved

      return createElement(
        'section',
        { 'aria-label': 'Ingest recipe review' },
        createElement(
          'p',
          { className: 'studio-muted' },
          `Version ${proposal.sourceVersion || 'unavailable'} · ${status === 'candidate' ? 'Review columns' : status}`,
        ),
        refreshNotice ? createElement('p', { role: 'status' }, refreshNotice) : null,
        stillTruncatedUnresolved
          ? createElement(
              'p',
              { role: 'status' },
              'Loading latest source proposal before approval…',
            )
          : null,
        proposal.pinId && status === 'candidate' && !stillTruncatedUnresolved && tables.length
          ? createElement(TypeEditor, {
              pinId: proposal.pinId,
              expectedRevision: proposal.revision,
              sourceVersion: proposal.sourceVersion,
              sessionId,
              onReady: setReviewReady,
              onReload: () => {
                setReviewReady(false)
                setLoadedTables(null)
                setReloadKey(reloadKey + 1)
              },
              tables,
              publisherSupplied: proposal.publisherSupplied || null,
              locked: reviewBlocked,
              onDirty: (dirty) => {
                setTypesDirty(dirty)
                onDirty?.(dirty)
              },
              onRevised: (value) => {
                setLoadedTables(value.tables)
                setLoadedProposal({ ...proposal, ...value })
                setTypesDirty(false)
                onDirty?.(false)
              },
            })
          : null,
        createElement(
          'details',
          { className: 'studio-source-details' },
          createElement('summary', null, 'Source details and import plan'),
          createElement('p', null, proposal.slug || 'Source name unavailable'),
          proposal.sourceVersion
            ? createElement('p', null, `Pinned Kaggle version: ${proposal.sourceVersion}`)
            : null,
          proposal.loadStrategy
            ? createElement(
                'p',
                null,
                proposal.loadStrategy === 'raw_then_typed'
                  ? 'Load strategy: raw_then_typed (lossless raw_* tables + typed projection; cast failures become NULL)'
                  : `Load strategy: ${proposal.loadStrategy}`,
              )
            : null,
          proposal.observedLicense
            ? createElement(
                'p',
                null,
                `Observed license: ${proposal.observedLicense} (${proposal.licenseVersionVerified ? 'exact version verified' : 'version unverified'})`,
              )
            : createElement('p', null, 'Observed license: unavailable'),
          proposal.provenanceStatus
            ? createElement('p', null, `Verification: ${proposal.provenanceStatus}`)
            : null,
          proposal.metadataWarning
            ? createElement('p', { role: 'note' }, proposal.metadataWarning)
            : null,
          // Publisher-supplied description/column dictionary. Shown as quoted,
          // labelled evidence next to the observed facts and the analyst's own
          // type decisions — never presented as a definition, and never merged
          // into the proposed types above it.
          proposal.publisherSupplied
            ? createElement(
                'div',
                { role: 'note' },
                createElement('p', null, 'Publisher-supplied (unverified)'),
                proposal.publisherSupplied.subtitle
                  ? createElement(
                      'p',
                      { className: 'studio-muted' },
                      `Publisher subtitle: ${proposal.publisherSupplied.subtitle}`,
                    )
                  : null,
                Array.isArray(proposal.publisherSupplied.keywords) &&
                  proposal.publisherSupplied.keywords.length
                  ? createElement(
                      'p',
                      { className: 'studio-muted' },
                      `Publisher keywords: ${proposal.publisherSupplied.keywords.join(', ')}`,
                    )
                  : null,
                publisherDescriptionOf(proposal.publisherSupplied)
                  ? createElement(
                      'p',
                      { style: { whiteSpace: 'pre-wrap' } },
                      publisherDescriptionOf(proposal.publisherSupplied).text,
                    )
                  : null,
                publisherDescriptionOf(proposal.publisherSupplied)?.truncated
                  ? createElement(
                      'p',
                      { className: 'studio-muted' },
                      `Publisher description shown in part (${publisherDescriptionOf(proposal.publisherSupplied).chars} characters supplied).`,
                    )
                  : null,
                createElement(
                  'p',
                  { className: 'studio-muted' },
                  `${publisherNotesOf(proposal.publisherSupplied).length} of ${proposal.publisherSupplied.columnDictionaryTotal ?? publisherNotesOf(proposal.publisherSupplied).length} publisher column note(s) shown; matched notes appear beside their column above.`,
                ),
                ...unmatchedPublisherNotes(proposal.publisherSupplied, tables).map((note, index) =>
                  createElement(
                    'p',
                    { key: `unmatched-publisher-note-${index}`, className: 'studio-muted' },
                    `Unmatched publisher note (unverified): ${note.column} — ${note.note}`,
                  ),
                ),
                ...(Array.isArray(proposal.publisherSupplied.notes)
                  ? proposal.publisherSupplied.notes
                  : []
                ).map((note, index) =>
                  createElement(
                    'p',
                    { key: `publisher-note-detail-${index}`, className: 'studio-muted' },
                    String(note),
                  ),
                ),
                proposal.publisherSupplied.caveat
                  ? createElement(
                      'p',
                      { className: 'studio-muted' },
                      String(proposal.publisherSupplied.caveat),
                    )
                  : null,
              )
            : null,
          createElement(
            'p',
            null,
            `Status: ${proposal.alreadyReviewed ? 'already reviewed' : status}`,
          ),
          observeTruncated
            ? createElement(
                'p',
                { role: 'note' },
                stillTruncatedUnresolved
                  ? 'Proposal truncated in the model view; loading full candidate for review…'
                  : 'Proposal truncated in the model view; loaded full candidate for review.',
              )
            : null,
          unsupportedFiles.length && !fileInventory
            ? createElement(
                'div',
                null,
                createElement('strong', null, 'Unsupported files'),
                createElement(
                  'ul',
                  null,
                  ...unsupportedFiles.map((file, index) =>
                    createElement(
                      'li',
                      { key: file.name ?? index },
                      `${file.name}: ${file.reason}`,
                    ),
                  ),
                ),
              )
            : null,
          fileInventory
            ? createElement(
                'div',
                null,
                createElement(
                  'p',
                  null,
                  `Archive inventory: ${fileInventory.length} file(s) — ${proposedFileCount} proposed, ${skippedFiles.length} skipped`,
                ),
                skippedFiles.length
                  ? createElement(
                      'div',
                      null,
                      createElement('strong', null, 'Skipped files'),
                      createElement(
                        'ul',
                        null,
                        ...skippedFiles.map((file, index) =>
                          createElement(
                            'li',
                            { key: file.name ?? index },
                            `${file.name} (${formatBytes(file.bytes)})${file.reason ? `: ${file.reason}` : ''}`,
                          ),
                        ),
                      ),
                    )
                  : null,
              )
            : null,
          !fileInventory
            ? createElement(
                'p',
                { className: 'studio-muted' },
                'Complete archive inventory, column samples and quality counts are unavailable in this saved proposal.',
              )
            : null,
        ),
        typesDirty
          ? createElement('p', { role: 'status' }, 'Save or reset type changes before approving.')
          : null,
        showActions
          ? createElement(
              'div',
              // Sticky so the decision stays on screen while a tall column grid
              // scrolls: with 38 columns the row rendered below the fold and a
              // first click missed it (measured: action row bottom 1323px in a
              // 794px viewport, with only six columns).
              { className: 'studio-actionbar' },
              // The decision this bar carries, named where the buttons are. Without
              // it the two buttons floated over the grid with nothing tying them to
              // the review, and a disabled pair explained itself only further up.
              createElement(
                'span',
                { className: 'studio-actionbar-label' },
                typesDirty
                  ? 'Save or reset your column changes to approve'
                  : 'Approve these storage types to publish',
              ),
              createElement(
                'span',
                { className: 'studio-actionbar-buttons' },
                createElement(
                  'button',
                  {
                    type: 'button',
                    disabled: busy || typesDirty || reviewBlocked || !reviewReady,
                    onClick: () => review('revoked'),
                    className: 'studio-reject',
                  },
                  'Reject',
                ),
                // Primary action last, so it sits at the trailing edge of the bar
                // where a confirm belongs. A bare ' ' text node used to separate the
                // pair, which flex counted as its own item and spaced unevenly.
                createElement(
                  'button',
                  {
                    type: 'button',
                    disabled: busy || typesDirty || reviewBlocked || !reviewReady,
                    onClick: () => review('approved'),
                    className: 'studio-approve',
                  },
                  busy ? 'Saving…' : 'Approve',
                ),
              ),
            )
          : null,
        error ? createElement('p', { role: 'alert' }, error) : null,
        loadError ? createElement('p', { role: 'alert' }, loadError) : null,
        (error || loadError) && !typesDirty
          ? createElement(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => {
                  setError(null)
                  setReviewReady(false)
                  setLoadedTables(null)
                  setReloadKey(reloadKey + 1)
                },
              },
              'Reload latest proposal',
            )
          : null,
      )
    }

    function IngestAdaptConfirmToolRow({ block, sidebar = false, onReviewed, blocked = false }) {
      const output = resultText(block)
      const result = parseObservePayload(output)
      const failed = 'kind' in block && block.isError
      const [status, setStatus] = useState(result?.status ?? null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      useEffect(() => setStatus(result?.status ?? null), [result?.status])

      if (failed) {
        const message = errorText(block)
        return createElement(
          'div',
          null,
          createElement('p', { role: 'alert' }, 'Ingest failed'),
          message
            ? createElement(
                'p',
                {
                  style: {
                    whiteSpace: 'pre-wrap',
                    fontSize: 13,
                    color: 'var(--dsw-alias-state-error-primary)',
                  },
                },
                message,
              )
            : null,
        )
      }
      if (!result) {
        return createElement('p', null, 'Loading ingest result')
      }

      const needsConfirm = status === 'needs-input' && result.jobId
      // Every ingest warning is analyst-facing text the coordinator already bounds
      // (rejected rows, cast-nulls, a type that parsed nothing, a currency column the
      // scan could not decide). Showing only cast-null lines hid the rest from the
      // analyst while the model saw them — the superstore date fallback and the
      // mixed-currency skips reached the agent but never the review card.
      const sourceWarnings = Array.isArray(result.qualityWarnings)
        ? result.qualityWarnings.map((warning) => String(warning))
        : []
      const reasons = Array.isArray(result.materialityReasons)
        ? result.materialityReasons
        : sourceWarnings

      if (needsConfirm && !sidebar)
        return createElement(
          'section',
          { 'aria-label': 'Import review status' },
          createElement('strong', null, 'Import needs publication review'),
          createElement(
            'p',
            null,
            'Review conversion warnings in Analysis Studio before publishing.',
          ),
          createElement(
            'button',
            { type: 'button', onClick: () => openImportReview?.(result.jobId) },
            'Open import review',
          ),
        )

      const confirm = (action) => {
        if (!result.jobId || busy || blocked) return
        setBusy(true)
        setError(null)
        fetch('/api/analyst/ingest-adapt/confirm', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId: result.jobId, action }),
        })
          .then(async (response) => {
            const value = await response.json()
            if (!response.ok) throw new Error(value.error || `Confirm HTTP ${response.status}`)
            setStatus(value.status)
            onReviewed?.({ kind: 'import', status: value.status })
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false))
      }

      return createElement(
        'div',
        { className: 'dsh-ingest-adapt' },
        createElement('p', null, [
          createElement('strong', { key: 's' }, 'Ingest '),
          String(result.slug || result.datasetId || ''),
          status ? ` — ${status}` : '',
        ]),
        needsConfirm
          ? createElement(
              'div',
              { key: 'confirm' },
              createElement(
                'p',
                null,
                'Typed projection has material cast-nulls. Publish projection or keep staging (no publish).',
              ),
              reasons.length
                ? createElement(
                    'ul',
                    null,
                    reasons
                      .slice(0, 8)
                      .map((reason, i) => createElement('li', { key: i }, String(reason))),
                  )
                : null,
              createElement(
                'div',
                { style: { display: 'flex', gap: '0.5rem', marginTop: '0.5rem' } },
                createElement(
                  'button',
                  {
                    type: 'button',
                    disabled: busy || blocked,
                    onClick: () => confirm('publish'),
                  },
                  'Publish projection',
                ),
                createElement(
                  'button',
                  {
                    type: 'button',
                    disabled: busy || blocked,
                    onClick: () => confirm('keep'),
                  },
                  'Keep staging',
                ),
              ),
            )
          : status === 'ready'
            ? createElement(
                'div',
                null,
                createElement('p', null, 'Published dataset version is ready.'),
                sourceWarnings.length
                  ? createElement(
                      'div',
                      null,
                      createElement('p', null, 'Review these before analysis:'),
                      createElement(
                        'ul',
                        null,
                        sourceWarnings
                          .slice(0, 8)
                          .map((warning, index) => createElement('li', { key: index }, warning)),
                      ),
                    )
                  : null,
              )
            : status === 'cancelled'
              ? createElement('p', null, 'Staging kept; no dataset version published.')
              : null,
        error ? createElement('p', { role: 'alert' }, error) : null,
      )
    }

    async function studioRequest(path, body, signal) {
      const response = await fetch(`/api/analyst/${path}`, {
        credentials: 'same-origin',
        signal,
        ...(body
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
      })
      const value = await response.json()
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? 'This view changed elsewhere. Refresh to review the latest revision before applying again.'
            : value.error || `Request failed (${response.status})`,
        )
      return value
    }

    /**
     * Metadata-only refresh: never replaces an open review or a draft. The
     * 30s poll already re-fetches `imports` job status in the background
     * (e.g. an agent-driven `ingest_dataset` finishing outside any click in
     * this sidebar) — `onChanged` fires once per detected change so a
     * caller can refresh dependent state (the dataset list, the inbox) the
     * same way an explicit human approve/reject/refresh already does,
     * instead of only updating this component's own local status text.
     * Never fires on the first load after mount/refreshKey change — that is
     * an initial population, not a "something changed in the background"
     * signal.
     */
    function StudioReviewStatus({
      refreshKey,
      blocked,
      onOpen,
      active = true,
      onChanged,
      onRefreshRequested,
    }) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [refresh, setRefresh] = useState(0)
      useEffect(() => {
        if (!active) return undefined
        const controller = new AbortController()
        let timer
        let previousSignature = null
        let first = true
        const load = async () => {
          try {
            const value = await studioRequest('studio/review-status', null, controller.signal)
            if (!controller.signal.aborted) {
              setStatus(value)
              setError(null)
              const signature = JSON.stringify([
                (value?.imports || []).map((job) => [job.jobId, job.status, job.updatedAt]),
                // A saved analysis changes nothing in `pending`/`imports`, so
                // without this a freshly saved chart never triggered onChanged
                // and stayed out of the saved-view list until a manual refresh.
                value?.analyses?.revisions ?? 0,
                value?.analyses?.updatedAt ?? '',
                // Identities, not just count + latest: a delete plus a create in the same
                // second leaves both unchanged and the saved-view list stale.
                value?.analyses?.digest ?? '',
              ])
              if (!first && signature !== previousSignature) onChanged?.(value)
              previousSignature = signature
              first = false
            }
          } catch (err) {
            if (!controller.signal.aborted) setError(err.message)
          } finally {
            if (!controller.signal.aborted) timer = setTimeout(load, 30000)
          }
        }
        load()
        return () => {
          controller.abort()
          clearTimeout(timer)
        }
      }, [refreshKey, refresh, active])
      const pending = status?.pending
      const labels = {
        ingestion: 'column',
        semantic: 'metric',
        structure: 'structure',
        adaptations: 'publication',
      }
      return createElement(
        'aside',
        { className: 'studio-review-status', 'aria-label': 'Review and import status' },
        createElement(
          'div',
          { className: 'studio-toolbar' },
          createElement(
            'span',
            { role: 'status', 'aria-live': 'polite' },
            pending
              ? `${pending.total} pending review${pending.total === 1 ? '' : 's'}`
              : 'Checking reviews…',
          ),
          createElement(
            'button',
            { type: 'button', disabled: blocked, onClick: onOpen },
            'Open reviews',
          ),
          createElement(
            'button',
            {
              type: 'button',
              onClick: () => {
                setRefresh((value) => value + 1)
                // Refreshing the counts alone never reloaded the review the analyst has
                // open: bubble up so the inbox (and with it the open proposal) re-fetches.
                onRefreshRequested?.()
              },
              'aria-label': 'Refresh review status',
            },
            'Refresh status',
          ),
        ),
        pending?.total
          ? createElement(
              'p',
              { className: 'studio-muted' },
              Object.entries(labels)
                .filter(([key]) => pending[key] > 0)
                .map(
                  ([key, label]) =>
                    `${pending[key]} ${label} review${pending[key] === 1 ? '' : 's'}`,
                )
                .join(' · '),
            )
          : null,
        (status?.imports || []).length
          ? createElement(
              'details',
              null,
              createElement('summary', null, 'Recent imports'),
              createElement(
                'ul',
                null,
                ...status.imports.map((job) =>
                  createElement(
                    'li',
                    { key: job.jobId },
                    `${job.slug || 'Source'} · ${String(job.status).replaceAll('-', ' ')}`,
                  ),
                ),
              ),
            )
          : null,
        blocked
          ? createElement(
              'p',
              { className: 'studio-muted' },
              'Save or discard your draft before opening another review.',
            )
          : null,
        error ? createElement('p', { role: 'alert' }, `Review status unavailable: ${error}`) : null,
      )
    }

    function StudioInbox({
      refreshKey,
      reviewPinId,
      importJobId,
      onDirty,
      onReviewed,
      onStatusChanged,
      sessionId,
    }) {
      const [inbox, setInbox] = useState(null)
      const [error, setError] = useState(null)
      const [dirtyPins, setDirtyPins] = useState({})
      useEffect(() => {
        const controller = new AbortController()
        studioRequest('studio/inbox', null, controller.signal)
          .then(setInbox)
          .catch((err) => {
            if (!controller.signal.aborted) setError(err.message)
          })
        return () => controller.abort()
      }, [refreshKey, reviewPinId, importJobId])
      const block = (value) => ({
        kind: 'tool-result',
        content: [{ type: 'text', text: JSON.stringify(value) }],
      })
      return createElement(
        'details',
        { open: true },
        createElement('summary', null, 'Review inbox'),
        error ? createElement('p', { role: 'alert' }, error) : null,
        !inbox ? createElement('p', null, 'Loading pending reviews…') : null,
        inbox &&
          !inbox.ingestion.length &&
          !inbox.semantic.length &&
          !inbox.structure.length &&
          !(inbox.adaptations || []).length
          ? createElement(
              'p',
              null,
              'No pending reviews. Refresh workspace after requesting a proposal.',
            )
          : null,
        inbox && reviewPinId && !inbox.ingestion.some((item) => item.pinId === reviewPinId)
          ? createElement(
              'p',
              { role: 'status' },
              'This source has no pending column review. It may already have been reviewed; historical proposals cannot be approved here.',
            )
          : null,
        ...(inbox?.ingestion || []).map((item) =>
          createElement(
            'details',
            {
              key: item.pinId,
              open: !reviewPinId || item.pinId === reviewPinId,
              className: 'studio-review-card',
            },
            createElement('summary', null, item.slug || item.recipe?.slug || 'Pending source'),
            createElement(IngestRecipeToolRow, {
              sidebar: true,
              sessionId,
              refreshKey,
              onDirty: (dirty) => {
                const next = { ...dirtyPins, [item.pinId]: dirty }
                setDirtyPins(next)
                onDirty?.(Object.values(next).some(Boolean))
              },
              reviewBlocked: Object.entries(dirtyPins).some(
                ([pin, dirty]) => pin !== item.pinId && dirty,
              ),
              onReviewed,
              block: block({ ...item.recipe, ...item }),
            }),
          ),
        ),
        inbox &&
          importJobId &&
          !(inbox.adaptations || []).some((item) => item.jobId === importJobId)
          ? createElement('p', { role: 'status' }, 'This import has no pending publication review.')
          : null,
        ...(inbox?.adaptations || []).map((item) =>
          createElement(
            'details',
            {
              key: item.jobId,
              open: !importJobId || item.jobId === importJobId,
              className: 'studio-review-card',
            },
            createElement('summary', null, `Publish: ${item.slug || 'Imported source'}`),
            createElement(IngestAdaptConfirmToolRow, {
              sidebar: true,
              blocked: Object.values(dirtyPins).some(Boolean),
              onReviewed,
              block: block(item),
            }),
          ),
        ),
        ...(inbox?.semantic || []).map((item) =>
          createElement(AliasProposalToolRow, {
            key: item.candidateId,
            onReviewed: onStatusChanged,
            block: block({ ...item, proposalId: item.candidateId }),
          }),
        ),
        inbox?.structure.length
          ? createElement(StructureReviewToolRow, {
              block: block({ candidates: inbox.structure }),
              onReviewed: onStatusChanged,
            })
          : null,
      )
    }

    function RecentReports({ refreshKey }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      useEffect(() => {
        const controller = new AbortController()
        setError(null)
        studioRequest('studio/reports', null, controller.signal)
          .then((value) => {
            if (!controller.signal.aborted) {
              setData(value)
              setError(null)
            }
          })
          .catch((err) => {
            if (!controller.signal.aborted) setError(err.message)
          })
        return () => controller.abort()
      }, [refreshKey])
      const reports = data?.reports || []
      return createElement(
        'section',
        { 'aria-label': 'Recent reports', style: { display: 'grid', gap: 10 } },
        createElement('h3', null, 'Recent reports'),
        error ? createElement('p', { role: 'alert' }, error) : null,
        !data ? createElement('p', null, 'Loading reports…') : null,
        data && !reports.length
          ? createElement('p', null, 'No newly exported reports tracked yet.')
          : null,
        ...reports.map((report) => {
          const dashboard = report.source?.kind === 'dashboard'
          const sourceLabel = dashboard
            ? `Dashboard snapshot · ${(report.source.slots || []).length} cards`
            : `Analysis revision ${report.source?.revision || '?'}`
          const downloads = Object.entries(report.downloads || {}).filter(([, url]) =>
            isSafeReportDownloadUrl(url),
          )
          return createElement(
            'article',
            {
              key: report.reportId,
              style: {
                border: '1px solid var(--dsw-alias-border-l3,#ccc)',
                borderRadius: 8,
                padding: 12,
                overflowWrap: 'anywhere',
              },
            },
            createElement('strong', null, report.title),
            createElement('p', { style: { margin: '4px 0' } }, sourceLabel),
            createElement(
              'p',
              { style: { margin: '4px 0', fontSize: 12 } },
              new Date(report.createdAt).toLocaleString(),
            ),
            report.openUrl
              ? createElement(
                  'a',
                  { href: report.openUrl, rel: 'noopener noreferrer' },
                  'Open report',
                )
              : createElement('p', { role: 'status' }, 'Report file missing'),
            report.missingFiles?.length
              ? createElement(
                  'p',
                  { role: 'status' },
                  `Incomplete report files: ${report.missingFiles.join(', ')}`,
                )
              : null,
            dashboard
              ? createElement(
                  'details',
                  null,
                  createElement('summary', null, 'Pinned revisions'),
                  createElement(
                    'ul',
                    null,
                    ...(report.source.slots || []).map((slot, index) =>
                      createElement(
                        'li',
                        { key: index },
                        `Card ${index + 1} · ${slot.analysisId} · revision ${slot.revision} · ${slot.resultId}`,
                      ),
                    ),
                  ),
                )
              : null,
            downloads.length
              ? createElement(
                  'details',
                  null,
                  createElement('summary', null, 'Downloads'),
                  createElement(
                    'ul',
                    null,
                    ...downloads.map(([format, url]) =>
                      createElement(
                        'li',
                        { key: format },
                        createElement('a', { href: url, download: true }, format.toUpperCase()),
                      ),
                    ),
                  ),
                )
              : null,
          )
        }),
      )
    }

    function StudioDashboard({ dashboardId, refreshKey, analyses, onSaved, onDirty, onOpen }) {
      const [data, setData] = useState(null)
      const [slots, setSlots] = useState([])
      const [dirty, setDirty] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      useEffect(() => {
        const controller = new AbortController()
        studioRequest(
          `studio/dashboard?dashboardId=${encodeURIComponent(dashboardId)}`,
          null,
          controller.signal,
        )
          .then((value) => {
            if (controller.signal.aborted) return
            setData(value)
            setSlots(value.slots)
            setDirty(false)
          })
          .catch((err) => {
            if (!controller.signal.aborted) setError(err.message)
          })
        return () => controller.abort()
      }, [dashboardId, refreshKey])
      useEffect(() => {
        onDirty(dirty)
      }, [dirty])
      const edit = (next) => {
        setSlots(next)
        setDirty(true)
      }
      const move = (index, direction) => {
        const next = [...slots]
        ;[next[index], next[index + direction]] = [next[index + direction], next[index]]
        edit(next)
      }
      const save = async () => {
        setBusy(true)
        setError(null)
        try {
          await studioRequest('studio/dashboard', {
            dashboardId,
            expectedVersion: data.dashboard.updatedAt,
            slots: slots.map(({ analysisId, revision, width, title, sharedFilterKeys }) => ({
              analysisId,
              revision,
              width: width || 1,
              ...(title !== data.slots.find((saved) => saved.analysisId === analysisId)?.title
                ? { title }
                : {}),
              sharedFilterKeys: sharedFilterKeys || [],
            })),
          })
          setDirty(false)
          onSaved()
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }
      const chooseLatest = async (analysisId, index) => {
        setBusy(true)
        setError(null)
        try {
          const value = await studioRequest(
            `studio/analysis?analysisId=${encodeURIComponent(analysisId)}&limit=1`,
          )
          const filterFields = value.result.columns.map((column) =>
            typeof column === 'string' ? column : column.name,
          )
          const previous = index == null ? {} : slots[index]
          const next = {
            ...previous,
            analysisId,
            revision: value.analysis.revision,
            latestRevision: value.analysis.revision,
            title:
              previous.title || value.analysis.chart.title || value.analysis.question.slice(0, 200),
            chartTitle: value.analysis.chart.title,
            width: previous.width || 1,
            artifactIds: value.analysis.artifactIds,
            filterFields,
            sharedFilterKeys: (previous.sharedFilterKeys || []).filter((field) =>
              filterFields.includes(field),
            ),
          }
          edit(
            index == null
              ? [...slots, next]
              : slots.map((slot, slotIndex) => (slotIndex === index ? next : slot)),
          )
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }
      const button = (label, action, disabled = false) =>
        createElement(
          'button',
          { type: 'button', disabled: busy || disabled, onClick: action },
          label,
        )
      return createElement(
        'section',
        {
          'aria-label': 'Edit dashboard layout',
          style: { display: 'grid', gap: 10, marginTop: 12 },
        },
        createElement('h3', null, 'Layout and pinned revisions'),
        createElement(
          'p',
          null,
          'Changes are saved together. Shared filters restrict saved result rows only. Use Explore population filters to recalculate measures from source rows.',
        ),
        error ? createElement('p', { role: 'alert' }, error) : null,
        !data ? createElement('p', null, 'Loading layout…') : null,
        ...slots.map((slot, index) =>
          createElement(
            'fieldset',
            { key: slot.analysisId, disabled: busy, style: { minWidth: 0 } },
            createElement(
              'legend',
              null,
              `${index + 1}. ${analysisLabel({ title: slot.title?.length <= 200 ? slot.title : slot.chartTitle, question: slot.title })} · revision ${slot.revision}`,
            ),
            slot.artifactIds?.[0]
              ? createElement('img', {
                  src: `${FETCH_PATH}?id=${encodeURIComponent(slot.artifactIds[0])}&format=svg`,
                  alt: analysisLabel({
                    title: slot.title?.length <= 200 ? slot.title : slot.chartTitle,
                    question: slot.title,
                  }),
                  style: { width: '100%', maxHeight: 140, objectFit: 'contain' },
                })
              : null,
            createElement(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              button(
                `Open ${analysisLabel({ title: slot.title?.length <= 200 ? slot.title : slot.chartTitle, question: slot.title })} in Explore`,
                () => onOpen(slot.analysisId),
                dirty,
              ),
              button(
                `Move ${analysisLabel({ title: slot.title?.length <= 200 ? slot.title : slot.chartTitle, question: slot.title })} up`,
                () => move(index, -1),
                index === 0,
              ),
              button(
                `Move ${analysisLabel({ title: slot.title?.length <= 200 ? slot.title : slot.chartTitle, question: slot.title })} down`,
                () => move(index, 1),
                index === slots.length - 1,
              ),
              button(
                `Remove ${analysisLabel({ title: slot.title?.length <= 200 ? slot.title : slot.chartTitle, question: slot.title })}`,
                () => edit(slots.filter((_, item) => item !== index)),
              ),
            ),
            createElement(
              'label',
              null,
              'Width',
              createElement(
                'select',
                {
                  'aria-label': `Width for ${analysisLabel({ title: slot.title?.length <= 200 ? slot.title : slot.chartTitle, question: slot.title })}`,
                  value: slot.width || 1,
                  onChange: (event) =>
                    edit(
                      slots.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, width: Number(event.target.value) } : item,
                      ),
                    ),
                },
                createElement('option', { value: 1 }, 'One column'),
                createElement('option', { value: 2 }, 'Full width'),
              ),
            ),
            createElement(
              'fieldset',
              { style: { minWidth: 0 } },
              createElement('legend', null, 'Shared filter fields'),
              !(slot.filterFields || []).length
                ? createElement(
                    'p',
                    null,
                    slot.filterWarning || 'No result fields available for mapping.',
                  )
                : null,
              ...(slot.filterFields || []).map((field) =>
                createElement(
                  'label',
                  { key: field, style: { display: 'flex', gap: 6 } },
                  createElement('input', {
                    type: 'checkbox',
                    'aria-label': `${field} shared filter for ${analysisLabel({ title: slot.title?.length <= 200 ? slot.title : slot.chartTitle, question: slot.title })}`,
                    checked: (slot.sharedFilterKeys || []).includes(field),
                    onChange: (event) =>
                      edit(
                        slots.map((item, itemIndex) =>
                          itemIndex === index
                            ? {
                                ...item,
                                sharedFilterKeys: event.target.checked
                                  ? [...(item.sharedFilterKeys || []), field]
                                  : (item.sharedFilterKeys || []).filter((key) => key !== field),
                              }
                            : item,
                        ),
                      ),
                  }),
                  field,
                ),
              ),
            ),
            slot.latestRevision > slot.revision
              ? button(
                  `Review revision ${slot.latestRevision} for ${analysisLabel({ title: slot.title?.length <= 200 ? slot.title : slot.chartTitle, question: slot.title })}`,
                  () => chooseLatest(slot.analysisId, index),
                )
              : null,
          ),
        ),
        data
          ? createElement(
              'label',
              null,
              'Add a saved view',
              createElement(
                'select',
                {
                  'aria-label': 'Add saved view to dashboard',
                  value: '',
                  disabled: busy,
                  onChange: (event) => {
                    if (event.target.value) chooseLatest(event.target.value)
                  },
                },
                createElement('option', { value: '' }, 'Choose a view'),
                ...analyses
                  .filter((item) => !slots.some((slot) => slot.analysisId === item.analysisId))
                  .map((item) =>
                    createElement(
                      'option',
                      { key: item.analysisId, value: item.analysisId },
                      analysisLabel(item),
                    ),
                  ),
              ),
            )
          : null,
        dirty
          ? createElement(
              'div',
              { role: 'status', style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              'Unsaved layout changes',
              button('Save dashboard layout', save, slots.length === 0),
              button('Discard layout changes', () => {
                setSlots(data.slots)
                setDirty(false)
                setError(null)
              }),
            )
          : null,
      )
    }

    function displayKpi(value, decimals) {
      if (value == null) return 'No value'
      if (
        Number.isInteger(decimals) &&
        decimals >= 0 &&
        decimals <= 6 &&
        Number.isFinite(Number(value))
      ) {
        return Number(value).toFixed(decimals)
      }
      return String(value)
    }

    /**
     * Display formatting for a result cell, mirroring `dsh-data-core`'s
     * `formatDisplayCell` (this file is a plain browser script and cannot import
     * it). Grouping only: the table reads like the chart axis beside it, while
     * stored values and every download keep the original string.
     */
    function formatStudioCell(value) {
      if (value === null || value === undefined) return 'NULL'
      const text = typeof value === 'string' ? value : String(value)
      if (!/^-?\d+(?:\.\d+)?$/.test(text)) return text
      const [integer, fraction] = text.split('.')
      const digits = integer.replace('-', '')
      if (digits.length > 1 && digits.startsWith('0')) return text
      const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      return fraction === undefined ? grouped : `${grouped}.${fraction}`
    }

    function StudioTable({ result, onSelect, selectionDisabled }) {
      if (!result) return null
      const columns = (result.columns || []).map((column) =>
        typeof column === 'string' ? column : column.name,
      )
      return createElement(
        'div',
        { style: { overflowX: 'auto', maxHeight: 400, overflowY: 'auto' } },
        createElement(
          'table',
          { style: { borderCollapse: 'collapse', width: '100%', fontSize: 12 } },
          createElement(
            'caption',
            null,
            `${result.rowCount} result rows · showing ${result.rows.length ? result.offset + 1 : 0}–${result.offset + result.rows.length}`,
          ),
          createElement(
            'thead',
            null,
            createElement(
              'tr',
              null,
              ...(onSelect
                ? [createElement('th', { key: 'selection', scope: 'col' }, 'Select group')]
                : []),
              ...columns.map((column) =>
                createElement(
                  'th',
                  { key: column, scope: 'col', style: { textAlign: 'left', padding: 6 } },
                  column,
                ),
              ),
            ),
          ),
          createElement(
            'tbody',
            null,
            ...result.rows.map((row, index) =>
              createElement(
                'tr',
                { key: index },
                onSelect
                  ? createElement(
                      'td',
                      null,
                      createElement(
                        'button',
                        {
                          type: 'button',
                          disabled: selectionDisabled,
                          onClick: () => onSelect(row),
                          'aria-label': `Use result row ${result.offset + index + 1} as population filter`,
                        },
                        'Filter to group',
                      ),
                    )
                  : null,
                ...columns.map((column, cell) =>
                  createElement(
                    'td',
                    {
                      key: column,
                      style: {
                        padding: 6,
                        borderTop: '1px solid var(--dsw-alias-border-l3, #ddd)',
                      },
                    },
                    formatStudioCell(Array.isArray(row) ? row[cell] : row[column]),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    }

    function DataTabBody({ sessionId, useTabInfo } = {}) {
      const tabInfo = useTabInfo ? useTabInfo() : null
      const [overview, setOverview] = useState(null)
      const [selected, setSelected] = useState('')
      const [datasetId, setDatasetId] = useState('')
      const [view, setView] = useState(null)
      const [schema, setSchema] = useState(null)
      const [draft, setDraft] = useState(null)
      const [title, setTitle] = useState('')
      const [mode, setMode] = useState('Explore')
      const [dashboardId, setDashboardId] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [refresh, setRefresh] = useState(0)
      const [offset, setOffset] = useState(0)
      const [dirty, setDirty] = useState(false)
      const [stateReady, setStateReady] = useState(!sessionId)
      const [history, setHistory] = useState(null)
      const [dashboardDirty, setDashboardDirty] = useState(false)
      const [reviewPinId, setReviewPinId] = useState(null)
      const [reviewDirty, setReviewDirty] = useState(false)
      const [importJobId, setImportJobId] = useState(null)
      const [reviewNotice, setReviewNotice] = useState(null)
      const [formatDraft, setFormatDraft] = useState(null)
      const [reportRefresh, setReportRefresh] = useState(0)
      const [reviewStatusRefresh, setReviewStatusRefresh] = useState(0)
      // Source slug of the most recently observed ready/newly-published
      // import job, so the dataset picker can flag which entry just
      // changed without the analyst already knowing to look. Declared last
      // so existing numeric state-slot indices in tests stay stable.
      const [justPublishedSlug, setJustPublishedSlug] = useState(null)
      const restoredDraft = useRef(null)
      const draftRevision = useRef(null)
      const stateWrite = useRef(Promise.resolve())
      const stateSaveTimer = useRef(null)
      const persistState = (body) => {
        stateWrite.current = stateWrite.current
          .catch(() => {})
          .then(() => studioRequest('studio/state', body))
        return stateWrite.current
      }
      useEffect(() => {
        const id = tabInfo?.tab.navigation.params?.analysisId
        const pinId = tabInfo?.tab.navigation.params?.reviewPinId
        const jobId = tabInfo?.tab.navigation.params?.importJobId
        const requestedMode = tabInfo?.tab.navigation.params?.mode
        const validMode = ['Data', 'Explore', 'Dashboard', 'Report'].includes(requestedMode)
        if ((!id && !pinId && !jobId && !validMode) || !stateReady) return
        if (dirty || dashboardDirty || reviewDirty || restoredDraft.current) {
          setError('Apply or discard your draft before opening another analysis.')
          return
        }
        if (validMode) {
          const requestedDashboard = tabInfo?.tab.navigation.params?.dashboardId
          if (
            requestedMode === 'Dashboard' &&
            typeof requestedDashboard === 'string' &&
            /^dash_[a-z0-9]+$/i.test(requestedDashboard)
          )
            setDashboardId(requestedDashboard)
          setMode(requestedMode)
          if (requestedMode === 'Data') {
            setImportJobId(null)
            setReviewPinId(null)
            setRefresh((value) => value + 1)
          }
          return
        }
        if (jobId) {
          setImportJobId(jobId)
          setReviewPinId(null)
          setMode('Data')
          setRefresh((value) => value + 1)
          return
        }
        if (pinId) {
          setImportJobId(null)
          setReviewPinId(pinId)
          setMode('Data')
          setRefresh((value) => value + 1)
          return
        }
        setSelected(id)
        setOffset(0)
        setMode('Explore')
        // Opening an analysis by id (e.g. the "Open analysis in Studio"
        // receipt button after a chat-driven save_analysis) can name a
        // revision the already-open panel's cached `overview` predates —
        // that analysis was persisted after this panel last fetched the
        // list. Without this, the selector renders no matching <option> for
        // `selected` and falls back to the "Choose a saved view" placeholder
        // even though the analysis exists. Refresh the workspace overview
        // the same way the mode/job/pin branches above already do.
        setRefresh((value) => value + 1)
      }, [tabInfo?.tab.navigation.revision, stateReady])
      useEffect(() => {
        if (!sessionId) return undefined
        const controller = new AbortController()
        setStateReady(false)
        studioRequest(
          `studio/state?sessionId=${encodeURIComponent(sessionId)}`,
          null,
          controller.signal,
        )
          .then((state) => {
            if (controller.signal.aborted) return
            restoredDraft.current = state.draft || null
            const restoredAnalysisId = state.draft?.analysisId || state.analysisId || ''
            setSelected(restoredAnalysisId)
            setDatasetId(state.datasetId || '')
            if (!restoredAnalysisId && state.draft) {
              setDraft(state.draft.definition)
              setTitle(state.draft.title)
              setDirty(true)
              restoredDraft.current = null
            }
            setStateReady(true)
          })
          .catch((err) => {
            if (!controller.signal.aborted)
              setError(`Could not restore Studio state: ${err.message}`)
          })
        return () => controller.abort()
      }, [sessionId])
      useEffect(() => {
        if (!sessionId || !stateReady || busy || restoredDraft.current) return undefined
        const timer = setTimeout(() => {
          persistState({
            sessionId,
            analysisId: selected || null,
            datasetId: datasetId || null,
            draft:
              dirty && draft
                ? {
                    ...(selected
                      ? {
                          analysisId: selected,
                          expectedRevision: draftRevision.current || view?.analysis.revision,
                        }
                      : {}),
                    title,
                    definition: draft,
                  }
                : dirty && formatDraft && selected
                  ? {
                      analysisId: selected,
                      expectedRevision: draftRevision.current || view?.analysis.revision,
                      title,
                      presentation: formatDraft,
                    }
                  : null,
          }).catch((err) => setError(`Could not save Studio state: ${err.message}`))
        }, 300)
        stateSaveTimer.current = timer
        return () => clearTimeout(timer)
      }, [sessionId, stateReady, busy, selected, datasetId, dirty, draft, formatDraft, title, view])

      useEffect(() => {
        const controller = new AbortController()
        studioRequest('overview', null, controller.signal)
          .then(setOverview)
          .catch((err) => {
            if (!controller.signal.aborted) setError(err.message)
          })
        return () => controller.abort()
      }, [refresh])
      useEffect(() => {
        if (!selected || !stateReady) return undefined
        const controller = new AbortController()
        setBusy(true)
        studioRequest(
          `studio/analysis?analysisId=${encodeURIComponent(selected)}&offset=${offset}&limit=100`,
          null,
          controller.signal,
        )
          .then((value) => {
            if (controller.signal.aborted) return
            const storedDraft = restoredDraft.current
            if (storedDraft?.analysisId && storedDraft.analysisId !== value.analysis.analysisId) {
              setSelected(storedDraft.analysisId)
              setError(
                'Recovered draft belongs to another analysis. Opening that analysis before applying any changes.',
              )
              return
            }
            setView(value)
            setDatasetId(value.datasetId)
            const matchesSaved =
              storedDraft &&
              storedDraft.title === (value.analysis.chart.title || value.analysis.question) &&
              (storedDraft.presentation
                ? JSON.stringify(storedDraft.presentation) ===
                  JSON.stringify({
                    mark: value.analysis.chart.mark,
                    format: value.analysis.chart.format,
                  })
                : JSON.stringify(storedDraft.definition) === JSON.stringify(value.definition))
            const recovered = matchesSaved ? null : storedDraft
            draftRevision.current = recovered?.expectedRevision || value.analysis.revision
            setTitle(recovered?.title || value.analysis.chart.title || value.analysis.question)
            setDraft(recovered?.presentation ? null : recovered?.definition || value.definition)
            setFormatDraft(recovered?.presentation || null)
            setDirty(Boolean(recovered))
            if (
              recovered?.expectedRevision &&
              recovered.expectedRevision !== value.analysis.revision
            )
              setError(
                'A newer saved revision exists. Your recovered draft is retained; discard it to review the latest saved view.',
              )
            restoredDraft.current = null
          })
          .catch((err) => {
            if (!controller.signal.aborted) setError(err.message)
          })
          .finally(() => {
            if (!controller.signal.aborted) setBusy(false)
          })
        return () => controller.abort()
      }, [selected, refresh, offset, stateReady])
      useEffect(() => {
        if (!datasetId) return undefined
        const controller = new AbortController()
        setSchema(null)
        studioRequest(
          `studio/schema?datasetId=${encodeURIComponent(datasetId)}`,
          null,
          controller.signal,
        )
          .then((value) => {
            if (!controller.signal.aborted) setSchema(value)
          })
          .catch((err) => {
            if (!controller.signal.aborted) setError(err.message)
          })
        return () => controller.abort()
      }, [datasetId, refresh])
      const field = (label, value, options, onChange) =>
        createElement(
          'label',
          { style: { display: 'grid', gap: 8, fontSize: 14 } },
          label,
          createElement(
            'select',
            {
              'aria-label': label,
              value,
              disabled:
                busy ||
                ((dirty || dashboardDirty || reviewDirty) &&
                  ['Saved analysis', 'Published dataset', 'Dashboard'].includes(label)),
              onChange: (event) => onChange(event.target.value),
              style: { width: '100%', minWidth: 0, padding: 6 },
            },
            ...options.map((option) =>
              createElement('option', { key: option.value, value: option.value }, option.label),
            ),
          ),
        )
      const option = (value, label = value) => ({ value, label })
      // Mirrors dsh-data-workbench's studio-definition.ts describeFilter: one
      // human-readable summary shared by every place a population filter is
      // rendered as text (this file only re-implements it because it is a
      // standalone client bundle with no import from the server package).
      const describeFilter = (filter) => {
        const op = filter.op || 'eq'
        if (op === 'range') {
          const bounds = [
            filter.min !== undefined ? `>= ${String(filter.min)}` : null,
            filter.max !== undefined ? `<= ${String(filter.max)}` : null,
          ].filter((part) => part !== null)
          return `${filter.column} ${bounds.join(' and ')}`
        }
        if (op === 'in')
          return `${filter.column} in [${(filter.values || []).map(String).join(', ')}]`
        return `${filter.column} = ${String(filter.value)}`
      }
      const update = (patch) => {
        setDraft({ ...draft, ...patch })
        setDirty(true)
      }
      const choose = (id) => {
        // Dashboard mutations can advance the already selected analysis revision.
        if (id === selected) setRefresh((value) => value + 1)
        setSelected(id)
        setHistory(null)
        setOffset(0)
        setError(null)
        setView(null)
        setFormatDraft(null)
        setDraft(null)
        setTitle('')
        setDirty(false)
      }
      const tables = schema?.tables || []
      const table = tables.find((item) => item.id === draft?.table)
      const columns = table?.columns || []
      const start = (tableId) => {
        setFormatDraft(null)
        setDraft({
          datasetId,
          datasetVersionId: schema.datasetVersionId,
          semanticRevisionId: schema.semanticRevisionId,
          table: tableId,
          measure: { aggregation: 'count' },
          filters: [],
          mark: 'table',
        })
        setTitle('New analysis')
        setDirty(true)
      }
      const apply = async () => {
        clearTimeout(stateSaveTimer.current)
        let savedRevision = null
        setBusy(true)
        setError(null)
        try {
          const presentationOnly =
            selected &&
            ((!draft && formatDraft) ||
              (view?.definition &&
                JSON.stringify({ ...draft, mark: undefined, format: undefined }) ===
                  JSON.stringify({ ...view.definition, mark: undefined, format: undefined })))
          const saved = presentationOnly
            ? await studioRequest('charts/rechart', {
                analysisId: selected,
                expectedRevision: draftRevision.current || view.analysis.revision,
                mark: styleDraft.mark,
                title,
                ...(styleDraft.format ? { format: styleDraft.format } : {}),
              })
            : await studioRequest('studio/apply', {
                ...(selected
                  ? {
                      analysisId: selected,
                      expectedRevision: draftRevision.current || view.analysis.revision,
                    }
                  : {}),
                title,
                definition: draft,
              })
          savedRevision = saved.revision
          setSelected(saved.analysisId)
          draftRevision.current = saved.revision
          restoredDraft.current = null
          setDirty(false)
          if (sessionId) {
            await persistState({ sessionId, analysisId: saved.analysisId, datasetId, draft: null })
          }
          setOffset(0)
          setRefresh((value) => value + 1)
        } catch (err) {
          setError(
            savedRevision
              ? `Revision ${savedRevision} was saved, but session recovery state could not be cleared: ${err.message}. Refresh the workspace to review the saved view.`
              : err.message,
          )
        } finally {
          setBusy(false)
        }
      }
      const loadHistory = async () => {
        setBusy(true)
        setError(null)
        try {
          setHistory(
            await studioRequest(`studio/history?analysisId=${encodeURIComponent(selected)}`),
          )
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }
      const restore = async (revision) => {
        setBusy(true)
        setError(null)
        try {
          await studioRequest('studio/restore', {
            analysisId: selected,
            expectedRevision: view.analysis.revision,
            revision,
          })
          setHistory(null)
          setOffset(0)
          setRefresh((value) => value + 1)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }
      const analysis = view?.analysis
      const styleDraft = draft ||
        formatDraft || { mark: analysis?.chart.mark, format: analysis?.chart.format }
      const updateStyle = (format) => {
        if (draft) update({ format })
        else {
          setFormatDraft({ mark: styleDraft.mark, format })
          setDirty(true)
        }
      }
      const styleFormat = styleDraft.format || {}
      const editableColours =
        !['table', 'kpi', 'heatmap'].includes(styleDraft.mark) && !analysis?.chart.y2
      const hasSeries = Boolean(draft ? draft.series : analysis?.chart.series)
      const seriesField = draft
        ? draft.series && draft.series === view?.definition?.series
          ? analysis?.chart.series
          : undefined
        : analysis?.chart.series
      const seriesIndex = view?.result?.columns?.findIndex(
        (column) => (typeof column === 'string' ? column : column.name) === seriesField,
      )
      const seriesValues =
        seriesField && seriesIndex >= 0
          ? [
              ...new Set(
                (view.result.rows || [])
                  .map((row) => row[seriesIndex])
                  .filter((value) => value != null && String(value).length <= 200),
              ),
            ].slice(0, 20)
          : []
      const axisLabel = (key) =>
        (key === 'xLabel') !==
        (styleDraft.mark === 'bar' && styleFormat.orientation === 'horizontal')
          ? 'Horizontal axis label'
          : 'Vertical axis label'
      const marks = draft
        ? ['table', ...(draft.groupBy ? ['bar', 'line', 'point', 'area'] : ['kpi'])]
        : allowedMarksForChart(analysis?.chart, view?.result?.rowCount).filter(
            (mark) => mark !== 'kpi' || view?.result?.rowCount === 1,
          )
      const rechart = async (mark) => {
        if (dirty || !analysis) {
          if (draft) update({ mark })
          else {
            setFormatDraft({ ...styleDraft, mark })
            setDirty(true)
          }
          return
        }
        setBusy(true)
        setError(null)
        try {
          await studioRequest('charts/rechart', {
            analysisId: selected,
            expectedRevision: analysis.revision,
            mark,
          })
          setRefresh((value) => value + 1)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }
      const button = (text, onClick, disabled = false) =>
        createElement(
          'button',
          { type: 'button', onClick, disabled: busy || disabled, style: { padding: '6px 10px' } },
          text,
        )
      const valuesPanel = view
        ? createElement(
            'details',
            { open: analysis.chart.mark === 'table' || analysis.chart.mark === 'kpi' },
            createElement('summary', null, 'Inspect chart values and select a group'),
            createElement(StudioTable, {
              result: view.result,
              selectionDisabled: dirty || busy,
              onSelect:
                view.definition?.groupBy && !view.definition.groupBy.timeGrain
                  ? (row) => {
                      const column = view.definition.groupBy.column
                      const value = Array.isArray(row) ? row[0] : row.group
                      if (value == null) {
                        setError('NULL groups cannot be selected as an equality filter.')
                        return
                      }
                      const selectedFilters = [{ column, value }]
                      if (view.definition.series) {
                        const seriesValue = Array.isArray(row) ? row[1] : row.series
                        if (seriesValue == null) {
                          setError('NULL series cannot be selected as an equality filter.')
                          return
                        }
                        selectedFilters.push({
                          column: view.definition.series,
                          value: seriesValue,
                        })
                      }
                      const filters = [
                        ...draft.filters.filter(
                          (filter) =>
                            !selectedFilters.some(
                              (selectedFilter) => selectedFilter.column === filter.column,
                            ),
                        ),
                        ...selectedFilters,
                      ]
                      if (filters.length > 10) {
                        setError(
                          'This selection exceeds the 10-filter limit. Remove a population filter first.',
                        )
                        return
                      }
                      update({ filters })
                      setError(null)
                    }
                  : null,
            }),
            button(
              'Previous rows',
              () => setOffset(Math.max(0, offset - 100)),
              offset === 0 || dirty,
            ),
            button(
              'Next rows',
              () => setOffset(view.result.nextOffset),
              view.result.nextOffset == null || dirty,
            ),
          )
        : null
      return createElement(
        'section',
        {
          'aria-label': 'Analysis Studio',
          style: {
            padding: 14,
            overflow: 'auto',
            height: '100%',
            color: 'var(--dsw-alias-label-primary)',
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          },
        },
        createElement(
          'style',
          null,
          `[aria-label="Analysis Studio"] { font: 14px/1.55 system-ui,sans-serif; }
          [aria-label="Analysis Studio"], [aria-label="Analysis Studio"] * { box-sizing:border-box; }
          [aria-label="Analysis Studio"] section, [aria-label="Analysis Studio"] fieldset, [aria-label="Analysis Studio"] label, [aria-label="Analysis Studio"] select { min-width:0; }
          [aria-label="Analysis Studio"] legend { max-width:100%;overflow-wrap:anywhere; }
          [aria-label="Analysis Studio"] h2 { font-size:20px;line-height:1.25;margin:0 0 12px; }
          [aria-label="Analysis Studio"] h3 { font-size:16px;line-height:1.35;margin:0 0 8px; }
          [aria-label="Analysis Studio"] h4 { font-size:14px;margin:0 0 4px; }
          [aria-label="Analysis Studio"] p { margin:6px 0 12px; }
          [aria-label="Analysis Studio"] button, [aria-label="Analysis Studio"] select, [aria-label="Analysis Studio"] input { font:inherit;min-height:36px;border:1px solid var(--dsw-alias-border-l3,#aaa);border-radius:5px;padding:6px 10px;max-width:100%;color:inherit;background:var(--dsw-alias-bg-layer-2,Canvas); }
          [aria-label="Analysis Studio"] select, [aria-label="Analysis Studio"] option { color:var(--dsw-alias-label-primary,CanvasText);background-color:var(--dsw-alias-bg-layer-2,Canvas); }
          [aria-label="Analysis Studio"] button { cursor:pointer;font-weight:500; }
          /* Colour-coded review decisions: the positive action is filled with the
             theme's info colour, the negative one is outlined in its error colour, so
             a review pair is recognisable at a glance instead of two identical buttons. */
          [aria-label="Analysis Studio"] .studio-approve { background:var(--dsw-alias-state-info-primary,#3875cb);border-color:var(--dsw-alias-state-info-primary,#3875cb);color:#fff;font-weight:600; }
          [aria-label="Analysis Studio"] .studio-reject { background:transparent;border-color:var(--dsw-alias-state-error-primary,#f25a5a);color:var(--dsw-alias-state-error-primary,#f25a5a);font-weight:600; }
          [aria-label="Analysis Studio"] button:disabled { cursor:default;opacity:.5; }
          [aria-label="Analysis Studio"] :focus-visible { outline:2px solid var(--dsw-alias-state-info-primary,#3875cb);outline-offset:2px; }
          [aria-label="Analysis Studio"] summary { cursor:pointer;font-weight:600;padding:10px 0; }
          [aria-label="Analysis Studio"] fieldset { border:1px solid var(--dsw-alias-border-l3,#ccc);border-radius:8px;padding:12px; }
          .studio-toolbar { display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:12px 0; }
          [aria-label="Analysis Studio"] > details { border-top:1px solid var(--dsw-alias-border-l3,#ccc);padding-top:8px; }
          [aria-label="Analysis Studio"] label { display:grid;gap:8px;margin:8px 0; }
          [aria-label="Analysis Studio"] fieldset > label { margin:14px 0; }
          [aria-label="Analysis Studio"] .studio-colour-control { display:flex;align-items:center;gap:12px;flex-wrap:wrap; }
          [aria-label="Analysis Studio"] input[type="color"] { width:54px;height:38px;padding:3px;flex:none; }
          .studio-colour-control span { font-size:12px;color:var(--dsw-alias-label-secondary); }
          .studio-colour-list { display:grid;gap:6px; }
          .studio-search { display:grid;gap:4px;max-width:24rem; }
          .studio-table-group,.studio-review-card { margin:16px 0;padding:12px;border:1px solid var(--dsw-alias-border-l3,#ccc);border-radius:8px; }
          .studio-table-scroll { overflow:auto;max-height:460px; }
          /* Sticky decision footer for the column review. It spans the review card's
             own padding (negative margins) so the grid scrolls *under* an opaque bar
             instead of beside a strip with transparent gutters, and it carries real
             padding, a labelled left side and the primary action at the trailing
             edge. Previously it was a bare 10px-tall strip whose two buttons were
             separated by a stray space text node. */
          .studio-actionbar { position:sticky;bottom:0;z-index:3;display:flex;flex-wrap:wrap;gap:12px 16px;align-items:center;justify-content:space-between;margin:18px -12px -12px;padding:12px;background:var(--dsw-alias-bg-layer-2,Canvas);border-top:1px solid var(--dsw-alias-border-l3,#ccc);border-radius:0 0 8px 8px;box-shadow:0 -8px 16px -14px rgba(0,0,0,.55); }
          .studio-actionbar-label { font-size:12px;color:var(--dsw-alias-label-secondary);flex:1 1 12rem;min-width:0; }
          .studio-actionbar-buttons { display:flex;gap:10px;align-items:center;flex:0 0 auto; }
          .studio-actionbar-buttons button { min-width:104px; }
          @media(max-width:600px) { .studio-actionbar { margin:14px -8px -8px;padding:10px 8px;gap:10px; } .studio-actionbar-buttons { width:100%; } .studio-actionbar-buttons button { flex:1 1 0;min-width:0; } }
          .studio-column-review thead th { position:sticky;top:0;background:var(--dsw-alias-bg-layer-2,Canvas);z-index:1; }
          .studio-review-status { border:1px solid var(--dsw-alias-border-l3,#ccc);border-radius:6px;padding:8px 10px; }
          .studio-review-status .studio-toolbar { margin:0;justify-content:flex-start; }
          .studio-review-status p { margin-bottom:0; }
          .studio-column-review table { border-collapse:collapse;width:100%;min-width:360px;text-align:left; }
          .studio-column-review th,.studio-column-review td { padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l3,#ddd);vertical-align:top;text-align:left; }
          .studio-column-review thead { background:var(--dsw-alias-interactive-bg-hover,#8881); }
          .studio-column-review small { display:block;font-weight:normal;margin-top:4px; }
          .studio-column-review [data-changed="true"] { background:var(--dsw-alias-interactive-bg-hover,#8881); }
          .studio-muted { color:var(--dsw-alias-label-secondary); }
          .studio-sr-only { position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%); }
          [aria-label="Analysis Studio"] section[aria-label="Pin analysis"], [aria-label="Analysis Studio"] form[data-analyst-action="map-keys"] { display:none; }
          @media(max-width:600px) { .studio-table-group,.studio-review-card { padding:8px; } }`,
        ),
        createElement(
          'header',
          null,
          // The sidebar tab above already names the panel; a second h2 gave the
          // pane two competing top-level headings.
          createElement(
            'p',
            { style: { fontSize: 12, margin: 0 } },
            'Explore data and refine saved views directly. Changes use the same published dataset.',
          ),
        ),
        createElement(
          'nav',
          { 'aria-label': 'Studio modes', style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
          ...['Data', 'Explore', 'Dashboard', 'Report'].map((name) =>
            createElement(
              'button',
              {
                key: name,
                type: 'button',
                'aria-pressed': mode === name,
                style: {
                  padding: '6px 10px',
                  borderRadius: 4,
                  border: mode === name ? '2px solid currentColor' : '2px solid transparent',
                  fontWeight: mode === name ? 700 : 400,
                  background:
                    mode === name
                      ? 'color-mix(in srgb, currentColor 10%, transparent)'
                      : 'transparent',
                },
                disabled: (dirty || dashboardDirty || reviewDirty) && mode !== name,
                onClick: () => setMode(name),
              },
              name,
            ),
          ),
        ),
        createElement(StudioReviewStatus, {
          active: tabInfo?.tab.visible !== false,
          onRefreshRequested: () => setRefresh((value) => value + 1),
          refreshKey: `${refresh}:${reviewStatusRefresh}`,
          blocked: dirty || dashboardDirty || reviewDirty,
          onOpen: () => {
            if (dirty || dashboardDirty || reviewDirty) return
            setMode('Data')
            setReviewPinId(null)
            setImportJobId(null)
            setRefresh((value) => value + 1)
          },
          onChanged: (value) => {
            // Background job-status change (typically an agent-driven
            // ingest_dataset finishing outside a click in this sidebar).
            // Same "never replaces an open review or a draft" rule the
            // manual Refresh workspace button already enforces (it is
            // disabled while dirty) — skip the auto-refresh rather than
            // clobber unsaved work; the poll will catch it on the next tick
            // once the draft is applied or discarded.
            if (dirty || dashboardDirty || reviewDirty) return
            setRefresh((count) => count + 1)
            const latest = (value?.imports || [])[0]
            if (!latest) return
            const label = latest.slug || 'Import'
            if (latest.status === 'ready') {
              setReviewNotice(`${label} is now published — choose it below to explore.`)
              setJustPublishedSlug(latest.slug || null)
            } else if (latest.status === 'failed' || latest.status === 'cancelled') {
              setReviewNotice(`${label} ${latest.status}. See Recent imports for details.`)
            } else if (latest.status === 'needs-input') {
              setReviewNotice(`${label} needs input before it can finish. See Recent imports.`)
            } else {
              // queued / downloading / validating / loading / profiling —
              // any other transitional job status: not a final published/
              // failed state, but still worth telling the analyst ingestion
              // is progressing instead of leaving the pre-ingest approval
              // notice showing as if nothing has happened yet.
              setReviewNotice(`${label} is ingesting (${latest.status})…`)
            }
          },
        }),
        button(
          'Refresh workspace',
          () => {
            setError(null)
            setRefresh((value) => value + 1)
          },
          // Never disabled: refreshing metadata is how the analyst finds out a proposal
          // or dashboard moved elsewhere, and it is exactly when they have unsaved work
          // that they need to know. Nothing is discarded — column drafts live on the
          // server and dashboard pins are revision-checked — and a stale write is still
          // rejected by the route.
          false,
        ),
        error ? createElement('p', { role: 'alert' }, error) : null,
        mode === 'Data' && reviewNotice
          ? createElement('p', { role: 'status' }, reviewNotice)
          : null,
        busy ? createElement('p', { role: 'status' }, 'Loading or saving…') : null,
        !overview ? createElement('p', null, 'Loading workspace…') : null,
        mode !== 'Data'
          ? field(
              'Saved analysis',
              selected,
              [
                option('', 'Choose a saved view'),
                ...(overview?.analyses || []).map((item) =>
                  option(item.analysisId, `${analysisLabel(item)} · revision ${item.revision}`),
                ),
              ],
              choose,
            )
          : null,
        mode !== 'Data' && dirty
          ? createElement(
              'p',
              { role: 'status' },
              'Draft changes · Apply to save a new revision, or Discard before changing views.',
            )
          : mode !== 'Data' && analysis
            ? createElement(
                'p',
                null,
                `Saved revision ${analysis.revision} · ${view.result.rowCount} result rows`,
              )
            : null,
        schema?.columnsTruncated
          ? button('Load more fields', async () => {
              setBusy(true)
              setError(null)
              try {
                const next = await studioRequest(
                  `studio/schema?datasetId=${encodeURIComponent(datasetId)}&offset=${schema.nextOffset}`,
                )
                setSchema({
                  ...next,
                  tables: next.tables.map((table) => ({
                    ...table,
                    columns: [
                      ...(schema.tables.find((previous) => previous.id === table.id)?.columns ||
                        []),
                      ...(table.columns || []),
                    ],
                  })),
                })
              } catch (err) {
                setError(err.message)
              } finally {
                setBusy(false)
              }
            })
          : null,
        mode === 'Data'
          ? createElement(
              'div',
              null,
              createElement(StudioInbox, {
                sessionId,
                refreshKey: refresh,
                reviewPinId,
                importJobId,
                onDirty: setReviewDirty,
                onStatusChanged: () => setReviewStatusRefresh((value) => value + 1),
                onReviewed: (review) => {
                  setReviewNotice(
                    review?.kind === 'source'
                      ? review.status === 'approved'
                        ? 'Source approved. Ask the agent to ingest when ready.'
                        : 'Source rejected. The proposal was not published.'
                      : review?.status === 'ready'
                        ? 'Dataset published and ready to explore.'
                        : 'Import review saved.',
                  )
                  setReviewDirty(false)
                  setRefresh((value) => value + 1)
                },
              }),
              field(
                'Published dataset',
                datasetId,
                [
                  option('', 'Choose a dataset'),
                  // Sort the just-published dataset first and prefix it, so
                  // a publish that finished via an agent tool call (not a
                  // click in this sidebar) is visible without already
                  // knowing which entry to look for.
                  ...[...(overview?.datasets || [])]
                    .sort((a, b) =>
                      a.sourceSlug === justPublishedSlug
                        ? -1
                        : b.sourceSlug === justPublishedSlug
                          ? 1
                          : 0,
                    )
                    .map((item) =>
                      option(
                        item.datasetId,
                        item.sourceSlug === justPublishedSlug
                          ? `● New — ${item.sourceSlug || item.datasetId}`
                          : item.sourceSlug || item.datasetId,
                      ),
                    ),
                ],
                (id) => {
                  setDatasetId(id)
                  setSelected('')
                  setView(null)
                  setDraft(null)
                  setJustPublishedSlug(null)
                },
              ),
              ...tables.map((item) =>
                createElement(
                  'details',
                  { key: item.id, style: { marginTop: 12 } },
                  createElement('summary', null, `${item.id} · ${item.rows ?? 'unknown'} rows`),
                  createElement(
                    'ul',
                    null,
                    ...(item.columns || []).map((column) =>
                      createElement('li', { key: column.name }, `${column.name} · ${column.type}`),
                    ),
                  ),
                  button(
                    'Explore this table',
                    () => {
                      setSelected('')
                      setView(null)
                      start(item.id)
                      setMode('Explore')
                    },
                    dirty,
                  ),
                ),
              ),
              createElement(
                'p',
                null,
                'Schema types describe storage, not business meaning. Choose aggregations only when they match the measure.',
              ),
            )
          : null,
        mode === 'Explore'
          ? createElement(
              'div',
              { style: { display: 'grid', gap: 12 } },
              analysis
                ? createElement(
                    'p',
                    { style: { fontSize: 12, margin: 0 } },
                    view.definition?.filters?.length
                      ? `Saved population: ${view.definition.filters.map((filter) => describeFilter(filter)).join('; ')}`
                      : 'Saved population: see query provenance for SQL views; field-defined views use all rows.',
                    dirty ? ' · Preview shows the saved view until Apply.' : '',
                  )
                : null,
              analysis?.chart.mark === 'table' ? valuesPanel : null,
              analysis?.chart.mark === 'kpi' && view.result.rowCount === 1
                ? createElement(
                    'div',
                    {
                      role: 'status',
                      style: {
                        padding: 18,
                        border: '1px solid var(--dsw-alias-border-l3, #ddd)',
                        borderRadius: 8,
                      },
                    },
                    createElement('p', null, analysis.chart.title || analysis.question),
                    createElement(
                      'strong',
                      { style: { fontSize: 32 } },
                      displayKpi(
                        Array.isArray(view.result.rows[0])
                          ? view.result.rows[0][
                              view.result.columns.findIndex(
                                (column) =>
                                  (typeof column === 'string' ? column : column.name) ===
                                  (analysis.chart.y || 'value'),
                              )
                            ]
                          : view.result.rows[0]?.[analysis.chart.y || 'value'],
                        analysis.chart.format?.decimals,
                      ),
                    ),
                  )
                : null,
              analysis?.artifactIds?.[0] &&
                analysis.chart.mark !== 'table' &&
                analysis.chart.mark !== 'kpi'
                ? createElement('img', {
                    src: `${FETCH_PATH}?id=${encodeURIComponent(analysis.artifactIds[0])}&format=svg`,
                    alt: analysis.chart.title || analysis.question,
                    style: { width: '100%', height: 'auto' },
                  })
                : null,
              analysis
                ? createElement(
                    'div',
                    { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                    button('Revision history', loadHistory, dirty),
                    button(
                      'Restore previous saved revision',
                      () => restore(analysis.revision - 1),
                      dirty || analysis.revision <= 1,
                    ),
                  )
                : null,
              history && history.analysisId === selected
                ? createElement(
                    'details',
                    { open: true },
                    createElement('summary', null, 'Saved revisions'),
                    createElement(
                      'p',
                      null,
                      'Restoring a revision creates a new revision and keeps all history.',
                    ),
                    ...history.revisions.map((item) =>
                      createElement(
                        'div',
                        {
                          key: item.revision,
                          style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
                        },
                        createElement(
                          'span',
                          null,
                          `Revision ${item.revision} · ${item.mark} · ${item.question}`,
                        ),
                        button(
                          `Restore revision ${item.revision}`,
                          () => restore(item.revision),
                          dirty || item.revision === analysis.revision,
                        ),
                      ),
                    ),
                  )
                : null,
              draft
                ? createElement(
                    'p',
                    { style: { fontSize: 12 } },
                    !draft.groupBy
                      ? 'Suggested display: KPI for one aggregate; table for exact values.'
                      : /DATE|TIME/i.test(
                            columns.find((column) => column.name === draft.groupBy.column)?.type ||
                              '',
                          )
                        ? 'Suggested display: line for a time trend; table for exact dates and values.'
                        : 'Suggested display: bar to compare groups; table for exact values.',
                    ' Numeric fields can be identifiers. Confirm the measure meaning before selecting an aggregation.',
                  )
                : null,
              !draft && schema && analysis
                ? createElement(
                    'div',
                    null,
                    createElement(
                      'p',
                      null,
                      'This saved SQL view has no editable field definition. Choose a table to replace its query explicitly.',
                    ),
                    field(
                      'Start field definition',
                      '',
                      [option('', 'Choose a table'), ...tables.map((item) => option(item.id))],
                      start,
                    ),
                  )
                : null,
              dirty && draft
                ? createElement(
                    'div',
                    { role: 'status', style: { fontSize: 12 } },
                    createElement(
                      'p',
                      null,
                      draft.filters.length
                        ? `Draft population: ${draft.filters.map((filter) => describeFilter(filter)).join('; ')}. Apply to save changes; Discard to keep the saved view.`
                        : 'Draft population: all rows. Apply to save changes; Discard to keep the saved view.',
                    ),
                    ...draft.filters.map((filter) =>
                      button(`Remove filter ${filter.column}`, () =>
                        update({
                          filters: draft.filters.filter((item) => item.column !== filter.column),
                        }),
                      ),
                    ),
                  )
                : null,
              draft
                ? createElement(
                    'details',
                    { open: !analysis },
                    createElement('summary', null, 'Edit fields and population filters'),
                    createElement(
                      'fieldset',
                      { disabled: busy, style: { display: 'grid', gap: 10, minWidth: 0 } },
                      createElement('legend', null, 'Data · changes apply before aggregation'),
                      field(
                        'Table',
                        draft.table,
                        tables.map((item) => option(item.id)),
                        start,
                      ),
                      field(
                        'Aggregation',
                        draft.measure.aggregation,
                        ['count', 'sum', 'avg', 'min', 'max'].map((value) => option(value)),
                        (value) =>
                          update({
                            measure:
                              value === 'count'
                                ? { aggregation: 'count' }
                                : { ...draft.measure, aggregation: value },
                          }),
                      ),
                      draft.measure.aggregation !== 'count'
                        ? field(
                            'Measure',
                            draft.measure.column || '',
                            [
                              option('', 'Choose a measure'),
                              ...columns
                                .filter((column) =>
                                  /INT|DECIMAL|DOUBLE|FLOAT|REAL|NUMERIC/i.test(column.type),
                                )
                                .map((column) =>
                                  option(column.name, `${column.name} (${column.type})`),
                                ),
                            ],
                            (column) => update({ measure: { ...draft.measure, column } }),
                          )
                        : null,
                      field(
                        'Group by',
                        draft.groupBy?.column || '',
                        [
                          option('', 'No grouping · single value'),
                          ...columns.map((column) => option(column.name)),
                        ],
                        (column) =>
                          update({
                            groupBy: column ? { column } : undefined,
                            series: undefined,
                            mark: column ? 'bar' : 'kpi',
                          }),
                      ),
                      draft.groupBy &&
                        /DATE|TIME/i.test(
                          columns.find((column) => column.name === draft.groupBy.column)?.type ||
                            '',
                        )
                        ? field(
                            'Time grain',
                            draft.groupBy.timeGrain || '',
                            [
                              option('', 'Exact date'),
                              ...['day', 'month', 'year'].map((value) => option(value)),
                            ],
                            (timeGrain) =>
                              update({
                                groupBy: {
                                  column: draft.groupBy.column,
                                  ...(timeGrain ? { timeGrain } : {}),
                                },
                              }),
                          )
                        : null,
                      draft.groupBy
                        ? field(
                            'Series',
                            draft.series || '',
                            [
                              option('', 'No series'),
                              ...columns
                                .filter((column) => column.name !== draft.groupBy.column)
                                .map((column) => option(column.name)),
                            ],
                            (series) =>
                              update({
                                series: series || undefined,
                                format: { ...draft.format, seriesColors: [] },
                              }),
                          )
                        : null,
                      field(
                        'Population filter field',
                        draft.filters[0]?.column || '',
                        [
                          option('', 'All source rows'),
                          ...columns.map((column) => option(column.name)),
                        ],
                        (column) =>
                          update({
                            filters: column
                              ? [
                                  {
                                    column,
                                    value: /^(BOOL|BOOLEAN)$/i.test(
                                      columns.find((item) => item.name === column)?.type || '',
                                    )
                                      ? true
                                      : '',
                                  },
                                  ...draft.filters
                                    .slice(1)
                                    .filter((filter) => filter.column !== column),
                                ]
                              : [],
                          }),
                      ),
                      ...(() => {
                        if (!draft.filters.length) return [null]
                        const activeFilter = draft.filters[0]
                        const restFilters = draft.filters.slice(1)
                        const activeType =
                          columns.find((item) => item.name === activeFilter.column)?.type || ''
                        const isBooleanFilter = /^(BOOL|BOOLEAN)$/i.test(activeType)
                        const isRangeEligible =
                          /INT|DECIMAL|DOUBLE|FLOAT|REAL|NUMERIC/i.test(activeType) ||
                          /^(DATE|TIMESTAMP)/i.test(activeType)
                        const isDateFilter = /^(DATE|TIMESTAMP)/i.test(activeType)
                        const isNumericFilter = /INT|DECIMAL|DOUBLE|FLOAT|REAL|NUMERIC/i.test(
                          activeType,
                        )
                        const op = isBooleanFilter ? 'eq' : activeFilter.op || 'eq'
                        const inputType = isDateFilter
                          ? 'date'
                          : isNumericFilter
                            ? 'number'
                            : 'text'
                        if (isBooleanFilter) {
                          return [
                            field(
                              'Filter value',
                              String(activeFilter.value),
                              [option('true'), option('false')],
                              (value) =>
                                update({
                                  filters: [
                                    { column: activeFilter.column, value: value === 'true' },
                                    ...restFilters,
                                  ],
                                }),
                            ),
                          ]
                        }
                        return [
                          field(
                            'Filter type',
                            op,
                            [
                              option('eq', 'Equals'),
                              isRangeEligible
                                ? option('range', 'Range')
                                : option('in', 'Multiple values'),
                            ],
                            (nextOp) =>
                              update({
                                filters: [
                                  nextOp === 'range'
                                    ? { column: activeFilter.column, op: 'range', min: '', max: '' }
                                    : nextOp === 'in'
                                      ? { column: activeFilter.column, op: 'in', values: [] }
                                      : { column: activeFilter.column, value: '' },
                                  ...restFilters,
                                ],
                              }),
                          ),
                          op === 'range'
                            ? createElement(
                                'div',
                                { style: { display: 'grid', gap: 8 } },
                                createElement(
                                  'label',
                                  null,
                                  'At least (optional)',
                                  createElement('input', {
                                    'aria-label': 'Range minimum',
                                    type: inputType,
                                    value: activeFilter.min ?? '',
                                    onChange: (event) =>
                                      update({
                                        filters: [
                                          {
                                            ...activeFilter,
                                            min:
                                              event.target.value === ''
                                                ? undefined
                                                : event.target.value,
                                          },
                                          ...restFilters,
                                        ],
                                      }),
                                    style: { width: '100%' },
                                  }),
                                ),
                                createElement(
                                  'label',
                                  null,
                                  isDateFilter
                                    ? 'At most (optional, includes the whole day)'
                                    : 'At most (optional)',
                                  createElement('input', {
                                    'aria-label': 'Range maximum',
                                    type: inputType,
                                    value: activeFilter.max ?? '',
                                    onChange: (event) =>
                                      update({
                                        filters: [
                                          {
                                            ...activeFilter,
                                            max:
                                              event.target.value === ''
                                                ? undefined
                                                : event.target.value,
                                          },
                                          ...restFilters,
                                        ],
                                      }),
                                    style: { width: '100%' },
                                  }),
                                ),
                              )
                            : op === 'in'
                              ? createElement(
                                  'label',
                                  null,
                                  'Values (one per line, up to 50)',
                                  createElement('textarea', {
                                    'aria-label': 'Filter values',
                                    value: (activeFilter.values || []).join('\n'),
                                    onChange: (event) =>
                                      update({
                                        filters: [
                                          {
                                            ...activeFilter,
                                            values: event.target.value
                                              .split('\n')
                                              .map((line) => line.trim())
                                              .filter((line) => line.length > 0)
                                              .slice(0, 50),
                                          },
                                          ...restFilters,
                                        ],
                                      }),
                                    style: { width: '100%', minHeight: 60 },
                                  }),
                                )
                              : createElement(
                                  'label',
                                  null,
                                  'Equals',
                                  createElement('input', {
                                    'aria-label': 'Filter value',
                                    type: inputType,
                                    value: String(activeFilter.value ?? ''),
                                    onChange: (event) =>
                                      update({
                                        filters: [
                                          { ...activeFilter, value: event.target.value },
                                          ...restFilters,
                                        ],
                                      }),
                                    style: { width: '100%' },
                                  }),
                                ),
                        ]
                      })(),
                    ),
                  )
                : null,
              createElement(
                'label',
                null,
                'Chart title',
                createElement('input', {
                  'aria-label': 'Chart title',
                  value: title,
                  disabled: (!draft && !analysis) || busy,
                  onChange: (event) => {
                    if (!draft) setFormatDraft(styleDraft)
                    setTitle(event.target.value)
                    setDirty(true)
                  },
                  style: { width: '100%', boxSizing: 'border-box' },
                }),
              ),
              draft || analysis
                ? field(
                    'Display',
                    styleDraft.mark,
                    marks.map((value) => option(value)),
                    rechart,
                  )
                : null,
              draft || analysis
                ? createElement(
                    'details',
                    null,
                    createElement('summary', null, 'Format chart'),
                    createElement(
                      'p',
                      { className: 'studio-muted' },
                      editableColours
                        ? 'Suggested: one restrained blue for a single measure; colourblind-friendly colours for distinct series. Colour is a presentation choice, not a new data meaning.'
                        : 'This display uses its template colours. Axis and number formatting remain available where applicable.',
                    ),
                    editableColours
                      ? button('Use suggested colours', () =>
                          updateStyle({
                            ...styleFormat,
                            color: '#0072B2',
                            palette: 'colorblind',
                            seriesColors: [],
                          }),
                        )
                      : null,
                    styleDraft.mark === 'bar'
                      ? field(
                          'Bar orientation',
                          styleFormat.orientation || 'vertical',
                          [
                            option('vertical', 'Vertical'),
                            option('horizontal', 'Horizontal · long category labels'),
                          ],
                          (orientation) => updateStyle({ ...styleFormat, orientation }),
                        )
                      : null,
                    !['kpi', 'table'].includes(styleDraft.mark)
                      ? field(
                          'Group / X field ticks',
                          styleFormat.xTicks || 'auto',
                          [
                            option('auto', 'Automatic'),
                            option('integer', 'Whole numbers'),
                            option('year', 'Year · no thousands separator'),
                          ],
                          (xTicks) => updateStyle({ ...styleFormat, xTicks }),
                        )
                      : null,
                    !hasSeries &&
                      !['table', 'kpi', 'heatmap'].includes(styleDraft.mark) &&
                      !analysis?.chart.y2
                      ? createElement(
                          'label',
                          { className: 'studio-colour-control' },
                          'Mark colour',
                          createElement('input', {
                            type: 'color',
                            'aria-label': 'Mark colour',
                            onInput: (event) =>
                              updateStyle({ ...styleFormat, color: event.target.value }),
                            value: styleFormat.color || '#4c78a8',
                            disabled: busy,
                            onChange: (event) =>
                              updateStyle({ ...styleFormat, color: event.target.value }),
                          }),
                          createElement('span', null, styleFormat.color || '#4c78a8'),
                        )
                      : null,
                    seriesValues.length
                      ? createElement(
                          'fieldset',
                          { className: 'studio-colour-list' },
                          createElement('legend', null, 'Series colours'),
                          createElement(
                            'p',
                            null,
                            'Edit up to 20 series in this values page. Explicit choices stay attached to their values when filtering.',
                          ),
                          ...seriesValues.map((value, index) => {
                            const chosen = styleFormat.seriesColors?.find(
                              (item) => item.value === value,
                            )?.color
                            const fallback = [
                              '#0072B2',
                              '#E69F00',
                              '#009E73',
                              '#CC79A7',
                              '#56B4E9',
                              '#D55E00',
                              '#F0E442',
                              '#000000',
                            ][index % 8]
                            const setSeriesColour = (event) =>
                              updateStyle({
                                ...styleFormat,
                                seriesColors: [
                                  ...(styleFormat.seriesColors || []).filter(
                                    (item) => item.value !== value,
                                  ),
                                  { value, color: event.target.value },
                                ],
                              })
                            return createElement(
                              'label',
                              { key: JSON.stringify(value), className: 'studio-colour-control' },
                              String(value),
                              createElement('input', {
                                type: 'color',
                                'aria-label': `Colour for ${String(value)}`,
                                value: chosen || fallback,
                                disabled:
                                  busy ||
                                  (!chosen && (styleFormat.seriesColors?.length || 0) >= 20),
                                onInput: setSeriesColour,
                                onChange: setSeriesColour,
                              }),
                              createElement('span', null, chosen || 'Suggested · not applied'),
                            )
                          }),
                        )
                      : null,

                    createElement(
                      'p',
                      null,
                      'Display rounding does not change exact values or query results.',
                    ),
                    ...(['table', 'kpi'].includes(styleDraft.mark) ? [] : ['xLabel', 'yLabel']).map(
                      (key) =>
                        createElement(
                          'label',
                          { key, style: { display: 'grid', gap: 4 } },
                          axisLabel(key),
                          createElement('input', {
                            'aria-label': axisLabel(key),
                            value: styleDraft.format?.[key] || '',
                            disabled: busy,
                            maxLength: 120,
                            onChange: (event) =>
                              updateStyle({ ...styleDraft.format, [key]: event.target.value }),
                            style: { width: '100%', boxSizing: 'border-box' },
                          }),
                        ),
                    ),
                    styleDraft.mark !== 'heatmap'
                      ? field(
                          'Decimal places',
                          styleDraft.format?.decimals == null
                            ? ''
                            : String(styleDraft.format.decimals),
                          [
                            option('', 'Automatic'),
                            ...[0, 1, 2, 3, 4, 5, 6].map((value) => option(String(value))),
                          ],
                          (value) =>
                            updateStyle({
                              ...styleDraft.format,
                              decimals: value === '' ? undefined : Number(value),
                            }),
                        )
                      : null,
                    hasSeries
                      ? field(
                          'Color palette',
                          styleDraft.format?.palette || 'tableau10',
                          [
                            option('tableau10', 'Tableau'),
                            option('colorblind', 'Colorblind-friendly'),
                            option('dark2', 'Dark contrast'),
                          ],
                          (palette) => updateStyle({ ...styleDraft.format, palette }),
                        )
                      : null,
                    hasSeries
                      ? field(
                          'Legend',
                          styleDraft.format?.legend || 'right',
                          ['right', 'bottom', 'none'].map((value) => option(value)),
                          (legend) => updateStyle({ ...styleDraft.format, legend }),
                        )
                      : null,
                  )
                : null,
              dirty
                ? createElement(
                    'div',
                    { style: { display: 'flex', gap: 8 } },
                    button(
                      'Apply changes',
                      apply,
                      (!draft && !formatDraft) ||
                        !title ||
                        Boolean(
                          draft && draft.measure.aggregation !== 'count' && !draft.measure.column,
                        ),
                    ),
                    button('Discard changes', async () => {
                      clearTimeout(stateSaveTimer.current)
                      setBusy(true)
                      setError(null)
                      try {
                        if (sessionId)
                          await persistState({
                            sessionId,
                            analysisId: selected || null,
                            datasetId: datasetId || null,
                            draft: null,
                          })
                        restoredDraft.current = null
                        draftRevision.current = analysis?.revision || null
                        setDraft(view?.definition || null)
                        setFormatDraft(null)
                        setTitle(analysis?.chart.title || analysis?.question || '')
                        setDirty(false)
                      } catch (err) {
                        setError(`Could not discard saved draft: ${err.message}`)
                      } finally {
                        setBusy(false)
                      }
                    }),
                  )
                : null,
              analysis?.chart.mark !== 'table' ? valuesPanel : null,
              view?.evidence
                ? createElement(
                    'details',
                    null,
                    createElement('summary', null, 'Verified result facts'),
                    createElement('p', null, view.evidence.scope),
                    ...view.evidence.facts.map((fact) =>
                      createElement(
                        'p',
                        { key: fact.column },
                        `${fact.column}: minimum ${fact.minimum}; maximum ${fact.maximum}; ${fact.nonNullCount} non-null values.`,
                      ),
                    ),
                    ...view.evidence.warnings.map((warning, index) =>
                      createElement('p', { key: index }, warning),
                    ),
                  )
                : null,
              analysis
                ? createElement(
                    'details',
                    null,
                    createElement('summary', null, 'Query and provenance'),
                    createElement(
                      'p',
                      null,
                      `Dataset version: ${analysis.datasetVersionId} · semantic revision: ${analysis.semanticRevisionId}`,
                    ),
                    createElement('p', null, JSON.stringify(view.source)),
                    createElement(
                      'pre',
                      { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
                      analysis.query?.sql || analysis.sql,
                    ),
                    createElement(
                      'p',
                      null,
                      'Result rows are query output, not the source population. Filters in the editor are applied before aggregation.',
                    ),
                  )
                : null,
            )
          : null,
        mode === 'Dashboard'
          ? createElement(
              'div',
              null,
              field(
                'Dashboard',
                dashboardId,
                [
                  option('', 'Choose a dashboard'),
                  ...(overview?.dashboards || []).map((item) =>
                    option(item.dashboardId, item.title),
                  ),
                ],
                setDashboardId,
              ),
              dashboardId
                ? createElement(StudioDashboard, {
                    dashboardId,
                    refreshKey: refresh,
                    analyses: overview?.analyses || [],
                    onSaved: () => setRefresh((value) => value + 1),
                    onDirty: setDashboardDirty,
                    onOpen: (id) => {
                      choose(id)
                      setMode('Explore')
                    },
                  })
                : null,
              dashboardId
                ? createElement(FragmentToolRow, {
                    url: `/api/analyst/ui/dashboard?dashboardId=${encodeURIComponent(dashboardId)}&studio=true`,
                    label: 'Dashboard composition',
                    refreshKey: refresh,
                    disabled: dashboardDirty,
                    onMutation: () => setRefresh((value) => value + 1),
                    onExport: () => setReportRefresh((value) => value + 1),
                  })
                : null,
            )
          : null,
        mode === 'Report'
          ? createElement(
              'div',
              null,
              createElement(
                'p',
                null,
                'Reports use the selected saved revision. Apply draft changes before exporting.',
              ),
              createElement(RecentReports, { refreshKey: `${refresh}:${reportRefresh}` }),
              analysis
                ? createElement(FragmentToolRow, {
                    url: `/api/analyst/ui/analysis?analysisId=${encodeURIComponent(selected)}`,
                    label: 'Saved analysis and export',
                    refreshKey: refresh,
                    onExport: () => setReportRefresh((value) => value + 1),
                  })
                : null,
            )
          : null,
      )
    }

    function apply(ctx) {
      openImportReview = (importJobId) =>
        ctx.get('sidebarRight')?.openTab('analyst.data', { params: { importJobId } })
      openColumnReview = (reviewPinId) =>
        ctx.get('sidebarRight')?.openTab('analyst.data', { params: { reviewPinId } })
      openDashboard = (dashboardId) =>
        ctx
          .get('sidebarRight')
          ?.openTab('analyst.data', { params: { mode: 'Dashboard', dashboardId } })
      openStudio = (analysisId) =>
        ctx.get('sidebarRight')?.openTab('analyst.data', { params: { analysisId } })
      // Native command contributions are managed by the harness command service.
      if (typeof ctx.inject === 'function')
        ctx.inject(['commandUi', 'sidebarRight'], (scope) => {
          const commands = scope.get('commandUi')
          const sidebar = scope.get('sidebarRight')
          for (const [name, mode, description] of [
            ['analyst-data', 'Data', 'Browse published datasets and review source columns'],
            ['analyst-explore', 'Explore', 'Explore a saved analysis and refine its chart'],
            ['analyst-dashboard', 'Dashboard', 'Compose and review saved dashboard cards'],
            ['analyst-report', 'Report', 'Preview and export a saved analysis report'],
            ['analyst-reviews', 'Data', 'Open pending column, metric and publication reviews'],
          ])
            scope.effect(
              () =>
                commands.register({
                  name,
                  label: () => `Analysis Studio: ${name === 'analyst-reviews' ? 'Reviews' : mode}`,
                  description: () => description,
                  available: (session) => Boolean(session?.sessionId),
                  ui: {
                    kind: 'action',
                    run: () => sidebar.openTab('analyst.data', { params: { mode } }),
                  },
                }),
              `dsh-data-analyst: ${name}`,
            )
        })

      // Right-sidebar "Data" tab (two stages): the type, then its body/title.
      const sidebarRightTabs = ctx.get('sidebarRightTabs')
      if (sidebarRightTabs) {
        ctx.effect(() =>
          sidebarRightTabs.register({
            id: 'dsh-data-analyst.data',
            kind: 'analyst.data',
            priority: 'extension',
            title: () => 'Analysis Studio',
            guide: [
              {
                order: 0,
                title: () => 'Analysis Studio',
                description: () => 'Published datasets, saved analyses and dashboards',
              },
            ],
          }),
        )
      }
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: 'dsh-data-analyst.data' },
          DataTabBody,
        ),
      )
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: 'dsh-data-analyst.data' },
          () => createElement('span', null, 'Analysis Studio'),
        ),
      )

      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          { name: 'tool.call.toolview', key: 'propose_sql_correction' },
          SqlCorrectionToolRow,
        ),
      )
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          { name: 'tool.call.toolview', key: 'propose_metric' },
          AliasProposalToolRow,
        ),
      )
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          { name: 'tool.call.toolview', key: 'list_pending_metrics' },
          AliasBatchToolRow,
        ),
      )
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          { name: 'tool.call.toolview', key: 'list_pending_structure' },
          StructureReviewToolRow,
        ),
      )
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register({ name: 'tool.call.toolview', key: 'export_report' }, ReportToolRow),
      )
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register({ name: 'tool.call.toolview', key: 'export_dashboard' }, ReportToolRow),
      )
      for (const key of ['save_analysis', 'create_dashboard', 'add_to_dashboard']) {
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({ name: 'tool.call.toolview', key }, PersistedActionToolRow),
        )
      }
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register({ name: 'tool.call.toolview', key: 'get_schema' }, SchemaToolRow),
      )
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register({ name: 'tool.call.toolview', key: 'get_analysis' }, AnalysisToolRow),
      )
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register({ name: 'tool.call.toolview', key: 'get_dashboard' }, DashboardToolRow),
      )
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          { name: 'tool.call.toolview', key: 'preview_ingest_source' },
          IngestRecipeToolRow,
        ),
      )
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          { name: 'tool.call.toolview', key: 'ingest_dataset' },
          IngestAdaptConfirmToolRow,
        ),
      )
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          {
            name: 'tool.call.toolview',
            key: 'make_chart',
          },
          ChartToolRow,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.mountAnalystFragment = mountAnalystFragment
    exports.ensureAnalystFragmentControls = ensureAnalystFragmentControls
    return module.exports
  },
}

window.__ModuleLoader__.load(dshDataVizClientModule)
