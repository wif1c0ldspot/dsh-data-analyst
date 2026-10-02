import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import * as DuckDBPlugin from '../packages/dsh-data-duckdb/dist/index.js'
import * as KagglePlugin from '../packages/dsh-data-kaggle/dist/index.js'
import * as VizPlugin from '../packages/dsh-data-viz/dist/index.js'
import * as WorkbenchPlugin from '../packages/dsh-data-workbench/dist/index.js'
import { HOST_ANALYST_TOOLS } from './analyst-tool-inventory.js'

it('loads compiled external plugins in the published dsh runtime and retains fail-closed behavior', async () => {
  const ctx = new Context()
  const prompt = ctx.plugin(SystemPrompt)
  await prompt
  const runtime = ctx.plugin(ToolRuntime)
  await runtime
  const plugins = [
    ctx.plugin(DuckDBPlugin),
    ctx.plugin(KagglePlugin),
    ctx.plugin(VizPlugin),
    ctx.plugin(WorkbenchPlugin),
  ]
  try {
    await Promise.all(plugins)
    expect(
      ctx.tools
        .schemas()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([...HOST_ANALYST_TOOLS])
    const result = await ctx.tools.execute({
      name: 'kaggle_download',
      callId: ToolCallId('download-stub'),
      arguments: { slug: 'not a slug' },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/slug|Invalid|not a valid|failed/i)

    let invoked = false
    ctx.tools.register(
      defineTool({
        name: 'test_probe',
        description: 'Test-only guard probe',
        parameters: {},
        output: { schema: { type: 'boolean' }, render: () => [] },
        async execute() {
          invoked = true
          return true
        },
      }),
    )
    const release = ctx.tools.guard((exec) =>
      exec.name === 'test_probe' ? 'Blocked by test policy' : undefined,
    )
    try {
      const denied = await ctx.tools.execute({
        name: 'test_probe',
        callId: ToolCallId('guard-probe'),
        arguments: {},
        signal: new AbortController().signal,
      })
      expect(denied.isError).toBe(true)
      expect(invoked).toBe(false)
      expect(JSON.stringify(denied.content)).toContain('Blocked by test policy')
    } finally {
      release()
    }
  } finally {
    for (const plugin of plugins.reverse()) await plugin.dispose()
    await runtime.dispose()
    await prompt.dispose()
  }
})
