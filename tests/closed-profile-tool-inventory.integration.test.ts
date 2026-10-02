/**
 * Loads our profile through the
 * actual published dsh boot pipeline (@deepseek-ai/dsh-app-boot, the same
 * `boot()` the CLI uses) composed from the real @deepseek-ai/dsh-base
 * bundle patch plus our profile's cordis.patch.yml, and asserts the
 * *effective* tool inventory is closed to our compiled plugins only.
 * Historical evidence measured three tools; later work expanded the same
 * closed host allowlist.
 *
 * This is intentionally NOT a mock: it resolves the installed, exact-pinned
 * @deepseek-ai/dsh-base@0.1.5-rc.2 package's own cordis.patch.yml from
 * node_modules and boots the real Cordis/Loader tree, so a future dsh-base
 * upgrade that adds a new tool row (and this profile forgets to disable it)
 * fails this test instead of silently widening the allowlist.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { expect, it } from 'vitest'
import { HOST_ANALYST_TOOLS } from './analyst-tool-inventory.js'

const require = createRequire(import.meta.url)

/**
 * Row ids the profile patch is allowed to leave enabled. `tools` + `system-prompt`
 * are the registry/prompt plumbing; `timer` and `repeat-tool-reminder` are
 * dependency-free services with no model-facing tool and no filesystem/network
 * access, re-enabled for utility.
 */
const KEPT_BASE_ROW_IDS = new Set(['tools', 'system-prompt', 'timer', 'repeat-tool-reminder'])

function baseInsertRowIds(basePatches: PatchOptions[]): string[] {
  const ids: string[] = []
  for (const patch of basePatches) {
    for (const row of patch.insert ?? []) {
      if (typeof row.id === 'string') ids.push(row.id)
    }
  }
  return ids
}

it("the profile's disable list covers every dsh-base row except tools/system-prompt", () => {
  const basePatchPath = require
    .resolve('@deepseek-ai/dsh-base/package.json')
    .replace(/package\.json$/, 'cordis.patch.yml')
  const basePatches = loadOverlayPatches('p0-4-test', basePatchPath)
  const baseIds = new Set(baseInsertRowIds(basePatches))

  const profilePatchPath = fileURLToPath(
    new URL('../profiles/data-analyst/cordis.patch.yml', import.meta.url),
  )
  const profilePatches = loadOverlayPatches('p0-4-test', profilePatchPath)
  const disabledByProfile = new Set(
    profilePatches
      .filter((patch) => patch.id !== undefined && patch.disabled === true)
      .map((patch) => patch.id as string),
  )

  const expectedToBeDisabled = [...baseIds].filter((id) => !KEPT_BASE_ROW_IDS.has(id))
  const missing = expectedToBeDisabled.filter((id) => !disabledByProfile.has(id))
  expect(missing).toEqual([])

  // The profile must not disable a row that no longer exists (stale entry).
  const stale = [...disabledByProfile].filter((id) => !baseIds.has(id))
  expect(stale).toEqual([])
})

it('boots the real dsh-base + data-analyst profile composition and exposes only our analyst tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-p0-4-'))
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, '[]\n', 'utf8')

  const basePatchPath = require
    .resolve('@deepseek-ai/dsh-base/package.json')
    .replace(/package\.json$/, 'cordis.patch.yml')
  const basePatches = loadOverlayPatches('p0-4-test', basePatchPath)
  const profilePatchPath = fileURLToPath(
    new URL('../profiles/data-analyst/cordis.patch.yml', import.meta.url),
  )
  const profilePatches = loadOverlayPatches('p0-4-test', profilePatchPath)

  const ctx = await boot('p0-4-test', configPath, [...basePatches, ...profilePatches])
  try {
    const names =
      ctx.tools
        ?.schemas()
        .map((tool) => tool.name)
        .sort() ?? []
    expect(names).toEqual([...HOST_ANALYST_TOOLS])

    const forbidden = [
      'bash',
      'pwsh',
      'read_file',
      'write_file',
      'edit_file',
      'list_directory',
      'glob',
      'grep',
      'web_search',
      'web_fetch',
      'subagent',
      'subagent_fork',
      'send_message',
      'list_agents',
      'run_code',
      'exit_plan_mode',
      'ask_user_question',
      'todo_write',
      'workflow',
      'ralph',
    ]
    for (const name of forbidden) expect(names).not.toContain(name)
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
