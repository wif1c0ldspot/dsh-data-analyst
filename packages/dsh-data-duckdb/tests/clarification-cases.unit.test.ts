import { expect, it } from 'vitest'
import { CLARIFICATION_CASES, REFUSAL_CASES } from '../src/nl-eval.js'

it('clarification/refusal corpus has at least 12 cases with clarify|refuse only', () => {
  expect(CLARIFICATION_CASES.length).toBeGreaterThanOrEqual(12)
  expect(REFUSAL_CASES).toBe(CLARIFICATION_CASES)
  for (const testCase of CLARIFICATION_CASES) {
    expect(['clarify', 'refuse']).toContain(testCase.expected)
    expect(testCase.id.length).toBeGreaterThan(0)
    expect(testCase.question.trim().length).toBeGreaterThan(0)
    expect(testCase.rationale.trim().length).toBeGreaterThan(0)
  }
  expect(CLARIFICATION_CASES.some((c) => c.expected === 'clarify')).toBe(true)
  expect(CLARIFICATION_CASES.some((c) => c.expected === 'refuse')).toBe(true)
})
