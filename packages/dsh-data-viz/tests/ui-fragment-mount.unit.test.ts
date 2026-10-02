import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'

const packageDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

type ClientExports = {
  mountAnalystFragment: (
    container: { innerHTML: string; dataset: Record<string, string> },
    options: { url: string; signal?: AbortSignal },
  ) => Promise<{ html: string; version: string | null }>
}

async function loadClient(): Promise<ClientExports> {
  const source = await readFile(join(packageDir, 'client.js'), 'utf8')
  const fakeReact = {
    createElement: () => null,
    useEffect: () => {},
    useState: (initial: unknown) => [initial, () => {}],
  }
  const loaded: Record<string, ClientExports> = {}
  const fakeWindow = {
    __ModuleLoader__: {
      load(mod: { id: string; factory: (require: (id: string) => unknown) => ClientExports }) {
        loaded[mod.id] = mod.factory((id) => {
          if (id === 'react') return fakeReact
          throw new Error(`Unexpected require("${id}")`)
        })
      },
    },
  }
  new Function('window', source)(fakeWindow)
  return loaded['dsh-data-analyst']!
}

it('mounts escaped trusted fragment HTML and retains its resource version', async () => {
  const client = await loadClient()
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response('<section aria-label="Analysis">&lt;script&gt;safe&lt;/script&gt;</section>', {
      status: 200,
      headers: { 'X-Analyst-Resource-Version': '7' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const container = createMountContainer()

  const mounted = await client.mountAnalystFragment(container, {
    url: '/api/analyst/ui/analysis?analysisId=ana_123',
  })

  expect(fetchMock).toHaveBeenCalledWith(
    '/api/analyst/ui/analysis?analysisId=ana_123',
    expect.objectContaining({ credentials: 'same-origin' }),
  )
  expect(container.innerHTML).toContain('&lt;script&gt;safe&lt;/script&gt;')
  expect(container.innerHTML).not.toContain('<script>')
  expect(container.dataset.resourceVersion).toBe('7')
  expect(mounted).toEqual({
    html: container.innerHTML,
    version: '7',
  })
  vi.unstubAllGlobals()
})

it('posts composition mutations with expectedVersion and remounts the response', async () => {
  const client = await loadClient()
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        `<form data-analyst-action="filter" data-analyst-url="/api/analyst/ui/dashboard/filter" method="post">
  <input name="column" value="region">
  <input name="value" value="West">
  <button type="submit">Apply</button>
</form>`,
        {
          status: 200,
          headers: { 'X-Analyst-Resource-Version': 'v1' },
        },
      ),
    )
    .mockResolvedValueOnce(
      new Response('<section aria-label="Dashboard composition">filtered</section>', {
        status: 200,
        headers: { 'X-Analyst-Resource-Version': 'v2' },
      }),
    )
  vi.stubGlobal('fetch', fetchMock)
  const container = createMountContainer()
  await client.mountAnalystFragment(container, {
    url: '/api/analyst/ui/dashboard?dashboardId=dash_1',
  })

  await container.submitForm('filter', { dashboardId: 'dash_1', column: 'region', value: 'West' })

  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    '/api/analyst/ui/dashboard/filter',
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: expect.objectContaining({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        expectedVersion: 'v1',
        dashboardId: 'dash_1',
        column: 'region',
        value: 'West',
      }),
    }),
  )
  expect(container.innerHTML).toContain('filtered')
  expect(container.dataset.resourceVersion).toBe('v2')
  vi.unstubAllGlobals()
})

it('posts clear through the same version-checked dashboard filter route', async () => {
  const client = await loadClient()
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        `<form data-analyst-action="filter-clear" data-analyst-url="/api/analyst/ui/dashboard/filter" method="post"><input name="dashboardId" value="dash_1"><button type="submit">Clear</button></form>`,
        { status: 200, headers: { 'X-Analyst-Resource-Version': 'v2' } },
      ),
    )
    .mockResolvedValueOnce(
      new Response('<section aria-label="Dashboard composition">cleared</section>', {
        status: 200,
        headers: { 'X-Analyst-Resource-Version': 'v3' },
      }),
    )
  vi.stubGlobal('fetch', fetchMock)
  const container = createMountContainer()
  await client.mountAnalystFragment(container, {
    url: '/api/analyst/ui/dashboard?dashboardId=dash_1',
  })
  await container.submitForm('filter-clear', { dashboardId: 'dash_1' })
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    '/api/analyst/ui/dashboard/filter',
    expect.objectContaining({
      body: JSON.stringify({
        expectedVersion: 'v2',
        dashboardId: 'dash_1',
        operation: 'clear',
      }),
    }),
  )
  expect(container.innerHTML).toContain('cleared')
  vi.unstubAllGlobals()
})

