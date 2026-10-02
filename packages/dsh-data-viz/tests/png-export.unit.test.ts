import { expect, it } from 'vitest'
import { createPngFromSvg } from '../src/png-export.js'

it('renders a tiny SVG to a non-empty PNG buffer with PNG magic bytes', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#0b5fff"/></svg>'
  const png = createPngFromSvg(svg)
  expect(png.length).toBeGreaterThan(0)
  expect(png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true)
})

it('renders text rather than silently dropping all chart labels', () => {
  const empty = createPngFromSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80"><rect width="300" height="80" fill="white"/></svg>',
  )
  const labelled = createPngFromSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80"><rect width="300" height="80" fill="white"/><text x="10" y="40" font-size="24" fill="black">Revenue 525.29</text></svg>',
  )
  expect(labelled.equals(empty)).toBe(false)
  expect(labelled.length).toBeGreaterThan(empty.length)
})
