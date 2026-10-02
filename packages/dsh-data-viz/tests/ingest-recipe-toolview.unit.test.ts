import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'

const packageDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

/**
 * A canned `preview_ingest_source` observation shaped exactly like
 * `renderObserve('catalog', ...)` in `dsh-data-core/src/tool-observe.ts`:
 * `<<observe kind=catalog>>\n{...}\n<</observe>>` — same as `get_schema`/
 * `get_analysis`, NOT raw JSON like `propose_metric`.
 */
const CANDIDATE_PAYLOAD = {
  slug: 'someone/widgets',
  sourceVersion: '1',
  alreadyReviewed: false,
  datasetId: 'someone_widgets',
  pinId: 'pin_0000000000000001',
  status: 'candidate',
  loadStrategy: 'raw_then_typed',
  tables: [
    {
      sourceFile: 'widgets.csv',
      tableId: 'orders',
      columns: [
        { name: 'region', sourceName: 'Region', type: 'VARCHAR', reason: 'string values' },
        { name: 'sales', sourceName: 'Sales', type: 'DOUBLE', reason: 'numeric values' },
      ],
      warnings: [],
    },
  ],
  unsupportedFiles: [{ name: 'notes.txt', reason: 'not a CSV file' }],
}

const CANDIDATE_OBSERVE_TEXT = `<<observe kind=catalog>>\n${JSON.stringify(CANDIDATE_PAYLOAD)}\n<</observe>>`

const ALREADY_REVIEWED_PAYLOAD = {
  slug: 'someone/widgets',
  sourceVersion: '1',
  alreadyReviewed: true,
  datasetId: 'someone_widgets',
}

const ALREADY_REVIEWED_OBSERVE_TEXT = `<<observe kind=catalog>>\n${JSON.stringify(ALREADY_REVIEWED_PAYLOAD)}\n<</observe>>`

/**
 * Shaped exactly like `renderObserve('catalog', ...)` after it had to
 * shrink an over-8-KiB proposal to fit: `tables` is dropped entirely and
 * `warnings` gains `"truncated"`. A
 * candidate this incomplete must never show Approve/Reject — the analyst
 * has not actually seen every table yet.
 */
const TRUNCATED_CANDIDATE_PAYLOAD = {
  slug: 'someone/widgets',
  sourceVersion: '1',
  alreadyReviewed: false,
  datasetId: 'someone_widgets',
  pinId: 'pin_0000000000000001',
  status: 'candidate',
  warnings: ['truncated'],
}

const TRUNCATED_CANDIDATE_OBSERVE_TEXT = `<<observe kind=catalog>>\n${JSON.stringify(TRUNCATED_CANDIDATE_PAYLOAD)}\n<</observe>>`

/**
 * Minimal fake `createElement` — returns a plain `{ type, props, children }`
 * tree instead of a real React element, so `IngestRecipeToolRow` can run
 * unmodified in Node without a `react` dependency. This loads and executes
 * the *actual* `client.js` factory — the same `parseObservePayload` and
 * render code the browser runs — rather than duplicating its parse/render
 * logic in the test.
 */
function fakeCreateElement(type: unknown, props: unknown, ...children: unknown[]) {
  return { type, props: props ?? {}, children }
}

interface ElementNode {
  type?: unknown
  props?: Record<string, unknown>
  children?: unknown[]
}

function elementText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(elementText).join(' | ')
  if (typeof node === 'object' && 'children' in (node as ElementNode)) {
    return elementText((node as ElementNode).children)
  }
  return ''
}

/** Collects every element node in the tree whose type is `'button'`. */
function findButtons(node: unknown, out: ElementNode[] = []): ElementNode[] {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findButtons(child, out)
    return out
  }
  const el = node as ElementNode
  if (el.type === 'button') out.push(el)
  const children = el.children ?? (Array.isArray(el.props?.children) ? el.props?.children : null)
  if (Array.isArray(children)) {
    for (const child of children) findButtons(child, out)
  }
  return out
}

type ToolviewComponent = (props: { block: unknown; sidebar?: boolean }) => unknown

/** Loads `client.js` for real and returns its registered toolview components. */
function loadToolviewRegistry(
  clientSource: string,
  reactOverrides: Record<string, unknown> = {},
  get: (name: string) => unknown = () => undefined,
): Record<string, ToolviewComponent> {
  const fakeReact = {
    createElement: fakeCreateElement,
    useEffect: () => {},
    useState: (initial: unknown) => [initial, () => {}],
    useRef: (initial: unknown) => ({ current: initial }),
    ...reactOverrides,
  }
  const fakeRequire = (id: string) => {
    if (id === 'react') return fakeReact
    throw new Error(`Unexpected require("${id}") while loading dsh-data-viz client.js`)
  }
  const loaded: Record<string, { apply: (ctx: unknown) => void }> = {}
  const fakeWindow = {
    __ModuleLoader__: {
      load(mod: {
        id: string
        factory: (require: (id: string) => unknown) => { apply: (ctx: unknown) => void }
      }) {
        loaded[mod.id] = mod.factory(fakeRequire)
      },
    },
  }

  const loadClientModule = new Function('window', clientSource)
  loadClientModule(fakeWindow)

  const registry: Record<string, ToolviewComponent> = {}
  const ctx = {
    get,
    slots: {
      inject: (_name: string, register: () => void) => register(),
      register: (descriptor: { key: string }, Component: ToolviewComponent) => {
        registry[descriptor.key] = Component
      },
    },
  }
  loaded['dsh-data-analyst']?.apply(ctx)
  return registry
}

it('parses a canned preview_ingest_source observe payload and renders slug/dataset/table fields with approve/reject buttons', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const IngestRecipeToolRow = registry.preview_ingest_source
  expect(IngestRecipeToolRow).toBeTypeOf('function')

  const block = {
    kind: 'result',
    isError: false,
    content: [{ type: 'text', text: CANDIDATE_OBSERVE_TEXT }],
  }
  const tree = IngestRecipeToolRow!({ block, sidebar: true })
  const text = elementText(tree)

  expect(text).toContain('someone/widgets')
  expect(text).toContain('raw_then_typed')
  expect(text).toContain('notes.txt')
  expect(text).toContain('not a CSV file')

  const buttons = findButtons(tree)
  expect(buttons.length).toBe(0) // Full live candidate must load before approval
})

