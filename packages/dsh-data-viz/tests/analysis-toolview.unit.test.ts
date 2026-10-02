import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'

const packageDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

/** Canned `get_analysis` observation — same shape as `renderObserve('catalog', …)`. */
const ANALYSIS_PAYLOAD = {
  analysisId: 'an_superstore_revenue',
  revision: 2,
  datasetVersionId: 'superstore-v1',
  semanticRevisionId: 'sem-superstore-v1',
  question: 'What is total revenue by region?',
  sql: 'SELECT region, SUM(sales) AS revenue\nFROM orders\nGROUP BY region\nORDER BY revenue DESC',
  resultId: 'res_abc123',
  chart: { mark: 'bar', title: 'Revenue by region' },
  artifactIds: ['art_chart1'],
}

const OBSERVE_TEXT = `<<observe kind=catalog>>\n${JSON.stringify(ANALYSIS_PAYLOAD)}\n<</observe>>`

function fakeCreateElement(type: unknown, props: unknown, ...children: unknown[]) {
  return { type, props: props ?? {}, children }
}

interface ElementNode {
  children?: unknown[]
  props?: { children?: unknown }
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

function findPreText(node: unknown): string | null {
  if (node == null || typeof node !== 'object') return null
  const el = node as ElementNode & { type?: unknown }
  if (el.type === 'pre') {
    const child = el.children ?? el.props?.children
    return typeof child === 'string' ? child : elementText(child)
  }
  const children = el.children ?? (Array.isArray(el) ? el : null)
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findPreText(child)
      if (found != null) return found
    }
  }
  return null
}

type ToolviewComponent = (props: { block: unknown }) => unknown

interface AnyElement {
  type?: unknown
  props?: Record<string, unknown>
  children?: unknown[]
}

/** Depth-first search over the fake element tree produced above. */
function findElement(node: unknown, match: (el: AnyElement) => boolean): AnyElement | null {
  if (node == null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match)
      if (found) return found
    }
    return null
  }
  const el = node as AnyElement
  if (match(el)) return el
  return findElement(el.children ?? null, match)
}

function findFragmentShell(node: unknown): AnyElement | null {
  return findElement(
    node,
    (el) =>
      typeof el.type === 'function' && (el.type as { name?: string }).name === 'FragmentToolRow',
  )
}

function findMountNode(node: unknown): AnyElement | null {
  return findElement(node, (el) => el.props?.className === 'analyst-fragment-mount')
}

function loadToolviewRegistry(
  clientSource: string,
  reactOverrides: Record<string, unknown> = {},
): Record<string, ToolviewComponent> {
  const fakeReact = {
    createElement: fakeCreateElement,
    useEffect: () => {},
    useState: (initial: unknown) => [initial, () => {}],
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
    get: () => undefined,
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

it('extracts SQL from a canned get_analysis observe payload and renders the correction CTA', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const AnalysisToolRow = registry.get_analysis
  expect(AnalysisToolRow).toBeTypeOf('function')

  const block = { kind: 'result', isError: false, content: [{ type: 'text', text: OBSERVE_TEXT }] }
  const tree = AnalysisToolRow!({ block })
  const text = elementText(tree)
  const sql = findPreText(tree)

  expect(sql).toBe(ANALYSIS_PAYLOAD.sql)
  expect(text).toContain('What is total revenue by region?')
  expect(text).toContain('Disagree? Propose a correction')
})

it('registers AnalysisToolRow on the get_analysis key', async () => {
  const client = await readFile(join(packageDir, 'client.js'), 'utf8')
  expect(client).toContain('function AnalysisToolRow')
  expect(client).toContain("key: 'get_analysis'")
  expect(client).toContain('function MarkSwitcher')
  expect(client).toContain('/api/analyst/charts/rechart')
})

it('renders a mark switcher offering valid marks for an x+y chart', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const AnalysisToolRow = registry.get_analysis
  expect(AnalysisToolRow).toBeTypeOf('function')

  const payload = {
    ...ANALYSIS_PAYLOAD,
    analysisId: 'ana_0000000000000001',
    chart: { mark: 'bar', title: 'Revenue by region', x: 'region', y: 'revenue' },
  }
  const block = {
    kind: 'result',
    isError: false,
    content: [
      {
        type: 'text',
        text: `<<observe kind=catalog>>\n${JSON.stringify(payload)}\n<</observe>>`,
      },
    ],
  }
  const tree = AnalysisToolRow!({ block })
  const switcher = findElement(
    tree,
    (el) => typeof el.type === 'function' && (el.type as { name?: string }).name === 'MarkSwitcher',
  )
  expect(switcher).not.toBeNull()
  const switcherTree = (switcher as { type: (p: unknown) => unknown; props: unknown }).type(
    (switcher as { props: unknown }).props,
  )
  const text = elementText(switcherTree)
  expect(text).toContain('Display as:')
  for (const mark of ['table', 'bar', 'line', 'point', 'area']) {
    expect(text).toContain(mark)
  }
  expect(text).not.toContain('kpi')
})

