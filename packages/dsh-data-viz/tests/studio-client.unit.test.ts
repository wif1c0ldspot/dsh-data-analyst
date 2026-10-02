import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'

interface Node {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}
function nodes(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...nodes(node.children)]
}
async function mount(initial: unknown[], props: unknown = {}) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const registry: Record<string, (props?: unknown) => unknown> = {}
  let slot = 0
  const state = initial.slice()
  const setters: ReturnType<typeof vi.fn>[] = []
  const effects: (() => unknown)[] = []
  const refs: Array<{ current: unknown }> = []
  const react = {
    createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => ({
      type,
      props: props || {},
      children,
    }),
    useRef: (value: unknown) => {
      const ref = { current: value }
      refs.push(ref)
      return ref
    },
    useEffect: (effect: () => unknown) => effects.push(effect),
    useState: (fallback: unknown) => {
      const index = slot++
      const set = vi.fn((value: unknown) => {
        state[index] = value
      })
      setters[index] = set
      return [index < state.length ? state[index] : fallback, set]
    },
  }
  new Function('window', source)({
    __ModuleLoader__: {
      load: (mod: { factory: (require: () => unknown) => { apply: (ctx: unknown) => void } }) =>
        mod
          .factory(() => react)
          .apply({
            get: () => undefined,
            slots: {
              inject: (_: unknown, register: () => void) => register(),
              register: (
                descriptor: { name: string; key: string },
                component: (props?: unknown) => unknown,
              ) => {
                if (descriptor.name === 'sidebar.right.pane.tab')
                  registry[descriptor.key] = component
              },
            },
          }),
    },
  })
  const tree = registry['dsh-data-analyst.data']!(props)
  return {
    tree,
    refs,
    setters,
    effects,
    render: (component: (props: unknown) => unknown, props: unknown, values: unknown[]) => {
      slot = 0
      state.splice(0, state.length, ...values)
      return component(props)
    },
  }
}
const definition = {
  datasetId: 'bikes',
  datasetVersionId: 'v1',
  semanticRevisionId: 's1',
  table: 'hour',
  measure: { aggregation: 'avg', column: 'cnt' },
  groupBy: { column: 'hr' },
  filters: [],
  mark: 'bar',
}
const analysis = {
  analysisId: 'ana_123',
  revision: 2,
  chart: { mark: 'bar', title: 'Hourly demand', x: 'hr', y: 'value' },
  artifactIds: ['art_123'],
  datasetVersionId: 'v1',
  semanticRevisionId: 's1',
}
const view = {
  analysis,
  datasetId: 'bikes',
  definition,
  result: {
    columns: [{ name: 'hr' }, { name: 'value' }],
    rows: [{ hr: 17, value: 525.29 }],
    rowCount: 24,
    offset: 0,
    nextOffset: null,
  },
  evidence: {
    scope: 'Complete result',
    facts: [
      {
        column: 'value',
        minimum: 1,
        maximum: 525.29,
        nonNullCount: 24,
        integerDomain: false,
        distinctCount: 24,
      },
    ],
    warnings: [],
  },
}
const overview = {
  analyses: [{ analysisId: 'ana_123', question: 'Hourly demand', revision: 2 }],
  datasets: [],
  dashboards: [],
}
const schema = {
  tables: [
    {
      id: 'hour',
      columns: [
        { name: 'hr', type: 'INTEGER' },
        { name: 'cnt', type: 'BIGINT' },
      ],
    },
  ],
}
function initial(dirty = false): unknown[] {
  return [
    overview,
    'ana_123',
    'bikes',
    view,
    schema,
    definition,
    'Hourly demand',
    'Explore',
    '',
    false,
    null,
    0,
    0,
    dirty,
  ]
}
function control(tree: unknown, label: string) {
  return nodes(tree).find((node) => node.props?.['aria-label'] === label)!
}

it('renders named navigation, exact values and complete evidence outside the chat', async () => {
  const { tree } = await mount(initial())
  expect(control(tree, 'Saved analysis')).toBeDefined()
  expect(JSON.stringify(tree)).toContain('Hourly demand · revision 2')
  expect(JSON.stringify(tree)).toContain('Verified result facts')
  expect(JSON.stringify(tree)).toContain('525.29')
  const display = control(tree, 'Display')
  expect(
    nodes(display)
      .filter((node) => node.type === 'option')
      .map((node) => node.props.value),
  ).not.toContain('kpi')
})