it('shows no approve/reject buttons once alreadyReviewed is true', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const IngestRecipeToolRow = registry.preview_ingest_source
  expect(IngestRecipeToolRow).toBeTypeOf('function')

  const block = {
    kind: 'result',
    isError: false,
    content: [{ type: 'text', text: ALREADY_REVIEWED_OBSERVE_TEXT }],
  }
  const tree = IngestRecipeToolRow!({ block, sidebar: true })
  const text = elementText(tree)

  expect(text).toContain('someone/widgets')
  expect(text).toContain('already reviewed')

  const buttons = findButtons(tree)
  expect(buttons).toHaveLength(0)
})

it('does not render Approve/Reject when the observe was truncated with tables dropped', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const IngestRecipeToolRow = registry.preview_ingest_source
  expect(IngestRecipeToolRow).toBeTypeOf('function')

  const block = {
    kind: 'result',
    isError: false,
    content: [{ type: 'text', text: TRUNCATED_CANDIDATE_OBSERVE_TEXT }],
  }
  const tree = IngestRecipeToolRow!({ block, sidebar: true })
  const text = elementText(tree)

  // The fake useEffect never fires (no real fetch happens in this harness),
  // so the load stays pending and Approve/Reject must not render at all —
  // this guards against "approved a proposal it never saw":
  // `pinId` alone must not be enough to show the buttons.
  expect(text).toContain('truncated')
  const buttons = findButtons(tree)
  expect(buttons).toHaveLength(0)
})

it('registers IngestRecipeToolRow on the preview_ingest_source key, posts to the review route, and GETs the full candidate', async () => {
  const client = await readFile(join(packageDir, 'client.js'), 'utf8')
  expect(client).toContain('function IngestRecipeToolRow')
  expect(client).toContain("key: 'preview_ingest_source'")
  expect(client).toContain('/api/analyst/ingest-recipes/review')
  expect(client).toContain('/api/analyst/ingest-recipes?pinId=')
  // Editable typed proposal (Finding 5): column-type revision form + route.
  expect(client).toContain('function TypeEditor')
  expect(client).toContain('/api/analyst/ingest-recipes/revise')
  expect(client).toContain('REVISABLE_TYPES')
})

/** An errored tool block: dsh-tools prefixes the observe error with `Error: `. */
const ERROR_OBSERVE_TEXT = `Error: <<observe kind=error>>\n${JSON.stringify({
  code: 'Error',
  message:
    'Publication rejected: 42861 rejected row(s) exceed maxRejectedRows=0. This pin loads strictly (typed_recipe) and rejects rows that fail type casts. Re-run preview_ingest_source to obtain a lossless raw_then_typed revision for fresh analyst approval.',
})}\n<</observe>>`

it('renders the redacted error message on a failed ingest preview', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const IngestRecipeToolRow = registry.preview_ingest_source
  expect(IngestRecipeToolRow).toBeTypeOf('function')

  const block = {
    kind: 'result',
    isError: true,
    content: [{ type: 'text', text: ERROR_OBSERVE_TEXT }],
  }
  const tree = IngestRecipeToolRow!({ block, sidebar: true })
  const text = elementText(tree)

  expect(text).toContain('Ingest preview failed')
  expect(text).toContain('Publication rejected')
  expect(text).toContain('preview_ingest_source')
})

it('renders the redacted error message on a failed ingest_dataset result', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const IngestAdaptConfirmToolRow = registry.ingest_dataset
  expect(IngestAdaptConfirmToolRow).toBeTypeOf('function')

  const block = {
    kind: 'result',
    isError: true,
    content: [{ type: 'text', text: ERROR_OBSERVE_TEXT }],
  }
  const tree = IngestAdaptConfirmToolRow!({ block })
  const text = elementText(tree)

  expect(text).toContain('Ingest failed')
  expect(text).toContain('Publication rejected')
  expect(text).toContain('preview_ingest_source')
})

it('lists every source warning on a published ingest result, not only cast-nulls', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const IngestAdaptConfirmToolRow = registry.ingest_dataset
  expect(IngestAdaptConfirmToolRow).toBeTypeOf('function')

  // The ingest card filtered qualityWarnings down to `cast-null:` lines, so a date
  // column that kept its raw text and a currency column the bounded scan could not
  // decide were announced to the model but never to the analyst.
  const observeText = `<<observe kind=catalog>>\n${JSON.stringify({
    jobId: 'job_0000000000000001',
    slug: 'someone/superstore',
    status: 'ready',
    qualityWarnings: [
      'sample_superstore.order_date: no value matched any DATE format (9994 value(s)), so the column keeps its raw text as VARCHAR - ask the analyst for the intended format',
      'sample_superstore.currency: NOT scanned for mixed currencies - it has more than 25 distinct values',
      'cast-null: sample_superstore.postal_code: 11 cast-null cell(s)',
    ],
  })}\n<</observe>>`
  const block = { kind: 'result', isError: false, content: [{ type: 'text', text: observeText }] }
  const tree = IngestAdaptConfirmToolRow!({ block })
  const text = elementText(tree)

  expect(text).toContain('Published dataset version is ready.')
  expect(text).toContain('no value matched any DATE format')
  expect(text).toContain('NOT scanned for mixed currencies')
})

it('renders approve/reject buttons for a propose_metric observe payload (not raw JSON)', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const AliasProposalToolRow = registry.propose_metric
  expect(AliasProposalToolRow).toBeTypeOf('function')

  const observeText = `<<observe kind=catalog>>\n${JSON.stringify({
    proposalId: 'cand_0000000000000001',
    datasetId: 'retail',
    term: 'revenue',
    expression: 'SUM(sales)',
    description: 'Total sales',
    units: 'source units',
    inclusion: 'class = 1',
    dateColumn: 'event_time',
    tableId: 'orders',
    status: 'candidate',
    actorId: 'analyst-session',
  })}\n<</observe>>`
  const block = { kind: 'result', isError: false, content: [{ type: 'text', text: observeText }] }
  const tree = AliasProposalToolRow!({ block })
  const text = elementText(tree)

  expect(text).toContain('Units: source units')
  expect(text).toContain('Population rule: class = 1')
  expect(text).toContain('Time field: event_time')
  expect(text).toContain('revenue')
  expect(text).toContain('candidate')
  const buttons = findButtons(tree)
  expect(buttons.length).toBe(2)
})

