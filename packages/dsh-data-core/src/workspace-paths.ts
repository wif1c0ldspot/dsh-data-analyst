/**
 * Resolve workspace paths for tools/CLIs. Paths come from the operator
 * environment (or explicit overrides), never from model arguments.
 */
import { join, resolve } from 'node:path'

export interface WorkspacePaths {
  root: string
  catalogPath: string
  resultsDir: string
  artifactsDir: string
  analysesDir: string
  sourcesDir: string
  datasetFile(datasetVersionId: string, datasetId: string): string
}

export function resolveWorkspacePaths(
  root = process.env.DSH_DATA_WORKSPACE ?? join(process.cwd(), 'datasets/dev'),
): WorkspacePaths {
  const resolvedRoot = resolve(root)
  return {
    root: resolvedRoot,
    catalogPath: join(resolvedRoot, 'catalog.sqlite'),
    resultsDir: join(resolvedRoot, 'results'),
    artifactsDir: join(resolvedRoot, 'artifacts'),
    analysesDir: join(resolvedRoot, 'analyses'),
    sourcesDir: join(resolvedRoot, 'sources'),
    datasetFile(datasetVersionId: string, datasetId: string): string {
      return join(
        resolvedRoot,
        'workspaces',
        datasetId,
        'datasets',
        datasetVersionId,
        'dataset.duckdb',
      )
    },
  }
}
