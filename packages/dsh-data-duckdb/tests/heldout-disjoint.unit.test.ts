import { expect, it } from 'vitest'
import { GOLDEN_CASES, HELD_OUT_CASES, SYNTHETIC_GOLDEN_CASES } from '../src/nl-eval.js'

/**
 * Nothing else pins this corpus's size in code (unlike the live 69-case
 * corpus, asserted at exactly 23x3 in dsh-loop-eval.ts), so the documented
 * counts drifted unnoticed once. This canary fails loudly on the next drift
 * instead: bump both numbers here alongside the fix whenever a case is added or
 * removed, and update the held-out corpus counts in the same change.
 */
it('held-out corpus size matches the documented held-out corpus', () => {
  expect(HELD_OUT_CASES.length).toBe(76)
  expect(HELD_OUT_CASES.filter((c) => c.acceptableCharts).length).toBe(43)
})

it('held-out questions are disjoint from golden/synthetic fixture questions', () => {
  const fixtureQuestions = new Set(
    [...GOLDEN_CASES, ...SYNTHETIC_GOLDEN_CASES].map(
      (c) => `${c.datasetId}::${c.question.trim().toLowerCase()}`,
    ),
  )
  for (const held of HELD_OUT_CASES) {
    const key = `${held.datasetId}::${held.question.trim().toLowerCase()}`
    expect(fixtureQuestions.has(key), `overlap: ${key}`).toBe(false)
  }
})