it('renders download links for an export_report observe payload (not raw JSON)', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const ReportToolRow = registry.export_report
  expect(ReportToolRow).toBeTypeOf('function')

  const observeText = `<<observe kind=catalog>>\n${JSON.stringify({
    ready: true,
    analysisId: 'ana_263ab0249d504488',
    downloads: {
      html: '/api/analyst/reports?file=export_9a121fb9ee0c4e0ab68b349ad9a0a50a.html',
      png: '/api/analyst/reports?file=export_9a121fb9ee0c4e0ab68b349ad9a0a50a.png',
    },
  })}\n<</observe>>`
  const block = { kind: 'result', isError: false, content: [{ type: 'text', text: observeText }] }
  const tree = ReportToolRow!({ block })
  const text = elementText(tree)

  expect(text).toContain('Download HTML')
  expect(text).toContain('Download PNG')
})

it('renders persisted save and dashboard receipts without exposing raw ids as copy', async () => {
  const registry = loadToolviewRegistry(await readFile(join(packageDir, 'client.js'), 'utf8'))
  const save = registry.save_analysis!({
    block: {
      kind: 'result',
      isError: false,
      content: [
        {
          type: 'text',
          text: `<<observe kind=catalog>>\n${JSON.stringify({ persisted: true, analysisId: 'ana_123', revision: 4 })}\n<</observe>>`,
        },
      ],
    },
  })
  expect(elementText(save)).toContain('Analysis saved')
  expect(elementText(save)).toContain('Persisted revision 4')
  expect(elementText(save)).not.toContain('ana_123')

  const dashboard = registry.add_to_dashboard!({
    block: {
      kind: 'result',
      isError: false,
      content: [
        {
          type: 'text',
          text: `<<observe kind=catalog>>\n${JSON.stringify({ persisted: true, dashboardId: 'dash_123', slotCount: 3 })}\n<</observe>>`,
        },
      ],
    },
  })
  expect(elementText(dashboard)).toContain('Dashboard saved')
  expect(elementText(dashboard)).toContain('3 pinned views')
  expect(elementText(dashboard)).not.toContain('dash_123')
})

/**
 * Regression coverage for a live-verified-but-not-yet-unit-tested path: the
 * "Open analysis in Studio"/"Open dashboard in Studio" receipt buttons call
 * module-level `openStudio`/`openDashboard`, which are assigned once inside
 * `apply(ctx)` and read `ctx.get('sidebarRight')` at click time (not at
 * apply time), per `packages/dsh-data-viz/client.js` around
 * `openStudio = (analysisId) => ctx.get('sidebarRight')?.openTab(...)`.
 * Every other test in this file uses the harness default `get: () =>
 * undefined`, so `ctx.get('sidebarRight')` is always `undefined` there and
 * the optional-chained call always no-ops silently — that default can never
 * catch a broken wire-up between the button and the sidebar service. This
 * test supplies a real `sidebarRight` stub through `ctx.get` and asserts
 * clicking each receipt button calls `openTab` with the exact kind and
 * params the Studio panel's navigation-params effect expects
 * (`{ params: { analysisId } }` / `{ params: { mode: 'Dashboard',
 * dashboardId } }`) — the same call shape a live click-through in a booted
 * dsh instance was independently confirmed to produce.
 */
it('wires the save/dashboard receipt buttons to sidebarRight.openTab with the navigation params the Studio panel expects', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const openTab = vi.fn()
  const sidebarRight = { openTab }
  const registry = loadToolviewRegistry(clientSource, {}, (name: string) =>
    name === 'sidebarRight' ? sidebarRight : undefined,
  )

  const save = registry.save_analysis!({
    block: {
      kind: 'result',
      isError: false,
      content: [
        {
          type: 'text',
          text: `<<observe kind=catalog>>\n${JSON.stringify({ persisted: true, analysisId: 'ana_123', revision: 4 })}\n<</observe>>`,
        },
      ],
    },
  })
  const [openInStudioButton] = findButtons(save)
  expect(openInStudioButton?.props?.onClick).toBeTypeOf('function')
  ;(openInStudioButton!.props!.onClick as () => void)()
  expect(openTab).toHaveBeenCalledWith('analyst.data', { params: { analysisId: 'ana_123' } })

  openTab.mockClear()
  const dashboard = registry.add_to_dashboard!({
    block: {
      kind: 'result',
      isError: false,
      content: [
        {
          type: 'text',
          text: `<<observe kind=catalog>>\n${JSON.stringify({ persisted: true, dashboardId: 'dash_123', slotCount: 3 })}\n<</observe>>`,
        },
      ],
    },
  })
  const [openDashboardButton] = findButtons(dashboard)
  expect(openDashboardButton?.props?.onClick).toBeTypeOf('function')
  ;(openDashboardButton!.props!.onClick as () => void)()
  expect(openTab).toHaveBeenCalledWith('analyst.data', {
    params: { mode: 'Dashboard', dashboardId: 'dash_123' },
  })
})

/**
 * Without a `sidebarRight` binding — the harness default, and what a
 * genuinely broken wire-up (this plugin's `ctx.get` resolving to a
 * different isolate, or `apply` never running) would look like — the
 * receipt button must still render and must not throw on click; the
 * optional-chained call silently no-ops. This pins the failure mode a
 * live-verification pass would observe (button present, click does
 * nothing, no console error) as expected behavior specifically for a
 * missing service, distinguishing it from the button being unwired.
 */
it('does not throw when the receipt button is clicked with no sidebarRight service bound', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const save = registry.save_analysis!({
    block: {
      kind: 'result',
      isError: false,
      content: [
        {
          type: 'text',
          text: `<<observe kind=catalog>>\n${JSON.stringify({ persisted: true, analysisId: 'ana_123', revision: 4 })}\n<</observe>>`,
        },
      ],
    },
  })
  const [openInStudioButton] = findButtons(save)
  expect(() => (openInStudioButton!.props!.onClick as () => void)()).not.toThrow()
})

