import { expect, it } from 'vitest'
import { csvEscapeCell, renderResultCsv } from '../src/csv-export.js'

it('neutralizes spreadsheet formula-leading cells', () => {
  expect(csvEscapeCell('=1+1')).toBe("'=1+1")
  expect(csvEscapeCell('+cmd')).toBe("'+cmd")
  expect(csvEscapeCell('-1')).toBe("'-1")
  expect(csvEscapeCell('@sum')).toBe("'@sum")
})

it('quotes commas and quotes', () => {
  expect(csvEscapeCell('a,b')).toBe('"a,b"')
  expect(csvEscapeCell('say "hi"')).toBe('"say ""hi"""')
})

it('renders a full authorized result as CSV, not preview-sized', () => {
  const csv = renderResultCsv(
    [{ name: 'region' }, { name: 'revenue' }],
    [
      ['West', '10.00'],
      ['East', '=2'],
    ],
  )
  expect(csv).toBe("region,revenue\nWest,10.00\nEast,'=2\n")
})
