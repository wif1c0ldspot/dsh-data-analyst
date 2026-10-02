import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'

interface Command {
  name: string
  available: (session: { sessionId?: string }) => boolean
  ui: { kind: string; run: () => void }
}

it('registers native client commands with managed disposal and opens only the Studio page', async () => {
  const commands: Command[] = []
  const disposers: unknown[] = []
  const dispose = vi.fn()
  const openTab = vi.fn()
  const register = vi.fn((command: Command) => {
    commands.push(command)
    return dispose
  })
  const scope = {
    get: (name: string) => (name === 'commandUi' ? { register } : { openTab }),
    effect: (effect: () => unknown) => disposers.push(effect()),
  }
  const inject = vi.fn((_services: string[], fn: (context: typeof scope) => void) => fn(scope))
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  new Function('window', source)({
    __ModuleLoader__: {
      load: (mod: { factory: (require: () => unknown) => { apply: (context: unknown) => void } }) =>
        mod
          .factory(() => ({}))
          .apply({ get: () => undefined, inject, slots: { inject: () => {}, register: () => {} } }),
    },
  })
  expect(inject).toHaveBeenCalledWith(['commandUi', 'sidebarRight'], expect.any(Function))
  expect(commands.map((command) => command.name)).toEqual([
    'analyst-data',
    'analyst-explore',
    'analyst-dashboard',
    'analyst-report',
    'analyst-reviews',
  ])
  expect(disposers).toEqual(Array(5).fill(dispose))
  expect(openTab).not.toHaveBeenCalled()
  for (const command of commands) {
    expect(command.available({})).toBe(false)
    expect(command.available({ sessionId: 's1' })).toBe(true)
    expect(command.ui.kind).toBe('action')
    command.ui.run()
  }
  expect(openTab.mock.calls.map((call) => call[1])).toEqual(
    ['Data', 'Explore', 'Dashboard', 'Report', 'Data'].map((mode) => ({ params: { mode } })),
  )
  expect(openTab.mock.calls.every((call) => call[0] === 'analyst.data')).toBe(true)
})