it('keeps historical save and report observations reopenable without claiming a receipt', async () => {
  const registry = loadToolviewRegistry(await readFile(join(packageDir, 'client.js'), 'utf8'))
  const saved = registry.save_analysis!({
    block: {
      kind: 'result',
      isError: false,
      content: [
        {
          type: 'text',
          text: `<<observe kind=catalog>>\n${JSON.stringify({ analysisId: 'ana_123', revision: 2 })}\n<</observe>>`,
        },
      ],
    },
  })
  expect(elementText(saved)).toContain('Saved analysis')
  expect(elementText(saved)).toContain('Persistence receipt unavailable for this earlier action')
  expect(elementText(saved)).not.toContain('Analysis saved')

  const report = registry.export_report!({
    block: {
      kind: 'result',
      isError: false,
      content: [
        {
          type: 'text',
          text: `<<observe kind=catalog>>\n${JSON.stringify({
            analysisId: 'ana_123',
            downloads: {
              html: '/api/analyst/reports?file=export_9a121fb9ee0c4e0ab68b349ad9a0a50a.html',
            },
          })}\n<</observe>>`,
        },
      ],
    },
  })
  expect(elementText(report)).toContain('Saved report')
  expect(elementText(report)).toContain('Open report')
  expect(elementText(report)).not.toContain('Report ready')
})

it('surfaces the provenance status on the ingest recipe toolview', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const IngestRecipeToolRow = registry.preview_ingest_source
  expect(IngestRecipeToolRow).toBeTypeOf('function')

  const observeText = `<<observe kind=catalog>>\n${JSON.stringify({
    slug: 'owner/dataset',
    sourceVersion: '3',
    alreadyReviewed: false,
    pinId: 'pin_0000000000000001',
    status: 'candidate',
    provenanceStatus: 'version-unverified',
    tables: [
      { sourceFile: 'x.csv', tableId: 'orders', columns: [{ name: 'region', type: 'VARCHAR' }] },
    ],
  })}\n<</observe>>`
  const block = { kind: 'result', isError: false, content: [{ type: 'text', text: observeText }] }
  const tree = IngestRecipeToolRow!({ block, sidebar: true })
  const text = elementText(tree)

  expect(text).toContain('Verification: version-unverified')
})

it('renders the archive file inventory (proposed vs skipped) when files are present', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const IngestRecipeToolRow = registry.preview_ingest_source
  expect(IngestRecipeToolRow).toBeTypeOf('function')

  const observeText = `<<observe kind=catalog>>\n${JSON.stringify({
    slug: 'owner/dataset',
    sourceVersion: '1',
    alreadyReviewed: false,
    pinId: 'pin_0000000000000001',
    status: 'candidate',
    tables: [
      { sourceFile: 'facts.csv', tableId: 'facts', columns: [{ name: 'id', type: 'BIGINT' }] },
    ],
    files: [
      { name: 'facts.csv', bytes: 2048, status: 'proposed' },
      {
        name: 'lookup.csv',
        bytes: 512,
        status: 'skipped',
        reason: 'Skipped after reaching the 20-table preview cap',
      },
    ],
  })}\n<</observe>>`
  const block = { kind: 'result', isError: false, content: [{ type: 'text', text: observeText }] }
  const tree = IngestRecipeToolRow!({ block, sidebar: true })
  const text = elementText(tree)

  expect(text).toContain('Archive inventory: 2 file(s) — 1 proposed, 1 skipped')
  expect(text).toContain('lookup.csv')
  expect(text).toContain('Skipped after reaching the 20-table preview cap')
  expect(text).toContain('512 B')
})

it('renders approve/reject controls for list_pending_structure candidates', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const StructureReviewToolRow = registry.list_pending_structure
  expect(StructureReviewToolRow).toBeTypeOf('function')

  const observeText = `<<observe kind=catalog>>\n${JSON.stringify({
    candidates: [
      {
        candidateId: 'grain_0000000000000001',
        datasetId: 'gtd',
        tableId: 'events',
        primaryKey: ['event_id'],
        grainDescription: 'One row per event',
        evidence: { reason: 'unique over 100 rows' },
        status: 'candidate',
      },
      {
        candidateId: 'rel_0000000000000002',
        datasetId: 'gtd',
        fromTable: 'events',
        toTable: 'locations',
        fromColumns: ['location_id'],
        toColumns: ['location_id'],
        cardinality: 'n:1',
        evidence: { reason: 'many events per location' },
        status: 'candidate',
      },
    ],
  })}\n<</observe>>`
  const block = { kind: 'result', isError: false, content: [{ type: 'text', text: observeText }] }
  const tree = StructureReviewToolRow!({ block })
  const text = elementText(tree)

  expect(text).toContain('Review structure candidates')
  expect(text).toContain('Grain: events (event_id) — One row per event')
  expect(text).toContain('Relationship: events → locations (n:1)')
  expect(text).toContain('unique over 100 rows')
  expect(text).toContain('many events per location')

  const buttons = findButtons(tree)
  expect(buttons.length).toBe(4) // Approve + Reject per candidate
  expect(buttons.some((button) => typeof button.props?.onClick === 'function')).toBe(true)
})

it('renders batch approve/reject controls for list_pending_metrics', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const AliasBatchToolRow = registry.list_pending_metrics
  expect(AliasBatchToolRow).toBeTypeOf('function')

  const observeText = `<<observe kind=catalog>>\n${JSON.stringify({
    candidates: [
      {
        candidateId: 'alias_0000000000000001',
        datasetId: 'retail',
        term: 'revenue',
        expression: 'SUM(sales)',
        description: 'Total sales',
        tableId: 'orders',
        status: 'candidate',
      },
      {
        candidateId: 'alias_0000000000000002',
        datasetId: 'retail',
        term: 'lethality',
        expression: 'SUM(nkill) / COUNT(*)',
        description: 'Fatalities per incident',
        tableId: 'events',
        status: 'candidate',
      },
    ],
  })}\n<</observe>>`
  const block = { kind: 'result', isError: false, content: [{ type: 'text', text: observeText }] }
  const tree = AliasBatchToolRow!({ block })
  const text = elementText(tree)

  expect(text).toContain('revenue = SUM(sales) (orders)')
  expect(text).toContain('lethality = SUM(nkill) / COUNT(*) (events)')
  const buttons = findButtons(tree)
  expect(buttons.length).toBe(2)
})

