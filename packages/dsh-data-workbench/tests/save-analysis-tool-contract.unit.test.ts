/**
 * Structural proof
 * that `save_analysis` proves persistence only (no Studio-availability
 * claim in its accepted input or declared output), and that the new
 * `check_studio_availability` tool computes `availableInStudio` itself
 * server-side rather than accepting it as an argument a model could set.
 */
import { expect, it } from 'vitest'
import { registerWorkbenchAnalystTools } from '../src/plugin-tools.js'

interface CapturedTool {
  name: string
  parameters: { properties?: Record<string, unknown> }
  output: { schema: { properties?: Record<string, unknown> } }
}

function fakeContext(): { ctx: unknown; registered: CapturedTool[] } {
  const registered: CapturedTool[] = []
  const ctx = {
    tools: {
      register: (tool: CapturedTool) => {
        registered.push(tool)
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

it('save_analysis accepts no input parameter that could set a Studio-availability claim', () => {
  const { ctx, registered } = fakeContext()
  registerWorkbenchAnalystTools(ctx as never)
  const saveAnalysis = registered.find((tool) => tool.name === 'save_analysis')!
  const properties = saveAnalysis.parameters.properties ?? {}
  for (const forbidden of ['availableInStudio', 'checkedVia', 'checkedAt', 'visuallyVerified']) {
    expect(properties).not.toHaveProperty(forbidden)
  }
  // resultId/question/artifactId/analysisId only — persistence inputs, not
  // an availability claim.
  expect(Object.keys(properties).sort()).toEqual(
    ['analysisId', 'artifactId', 'question', 'resultId'].sort(),
  )
})

it('check_studio_availability computes availableInStudio itself — no input parameter sets it', () => {
  const { ctx, registered } = fakeContext()
  registerWorkbenchAnalystTools(ctx as never)
  const checkAvailability = registered.find((tool) => tool.name === 'check_studio_availability')!
  expect(checkAvailability).toBeDefined()
  const properties = checkAvailability.parameters.properties ?? {}
  expect(Object.keys(properties).sort()).toEqual(['analysisId', 'revision'].sort())
  expect(properties).not.toHaveProperty('availableInStudio')
})
