/**
 * Unit coverage for
 * the pure diagnostic-code-to-template-change mapping, independent of
 * `createChartArtifact`'s single-retry orchestration (covered by
 * `chart-service-refinement.integration.test.ts`).
 */
import { expect, it } from 'vitest'
import { proposeChartRefinement } from '../src/chart-refinement.js'
import type { ChartLayoutDiagnostic } from 'dsh-data-core/contracts'

function diagnostic(code: ChartLayoutDiagnostic['code']): ChartLayoutDiagnostic {
  return { code, role: 'canvas', message: 'x', remediation: 'y' }
}

it('returns undefined when no diagnostic maps to a safe change', () => {
  const intent = { mark: 'bar' as const, title: 't', x: 'region', y: 'revenue' }
  expect(proposeChartRefinement(intent, [diagnostic('unreadable-svg')])).toBeUndefined()
  expect(proposeChartRefinement(intent, [])).toBeUndefined()
})

it('excessive-output-bounds: drops an explicit facetColumns override', () => {
  const intent = {
    mark: 'bar' as const,
    title: 't',
    x: 'region',
    y: 'revenue',
    facet: 'group',
    facetColumns: 6,
  }
  const proposal = proposeChartRefinement(intent, [diagnostic('excessive-output-bounds')])
  expect(proposal).toBeDefined()
  expect(proposal!.intent.facetColumns).toBeUndefined()
  expect(proposal!.intent.facet).toBe('group')
  expect(proposal!.changes).toHaveLength(1)
})

it('excessive-output-bounds: no-op when there is no facetColumns override to drop', () => {
  const intent = { mark: 'bar' as const, title: 't', x: 'region', y: 'revenue', facet: 'group' }
  expect(proposeChartRefinement(intent, [diagnostic('excessive-output-bounds')])).toBeUndefined()
})

it('oversized-axis-title/text-collision/label-out-of-bounds: flips bar orientation', () => {
  for (const code of ['oversized-axis-title', 'text-collision', 'label-out-of-bounds'] as const) {
    const intent = { mark: 'bar' as const, title: 't', x: 'region', y: 'revenue' }
    const proposal = proposeChartRefinement(intent, [diagnostic(code)])
    expect(proposal?.intent.format?.orientation).toBe('horizontal')
  }
})

it('does not flip orientation a second time once already horizontal', () => {
  const intent = {
    mark: 'bar' as const,
    title: 't',
    x: 'region',
    y: 'revenue',
    format: { orientation: 'horizontal' as const },
  }
  const proposal = proposeChartRefinement(intent, [diagnostic('text-collision')])
  expect(proposal).toBeUndefined()
})

it('does not propose an orientation flip for a non-bar mark', () => {
  const intent = { mark: 'line' as const, title: 't', x: 'month', y: 'revenue' }
  expect(proposeChartRefinement(intent, [diagnostic('oversized-axis-title')])).toBeUndefined()
})

it('blank-legend-label: moves the legend to bottom placement', () => {
  const intent = {
    mark: 'bar' as const,
    title: 't',
    x: 'region',
    y: 'revenue',
    series: 'segment',
  }
  const proposal = proposeChartRefinement(intent, [diagnostic('blank-legend-label')])
  expect(proposal?.intent.format?.legend).toBe('bottom')
})

it('combines independent fixes for multiple simultaneous diagnostics into one proposal', () => {
  const intent = {
    mark: 'bar' as const,
    title: 't',
    x: 'region',
    y: 'revenue',
    series: 'segment',
    facet: 'group',
    facetColumns: 6,
  }
  const proposal = proposeChartRefinement(intent, [
    diagnostic('excessive-output-bounds'),
    diagnostic('blank-legend-label'),
  ])
  expect(proposal?.intent.facetColumns).toBeUndefined()
  expect(proposal?.intent.format?.legend).toBe('bottom')
  expect(proposal?.changes).toHaveLength(2)
})

it('never mutates the input intent object', () => {
  const intent = {
    mark: 'bar' as const,
    title: 't',
    x: 'region',
    y: 'revenue',
    facet: 'group',
    facetColumns: 6,
  }
  const frozen = Object.freeze({ ...intent })
  expect(() =>
    proposeChartRefinement(frozen, [diagnostic('excessive-output-bounds')]),
  ).not.toThrow()
  expect(frozen.facetColumns).toBe(6)
})

/**
 * An explicit `format.orientation: 'vertical'` is an instruction, not a default the
 * service filled in, so reversing it delivers a chart the analyst did not ask for.
 * The flag is what `make_chart` tells the model to disclose; without it the
 * substitution lived only in a change log nothing surfaces to the analyst.
 */
it('marks an overridden explicit orientation, and says so in the change text', () => {
  const intent = {
    mark: 'bar' as const,
    title: 't',
    x: 'attack_category',
    y: 'count',
    format: { orientation: 'vertical' as const },
  }
  const proposal = proposeChartRefinement(intent, [diagnostic('excessive-output-bounds')])
  expect(proposal?.intent.format?.orientation).toBe('horizontal')
  expect(proposal?.overrodeRequestedFormat).toBe(true)
  expect(proposal?.changes.join(' ')).toContain('Requested vertical orientation was not used')
})

it('does not mark an override when the caller stated no orientation', () => {
  // Filling in a default the caller left open is not a reversal of anything: the
  // flag has to stay off, or every ordinary refinement would read as a substitution.
  const intent = { mark: 'bar' as const, title: 't', x: 'region', y: 'revenue' }
  const proposal = proposeChartRefinement(intent, [diagnostic('text-collision')])
  expect(proposal?.intent.format?.orientation).toBe('horizontal')
  expect(proposal?.overrodeRequestedFormat).toBeUndefined()
})