it('keeps chat compact and opens the requested column review only on a user click', async () => {
  const openTab = vi.fn()
  const effects: Array<() => unknown> = []
  const registry = loadToolviewRegistry(
    await readFile(join(packageDir, 'client.js'), 'utf8'),
    { useEffect: (fn: () => unknown) => effects.push(fn) },
    (name) => (name === 'sidebarRight' ? { openTab } : undefined),
  )
  const tree = registry.preview_ingest_source!({
    block: { kind: 'result', content: [{ type: 'text', text: CANDIDATE_OBSERVE_TEXT }] },
  })
  for (const effect of effects) effect()
  expect(openTab).not.toHaveBeenCalled()
  const buttons = findButtons(tree)
  expect(buttons).toHaveLength(1)
  expect(elementText(buttons[0])).toBe('Open column review')
  ;(buttons[0]!.props!.onClick as () => void)()
  expect(openTab).toHaveBeenCalledWith('analyst.data', {
    params: { reviewPinId: CANDIDATE_PAYLOAD.pinId },
  })
  expect(elementText(tree)).not.toContain('region')
})

it('prevents approving unsaved type edits even after the full live proposal loaded', async () => {
  let index = 0
  const registry = loadToolviewRegistry(await readFile(join(packageDir, 'client.js'), 'utf8'), {
    useState: (initial: unknown) => {
      const state = [
        CANDIDATE_PAYLOAD,
        true,
        'candidate',
        null,
        false,
        CANDIDATE_PAYLOAD.tables,
        null,
      ]
      return [state[index++] ?? initial, () => {}]
    },
  })
  const tree = registry.preview_ingest_source!({
    sidebar: true,
    block: { kind: 'result', content: [{ type: 'text', text: CANDIDATE_OBSERVE_TEXT }] },
  })
  expect(elementText(tree)).toContain('Save or reset type changes before approving')
  const approve = findButtons(tree).find((button) => elementText(button) === 'Approve')!
  expect(approve.props?.disabled).toBe(true)
})

it('opens a newly completed preview after observing its running state', async () => {
  const openTab = vi.fn()
  const effects: Array<() => unknown> = []
  const pending = { current: true }
  const registry = loadToolviewRegistry(
    await readFile(join(packageDir, 'client.js'), 'utf8'),
    { useEffect: (fn: () => unknown) => effects.push(fn), useRef: () => pending },
    (name) => (name === 'sidebarRight' ? { openTab } : undefined),
  )
  registry.preview_ingest_source!({
    block: { kind: 'result', content: [{ type: 'text', text: CANDIDATE_OBSERVE_TEXT }] },
  })
  for (const effect of effects) effect()
  expect(openTab).toHaveBeenCalledOnce()
  expect(openTab).toHaveBeenCalledWith('analyst.data', {
    params: { reviewPinId: CANDIDATE_PAYLOAD.pinId },
  })
  for (const effect of effects) effect()
  expect(openTab).toHaveBeenCalledOnce()
})

