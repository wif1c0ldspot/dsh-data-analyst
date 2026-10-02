import { registerStudioRoutes } from './studio-routes.js'
import { registerAliasReview } from './alias-review.js'
import { registerChartFeedbackReview } from './chart-feedback-review.js'
import { registerIngestAdaptConfirm } from './ingest-adapt-confirm.js'
import { registerIngestRecipeReview } from './ingest-recipe-review.js'
import { registerInterpretationReview } from './interpretation-review.js'
import { registerLearningReview } from './learning-review.js'
import { registerAnalystOverview } from './overview.js'
import { registerReportFetch } from './report-fetch.js'
import { registerStructureReview } from './structure-review.js'
import { registerAnalystUiRoutes } from './ui-routes.js'
import type { Context } from '@deepseek-ai/cordis'
import { registerWorkbenchAnalystTools } from './plugin-tools.js'

export { resolveSafeArtifact } from './artifact-path.js'
export { writeExportPack } from './export-pack.js'
export { registerWorkbenchAnalystTools } from './plugin-tools.js'

export const name = 'dsh-data-workbench'
export const inject = ['tools']

function registerConfiguredWorkspace(ctx: Context): void {
  const workspaceRoot = process.env.DSH_DATA_WORKSPACE?.trim()
  if (!workspaceRoot) return
  ctx.inject(['workspaceRegistry'], (workspaceCtx) => {
    const registry = Reflect.get(workspaceCtx, 'workspaceRegistry') as {
      create: (path: string, title?: string) => Promise<unknown>
    }
    workspaceCtx.effect(async () => {
      await registry.create(workspaceRoot, 'Analyst data')
      return () => undefined
    }, 'dsh-data-workbench: configured analyst workspace')
  })
}

export function apply(ctx: Context) {
  registerConfiguredWorkspace(ctx)
  registerAliasReview(ctx)
  registerChartFeedbackReview(ctx)
  registerIngestRecipeReview(ctx)
  registerIngestAdaptConfirm(ctx)
  registerInterpretationReview(ctx)
  registerLearningReview(ctx)
  registerStructureReview(ctx)
  registerAnalystOverview(ctx)
  registerStudioRoutes(ctx)
  registerReportFetch(ctx)
  registerAnalystUiRoutes(ctx)
  registerWorkbenchAnalystTools(ctx)
}
