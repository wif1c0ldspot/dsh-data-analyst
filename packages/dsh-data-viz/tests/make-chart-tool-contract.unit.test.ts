/**
 * Proves the
 * `make_chart` tool's own *input* schema has no way for a model to set
 * `rendered`, `layoutValidation`, `persisted`, or any Studio-availability
 * field — those states can only ever come from `createChartArtifact`
 * running server-side, never from free-text self-attestation via a tool
 * argument. This is the structural half of "make_chart cannot claim Studio
 * or browser verification": there is no parameter path to spoof it through.
 */
import { expect, it } from 'vitest'
import { apply } from '../src/index.js'

interface CapturedTool {
  name: string
  parameters: { properties?: Record<string, unknown> }
  output: { schema: { properties?: Record<string, unknown>; required?: string[] } }
}

function fakeContext(): { ctx: unknown; registered: CapturedTool[] } {
  const registered: CapturedTool[] = []
  const ctx = {
    inject: () => {
      // No real cordis injection in this unit test — the chart-artifact-fetch
      // and rechart routes aren't under test here, only the make_chart tool
      // definition captured via tools.register below.
    },
    tools: {
      register: (tool: CapturedTool) => {
        registered.push(tool)
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

it('make_chart accepts no input parameter that could set a rendered, layout-verification, persistence or Studio-availability claim', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx as never)
  const makeChart = registered.find((tool) => tool.name === 'make_chart')
  expect(makeChart).toBeDefined()

  const forbiddenInputNames = [
    'rendered',
    'layoutValidation',
    'delivered',
    'deliveryVerified',
    'persisted',
    'availableInStudio',
    'verified',
    'visuallyVerified',
    'studioOpened',
  ]
  const topLevelProperties = makeChart!.parameters.properties ?? {}
  const intent = topLevelProperties.intent as { properties?: Record<string, unknown> } | undefined
  const format = intent?.properties?.format as { properties?: Record<string, unknown> } | undefined
  for (const forbidden of forbiddenInputNames) {
    expect(topLevelProperties).not.toHaveProperty(forbidden)
    // Also check inside the nested intent/format objects, the only other
    // input surfaces this tool exposes.
    expect(intent?.properties ?? {}).not.toHaveProperty(forbidden)
    expect(format?.properties ?? {}).not.toHaveProperty(forbidden)
  }
})

it('make_chart output declares rendered and layoutValidation as tool-produced facts, not as accepted input', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx as never)
  const makeChart = registered.find((tool) => tool.name === 'make_chart')!
  expect(makeChart.output.schema.properties).toMatchObject({
    rendered: { type: 'boolean' },
    layoutValidation: { type: 'object' },
  })
  expect(makeChart.output.schema.required).toEqual(
    expect.arrayContaining(['rendered', 'layoutValidation']),
  )
  // The output schema is a description of what execute() returns, never a
  // second input surface — dsh-tools does not accept these back from a
  // model, but assert the shape explicitly documents both facts exist
  // without also appearing as a settable input parameter.
  expect(Object.keys(makeChart.parameters.properties ?? {})).not.toContain('rendered')
  expect(Object.keys(makeChart.parameters.properties ?? {})).not.toContain('layoutValidation')
})

/**
 * `refinement` (the bounded automatic retry attempt) is the same kind
 * of server-produced-only fact as `rendered`/`layoutValidation` — declared
 * on the output schema, never accepted as an input parameter.
 */
it('make_chart output declares refinement as a tool-produced fact, not as accepted input', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx as never)
  const makeChart = registered.find((tool) => tool.name === 'make_chart')!
  expect(makeChart.output.schema.properties).toMatchObject({ refinement: { type: 'object' } })
  expect(makeChart.output.schema.required).toEqual(expect.arrayContaining(['refinement']))
  expect(Object.keys(makeChart.parameters.properties ?? {})).not.toContain('refinement')
})

/**
 * `deliveryProfile` is the only delivery-size-related input make_chart
 * accepts, and it is a bounded named enum — never a raw pixel width/number a
 * model could set arbitrarily.
 */
it('make_chart accepts only a named deliveryProfile enum, never a raw pixel width, for delivery sizing', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx as never)
  const makeChart = registered.find((tool) => tool.name === 'make_chart')!
  const topLevelProperties = makeChart.parameters.properties ?? {}
  for (const forbidden of ['deliveryWidthPx', 'width', 'widthPx', 'canvasWidth', 'pixelWidth']) {
    expect(topLevelProperties).not.toHaveProperty(forbidden)
  }
  const deliveryProfile = topLevelProperties.deliveryProfile as
    { type?: string; enum?: string[] } | undefined
  expect(deliveryProfile).toBeDefined()
  expect(deliveryProfile!.type).toBe('string')
  expect(deliveryProfile!.enum).toEqual(
    expect.arrayContaining(['chat-card', 'sidebar-narrow', 'sidebar-wide', 'export']),
  )
})