it('shows persistent recent reports without a selected analysis and refreshes after export', async () => {
  const state = initial()
  state[1] = null
  state[3] = null
  state[7] = 'Report'
  const mounted = await mount(state)
  const recentNode = nodes(mounted.tree).find(
    (node) =>
      typeof node.type === 'function' &&
      (node.type as (props?: unknown) => unknown).name === 'RecentReports',
  )!
  expect(recentNode).toBeDefined()
  expect(recentNode.props.refreshKey).toBe('0:0')
  const refreshWorkspace = nodes(mounted.tree).find(
    (node) => node.type === 'button' && node.children.includes('Refresh workspace'),
  )!
  ;(refreshWorkspace.props.onClick as () => void)()
  expect(mounted.setters[11]).toHaveBeenCalledOnce()
  expect(nodes(mounted.tree).some((node) => node.props.label === 'Saved analysis and export')).toBe(
    false,
  )

  const reportTree = mounted.render(
    recentNode.type as (props: unknown) => unknown,
    recentNode.props,
    [
      {
        reports: [
          {
            reportId: 'export_0123456789abcdef0123456789abcdef',
            title: 'Quarterly review',
            createdAt: '2026-09-18T00:00:00.000Z',
            source: {
              kind: 'dashboard',
              slots: [{ analysisId: 'ana_123', revision: 2, resultId: 'res_123' }],
            },
            downloads: {
              zip: '/api/analyst/reports?file=export_0123456789abcdef0123456789abcdef.zip',
            },
            missingFiles: ['html'],
            openUrl: null,
          },
        ],
      },
      'stale error',
    ],
  )
  const rendered = JSON.stringify(reportTree)
  expect(rendered).toContain('Quarterly review')
  expect(rendered).toContain('Dashboard snapshot · 1 cards')
  expect(rendered).toContain('ana_123 · revision 2 · res_123')
  expect(rendered).toContain('Report file missing')
  expect(rendered).toContain('Incomplete report files: html')
  expect(rendered).toContain('export_0123456789abcdef0123456789abcdef.zip')

  const fetchMock = vi.fn().mockResolvedValue(Response.json({ reports: [] }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    await mounted.effects.at(-1)!()
    await vi.waitFor(() => expect(mounted.setters[1]).toHaveBeenCalledWith(null))
  } finally {
    vi.unstubAllGlobals()
  }

  const selected = initial()
  selected[7] = 'Report'
  const selectedMount = await mount(selected)
  const exportCard = nodes(selectedMount.tree).find(
    (node) => node.props.label === 'Saved analysis and export',
  )!
  expect(exportCard.props.onExport).toEqual(expect.any(Function))
  expect(exportCard.props.onMutation).toBeUndefined()
  ;(exportCard.props.onExport as () => void)()
  expect(selectedMount.setters[22]).toHaveBeenCalledOnce()
  const advance = selectedMount.setters[22].mock.calls[0]![0] as (value: number) => number
  expect(advance(0)).toBe(1)
})

it('blocks changing resources while a draft is dirty and submits one bounded apply request', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ analysisId: 'ana_123', revision: 3 }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const state = initial(true)
    state[5] = { ...definition, measure: { aggregation: 'sum', column: 'cnt' } }
    const { tree } = await mount(state)
    expect(control(tree, 'Saved analysis').props.disabled).toBe(true)
    const apply = nodes(tree).find(
      (node) => node.type === 'button' && node.children.includes('Apply changes'),
    )!
    await (apply.props.onClick as () => Promise<void>)()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analyst/studio/apply',
      expect.objectContaining({
        body: JSON.stringify({
          analysisId: 'ana_123',
          expectedRevision: 2,
          title: 'Hourly demand',
          definition: state[5],
        }),
      }),
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

it('switches presentation through rechart with optimistic revision, without a query or model call', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ revision: 3 }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const { tree } = await mount(initial())
    ;(control(tree, 'Display').props.onChange as (event: unknown) => void)({
      target: { value: 'line' },
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analyst/charts/rechart',
      expect.objectContaining({
        body: JSON.stringify({ analysisId: 'ana_123', expectedRevision: 2, mark: 'line' }),
      }),
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

it('count clears a previously selected measure so it counts source rows', async () => {
  const { tree, setters } = await mount(initial())
  ;(control(tree, 'Aggregation').props.onChange as (event: unknown) => void)({
    target: { value: 'count' },
  })
  expect(setters[5]).toHaveBeenCalledWith(
    expect.objectContaining({ measure: { aggregation: 'count' } }),
  )
})

it('boolean population filters submit boolean values', async () => {
  const state = initial()
  state[4] = { tables: [{ id: 'hour', columns: [{ name: 'working', type: 'BOOLEAN' }] }] }
  state[5] = { ...definition, filters: [{ column: 'working', value: true }] }
  const { tree, setters } = await mount(state)
  ;(control(tree, 'Filter value').props.onChange as (event: unknown) => void)({
    target: { value: 'false' },
  })
  expect(setters[5]).toHaveBeenCalledWith(
    expect.objectContaining({ filters: [{ column: 'working', value: false }] }),
  )
})

it('offers a Range filter type for a numeric column and edits min/max independently, clearing a bound to undefined', async () => {
  const state = initial()
  state[4] = {
    tables: [{ id: 'hour', columns: [{ name: 'hr', type: 'INTEGER' }] }],
  }
  state[5] = { ...definition, filters: [{ column: 'hr', op: 'range', min: 5, max: 10 }] }
  const { tree, setters } = await mount(state)
  const filterType = control(tree, 'Filter type')
  expect(nodes(filterType).map((node) => node.props.value)).toEqual(
    expect.arrayContaining(['eq', 'range']),
  )
  expect(filterType.props.value).toBe('range')
  ;(control(tree, 'Range minimum').props.onChange as (event: unknown) => void)({
    target: { value: '' },
  })
  expect(setters[5]).toHaveBeenCalledWith(
    expect.objectContaining({
      filters: [{ column: 'hr', op: 'range', min: undefined, max: 10 }],
    }),
  )
  ;(control(tree, 'Range maximum').props.onChange as (event: unknown) => void)({
    target: { value: '20' },
  })
  expect(setters[5]).toHaveBeenCalledWith(
    expect.objectContaining({
      filters: [{ column: 'hr', op: 'range', min: 5, max: '20' }],
    }),
  )
})

it('switching an eq filter to Range on a date column starts with both bounds empty', async () => {
  const state = initial()
  state[4] = { tables: [{ id: 'hour', columns: [{ name: 'order_date', type: 'DATE' }] }] }
  state[5] = { ...definition, filters: [{ column: 'order_date', value: '' }] }
  const { tree, setters } = await mount(state)
  ;(control(tree, 'Filter type').props.onChange as (event: unknown) => void)({
    target: { value: 'range' },
  })
  expect(setters[5]).toHaveBeenCalledWith(
    expect.objectContaining({
      filters: [{ column: 'order_date', op: 'range', min: '', max: '' }],
    }),
  )
})

it('offers Multiple values (not Range) for a categorical column and parses newline-separated entries', async () => {
  const state = initial()
  state[4] = { tables: [{ id: 'hour', columns: [{ name: 'region', type: 'VARCHAR' }] }] }
  state[5] = { ...definition, filters: [{ column: 'region', op: 'in', values: ['East'] }] }
  const { tree, setters } = await mount(state)
  const filterType = control(tree, 'Filter type')
  expect(nodes(filterType).map((node) => node.props.value)).toEqual(
    expect.arrayContaining(['eq', 'in']),
  )
  expect(filterType.props.value).toBe('in')
  ;(control(tree, 'Filter values').props.onChange as (event: unknown) => void)({
    target: { value: 'East\nWest\n\n  ' },
  })
  expect(setters[5]).toHaveBeenCalledWith(
    expect.objectContaining({
      filters: [{ column: 'region', op: 'in', values: ['East', 'West'] }],
    }),
  )
})

it('clearing the population filter field resets to the unfiltered state for range and multi-value filters too', async () => {
  const state = initial()
  state[4] = { tables: [{ id: 'hour', columns: [{ name: 'hr', type: 'INTEGER' }] }] }
  state[5] = { ...definition, filters: [{ column: 'hr', op: 'range', min: 5, max: 10 }] }
  const { tree, setters } = await mount(state)
  ;(control(tree, 'Population filter field').props.onChange as (event: unknown) => void)({
    target: { value: '' },
  })
  expect(setters[5]).toHaveBeenCalledWith(expect.objectContaining({ filters: [] }))
})

it('a dirty draft cannot be replaced through the Data table action', async () => {
  const state = initial(true)
  state[7] = 'Data'
  const { tree } = await mount(state)
  const button = nodes(tree).find(
    (node) => node.type === 'button' && node.children.includes('Explore this table'),
  )!
  expect(button.props.disabled).toBe(true)
})

it('title-only drafts reuse the saved result through the presentation route', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ analysisId: 'ana_123', revision: 3 }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const state = initial(true)
    state[6] = 'A clearer title'
    const { tree } = await mount(state)
    const apply = nodes(tree).find(
      (node) => node.type === 'button' && node.children.includes('Apply changes'),
    )!
    await (apply.props.onClick as () => Promise<void>)()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analyst/charts/rechart',
      expect.objectContaining({
        body: JSON.stringify({
          analysisId: 'ana_123',
          expectedRevision: 2,
          mark: 'bar',
          title: 'A clearer title',
        }),
      }),
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

it('restores a session-scoped unfinished new analysis from managed persistence', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      analysisId: null,
      datasetId: 'bikes',
      draft: { title: 'Unfinished view', definition },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  try {
    const { effects, setters } = await mount(initial(), { sessionId: 'session-bike' })
    effects[1]!()
    await vi.waitFor(() => expect(setters[5]).toHaveBeenCalledWith(definition))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analyst/studio/state?sessionId=session-bike',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    expect(setters[6]).toHaveBeenCalledWith('Unfinished view')
    expect(setters[13]).toHaveBeenCalledWith(true)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('debounces saving session selection and dirty draft to the managed state route', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ saved: true }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const state = initial(true)
    state.push(true)
    const { effects } = await mount(state, { sessionId: 'session-bike' })
    const dispose = effects[2]!() as () => void
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analyst/studio/state',
      expect.objectContaining({
        body: JSON.stringify({
          sessionId: 'session-bike',
          analysisId: 'ana_123',
          datasetId: 'bikes',
          draft: { analysisId: 'ana_123', expectedRevision: 2, title: 'Hourly demand', definition },
        }),
      }),
    )
    dispose()
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it('keeps the chart ahead of a collapsed field inspector and explains saved preview', async () => {
  const { tree } = await mount(initial(true))
  const all = nodes(tree)
  const chart = all.findIndex((node) => node.type === 'img')
  const inspector = all.findIndex(
    (node) =>
      node.type === 'details' &&
      nodes(node).some((child) => child.children.includes('Edit fields and population filters')),
  )
  expect(chart).toBeGreaterThan(-1)
  expect(chart).toBeLessThan(inspector)
  expect(all[inspector]!.props.open).toBe(false)
  expect(JSON.stringify(tree)).toContain('Preview shows the saved view until Apply')
})

it('format-only Apply reuses the result and forwards only bounded presentation settings', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ analysisId: 'ana_123', revision: 3 }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const state = initial(true)
    state[5] = { ...definition, format: { decimals: 2, palette: 'colorblind' } }
    const { tree } = await mount(state)
    const apply = nodes(tree).find((node) => node.children.includes('Apply changes'))!
    await (apply.props.onClick as () => Promise<void>)()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analyst/charts/rechart',
      expect.objectContaining({
        body: JSON.stringify({
          analysisId: 'ana_123',
          expectedRevision: 2,
          mark: 'bar',
          title: 'Hourly demand',
          format: { decimals: 2, palette: 'colorblind' },
        }),
      }),
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

it('Restore previous appends a restore with the displayed revision and is disabled for dirty drafts', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ analysisId: 'ana_123', revision: 3 }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const { tree } = await mount(initial())
    const undo = nodes(tree).find((node) =>
      node.children.includes('Restore previous saved revision'),
    )!
    await (undo.props.onClick as () => Promise<void>)()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analyst/studio/restore',
      expect.objectContaining({
        body: JSON.stringify({ analysisId: 'ana_123', expectedRevision: 2, revision: 1 }),
      }),
    )
    const dirty = await mount(initial(true))
    expect(
      nodes(dirty.tree).find((node) => node.children.includes('Restore previous saved revision'))!
        .props.disabled,
    ).toBe(true)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('exact row selection uses the result group alias but stages the original source field', async () => {
  const { tree, setters } = await mount(initial())
  const values = nodes(tree).find(
    (node) => typeof node.type === 'function' && node.type.name === 'StudioTable',
  )!
  ;(values.props.onSelect as (row: unknown) => void)({ group: 17, value: 525.29 })
  expect(setters[5]).toHaveBeenCalledWith(
    expect.objectContaining({ filters: [{ column: 'hr', value: 17 }] }),
  )
  expect(setters[13]).toHaveBeenCalledWith(true)
})

it('prevents leaving a dirty dashboard layout through navigation or resource pickers', async () => {
  const state = initial()
  state[7] = 'Dashboard'
  state[14] = true
  state[15] = null
  state[16] = true
  const { tree } = await mount(state)
  expect(control(tree, 'Dashboard').props.disabled).toBe(true)
  expect(control(tree, 'Saved analysis').props.disabled).toBe(true)
  expect(
    nodes(tree).find((node) => node.type === 'button' && node.children.includes('Explore'))!.props
      .disabled,
  ).toBe(true)
})

it('renders KPI scalar from persisted array rows by the named measure column', async () => {
  const state = initial()
  state[3] = {
    ...view,
    analysis: { ...analysis, chart: { ...analysis.chart, mark: 'kpi', format: { decimals: 2 } } },
    result: { ...view.result, rows: [[17, 525.2905811623247]], rowCount: 1 },
  }
  const { tree } = await mount(state)
  expect(
    nodes(tree).some((node) => node.type === 'strong' && node.children.includes('525.29')),
  ).toBe(true)
})

it('selecting a group preserves other population filters and adds the selected series', async () => {
  const state = initial()
  const filtered = {
    ...definition,
    filters: [{ column: 'weather', value: 1 }],
    series: 'workingday',
  }
  state[5] = filtered
  state[3] = { ...view, definition: filtered }
  const { tree, setters } = await mount(state)
  const values = nodes(tree).find(
    (node) => typeof node.type === 'function' && node.type.name === 'StudioTable',
  )!
  ;(values.props.onSelect as (row: unknown) => void)([17, 1, 525.29])
  expect(setters[5]).toHaveBeenCalledWith(
    expect.objectContaining({
      filters: [
        { column: 'weather', value: 1 },
        { column: 'hr', value: 17 },
        { column: 'workingday', value: 1 },
      ],
    }),
  )
})

it('disables saved dashboard fragment mutations while layout draft is dirty', async () => {
  const state = initial()
  state[7] = 'Dashboard'
  state[8] = 'dash_123'
  state[14] = true
  state[15] = null
  state[16] = true
  const { tree } = await mount(state)
  const fragment = nodes(tree).find(
    (node) => typeof node.type === 'function' && node.type.name === 'FragmentToolRow',
  )!
  expect(fragment.props.disabled).toBe(true)
  expect(fragment.props.url).toContain('studio=true')
  expect(fragment.props.onMutation).toBeTypeOf('function')
})

it('Apply waits for an in-flight draft write and then durably clears recovery state before completing', async () => {
  vi.useFakeTimers()
  let finishDraft!: (response: Response) => void
  let finishClean!: (response: Response) => void
  const draftWrite = new Promise<Response>((resolve) => {
    finishDraft = resolve
  })
  const cleanWrite = new Promise<Response>((resolve) => {
    finishClean = resolve
  })
  let stateWrites = 0
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith('studio/state')) return ++stateWrites === 1 ? draftWrite : cleanWrite
    return Promise.resolve(Response.json({ analysisId: 'ana_123', revision: 3 }))
  })
  vi.stubGlobal('fetch', fetchMock)
  try {
    const state = initial(true)
    state[14] = true
    const { tree, effects, setters } = await mount(state, { sessionId: 'session-bike' })
    const dispose = effects[2]!() as () => void
    await vi.advanceTimersByTimeAsync(300)
    expect(stateWrites).toBe(1)
    const apply = nodes(tree).find((node) => node.children.includes('Apply changes'))!
    const applying = (apply.props.onClick as () => Promise<void>)()
    await vi.waitFor(() => expect(setters[13]).toHaveBeenCalledWith(false))
    expect(stateWrites).toBe(1)
    expect(setters[9]).not.toHaveBeenCalledWith(false)
    finishDraft(Response.json({ saved: true }))
    await vi.waitFor(() => expect(stateWrites).toBe(2))
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/analyst/studio/state',
      expect.objectContaining({
        body: JSON.stringify({
          sessionId: 'session-bike',
          analysisId: 'ana_123',
          datasetId: 'bikes',
          draft: null,
        }),
      }),
    )
    expect(setters[9]).not.toHaveBeenCalledWith(false)
    finishClean(Response.json({ saved: true }))
    await applying
    expect(setters[9]).toHaveBeenLastCalledWith(false)
    dispose()
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it.each([false, true])(
  'recovery normalizes only an exact saved draft match (divergent=%s)',
  async (divergent) => {
    const recoveredTitle = divergent ? 'Still editing this title' : 'Hourly demand'
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        Response.json(
          url.includes('studio/state')
            ? {
                analysisId: 'ana_123',
                datasetId: 'bikes',
                draft: {
                  analysisId: 'ana_123',
                  expectedRevision: 1,
                  title: recoveredTitle,
                  definition,
                },
              }
            : view,
        ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const state = initial()
      state[14] = true
      const { effects, setters } = await mount(state, { sessionId: 'session-bike' })
      effects[1]!()
      await vi.waitFor(() => expect(setters[14]).toHaveBeenLastCalledWith(true))
      effects[4]!()
      await vi.waitFor(() => expect(setters[3]).toHaveBeenCalledWith(view))
      expect(setters[13]).toHaveBeenLastCalledWith(divergent)
      expect(setters[6]).toHaveBeenLastCalledWith(recoveredTitle)
      if (divergent)
        expect(setters[10]).toHaveBeenCalledWith(
          expect.stringContaining('recovered draft is retained'),
        )
      else expect(setters[10]).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  },
)

it('Discard clears the conflict alert and persists clean recovery state', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ saved: true }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const state = initial(true)
    state[10] = 'A newer saved revision exists'
    const { tree, setters } = await mount(state, { sessionId: 'session-bike' })
    const discard = nodes(tree).find((node) => node.children.includes('Discard changes'))!
    await (discard.props.onClick as () => Promise<void>)()
    expect(setters[10]).toHaveBeenCalledWith(null)
    expect(setters[13]).toHaveBeenLastCalledWith(false)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analyst/studio/state',
      expect.objectContaining({
        body: JSON.stringify({
          sessionId: 'session-bike',
          analysisId: 'ana_123',
          datasetId: 'bikes',
          draft: null,
        }),
      }),
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

it('native mode navigation respects dirty analysis drafts', async () => {
  const { effects, setters } = await mount(initial(true), {
    useTabInfo: () => ({ tab: { navigation: { revision: 1, params: { mode: 'Data' } } } }),
  })
  effects[0]!()
  expect(setters[7]).not.toHaveBeenCalled()
  expect(setters[10]).toHaveBeenCalledWith(
    'Apply or discard your draft before opening another analysis.',
  )
})

it('native mode navigation opens clean Studio mode without querying', async () => {
  const { effects, setters } = await mount(initial(), {
    useTabInfo: () => ({ tab: { navigation: { revision: 1, params: { mode: 'Report' } } } }),
  })
  effects[0]!()
  expect(setters[7]).toHaveBeenCalledWith('Report')
  expect(setters[11]).not.toHaveBeenCalled()
})

it('opening a newly saved analysis by id refreshes the workspace overview so the selector can list it', async () => {
  // Reproduces the confirmed food-ordering walkthrough symptom: the
  // "Open analysis in Studio" receipt button (fired from a chat-driven
  // save_analysis) navigates to a fresh analysisId that predates the
  // already-open panel's cached `overview`. Selecting an id with no
  // matching <option> falls back to the "Choose a saved view" placeholder,
  // so this branch must refresh the same way the mode/job/pin branches do.
  const { effects, setters } = await mount(initial(), {
    useTabInfo: () => ({
      tab: { navigation: { revision: 1, params: { analysisId: 'ana_new' } } },
    }),
  })
  effects[0]!()
  expect(setters[1]).toHaveBeenCalledWith('ana_new')
  expect(setters[7]).toHaveBeenCalledWith('Explore')
  expect(setters[11]).toHaveBeenCalledOnce()
  const advance = setters[11]!.mock.calls[0]![0] as (value: number) => number
  expect(advance(2)).toBe(3)
})

it('picks up a newly persisted analysis in the selector once the id-triggered overview refetch resolves', async () => {
  // End-to-end through the same code path as above, but also exercises the
  // overview-fetch effect so the entry that was missing when the panel
  // opened actually arrives via the same refresh the navigation effect now
  // triggers — the client half of the route/client seam, not just the
  // setter call in isolation.
  const updatedOverview = {
    ...overview,
    analyses: [
      ...overview.analyses,
      { analysisId: 'ana_new', question: 'Orders by hour', revision: 1 },
    ],
  }
  const fetchMock = vi.fn().mockResolvedValue(Response.json(updatedOverview))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const mounted = await mount(initial(), {
      useTabInfo: () => ({
        tab: { navigation: { revision: 1, params: { analysisId: 'ana_new' } } },
      }),
    })
    // The navigation effect selects the new id and schedules a refresh.
    mounted.effects[0]!()
    expect(mounted.setters[1]).toHaveBeenCalledWith('ana_new')
    expect(mounted.setters[11]).toHaveBeenCalledOnce()

    // The overview-fetch effect is what actually refetches
    // `/api/analyst/overview` whenever `refresh` advances; run it directly
    // to prove the refetched list now contains the newly selected analysis.
    await mounted.effects[3]!()
    await vi.waitFor(() => expect(mounted.setters[0]).toHaveBeenCalledWith(updatedOverview))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analyst/overview',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    expect(updatedOverview.analyses.map((a) => a.analysisId)).toContain('ana_new')
  } finally {
    vi.unstubAllGlobals()
  }
})

it('polls compact review metadata without refreshing or replacing a draft', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      pending: { total: 2, ingestion: 2, semantic: 0, structure: 0, adaptations: 0 },
      imports: [],
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  try {
    const { tree, effects, setters } = await mount(initial(true))
    const badge = nodes(tree).find(
      (node) => typeof node.type === 'function' && node.type.name === 'StudioReviewStatus',
    )!
    const badgeTree = (badge.type as (props: unknown) => unknown)(badge.props)
    const dispose = effects.at(-1)!() as () => void
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analyst/studio/review-status',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    expect(
      nodes(badgeTree).find(
        (node) => node.type === 'button' && node.children.includes('Open reviews'),
      )!.props.disabled,
    ).toBe(true)
    await vi.advanceTimersByTimeAsync(30000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(setters[5]).not.toHaveBeenCalled()
    expect(setters[11]).not.toHaveBeenCalled()
    dispose()
    await vi.advanceTimersByTimeAsync(30000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it('pauses review status requests while the sidebar body is hidden', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  try {
    const { tree, effects } = await mount(initial(), {
      useTabInfo: () => ({ tab: { visible: false, navigation: {} } }),
    })
    const badge = nodes(tree).find(
      (node) => typeof node.type === 'function' && node.type.name === 'StudioReviewStatus',
    )!
    ;(badge.type as (props: unknown) => unknown)(badge.props)
    expect(effects.at(-1)!()).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('prevents leaving a dirty analysis for Data where review mutations could replace the draft', async () => {
  const { tree } = await mount(initial(true))
  for (const mode of ['Data', 'Dashboard', 'Report']) {
    const button = nodes(tree).find(
      (node) => node.type === 'button' && node.children.includes(mode),
    )!
    expect(button.props.disabled).toBe(true)
  }
  const current = nodes(tree).find(
    (node) => node.type === 'button' && node.children.includes('Explore'),
  )!
  expect(current.props.disabled).toBe(false)
})

it('uses short chart titles for saved view options while retaining the complete question metadata', async () => {
  const longQuestion = 'Long analytical question with provenance and caveats. '.repeat(10)
  const state = initial()
  state[0] = {
    ...overview,
    analyses: [
      { analysisId: 'ana_123', revision: 2, title: 'GTD annual incidents', question: longQuestion },
    ],
  }
  const { tree } = await mount(state)
  const picker = control(tree, 'Saved analysis')
  expect(JSON.stringify(picker)).toContain('GTD annual incidents · revision 2')
  expect(JSON.stringify(picker)).not.toContain(longQuestion)
  state[0] = {
    ...overview,
    analyses: [{ analysisId: 'ana_123', revision: 2, question: longQuestion }],
  }
  const fallback = control((await mount(state)).tree, 'Saved analysis')
  expect(JSON.stringify(fallback)).toContain('… · revision 2')
  expect(JSON.stringify(fallback)).not.toContain(longQuestion)
})

it('reloads the current analysis when reopened from a dashboard after a filter mutation', async () => {
  const state = initial()
  state[7] = 'Dashboard'
  state[8] = 'dash_123'
  const { tree, setters } = await mount(state)
  const editor = nodes(tree).find(
    (node) => typeof node.type === 'function' && node.type.name === 'StudioDashboard',
  )!
  ;(editor.props.onOpen as (id: string) => void)('ana_123')
  expect(setters[3]).toHaveBeenCalledWith(null)
  expect(setters[7]).toHaveBeenCalledWith('Explore')
  const refresh = setters[11]!.mock.calls[0]![0] as (value: number) => number
  expect(refresh(4)).toBe(5)
})

it('saves width changes without echoing legacy long titles and displays the pinned chart title', async () => {
  const state = initial()
  state[7] = 'Dashboard'
  state[8] = 'dash_123'
  const mounted = await mount(state)
  const editor = nodes(mounted.tree).find(
    (node) => typeof node.type === 'function' && node.type.name === 'StudioDashboard',
  )!
  const longTitle = 'Full source caveats and analytical question. '.repeat(12)
  const slots = [
    {
      analysisId: 'ana_123',
      revision: 2,
      title: longTitle,
      chartTitle: 'GTD incidents by year',
      width: 1,
      sharedFilterKeys: [],
    },
  ]
  const tree = mounted.render(editor.type as (props: unknown) => unknown, editor.props, [
    { dashboard: { updatedAt: 'version1' }, slots },
    [{ ...slots[0], width: 2 }],
    true,
    false,
    null,
  ])
  expect(JSON.stringify(tree)).toContain('GTD incidents by year')
  expect(JSON.stringify(tree)).not.toContain(longTitle)
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ saved: true }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const save = nodes(tree).find(
      (node) => node.type === 'button' && node.children.includes('Save dashboard layout'),
    )!
    await (save.props.onClick as () => Promise<void>)()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.slots[0]).toEqual({
      analysisId: 'ana_123',
      revision: 2,
      width: 2,
      sharedFilterKeys: [],
    })
  } finally {
    vi.unstubAllGlobals()
  }
})

it('formats a saved SQL view using the existing result without starting a field definition', async () => {
  const state = initial(true)
  state[3] = { ...view, definition: null }
  state[5] = null
  state[21] = {
    mark: 'bar',
    format: { color: '#0072B2', orientation: 'horizontal', xTicks: 'year' },
  }
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ analysisId: 'ana_123', revision: 3 }))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const { tree } = await mount(state)
    expect(control(tree, 'Mark colour').props.value).toBe('#0072B2')
    expect(control(tree, 'Bar orientation').props.value).toBe('horizontal')
    expect(control(tree, 'Chart title').props.disabled).toBe(false)
    const apply = nodes(tree).find(
      (node) => node.type === 'button' && node.children.includes('Apply changes'),
    )!
    expect(apply.props.disabled).toBe(false)
    await (apply.props.onClick as () => Promise<void>)()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/analyst/charts/rechart')
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      analysisId: 'ana_123',
      expectedRevision: 2,
      title: 'Hourly demand',
      mark: 'bar',
      format: { color: '#0072B2', orientation: 'horizontal', xTicks: 'year' },
    })
  } finally {
    vi.unstubAllGlobals()
  }
})

