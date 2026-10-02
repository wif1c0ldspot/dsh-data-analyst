/**
 * Same-origin confirm for adaptive ingest materiality (Publish projection /
 * Keep staging). Model tools cannot set confirm flags.
 */
import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MetadataStore, JobNotFoundError } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { deferPendingAdaptation, publishPendingAdaptation } from 'dsh-data-duckdb/ingest-pipeline'
import { isTrustedBrowserRequest } from './browser-trust.js'

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

async function findDatasetWorkspaceForJob(
  workspaceRoot: string,
  jobId: string,
): Promise<string | undefined> {
  const workspacesRoot = join(workspaceRoot, 'workspaces')
  let entries: string[]
  try {
    entries = await readdir(workspacesRoot)
  } catch {
    return undefined
  }
  for (const name of entries) {
    const candidate = join(workspacesRoot, name)
    const pending = join(candidate, 'staging', 'pending-adaptation.json')
    try {
      await access(pending)
      const raw = await readFile(pending, 'utf8')
      const parsed = JSON.parse(raw) as { jobId?: string }
      if (parsed.jobId === jobId) return candidate
    } catch {
      // keep scanning
    }
  }
  return undefined
}

export async function handleIngestAdaptConfirmRequest(
  request: Request,
  catalogPath: string,
  workspaceRoot: string,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!isTrustedBrowserRequest(request)) {
    return json({ error: 'Same-origin request required' }, 403)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400)
  const { jobId, action } = body as Record<string, unknown>
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) {
    return json({ error: 'Invalid job id' }, 400)
  }
  if (action !== 'publish' && action !== 'keep') {
    return json({ error: 'Invalid action' }, 400)
  }

  const store = new MetadataStore(catalogPath)
  try {
    const job = store.getImportJob(jobId)
    if (!job) return json({ error: `Import job ${jobId} does not exist` }, 404)
    if (job.status !== 'needs-input') {
      return json({ error: `Import job ${jobId} is not waiting for adaptation confirm` }, 409)
    }
  } catch (error) {
    if (error instanceof JobNotFoundError) return json({ error: error.message }, 404)
    throw error
  } finally {
    store.close()
  }

  const workspaceDir = await findDatasetWorkspaceForJob(workspaceRoot, jobId)
  if (!workspaceDir) {
    return json({ error: `No pending adaptation found for job ${jobId}` }, 404)
  }

  if (action === 'keep') {
    const deferred = await deferPendingAdaptation({
      catalogPath,
      workspaceDir,
      jobId,
    })
    return json(deferred)
  }

  const published = await publishPendingAdaptation({
    catalogPath,
    workspaceDir,
    jobId,
  })
  return json({
    jobId: published.jobId,
    status: published.status,
    datasetId: published.datasetId,
    datasetVersionId: published.datasetVersionId,
    materialityReasons: published.materiality?.reasons ?? [],
  })
}

export function registerIngestAdaptConfirm(ctx: Context): void {
  ctx.inject(['connection'], (webCtx) => {
    const connection = Reflect.get(webCtx, 'connection') as {
      fetch: {
        register: (route: {
          path: string
          methods: readonly string[]
          requestBody: 'buffered'
          fetch: (request: Request) => Promise<Response>
        }) => () => Promise<void>
      }
    }
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/ingest-adapt/confirm',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => {
            const workspace = resolveWorkspacePaths()
            return handleIngestAdaptConfirmRequest(request, workspace.catalogPath, workspace.root)
          },
        }),
      'dsh-data-workbench: analyst ingest adaptation confirm',
    )
  })
}
