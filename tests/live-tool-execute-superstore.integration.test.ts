/**
 * Live dsh tool execute (no LLM): duckdb_query + make_chart against published
 * Superstore. Skips cleanly when the workspace has no Superstore pointer so CI
 * without credentialed datasets still passes.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { MetadataStore } from '../packages/dsh-data-core/dist/metadata-store.js'
import { getEffectiveSemantics } from '../packages/dsh-data-core/dist/semantics.js'
import { resolveWorkspacePaths } from '../packages/dsh-data-core/dist/workspace-paths.js'
import { GOLDEN_CASES, previewMatchesExpected } from '../packages/dsh-data-duckdb/dist/nl-eval.js'
import { expect, it } from 'vitest'
import * as DuckDBPlugin from '../packages/dsh-data-duckdb/dist/index.js'
import * as KagglePlugin from '../packages/dsh-data-kaggle/dist/index.js'
import * as VizPlugin from '../packages/dsh-data-viz/dist/index.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const workspaceRoot = process.env.DSH_DATA_WORKSPACE ?? join(repoRoot, 'datasets/dev')
process.env.DSH_DATA_WORKSPACE = workspaceRoot

const workspace = resolveWorkspacePaths(workspaceRoot)
const golden = GOLDEN_CASES.find((c) => c.id === 'superstore-sales-by-region')!

function loadPublishedSuperstore():
  { datasetVersionId: string; semanticRevisionId: string; datasetPath: string } | undefined {
  if (!existsSync(workspace.catalogPath)) return undefined
  const store = new MetadataStore(workspace.catalogPath)
  try {
    const manifest = store.getCurrentDatasetVersion('superstore')
    if (!manifest) return undefined
    const semantics = getEffectiveSemantics('superstore', store)
    if (!semantics) return undefined
    const datasetPath = workspace.datasetFile(manifest.datasetVersionId, manifest.datasetId)
    if (!existsSync(datasetPath)) return undefined
    return {
      datasetVersionId: manifest.datasetVersionId,
      semanticRevisionId: semantics.semanticRevisionId,
      datasetPath,
    }
  } finally {
    store.close()
  }
}

const published = loadPublishedSuperstore()
const skipReason = published
  ? undefined
  : `Superstore not published under ${workspaceRoot} (set DSH_DATA_WORKSPACE or ingest Superstore)`

;(skipReason ? it.skip : it)(
  skipReason ?? 'live duckdb_query + make_chart against published Superstore via dsh tools.execute',
  async () => {
    const ctx = new Context()
    const prompt = ctx.plugin(SystemPrompt)
    await prompt
    const runtime = ctx.plugin(ToolRuntime)
    await runtime
    const plugins = [ctx.plugin(DuckDBPlugin), ctx.plugin(KagglePlugin), ctx.plugin(VizPlugin)]
    const queryAbort = new AbortController()
    const chartAbort = new AbortController()
    try {
      await Promise.all(plugins)

      const queryResult = await ctx.tools.execute({
        name: 'duckdb_query',
        callId: ToolCallId('p0-superstore-query'),
        arguments: {
          datasetVersionId: published!.datasetVersionId,
          semanticRevisionId: published!.semanticRevisionId,
          sql: golden.goldenSql,
          parameters: [],
        },
        signal: queryAbort.signal,
      })
      expect(queryResult.isError, JSON.stringify(queryResult.content)).toBe(false)
      if (queryResult.isError) return

      const summary = queryResult.value as {
        resultId: string
        preview: unknown[][]
      }
      expect(summary.resultId).toMatch(/^res_/)
      expect(previewMatchesExpected(summary.preview, golden.expectedPreview)).toBe(true)

      const chartResult = await ctx.tools.execute({
        name: 'make_chart',
        callId: ToolCallId('p0-superstore-chart'),
        arguments: {
          resultId: summary.resultId,
          intent: {
            mark: 'bar',
            title: 'Sales by region',
            x: 'region',
            y: 'revenue',
          },
        },
        signal: chartAbort.signal,
      })
      expect(chartResult.isError, JSON.stringify(chartResult.content)).toBe(false)
      if (chartResult.isError) return

      const chart = chartResult.value as { artifactId: string }
      expect(chart.artifactId).toMatch(/^art_/)
      expect(existsSync(join(workspace.artifactsDir, `${chart.artifactId}.svg`))).toBe(true)
      expect(existsSync(join(workspace.artifactsDir, `${chart.artifactId}.json`))).toBe(true)
    } finally {
      queryAbort.abort()
      chartAbort.abort()
      for (const plugin of plugins.reverse()) await plugin.dispose()
      await runtime.dispose()
      await prompt.dispose()
    }
  },
  60_000,
)