it('edits a series colour by its typed value and preserves other overrides', async () => {
  const state = initial()
  state[3] = {
    ...view,
    definition: null,
    analysis: {
      ...analysis,
      chart: {
        ...analysis.chart,
        series: 'group',
        format: { seriesColors: [{ value: 'B', color: '#112233' }] },
      },
    },
    result: {
      ...view.result,
      columns: [{ name: 'hr' }, { name: 'value' }, { name: 'group' }],
      rows: [
        [17, 20, 'A'],
        [18, 30, 'B'],
      ],
    },
  }
  state[5] = null
  const { tree, setters } = await mount(state)
  ;(control(tree, 'Colour for A').props.onInput as (event: unknown) => void)({
    target: { value: '#ff0000' },
  })
  expect(setters[21]).toHaveBeenCalledWith({
    mark: 'bar',
    format: {
      seriesColors: [
        { value: 'B', color: '#112233' },
        { value: 'A', color: '#ff0000' },
      ],
    },
  })
  expect(setters[13]).toHaveBeenCalledWith(true)
})

it('blocks command navigation while a persisted draft is still being recovered', async () => {
  const mounted = await mount(initial(), {
    useTabInfo: () => ({
      tab: { navigation: { revision: 1, params: { analysisId: 'ana_other' } } },
    }),
  })
  mounted.refs[0]!.current = {
    analysisId: 'ana_original',
    expectedRevision: 2,
    title: 'Draft',
    presentation: { mark: 'bar' },
  }
  mounted.effects[0]!()
  expect(mounted.setters[1]).not.toHaveBeenCalled()
  expect(mounted.setters[10]).toHaveBeenCalledWith(
    'Apply or discard your draft before opening another analysis.',
  )
})