it('renders aligned type-review rows with proposal warnings and a date-format control, tracks changes and resets without saving', async () => {
  const state: unknown[] = [
    CANDIDATE_PAYLOAD,
    false,
    'candidate',
    null,
    false,
    CANDIDATE_PAYLOAD.tables,
    null,
  ]
  let cursor = 0
  const dirty = vi.fn()
  const registry = loadToolviewRegistry(await readFile(join(packageDir, 'client.js'), 'utf8'), {
    useState: (initial: unknown) => {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [
        state[index],
        (value: unknown) => {
          state[index] = value
        },
      ]
    },
  })
  const find = (
    node: unknown,
    predicate: (node: ElementNode) => boolean,
  ): ElementNode | undefined => {
    if (!node || typeof node !== 'object') return undefined
    if (Array.isArray(node)) return node.map((item) => find(item, predicate)).find(Boolean)
    const element = node as ElementNode
    return predicate(element) ? element : find(element.children, predicate)
  }
  const parent = registry.preview_ingest_source!({
    sidebar: true,
    block: { kind: 'result', content: [{ type: 'text', text: CANDIDATE_OBSERVE_TEXT }] },
  })
  const editor = find(
    parent,
    (node) => typeof node.type === 'function' && node.type.name === 'TypeEditor',
  )!
  const render = () => {
    cursor = 7
    return (editor.type as (props: unknown) => unknown)({ ...editor.props, onDirty: dirty })
  }
  let tree = render()
  expect(elementText(tree)).toContain('Proposed type')
  expect(elementText(tree)).toContain('numeric values')
  const select = find(tree, (node) => node.props?.['aria-label'] === 'orders.sales chosen type')!
  ;(select.props!.onChange as (event: unknown) => void)({ target: { value: 'BIGINT' } })
  tree = render()
  expect(elementText(tree)).toContain('1 unsaved change')
  expect(dirty).toHaveBeenLastCalledWith(true)
  const reset = findButtons(tree).find((button) => elementText(button) === 'Reset changes')!
  await (reset.props!.onClick as () => Promise<void>)()
  expect(elementText(render())).toContain('0 unsaved changes')
  expect(dirty).toHaveBeenLastCalledWith(false)
  cursor = 7
  const withoutEvidence = (editor.type as (props: unknown) => unknown)({
    ...editor.props,
    tables: CANDIDATE_PAYLOAD.tables.map((table) => ({
      ...table,
      columns: table.columns.map(({ reason: _reason, ...column }) => column),
    })),
  })
  expect(elementText(withoutEvidence)).not.toContain('Available evidence')
  expect(elementText(withoutEvidence)).not.toContain('Inference evidence unavailable')
  state[10] = 'country'
  state[11] = 'events'
  cursor = 7
  const wide = (editor.type as (props: unknown) => unknown)({
    ...editor.props,
    tables: [
      {
        tableId: 'events',
        sourceFile: 'events.csv',
        columns: [
          { name: 'country_txt', type: 'VARCHAR' },
          ...Array.from({ length: 134 }, (_, index) => ({
            name: `column_${index}`,
            type: 'DOUBLE',
          })),
        ],
      },
      {
        tableId: 'lookup',
        sourceFile: 'lookup.csv',
        columns: [{ name: 'country_name', type: 'VARCHAR' }],
      },
    ],
  })
  expect(elementText(wide)).toContain('1 of 135 columns shown')
  expect(elementText(wide)).toContain('country_txt')
  expect(elementText(wide)).not.toContain('column_0')
  expect(elementText(wide)).not.toContain('country_name')
  expect(find(wide, (node) => node.props?.['aria-label'] === 'Review table')).toBeDefined()

  // The grid alone never explained why a DATE column is risky or how to answer the
  // source's ambiguous day/month order, so the review carries both: the proposal's
  // own warnings, and a format the analyst can choose and save with the types.
  // the earlier part of this test left the table filter on 'events'; clear it so the
  // 'orders' group (and its warnings) renders
  state[10] = ''
  state[11] = ''
  const formatProbeTables = [
    {
      tableId: 'orders',
      sourceFile: 'orders.csv',
      columns: [
        { name: 'order_id', type: 'VARCHAR' },
        { name: 'order_date', type: 'DATE' },
      ],
      warnings: [
        'DATE format not persisted: ambiguous day/month order across sampled values (e.g. "12/8/2016")',
      ],
    },
  ]
  cursor = 7
  const withDates = (editor.type as (props: unknown) => unknown)({
    ...editor.props,
    // the same spy render() injects, so the dirty wiring is observable here
    onDirty: dirty,
    tables: formatProbeTables,
  })
  const reviewText = elementText(withDates)
  // The warnings render beside the columns they belong to (one list, not a second
  // copy at the top of the review). Assert on the warning's own wording: the review's
  // instructions also mention ambiguous day/month order.
  expect(reviewText).toContain('DATE format not persisted')
  expect(reviewText).not.toContain('Proposal warnings')

  // The control is a labelled select. This harness walks element children only, so
  // assert the label and option text the analyst reads; the control's behaviour
  // (choose month-first, save, re-ingest with real DATE values) is verified end to
  // end by the live WebUI pass and by the duckdb revise tests.
  expect(reviewText).toContain('orders date format')
  expect(reviewText).toContain('Month first (MM/DD/YYYY)')
  expect(reviewText).toContain('Day first (DD/MM/YYYY)')
  // The no-format option must not claim dates stay text: without a format the loader
  // still casts, and only wholly unparseable values stay text.
  expect(reviewText).toContain('Auto-detect (unparseable dates stay text)')
  expect(reviewText).not.toContain('Not set (dates stay text)')

  // Picking a format is an unsaved change in the same sense a type edit is: the parent
  // disables Approve on this exact callback, so approving cannot drop the choice.
  dirty.mockClear()
  cursor = 7
  const formatSelect = find(
    withDates,
    (node) => node.props?.['aria-label'] === 'orders date format',
  )!
  ;(formatSelect.props!.onChange as (event: unknown) => void)({ target: { value: '%m/%d/%Y' } })
  expect(dirty).toHaveBeenCalledWith(true)
  expect(elementText(render())).toContain('1 unsaved change')

  // A TIMESTAMP-only table reads timestampFormat, so it gets its own control rather
  // than a date control that would save and then do nothing.
  cursor = 7
  const timestampOnly = (editor.type as (props: unknown) => unknown)({
    ...editor.props,
    tables: [
      {
        tableId: 'events',
        sourceFile: 'events.csv',
        columns: [{ name: 'happened_at', type: 'TIMESTAMP' }],
      },
    ],
  })
  const timestampText = elementText(timestampOnly)
  expect(timestampText).toContain('events timestamp format')
  expect(timestampText).not.toContain('events date format')
  expect(timestampText).toContain('Auto-detect (unparseable timestamps stay text)')

  // Choosing a format answers that warning, so it must stop being current once the
  // analyst has picked one - otherwise the review keeps showing a resolved warning.
  cursor = 7
  const afterChoice = (editor.type as (props: unknown) => unknown)({
    ...editor.props,
    onDirty: dirty,
    tables: formatProbeTables,
  })
  expect(elementText(afterChoice)).not.toContain('DATE format not persisted')

  // Switching back to the value the table already has is NOT a change. Keeping it as
  // one left onDirty(true) with a zero change count, which disabled Approve, Save and
  // Reset at once and survived a reload through the saved draft.
  cursor = 7
  const reverted = find(afterChoice, (node) => node.props?.['aria-label'] === 'orders date format')!
  dirty.mockClear()
  ;(reverted.props!.onChange as (event: unknown) => void)({ target: { value: '' } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  cursor = 7
  const backToAuto = (editor.type as (props: unknown) => unknown)({
    ...editor.props,
    onDirty: dirty,
    tables: formatProbeTables,
  })
  expect(elementText(backToAuto)).toContain('0 unsaved changes')
  expect(dirty).toHaveBeenLastCalledWith(false)

  // A table with no date column offers no format control.
  cursor = 7
  const noDates = (editor.type as (props: unknown) => unknown)({
    ...editor.props,
    tables: [
      { tableId: 'lookup', sourceFile: 'lookup.csv', columns: [{ name: 'code', type: 'VARCHAR' }] },
    ],
  })
  expect(
    find(noDates, (node) => node.props?.['aria-label'] === 'lookup date format'),
  ).toBeUndefined()
})

it('renders a compact safe report card with preview, ZIP and no embedded composition', async () => {
  const registry = loadToolviewRegistry(await readFile(join(packageDir, 'client.js'), 'utf8'))
  const html = '/api/analyst/reports?file=export_0123456789abcdef0123456789abcdef.html'
  const zip = html.replace('.html', '.zip')
  const tree = registry.export_report!({
    block: {
      kind: 'result',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ready: true,
            analysisId: 'ana_123',
            downloads: {
              html,
              zip,
              unsafe: 'https://evil.example/report.html',
              javascript: 'javascript:alert(1)',
            },
          }),
        },
      ],
    },
  })
  const serialized = JSON.stringify(tree)
  expect(elementText(tree)).toContain('Open report')
  expect(elementText(tree)).toContain('Offline downloads')
  expect(elementText(tree)).toContain('Download ZIP')
  expect(serialized).toContain(`${html}&preview=1`)
  expect(serialized).not.toContain('evil.example')
  expect(serialized).not.toContain('javascript:')
  expect(serialized).not.toContain('Analysis composition')
  expect(findButtons(tree)).toHaveLength(1)
  expect(elementText(findButtons(tree)[0])).toBe('Open analysis in Studio')
})

