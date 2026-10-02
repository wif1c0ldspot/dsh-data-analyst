// Registration verified against the published dsh pin. Queries run in a
// scrubbed child process after SQL policy; published datasets open
// read-only from the catalog. This plugin owns staging/publication and the
// read-only query-worker lifecycle through services; tools are narrow consumers.
import { mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { openMetadataStore } from 'dsh-data-core/catalog'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { registerIngestRecipeRevise } from './ingest-revise.js'
import { registerDuckdbAnalystTools } from './plugin-tools.js'
import { DuckdbAnalystService } from './plugin-service.js'

export const name = 'dsh-data-duckdb'
export const inject = ['tools']

export function apply(ctx: Context) {
  const workspace = resolveWorkspacePaths()
  mkdirSync(workspace.root, { recursive: true })
  const store = openMetadataStore(workspace.catalogPath)
  store.close()
  const service = new DuckdbAnalystService(workspace)
  ctx.provide('dataDuckdb', service)
  ctx.effect(() => () => service.dispose(), 'dsh-data-duckdb: managed service lifecycle')
  registerIngestRecipeRevise(ctx)
  registerDuckdbAnalystTools(ctx, service)
}
