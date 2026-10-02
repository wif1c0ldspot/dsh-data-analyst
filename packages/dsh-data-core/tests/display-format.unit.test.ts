import { expect, it } from 'vitest'
import { formatDisplayCell, formatDisplayNumber } from '../src/display-format.js'

it('groups plain integers and decimals for display', () => {
  expect(formatDisplayNumber('9688')).toBe('9,688')
  expect(formatDisplayNumber('25000')).toBe('25,000')
  expect(formatDisplayNumber('-1234567')).toBe('-1,234,567')
  expect(formatDisplayNumber('1358215.74')).toBe('1,358,215.74')
  expect(formatDisplayNumber('12')).toBe('12')
})

it('never rewrites something that only looks numeric', () => {
  // Identifiers keep their shape: leading zeroes are not quantities.
  expect(formatDisplayNumber('007')).toBe('007')
  expect(formatDisplayNumber('0012345')).toBe('0012345')
  // Ranges and labels reaching a cell stay verbatim.
  expect(formatDisplayNumber('1988-2017')).toBe('1988-2017')
  expect(formatDisplayNumber('3-5')).toBe('3-5')
  expect(formatDisplayNumber('West')).toBe('West')
  expect(formatDisplayNumber('')).toBe('')
  expect(formatDisplayNumber('1e5')).toBe('1e5')
})

it('renders a null cell as NULL rather than a number', () => {
  expect(formatDisplayCell(null)).toBe('NULL')
  expect(formatDisplayCell(undefined)).toBe('NULL')
  expect(formatDisplayCell('9688')).toBe('9,688')
  expect(formatDisplayCell(9688)).toBe('9,688')
})
