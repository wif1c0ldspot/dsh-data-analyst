/**
 * Shared cell-value tolerance used by both the SQL preview grader
 * (`nl-eval.ts`) and the chart grader (`chart-grader.ts`) so there is exactly
 * one definition of "value matches" across the eval harness. Moved out of
 * `nl-eval.ts` (where these were private) into its own module rather than
 * exported directly from there, because `nl-eval.ts` already imports from
 * `chart-grader.ts` — a direct export would have made the two modules
 * circular the moment chart-grader.ts needed the same tolerance.
 */

/**
 * True when two result cells are the "same" value for grading purposes:
 * identical, equal after string coercion, or numerically equal within 0.01
 * (money rounding). Used both for exact preview comparison and for the
 * subset/role matchers that tolerate reshaping or renaming.
 */
export function cellsMatch(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true
  const a = actual == null ? '' : String(actual)
  const e = expected == null ? '' : String(expected)
  if (a === e) return true
  const an = Number(a)
  const en = Number(e)
  if (!Number.isFinite(an) || !Number.isFinite(en)) return false
  return Math.abs(an - en) <= 0.01
}

/** True when `value` denotes a measurable number (via the same coercion `cellsMatch` uses). */
export function isMeasurableCell(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  const s = value == null ? '' : String(value)
  if (s.trim() === '') return false
  return Number.isFinite(Number(s))
}