it('uses the draft resource identity when restoring legacy mismatched session state', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      analysisId: 'ana_wrong',
      draft: {
        analysisId: 'ana_original',
        expectedRevision: 2,
        title: 'Draft',
        presentation: { mark: 'bar' },
      },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  try {
    const mounted = await mount(initial(), { sessionId: 's1' })
    mounted.effects[1]!()
    await vi.waitFor(() => expect(mounted.setters[1]).toHaveBeenCalledWith('ana_original'))
    expect(mounted.refs[0]!.current).toMatchObject({ analysisId: 'ana_original' })
  } finally {
    vi.unstubAllGlobals()
  }
})

it('never attaches a recovered presentation to a different fetched analysis', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json(view))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const mounted = await mount(initial())
    mounted.refs[0]!.current = {
      analysisId: 'ana_original',
      expectedRevision: 2,
      title: 'Draft',
      presentation: { mark: 'bar' },
    }
    mounted.effects[4]!()
    await vi.waitFor(() => expect(mounted.setters[1]).toHaveBeenCalledWith('ana_original'))
    expect(mounted.setters[3]).not.toHaveBeenCalled()
    expect(mounted.setters[5]).not.toHaveBeenCalled()
    expect(mounted.refs[0]!.current).toMatchObject({ analysisId: 'ana_original' })
  } finally {
    vi.unstubAllGlobals()
  }
})