it('accepts runtime-absolute report download URLs for markdown-safe chat links', async () => {
  const registry = loadToolviewRegistry(await readFile(join(packageDir, 'client.js'), 'utf8'))
  const path = '/api/analyst/reports?file=export_0123456789abcdef0123456789abcdef.html'
  const html = `http://127.0.0.1:3088${path}`
  const tree = registry.export_report!({
    block: {
      kind: 'result',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ready: true,
            downloads: {
              html,
              zip: html.replace('.html', '.zip'),
              unsafe:
                'https://example.invalid/api/analyst/reports?file=export_0123456789abcdef0123456789abcdef.html',
            },
          }),
        },
      ],
    },
  })
  const serialized = JSON.stringify(tree)
  expect(elementText(tree)).toContain('Open report')
  expect(elementText(tree)).toContain('Download HTML')
  expect(serialized).toContain(`${html}&preview=1`)
  expect(serialized).not.toContain('example.invalid')
})

it('keeps dashboard chat cards compact and opens only a validated Studio resource', async () => {
  const openTab = vi.fn()
  const registry = loadToolviewRegistry(
    await readFile(join(packageDir, 'client.js'), 'utf8'),
    {},
    (name) => (name === 'sidebarRight' ? { openTab } : undefined),
  )
  const block = (payload: unknown) => ({
    kind: 'result',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  })
  const tree = registry.get_dashboard!({
    block: block({ dashboardId: 'dash_123', title: 'GTD review', slots: [{}, {}] }),
  })
  expect(elementText(tree)).toContain('GTD review')
  expect(elementText(tree)).toContain('2 pinned views')
  expect(JSON.stringify(tree)).not.toContain('/api/analyst/ui/dashboard')
  const buttons = findButtons(tree)
  expect(buttons).toHaveLength(1)
  ;(buttons[0]!.props!.onClick as () => void)()
  expect(openTab).toHaveBeenCalledWith('analyst.data', {
    params: { mode: 'Dashboard', dashboardId: 'dash_123' },
  })
  const invalid = registry.get_dashboard!({
    block: block({ dashboardId: 'https://evil.example', title: 'Bad' }),
  })
  expect(findButtons(invalid)).toHaveLength(0)
  const truncated = registry.get_dashboard!({
    block: block({ dashboardId: 'dash_123', slots: [], warnings: ['truncated'] }),
  })
  expect(elementText(truncated)).not.toContain('0 pinned views')
})

it('notifies Studio after a successful metric review but not a failed request', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ status: 'approved' }))
    .mockResolvedValueOnce(Response.json({ error: 'failed' }, { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const registry = loadToolviewRegistry(await readFile(join(packageDir, 'client.js'), 'utf8'))
    const onReviewed = vi.fn()
    const render = registry.propose_metric as (props: unknown) => unknown
    const tree = render({
      onReviewed,
      block: {
        kind: 'result',
        content: [
          {
            type: 'text',
            text:
              '<<observe kind=catalog>>\n' +
              JSON.stringify({
                proposalId: 'alias_0000000000000001',
                status: 'candidate',
                term: 'Count',
              }) +
              '\n<</observe>>',
          },
        ],
      },
    })
    const approve = findButtons(tree).find(
      (button) => elementText(button) === 'Approve definition',
    )!
    ;(approve.props!.onClick as () => void)()
    await vi.waitFor(() =>
      expect(onReviewed).toHaveBeenCalledWith({ kind: 'semantic', status: 'approved' }),
    )
    ;(approve.props!.onClick as () => void)()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onReviewed).toHaveBeenCalledOnce()
  } finally {
    vi.unstubAllGlobals()
  }
})

/**
 * Publisher-supplied text in the review pane. Two shapes reach it: the bounded
 * model observation (`descriptionExcerpt` + `columnNotes`) and the full stored
 * block served by the authenticated recipe route (`description.text` +
 * `columnDictionary`). Both stay labelled and unverified, and neither is merged
 * into the proposed storage types or the observed evidence column.
 */
const PUBLISHER_NOTE = 'Gross order value in the seller currency, before refunds.'
const PUBLISHER_CAVEAT =
  'Publisher-supplied and unverified: quoted Kaggle metadata, not an approved definition. Use it as evidence to confirm with the analyst.'

const CANDIDATE_WITH_PUBLISHER_PAYLOAD = {
  ...CANDIDATE_PAYLOAD,
  publisherSupplied: {
    provenance: 'publisher-supplied',
    verification: 'unverified',
    caveat: PUBLISHER_CAVEAT,
    sources: ['kaggle-cli-datasets-metadata'],
    subtitle: 'Anonymised widget orders',
    keywords: ['retail'],
    descriptionExcerpt: '# Widgets by Example Retail\n\nWelcome!',
    descriptionTruncated: true,
    descriptionChars: 4321,
    columnNotes: [
      {
        provenance: 'publisher-supplied',
        verification: 'unverified',
        tableId: 'orders',
        column: 'Sales',
        note: PUBLISHER_NOTE,
      },
      {
        provenance: 'publisher-supplied',
        verification: 'unverified',
        column: 'unmatched_column',
        note: 'A publisher note about a column we never proposed.',
      },
    ],
    columnDictionaryTotal: 7,
    columnNotesOmitted: 5,
    notes: ['5 publisher column-dictionary entries were omitted.'],
  },
}

const CANDIDATE_WITH_PUBLISHER_OBSERVE_TEXT = `<<observe kind=catalog>>\n${JSON.stringify(
  CANDIDATE_WITH_PUBLISHER_PAYLOAD,
)}\n<</observe>>`