it('replaces the mount on 409 conflict fragments', async () => {
  const client = await loadClient()
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        `<form data-analyst-action="export" data-analyst-url="/api/analyst/ui/analysis/export" method="post">
  <button type="submit">Export</button>
</form>`,
        { status: 200, headers: { 'X-Analyst-Resource-Version': '1' } },
      ),
    )
    .mockResolvedValueOnce(
      new Response('<section aria-label="Analysis composition">stale</section>', {
        status: 409,
        headers: { 'X-Analyst-Resource-Version': '2' },
      }),
    )
  vi.stubGlobal('fetch', fetchMock)
  const container = createMountContainer()
  await client.mountAnalystFragment(container, {
    url: '/api/analyst/ui/analysis?analysisId=ana_1',
  })

  await container.submitForm('export', { analysisId: 'ana_1' })

  expect(container.innerHTML).toContain('stale')
  expect(container.dataset.resourceVersion).toBe('2')
  vi.unstubAllGlobals()
})

it('emits a separate export completion event after preserving the export receipt fragment', async () => {
  const client = await loadClient()
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        `<form data-analyst-action="export" data-analyst-url="/api/analyst/ui/analysis/export" method="post"><button type="submit">Export</button></form>`,
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response('<section aria-label="Report ready">Open report</section>', { status: 200 }),
    )
  vi.stubGlobal('fetch', fetchMock)
  try {
    const container = createMountContainer()
    const completed = vi.fn()
    const mutated = vi.fn()
    container.addEventListener('analyst:export', completed)
    container.addEventListener('analyst:mutation', mutated)
    await client.mountAnalystFragment(container, {
      url: '/api/analyst/ui/analysis?analysisId=ana_1',
    })
    await container.submitForm('export', { analysisId: 'ana_1' })
    expect(completed).toHaveBeenCalledOnce()
    expect(mutated).not.toHaveBeenCalled()
    expect(container.innerHTML).toContain('Report ready')
  } finally {
    vi.unstubAllGlobals()
  }
})

type MountContainer = {
  innerHTML: string
  dataset: Record<string, string>
  addEventListener: (type: string, listener: (event: never) => void) => void
  dispatchEvent: (event: Event) => boolean
  submitForm: (action: string, fields: Record<string, string>) => Promise<void>
}

type SubmitEventLike = {
  preventDefault: () => void
  target: {
    getAttribute: (name: string) => string | null
    elements?: ArrayLike<{ name?: string; value?: string }>
  }
}

function createMountContainer(): MountContainer {
  const listeners: Record<string, Array<(event: never) => void | Promise<void>>> = {}
  const container: MountContainer = {
    innerHTML: '',
    dataset: {},
    addEventListener(type, listener) {
      ;(listeners[type] ||= []).push(listener)
    },
    dispatchEvent(event) {
      for (const listener of listeners[event.type] || []) listener(event as never)
      return true
    },
    async submitForm(action, fields) {
      const event: SubmitEventLike = {
        preventDefault() {},
        target: {
          getAttribute(name) {
            if (name === 'data-analyst-action') return action
            if (name === 'data-analyst-url') {
              if (action === 'filter' || action === 'filter-clear')
                return '/api/analyst/ui/dashboard/filter'
              if (action === 'export') return '/api/analyst/ui/analysis/export'
              return null
            }
            if (name === 'data-analyst-dashboard-id') return 'dash_1'
            return null
          },
          elements: Object.entries(fields).map(([name, value]) => ({ name, value })),
        },
      }
      for (const listener of listeners.submit || []) {
        await listener(event as never)
      }
    },
  }
  return container
}