it('updates the SQL presentation draft while a native colour picker emits input', async () => {
  const state = initial()
  state[3] = { ...view, definition: null }
  state[5] = null
  const { tree, setters } = await mount(state)
  ;(control(tree, 'Mark colour').props.onInput as (event: unknown) => void)({
    target: { value: '#009e73' },
  })
  expect(setters[21]).toHaveBeenCalledWith({ mark: 'bar', format: { color: '#009e73' } })
  expect(setters[13]).toHaveBeenCalledWith(true)
})

it('refreshes the workspace and posts a status notice when a background import finishes', async () => {
  const state = initial()
  state[7] = 'Data'
  const { tree, setters } = await mount(state)
  const badge = nodes(tree).find(
    (node) => typeof node.type === 'function' && node.type.name === 'StudioReviewStatus',
  )!
  ;(badge.props.onChanged as (value: unknown) => void)({
    imports: [{ jobId: 'job_1', slug: 'someone/widgets', status: 'ready', updatedAt: 't2' }],
  })
  expect(setters[11]).toHaveBeenCalledOnce()
  const advance = setters[11]!.mock.calls[0]![0] as (value: number) => number
  expect(advance(0)).toBe(1)
  expect(setters[20]).toHaveBeenCalledWith(
    'someone/widgets is now published — choose it below to explore.',
  )
})

