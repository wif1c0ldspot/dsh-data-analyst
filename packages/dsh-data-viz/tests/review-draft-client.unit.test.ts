import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
interface Node {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}
function find(node: unknown, predicate: (node: Node) => boolean): Node | undefined {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map((n) => find(n, predicate)).find(Boolean)
  const element = node as Node
  return predicate(element) ? element : find(element.children, predicate)
}
const text = (node: unknown): string =>
  typeof node === 'string'
    ? node
    : Array.isArray(node)
      ? node.map(text).join(' ')
      : node && typeof node === 'object'
        ? text((node as Node).children)
        : ''
/**
 * Extract one top-level function's source by brace matching, so this harness can
 * inject the helpers the component under test calls. The component slice below is
 * a window into client.js and cannot see helpers defined outside it.
 */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`client.js no longer defines ${name}`)
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}') {
      depth--
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`)
}

async function harness(request: ReturnType<typeof vi.fn>) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const component = source.slice(
    source.indexOf('function TypeEditor('),
    source.indexOf('    function IngestRecipeToolRow('),
  )
  // The component window below uses the publisher-supplied note helpers, which
  // are defined earlier in the file and so fall outside the slice.
  const publisherHelpers = [
    'publisherNotesOf',
    'publisherDescriptionOf',
    'publisherColumnKey',
    'publisherNotesForColumn',
    'unmatchedPublisherNotes',
  ]
    .map((name) => extractFunction(source, name))
    .join('\n')
  const states: unknown[] = []
  const refs: { current: unknown }[] = []
  const dependencies: unknown[][] = []
  const effects: (() => void)[] = []
  let stateIndex = 0,
    refIndex = 0,
    effectIndex = 0
  const hooks = {
    studioRequest: request,
    REVISABLE_TYPES: ['DOUBLE', 'BIGINT', 'VARCHAR'],
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props: props ?? {},
      children,
    }),
    useState: (initial: unknown) => {
      const i = stateIndex++
      if (!(i in states)) states[i] = initial
      return [
        states[i],
        (next: unknown) => {
          states[i] = next
        },
      ]
    },
    useRef: (initial: unknown) => {
      const i = refIndex++
      return refs[i] ?? (refs[i] = { current: initial })
    },
    useEffect: (action: () => void, deps: unknown[]) => {
      const i = effectIndex++
      if (!dependencies[i] || deps.some((d, j) => d !== dependencies[i]![j])) {
        dependencies[i] = deps
        effects.push(action)
      }
    },
  }
  const renderComponent = new Function(
    'hooks',
    `const {studioRequest,REVISABLE_TYPES,createElement,useState,useRef,useEffect}=hooks;${publisherHelpers}return ${component}`,
  )(hooks) as (props: unknown) => unknown
  const props = {
    pinId: 'pin_0000000000000001',
    sessionId: 'session',
    locked: false,
    expectedRevision: 1,
    sourceVersion: '1',
    tables: [{ tableId: 'orders', columns: [{ name: 'sales', type: 'DOUBLE' }] }],
    onDirty: vi.fn(),
    onReady: vi.fn(),
    onReload: vi.fn(),
    onRevised: vi.fn(),
  }
  const render = () => {
    stateIndex = refIndex = effectIndex = 0
    const tree = renderComponent(props)
    for (const effect of effects.splice(0)) effect()
    return tree
  }
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  return {
    props,
    render,
    flush,
    change: (tree: unknown) =>
      (
        find(tree, (n) => n.props?.['aria-label'] === 'orders.sales chosen type')!.props
          .onChange as (event: unknown) => void
      )({ target: { value: 'BIGINT' } }),
    button: (tree: unknown, label: string) =>
      find(tree, (n) => n.type === 'button' && text(n) === label)!,
  }
}
it('recovers persisted changes and does not silently rebase when the proposal advances', async () => {
  const request = vi.fn().mockResolvedValue({
    draft: {
      expectedRevision: 1,
      sourceVersion: '1',
      edits: [{ tableId: 'orders', columns: [{ name: 'sales', type: 'BIGINT' }] }],
    },
    stale: false,
  })
  const h = await harness(request)
  h.render()
  await h.flush()
  expect(text(h.render())).toContain('Recovered unsaved')
  h.props.expectedRevision = 2
  h.render()
  const tree = h.render()
  expect(text(tree)).toContain('Proposal changed while you were editing')
  expect(h.button(tree, 'Save type changes').props.disabled).toBe(true)
  expect(h.props.onDirty).toHaveBeenLastCalledWith(true)
})
it('serializes discard after a delayed autosave so discarded edits cannot reappear', async () => {
  let finish: ((value: unknown) => void) | undefined
  const request = vi.fn().mockImplementation((_path: string, body?: unknown) =>
    body
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve({ draft: null, stale: false }),
  )
  const h = await harness(request)
  h.render()
  await h.flush()
  h.change(h.render())
  await h.flush()
  const resetting = (h.button(h.render(), 'Reset changes').props.onClick as () => Promise<void>)()
  expect(request).toHaveBeenCalledTimes(2)
  finish!({ saved: true })
  await h.flush()
  expect(request).toHaveBeenCalledTimes(3)
  expect(request.mock.calls[2]![1]).toMatchObject({ draft: null })
  finish!({ saved: true })
  await resetting
  expect(text(h.render())).toContain('0 unsaved changes')
})
it('keeps approval blocked until a successful revision save clears its recovery draft', async () => {
  let finish: ((value: unknown) => void) | undefined
  const request = vi.fn().mockImplementation((path: string, body?: { draft?: unknown }) =>
    path.includes('?')
      ? Promise.resolve({ draft: null, stale: false })
      : path === 'ingest-recipes/revise'
        ? Promise.resolve({ revision: 2, sourceVersion: '1', tables: [] })
        : body?.draft === null
          ? new Promise((resolve) => {
              finish = resolve
            })
          : Promise.resolve({ saved: true }),
  )
  const h = await harness(request)
  h.render()
  await h.flush()
  h.change(h.render())
  await h.flush()
  const saving = (h.button(h.render(), 'Save type changes').props.onClick as () => Promise<void>)()
  await h.flush()
  expect(h.props.onReady).toHaveBeenLastCalledWith(false)
  expect(h.props.onRevised).not.toHaveBeenCalled()
  finish!({ saved: true })
  await saving
  expect(h.props.onRevised).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }))
  expect(h.props.onReady).toHaveBeenLastCalledWith(true)
})
it('shows failed recovery persistence while preserving unsaved changes', async () => {
  const request = vi
    .fn()
    .mockImplementation((_path: string, body?: unknown) =>
      body ? Promise.reject(new Error('offline')) : Promise.resolve({ draft: null, stale: false }),
    )
  const h = await harness(request)
  h.render()
  await h.flush()
  h.change(h.render())
  await h.flush()
  expect(text(h.render())).toContain('Recovery draft not saved: offline')
  expect(text(h.render())).toContain('1 unsaved change')
  expect(h.props.onDirty).toHaveBeenLastCalledWith(true)
})

it('allows discarding a recovered draft while another proposal has unsaved changes', async () => {
  const request = vi.fn().mockResolvedValue({
    draft: {
      expectedRevision: 1,
      sourceVersion: '1',
      edits: [{ tableId: 'orders', columns: [{ name: 'sales', type: 'BIGINT' }] }],
    },
    stale: true,
  })
  const h = await harness(request)
  h.props.locked = true
  h.render()
  await h.flush()
  const tree = h.render()
  expect(h.button(tree, 'Discard draft and reload').props.disabled).toBe(false)
  expect(h.button(tree, 'Save type changes').props.disabled).toBe(true)
})
