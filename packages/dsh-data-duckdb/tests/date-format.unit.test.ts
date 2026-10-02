import { expect, it } from 'vitest'
import { detectStrptimeFormat } from '../src/date-format.js'

it('detects unambiguous day-first and month-first date formats', () => {
  expect(detectStrptimeFormat(['31/01/2024', '29/02/2024'], 'DATE')).toMatchObject({
    format: '%d/%m/%Y',
    ambiguous: false,
  })
  expect(detectStrptimeFormat(['01/31/2024', '12/25/2024'], 'DATE')).toMatchObject({
    format: '%m/%d/%Y',
    ambiguous: false,
  })
  expect(detectStrptimeFormat(['2024-01-31', '2024-02-01'], 'DATE')).toMatchObject({
    format: '%Y-%m-%d',
    ambiguous: false,
  })
  expect(detectStrptimeFormat(['2024-31-01'], 'DATE')).toMatchObject({
    format: '%Y-%d-%m',
    ambiguous: false,
  })
})

it('flags DD/MM vs MM/DD ambiguity instead of guessing', () => {
  const result = detectStrptimeFormat(['01/02/2024', '02/01/2024'], 'DATE')
  expect(result.ambiguous).toBe(true)
  expect(result.format).toBeUndefined()
})

it('rejects two-digit years and mixed separators as ambiguous', () => {
  expect(detectStrptimeFormat(['01/02/24'], 'DATE').ambiguous).toBe(true)
  expect(detectStrptimeFormat(['2024-01-31', '2024/01/31'], 'DATE').ambiguous).toBe(true)
})

it('detects timestamp formats with day-first dates', () => {
  expect(
    detectStrptimeFormat(['31/01/2024 14:30:00', '29/02/2024 08:05:59'], 'TIMESTAMP'),
  ).toMatchObject({ format: '%d/%m/%Y %H:%M:%S', ambiguous: false })
  expect(detectStrptimeFormat(['2024-01-31 14:30'], 'TIMESTAMP')).toMatchObject({
    format: '%Y-%m-%d %H:%M',
    ambiguous: false,
  })
})

it('is conservative on unsupported or empty input', () => {
  expect(detectStrptimeFormat(['not a date'], 'DATE').ambiguous).toBe(true)
  expect(detectStrptimeFormat([], 'DATE')).toMatchObject({ ambiguous: false })
})