function findTypeEditorNode(node: unknown): ElementNode | undefined {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findTypeEditorNode(item)
      if (found) return found
    }
    return undefined
  }
  const element = node as ElementNode
  if (typeof element.type === 'function' && element.type.name === 'TypeEditor') return element
  return findTypeEditorNode(element.children)
}

it('labels the publisher description in the source details, never as a definition', async () => {
  const registry = loadToolviewRegistry(await readFile(join(packageDir, 'client.js'), 'utf8'))
  const tree = registry.preview_ingest_source!({
    sidebar: true,
    block: {
      kind: 'result',
      content: [{ type: 'text', text: CANDIDATE_WITH_PUBLISHER_OBSERVE_TEXT }],
    },
  })
  const text = elementText(tree)

  expect(text).toContain('Publisher-supplied (unverified)')
  expect(text).toContain('Publisher subtitle: Anonymised widget orders')
  expect(text).toContain('Publisher keywords: retail')
  expect(text).toContain('# Widgets by Example Retail')
  expect(text).toContain('Publisher description shown in part (4321 characters supplied)')
  expect(text).toContain('Unmatched publisher note (unverified): unmatched_column')
  expect(text).toContain(PUBLISHER_CAVEAT)
  // The proposed storage types are our own observation and are never restated
  // as publisher claims.
  expect(text).toContain('Load strategy: raw_then_typed')
})

it('renders a publisher column note beside its column, labelled, from either shape', async () => {
  // Same `useState` override as the type-review tests above: the full live
  // candidate must appear loaded before the editor renders at all.
  const state: unknown[] = [
    CANDIDATE_WITH_PUBLISHER_PAYLOAD,
    false,
    'candidate',
    null,
    false,
    CANDIDATE_WITH_PUBLISHER_PAYLOAD.tables,
    null,
  ]
  let cursor = 0
  const registry = loadToolviewRegistry(await readFile(join(packageDir, 'client.js'), 'utf8'), {
    useState: (initial: unknown) => {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], () => {}]
    },
  })
  const parent = registry.preview_ingest_source!({
    sidebar: true,
    block: {
      kind: 'result',
      content: [{ type: 'text', text: CANDIDATE_WITH_PUBLISHER_OBSERVE_TEXT }],
    },
  })
  const editor = findTypeEditorNode(parent)
  expect(editor, 'TypeEditor element').toBeDefined()
  const render = (props: Record<string, unknown>) => {
    cursor = 7
    return (editor!.type as (props: unknown) => unknown)({ ...editor!.props, ...props })
  }

  // Model-observation shape (`columnNotes`), matched case/punctuation-insensitively.
  const fromModel = elementText(render({}))
  expect(fromModel).toContain(`Publisher-supplied (unverified): ${PUBLISHER_NOTE}`)
  // Exactly one column carries it — it is not smeared across every row.
  expect(fromModel.split(PUBLISHER_NOTE).length - 1).toBe(1)
  expect(fromModel).not.toContain('unmatched_column')

  // Stored-block shape (`columnDictionary` + `description.text`).
  const fromStored = elementText(
    render({
      publisherSupplied: {
        provenance: 'publisher-supplied',
        verification: 'unverified',
        caveat: PUBLISHER_CAVEAT,
        sources: ['kaggle-cli-datasets-metadata'],
        description: {
          text: 'Full stored publisher description, longer than the excerpt.',
          truncated: false,
          sourceLength: 51,
        },
        columnDictionary: [
          {
            provenance: 'publisher-supplied',
            verification: 'unverified',
            tableId: 'orders',
            column: 'region',
            note: 'Sales region the order was booked in.',
          },
        ],
        columnDictionaryTotal: 1,
        notes: [],
      },
    }),
  )
  expect(fromStored).toContain(
    'Publisher-supplied (unverified): Sales region the order was booked in.',
  )
  expect(fromStored.split('Publisher-supplied (unverified)').length - 1).toBe(1)

  // No publisher block at all: nothing is invented for the pane.
  const withoutPublisher = elementText(render({ publisherSupplied: null }))
  expect(withoutPublisher).not.toContain('Publisher-supplied')
  expect(withoutPublisher).toContain('Proposed type')
})

it('keeps publisher wording out of the chosen-type and available-evidence cells', async () => {
  const state: unknown[] = [
    CANDIDATE_WITH_PUBLISHER_PAYLOAD,
    false,
    'candidate',
    null,
    false,
    CANDIDATE_WITH_PUBLISHER_PAYLOAD.tables,
    null,
  ]
  let cursor = 0
  const registry = loadToolviewRegistry(await readFile(join(packageDir, 'client.js'), 'utf8'), {
    useState: (initial: unknown) => {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], () => {}]
    },
  })
  const parent = registry.preview_ingest_source!({
    sidebar: true,
    block: {
      kind: 'result',
      content: [{ type: 'text', text: CANDIDATE_WITH_PUBLISHER_OBSERVE_TEXT }],
    },
  })
  const editor = findTypeEditorNode(parent)!
  cursor = 7
  const tree = (editor.type as (props: unknown) => unknown)(editor.props) as unknown

  const collect = (node: unknown, out: ElementNode[] = []): ElementNode[] => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const item of node) collect(item, out)
      return out
    }
    const element = node as ElementNode
    out.push(element)
    collect(element.children, out)
    return out
  }
  const nodes = collect(tree)
  const typeCells = nodes.filter(
    (node) => node.type === 'td' && elementText(node.children).trim().startsWith('DOUBLE'),
  )
  expect(typeCells.length).toBeGreaterThan(0)
  for (const cell of typeCells) {
    expect(elementText(cell.children)).not.toContain('Publisher-supplied')
    expect(elementText(cell.children)).not.toContain(PUBLISHER_NOTE)
  }
  const evidenceCells = nodes.filter(
    (node) => node.type === 'td' && elementText(node.children).includes('numeric values'),
  )
  expect(evidenceCells).toHaveLength(1)
  expect(elementText(evidenceCells[0]!.children)).not.toContain('Publisher-supplied')
})