it('flags an in-progress background import distinctly from published/failed', async () => {
  const state = initial()
  state[7] = 'Data'
  const { tree, setters } = await mount(state)
  const badge = nodes(tree).find(
    (node) => typeof node.type === 'function' && node.type.name === 'StudioReviewStatus',
  )!
  ;(badge.props.onChanged as (value: unknown) => void)({
    imports: [{ jobId: 'job_1', slug: 'someone/widgets', status: 'loading', updatedAt: 't2' }],
  })
  expect(setters[20]).toHaveBeenCalledWith('someone/widgets is ingesting (loading)…')
  // An in-progress status is not a publish — the dataset picker's "New" flag
  // (slot 24, justPublishedSlug) must not be set for it.
  expect(setters[24]).not.toHaveBeenCalled()
})

it('marks the just-published dataset first and prefixed in the dataset picker', async () => {
  const state = initial()
  state[0] = {
    ...overview,
    datasets: [
      { datasetId: 'ds_old', sourceSlug: 'someone/old' },
      { datasetId: 'ds_new', sourceSlug: 'someone/widgets' },
    ],
  }
  state[7] = 'Data'
  state[24] = 'someone/widgets'
  const { tree, setters } = await mount(state)
  const picker = control(tree, 'Published dataset')
  const options = nodes(picker)
    .filter((node) => node.type === 'option')
    .map((node) => [node.props.value, node.children[0]])
  expect(options).toEqual([
    ['', 'Choose a dataset'],
    ['ds_new', '● New — someone/widgets'],
    ['ds_old', 'someone/old'],
  ])
  ;(picker.props.onChange as (event: unknown) => void)({ target: { value: 'ds_new' } })
  expect(setters[24]).toHaveBeenCalledWith(null)
})

