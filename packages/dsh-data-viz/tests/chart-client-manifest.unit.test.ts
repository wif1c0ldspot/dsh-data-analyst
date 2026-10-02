import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const packageDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const rootDir = join(packageDir, '..', '..')

it('declares a dsh.client toolview bundle for make_chart', async () => {
  // The root package.json is the single declared owner of this client face
  // (see client-plugin-entry.js and tests/client-face-identity.integration.test.ts) —
  // packages/dsh-data-viz/package.json must not also declare dsh.client for
  // the same file.
  const subPkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
    dsh?: { client?: unknown }
    exports?: Record<string, unknown>
  }
  expect(subPkg.dsh?.client).toBeUndefined()
  expect(subPkg.exports?.['./client']).toBeUndefined()

  const pkg = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')) as {
    dsh?: { client?: { platform?: string; inject?: string[] } }
    exports?: Record<string, unknown>
  }
  expect(pkg.dsh?.client?.platform).toBe('web')
  expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-tool')
  expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-sidebar-right')
  expect(pkg.exports?.['./client']).toBeTruthy()

  const client = await readFile(join(packageDir, 'client.js'), 'utf8')
  expect(client).toContain('window.__ModuleLoader__.load')
  expect(client).toContain("id: 'dsh-data-analyst'")
  expect(client).toContain("key: 'make_chart'")
  expect(client).toContain('/api/analyst/artifacts')
  expect(client).toContain('Pinned Kaggle version:')
  expect(client).toContain('Observed license:')
  expect(client).toContain("table.sourceFormat ?? 'csv'")
  // Right-sidebar "Data" tab (two-stage registration).
  expect(client).toContain("'sidebar.right.pane.tab'")
  expect(client).toContain("'sidebar.right.pane.tab.title'")
  expect(client).toContain("kind: 'analyst.data'")
  expect(client).toContain("studioRequest('overview'")
})