it('sends the current revision and refreshes chart and composition state after a switch', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const setters: Array<ReturnType<typeof vi.fn>> = []
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      analysisId: 'ana_0000000000000001',
      artifactId: 'art_newchart',
      resultId: 'res_abc123',
      revision: 3,
      chart: { mark: 'line', title: 'Revenue by region', x: 'region', y: 'revenue' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  try {
    const registry = loadToolviewRegistry(clientSource, {
      useState: (initial: unknown) => {
        const setter = vi.fn()
        setters.push(setter)
        return [initial, setter]
      },
    })
    const payload = {
      ...ANALYSIS_PAYLOAD,
      analysisId: 'ana_0000000000000001',
      revision: 2,
      chart: { mark: 'bar', title: 'Revenue by region', x: 'region', y: 'revenue' },
    }
    const block = {
      kind: 'result',
      isError: false,
      content: [
        {
          type: 'text',
          text: `<<observe kind=catalog>>\n${JSON.stringify(payload)}\n<</observe>>`,
        },
      ],
    }
    const tree = registry.get_analysis!({ block })
    const switcher = findElement(
      tree,
      (el) =>
        typeof el.type === 'function' && (el.type as { name?: string }).name === 'MarkSwitcher',
    )!
    const switcherTree = (switcher.type as (props: unknown) => unknown)(switcher.props)
    const lineButton = findElement(
      switcherTree,
      (el) => el.type === 'button' && elementText(el) === 'line',
    )
    expect(lineButton).not.toBeNull()
    ;(lineButton!.props!.onClick as () => void)()

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analyst/charts/rechart',
      expect.objectContaining({
        body: JSON.stringify({
          analysisId: 'ana_0000000000000001',
          expectedRevision: 2,
          mark: 'line',
        }),
      }),
    )
    await vi.waitFor(() => expect(setters[0]).toHaveBeenCalledWith(3))
    expect(setters[1]).toHaveBeenCalledWith(
      expect.objectContaining({ mark: 'line', x: 'region', y: 'revenue' }),
    )
    expect(setters[2]).toHaveBeenCalledWith(3)
    expect(setters[3]).toHaveBeenCalledWith('art_newchart')
  } finally {
    vi.unstubAllGlobals()
  }
})

/**
 * The SQL/CTA slice above still comes from the observe payload with no extra
 * request, but a payload carrying an `analysisId` additionally mounts the
 * authenticated composition fragment — so the row *does* fetch, and that
 * fetch must land escaped server HTML in the toolview's own mount region
 * (never model context, never unescaped).
 */
it('mounts escaped fragment HTML into the AnalysisToolRow shell for an analysisId payload', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        '<section class="analyst-analysis-fragment">&lt;script&gt;alert(1)&lt;/script&gt;</section>',
        { status: 200, headers: { 'X-Analyst-Resource-Version': '2' } },
      ),
    )
  vi.stubGlobal('fetch', fetchMock)
  try {
    const effects: Array<() => void | (() => void)> = []
    const registry = loadToolviewRegistry(clientSource, {
      useEffect: (effect: () => void | (() => void)) => {
        effects.push(effect)
      },
    })
    const payload = { ...ANALYSIS_PAYLOAD, analysisId: 'ana_superstorerevenue' }
    const block = {
      kind: 'result',
      isError: false,
      content: [
        {
          type: 'text',
          text: `<<observe kind=catalog>>\n${JSON.stringify(payload)}\n<</observe>>`,
        },
      ],
    }

    const tree = registry.get_analysis!({ block })
    const shell = findFragmentShell(tree)
    expect(shell).not.toBeNull()

    // Render the nested FragmentToolRow the shell delegates to, capture its
    // mount node through the `ref` callback, then run its mount effect.
    const fragmentRow = (shell as { type: (props: unknown) => unknown }).type(
      (shell as { props: unknown }).props,
    )
    const mount = findMountNode(fragmentRow)
    expect(mount).not.toBeNull()
    const container = { innerHTML: '', dataset: {} as Record<string, string> }
    ;(mount as { props: { ref: (node: unknown) => void } }).props.ref(container)
    for (const effect of effects) effect()
    await vi.waitFor(() => expect(container.innerHTML).not.toBe(''))

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analyst/ui/analysis?analysisId=ana_superstorerevenue',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    expect(container.innerHTML).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(container.innerHTML).not.toContain('<script>')
    expect(container.dataset.resourceVersion).toBe('2')
  } finally {
    vi.unstubAllGlobals()
  }
})
