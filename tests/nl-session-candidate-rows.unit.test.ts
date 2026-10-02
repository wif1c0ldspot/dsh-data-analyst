/**
 * Documents the session enablement delta vs the live closed profile. Does
 * not enable model rows — only asserts the inventory contract in
 * docs/dsh-compatibility.md remains true for production boots.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import {
  ALWAYS_DISABLED_TOOL_ROWS,
  LIVE_DISABLED_EXTRA_ROWS,
  NL_SESSION_CANDIDATE_ROWS,
} from './nl-session-candidate-rows.js'

export { ALWAYS_DISABLED_TOOL_ROWS, NL_SESSION_CANDIDATE_ROWS }

function disabledIdsFromProfile(): Set<string> {
  const path = fileURLToPath(new URL('../profiles/data-analyst/cordis.patch.yml', import.meta.url))
  const text = readFileSync(path, 'utf8')
  const ids = new Set<string>()
  let currentId: string | undefined
  for (const line of text.split('\n')) {
    const idMatch = line.match(/^- id:\s*(\S+)\s*$/)
    if (idMatch) {
      currentId = idMatch[1]
      continue
    }
    if (currentId && /^\s+disabled:\s*true\s*$/.test(line)) {
      ids.add(currentId)
      currentId = undefined
    }
  }
  return ids
}

it('live profile keeps NL session candidates disabled until operator enablement', () => {
  const disabled = disabledIdsFromProfile()
  for (const id of NL_SESSION_CANDIDATE_ROWS) {
    expect(disabled.has(id), `${id} should still be disabled in cordis.patch.yml`).toBe(true)
  }
})

it('live profile keeps shell/web/subagent tool rows disabled', () => {
  const disabled = disabledIdsFromProfile()
  const missing = ALWAYS_DISABLED_TOOL_ROWS.filter((id) => !disabled.has(id))
  expect(missing).toEqual([])
})

it('live profile keeps skill rows disabled until product composition enables them', () => {
  const disabled = disabledIdsFromProfile()
  const missing = LIVE_DISABLED_EXTRA_ROWS.filter((id) => !disabled.has(id))
  expect(missing).toEqual([])
})