it('surfaces a failed/cancelled background import without a "published" notice', async () => {
  const state = initial()
  state[7] = 'Data'
  const { tree, setters } = await mount(state)
  const badge = nodes(tree).find(
    (node) => typeof node.type === 'function' && node.type.name === 'StudioReviewStatus',
  )!
  ;(badge.props.onChanged as (value: unknown) => void)({
    imports: [{ jobId: 'job_1', slug: 'someone/widgets', status: 'failed', updatedAt: 't2' }],
  })
  expect(setters[11]).toHaveBeenCalledOnce()
  expect(setters[20]).toHaveBeenCalledWith(
    'someone/widgets failed. See Recent imports for details.',
  )
})

it('never refreshes the workspace or overwrites the status notice while a draft is dirty', async () => {
  const state = initial(true)
  state[7] = 'Data'
  const { tree, setters } = await mount(state)
  const badge = nodes(tree).find(
    (node) => typeof node.type === 'function' && node.type.name === 'StudioReviewStatus',
  )!
  ;(badge.props.onChanged as (value: unknown) => void)({
    imports: [{ jobId: 'job_1', slug: 'someone/widgets', status: 'ready', updatedAt: 't2' }],
  })
  expect(setters[11]).not.toHaveBeenCalled()
  expect(setters[20]).not.toHaveBeenCalled()
})

