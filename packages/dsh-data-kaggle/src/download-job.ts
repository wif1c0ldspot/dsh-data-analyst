/**
 * Download-job service for `kaggle_download`: create an idempotent import job
 * and run the fixed-argv Kaggle adapter into a coordinator-chosen destination.
 * Download completion is not dataset readiness.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  runKaggleDownload,
  validateKaggleSlug,
  validateKaggleSourceVersion,
} from './download-adapter.js'

export interface StartKaggleDownloadRequest {
  slug: string
  sourceVersion?: string
  destinationDir: string
  kaggleExecutable: string
  createJob: (input: { idempotencyKey: string; slug: string; sourceVersion?: string }) => {
    jobId: string
    status: string
  }
  updateJobStatus: (jobId: string, status: string, options?: { errorMessage?: string }) => void
  signal?: AbortSignal
}

export interface StartKaggleDownloadResult {
  jobId: string
  status: string
}

export async function startKaggleDownloadJob(
  request: StartKaggleDownloadRequest,
): Promise<StartKaggleDownloadResult> {
  const sourceVersion = request.sourceVersion ?? 'latest'
  if (sourceVersion === 'latest' || !/^[1-9][0-9]{0,8}$/.test(sourceVersion)) {
    throw new Error(
      `Pinned numeric sourceVersion is required for kaggle_download (got "${sourceVersion}")`,
    )
  }
  const idempotencyKey = `download:${request.slug}:${sourceVersion}`
  const job = request.createJob({
    idempotencyKey,
    slug: request.slug,
    sourceVersion,
  })

  if (job.status === 'failed') {
    throw new Error(`Download job ${job.jobId} previously failed for ${request.slug}`)
  }
  if (job.status === 'ready' || job.status === 'cancelled') {
    return { jobId: job.jobId, status: job.status }
  }
  if (job.status === 'validating' || job.status === 'loading' || job.status === 'profiling') {
    return { jobId: job.jobId, status: job.status }
  }

  if (job.status === 'queued') {
    request.updateJobStatus(job.jobId, 'downloading')
  }

  await mkdir(request.destinationDir, { recursive: true })
  try {
    const result = await runKaggleDownload(
      {
        slug: request.slug,
        sourceVersion,
        destinationDir: request.destinationDir,
      },
      { kaggleExecutable: request.kaggleExecutable, signal: request.signal },
    )
    if (result.exitCode !== 0) {
      request.updateJobStatus(job.jobId, 'failed', {
        errorMessage: result.stderr.slice(0, 2_000) || `kaggle exited ${result.exitCode}`,
      })
      return { jobId: job.jobId, status: 'failed' }
    }
    // Download finished; ingest/publish is a separate trusted step.
    request.updateJobStatus(job.jobId, 'validating')
    return { jobId: job.jobId, status: 'validating' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      request.updateJobStatus(job.jobId, 'failed', { errorMessage: message })
    } catch {
      // Preserve the original adapter error if status recovery also fails.
    }
    throw error
  }
}

export function downloadDestinationForSlug(
  sourcesDir: string,
  slug: string,
  sourceVersion: string,
): string {
  validateKaggleSlug(slug)
  validateKaggleSourceVersion(sourceVersion)
  return join(sourcesDir, slug.replace('/', '__'), sourceVersion)
}
