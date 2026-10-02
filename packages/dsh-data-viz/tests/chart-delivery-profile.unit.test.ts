/**
 * Delivery-width
 * profiles are a small, bounded, service-owned enum mapped internally to
 * fixed pixel widths — never a raw model-supplied dimension.
 */
import { expect, it } from 'vitest'
import { ChartDeliveryProfileSchema } from 'dsh-data-core/contracts'
import { deliveryWidthPxForProfile } from '../src/chart.js'

it('accepts only the four named profiles, never an arbitrary string or number', () => {
  for (const profile of ['chat-card', 'sidebar-narrow', 'sidebar-wide', 'export']) {
    expect(ChartDeliveryProfileSchema.safeParse(profile).success).toBe(true)
  }
  for (const invalid of [420, '420', '420px', 'full-width', null, undefined, {}]) {
    expect(ChartDeliveryProfileSchema.safeParse(invalid).success).toBe(false)
  }
})

it('maps every profile to a distinct, bounded pixel width', () => {
  const widths = ChartDeliveryProfileSchema.options.map((profile) =>
    deliveryWidthPxForProfile(profile),
  )
  // Distinct: each profile actually means something different.
  expect(new Set(widths).size).toBe(widths.length)
  for (const width of widths) {
    expect(width).toBeGreaterThan(0)
    // Bounded: no profile can itself request an unbounded/pathological width
    // (the layout validator's own absolute canvas cap is 950px wide, so no
    // named profile should sit at or beyond it on its own).
    expect(width).toBeLessThan(950)
  }
})

it('orders profiles narrow to wide as their names suggest', () => {
  expect(deliveryWidthPxForProfile('chat-card')).toBeLessThan(
    deliveryWidthPxForProfile('sidebar-narrow'),
  )
  expect(deliveryWidthPxForProfile('sidebar-narrow')).toBeLessThan(
    deliveryWidthPxForProfile('sidebar-wide'),
  )
  expect(deliveryWidthPxForProfile('sidebar-wide')).toBeLessThan(
    deliveryWidthPxForProfile('export'),
  )
})