it("StudioReviewStatus's own poll only reports a change from its second tick onward", async () => {
  vi.useFakeTimers()
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        pending: { total: 0, ingestion: 0, semantic: 0, structure: 0, adaptations: 0 },
        imports: [{ jobId: 'job_1', slug: 'someone/widgets', status: 'loading', updatedAt: 't1' }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        pending: { total: 0, ingestion: 0, semantic: 0, structure: 0, adaptations: 0 },
        imports: [{ jobId: 'job_1', slug: 'someone/widgets', status: 'ready', updatedAt: 't2' }],
      }),
    )
  vi.stubGlobal('fetch', fetchMock)
  try {
    const state = initial()
    state[7] = 'Data'
    const { tree, effects } = await mount(state)
    const badge = nodes(tree).find(
      (node) => typeof node.type === 'function' && node.type.name === 'StudioReviewStatus',
    )!
    const onChanged = vi.fn()
    const badgeTree = (badge.type as (props: unknown) => unknown)({ ...badge.props, onChanged })
    void badgeTree
    const dispose = effects.at(-1)!() as () => void
    await vi.advanceTimersByTimeAsync(1)
    expect(onChanged).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30000)
    expect(onChanged).toHaveBeenCalledOnce()
    dispose()
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it('refreshes review counts after metric review without replacing an open draft', async () => {
  const state = initial(true)
  state[7] = 'Data'
  state[18] = true
  const { tree, setters } = await mount(state)
  const inbox = nodes(tree).find(
    (node) => typeof node.type === 'function' && node.type.name === 'StudioInbox',
  )!
  ;(inbox.props.onStatusChanged as () => void)()
  expect(setters[23]).toHaveBeenCalledOnce()
  const increment = setters[23]!.mock.calls[0]![0] as (value: number) => number
  expect(increment(0)).toBe(1)
  expect(setters[11]).not.toHaveBeenCalled()
  expect(setters[18]).not.toHaveBeenCalled()
  expect(setters[5]).not.toHaveBeenCalled()
  const next = [...state]
  next[23] = 1
  const rerendered = await mount(next)
  const badge = nodes(rerendered.tree).find(
    (node) => typeof node.type === 'function' && node.type.name === 'StudioReviewStatus',
  )!
  expect(badge.props.refreshKey).toBe('0:1')
})
