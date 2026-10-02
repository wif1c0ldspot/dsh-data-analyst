/**
 * Prove a test-only dsh-base composition that re-enables
 * NL_SESSION_CANDIDATE_ROWS while keeping ALWAYS_DISABLED_TOOL_ROWS off and
 * the effective tool inventory closed (our three plugins only).
 *
 * Production boots still use only cordis.patch.yml (closed). This overlay is
 * never part of the live profile allowlist.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'
import { HOST_ANALYST_TOOLS } from './analyst-tool-inventory.js'
import {
  ALWAYS_DISABLED_TOOL_ROWS,
  NL_SESSION_CANDIDATE_ROWS,
} from './nl-session-candidate-rows.js'

const require = createRequire(import.meta.url)

const FORBIDDEN_TOOL_NAMES = [
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
] as const

function loadCompositionPatches() {
  const basePatchPath = require
    .resolve('@deepseek-ai/dsh-base/package.json')
    .replace(/package\.json$/, 'cordis.patch.yml')
  const basePatches = loadOverlayPatches('p3-nl-session', basePatchPath)

  const profilePatchPath = fileURLToPath(
    new URL('../profiles/data-analyst/cordis.patch.yml', import.meta.url),
  )
  const profilePatches = loadOverlayPatches('p3-nl-session', profilePatchPath)

  const candidatePatchPath = fileURLToPath(
    new URL(
      '../tests/fixtures/cordis-overlays/cordis.nl-session.candidate.patch.yml',
      import.meta.url,
    ),
  )
  const candidatePatches = loadOverlayPatches('p3-nl-session', candidatePatchPath)

  return [...basePatches, ...profilePatches, ...candidatePatches]
}

it('candidate overlay re-enables every NL_SESSION_CANDIDATE_ROWS id and none of ALWAYS_DISABLED', () => {
  const candidatePatchPath = fileURLToPath(
    new URL(
      '../tests/fixtures/cordis-overlays/cordis.nl-session.candidate.patch.yml',
      import.meta.url,
    ),
  )
  const candidatePatches = loadOverlayPatches('p3-nl-session', candidatePatchPath)
  const reenabled = new Set(
    candidatePatches
      .filter((patch) => patch.id !== undefined && patch.disabled === false)
      .map((patch) => patch.id as string),
  )

  expect([...reenabled].sort()).toEqual([...NL_SESSION_CANDIDATE_ROWS].sort())
  for (const id of ALWAYS_DISABLED_TOOL_ROWS) {
    expect(reenabled.has(id), `${id} must stay out of the candidate overlay`).toBe(false)
  }
})

it('boots dsh-base + closed profile + NL candidate overlay with only our analyst tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-p3-nl-session-'))
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, '[]\n', 'utf8')

  const patches = loadCompositionPatches()
  const ctx = await boot('p3-nl-session', configPath, patches)
  try {
    const names =
      ctx.tools
        ?.schemas()
        .map((tool) => tool.name)
        .sort() ?? []
    expect(names).toEqual([...HOST_ANALYST_TOOLS])

    for (const name of FORBIDDEN_TOOL_NAMES) expect(names).not.toContain(name)
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
