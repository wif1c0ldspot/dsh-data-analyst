/**
 * Deterministic Kaggle download adapter. Invokes a fixed
 * executable with a fixed argument array — never a model-authored shell
 * command, never string-concatenated into a shell — and never accepts a
 * caller-supplied path or environment override. Credentials resolve from the
 * operator's own process environment / `~/.kaggle` configuration, exactly as
 * the official `kaggle` CLI already does; this adapter does not read, forward,
 * or log them. See docs/contracts.md's `kaggle_download` note ("the
 * coordinator chooses paths and credentials").
 */
import { accessSync, constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `owner/dataset-slug`; optional `/version` is composed separately for downloads. */
const SLUG_PATTERN = /^[a-z0-9][\w-]{1,99}\/[a-z0-9][\w.-]{1,149}$/i
const VERSION_PATTERN = /^[1-9][0-9]{0,8}$/

export class InvalidKaggleSlugError extends Error {}
export class InvalidKaggleSourceVersionError extends Error {}
export class KaggleDownloadTimeoutError extends Error {}
export class MissingKaggleExecutableError extends Error {}

export interface KaggleDownloadRequest {
  /** `owner/dataset-slug`, validated against {@link SLUG_PATTERN} before use. */
  slug: string
  /**
   * Pinned Kaggle dataset version number (positive integer string). Required for
   * provenance-correct downloads — `"latest"` is refused so upstream bytes cannot
   * silently drift under a recorded version.
   */
  sourceVersion: string
  /** Absolute directory the coordinator created for this job; never caller-chosen. */
  destinationDir: string
}

export interface KaggleDownloadOptions {
  /** Defaults to `'kaggle'`, resolved via PATH like any other trusted executable. */
  kaggleExecutable?: string
  /** Hard wall-clock cap; the child is killed (and awaited) past this point. */
  timeoutMs?: number
  /** Caller-owned cancellation; the child is killed the same way as a timeout. */
  signal?: AbortSignal
  /** Cap on buffered stdout/stderr bytes, to bound memory on a runaway process. */
  maxOutputBytes?: number
}

export interface KaggleDownloadResult {
  exitCode: number | null
  signalName: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** True when a byte cap truncated the buffered output (not the download itself). */
  outputTruncated: boolean
  /** Exact `-d` dataset reference passed to kaggle, including version. */
  datasetRef: string
  sourceVersion: string
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000 // matches the architecture's 10-minute import cap.
const DEFAULT_MAX_OUTPUT_BYTES = 65_536

export function validateKaggleSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new InvalidKaggleSlugError(
      `"${slug}" is not a valid Kaggle "owner/dataset-slug" reference`,
    )
  }
}

export function validateKaggleSourceVersion(sourceVersion: string): void {
  if (!VERSION_PATTERN.test(sourceVersion)) {
    throw new InvalidKaggleSourceVersionError(
      `"${sourceVersion}" is not a pinned Kaggle dataset version number (refuse "latest")`,
    )
  }
}

/** Build the kaggle `-d` value `owner/dataset/version` from validated parts. */
export function pinnedDatasetRef(slug: string, sourceVersion: string): string {
  validateKaggleSlug(slug)
  validateKaggleSourceVersion(sourceVersion)
  return `${slug}/${sourceVersion}`
}

/**
 * Absolute path to the pinned `tools/kaggle-cli` console script, or
 * `DSH_KAGGLE_EXECUTABLE` when the operator overrides it. Resolved from this
 * package location so a dsh host started outside the repo cwd still finds the
 * checkout binary.
 */
export function defaultPinnedKaggleExecutable(): string {
  const override = process.env.DSH_KAGGLE_EXECUTABLE?.trim()
  if (override) return resolve(override)
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
  return resolve(repoRoot, 'tools/kaggle-cli/.venv/bin/kaggle')
}

/**
 * Fail closed before spawn when the configured CLI is missing — Node's raw
 * `spawn … ENOENT` is opaque after observe path-redaction.
 */
export function assertKaggleExecutable(executable: string): void {
  try {
    accessSync(executable, constants.X_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new MissingKaggleExecutableError(
        'Pinned Kaggle CLI executable not found. From the repo root run: ' +
          'cd tools/kaggle-cli && uv sync. Or set DSH_KAGGLE_EXECUTABLE to an ' +
          'absolute path for an installed kaggle binary.',
      )
    }
    throw new MissingKaggleExecutableError(
      'Pinned Kaggle CLI executable is not runnable. From the repo root run: ' +
        'cd tools/kaggle-cli && uv sync. Or set DSH_KAGGLE_EXECUTABLE to an ' +
        'absolute path for an installed kaggle binary.',
    )
  }
}

/**
 * Run exactly one `kaggle datasets download` invocation with a fixed argument
 * array. Never unzips (archive validation happens in trusted code before any
 * extraction); never passes `--force` past what the coordinator's fresh job
 * directory already guarantees; never receives a shell.
 */
export async function runKaggleDownload(
  request: KaggleDownloadRequest,
  options: KaggleDownloadOptions = {},
): Promise<KaggleDownloadResult> {
  const datasetRef = pinnedDatasetRef(request.slug, request.sourceVersion)
  const executable = options.kaggleExecutable ?? defaultPinnedKaggleExecutable()
  assertKaggleExecutable(executable)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  // Fixed argv array. datasetRef is pattern-validated above;
  // request.destinationDir is the coordinator's own job directory, never a
  // path a model or analyst request supplies directly to this function.
  const args = ['datasets', 'download', '-d', datasetRef, '-p', request.destinationDir, '-q']

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let outputTruncated = false
    let settled = false
    let timedOut = false

    const appendCapped = (current: string, chunk: Buffer): string => {
      if (current.length >= maxOutputBytes) {
        outputTruncated = true
        return current
      }
      const next = current + chunk.toString('utf8')
      if (next.length > maxOutputBytes) {
        outputTruncated = true
        return next.slice(0, maxOutputBytes)
      }
      return next
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk)
    })

    const killAndWait = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      // Escalate if the process ignores SIGTERM; do not leave a wedged worker.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 2_000).unref()
    }

    const timer = setTimeout(() => {
      timedOut = true
      killAndWait()
    }, timeoutMs)
    timer.unref()

    const onAbort = (): void => killAndWait()
    options.signal?.addEventListener('abort', onAbort)

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })

    child.on('close', (exitCode, signalName) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (timedOut) {
        reject(
          new KaggleDownloadTimeoutError(
            `kaggle datasets download exceeded ${timeoutMs}ms and was terminated`,
          ),
        )
        return
      }
      resolve({
        exitCode,
        signalName,
        stdout,
        stderr,
        outputTruncated,
        datasetRef,
        sourceVersion: request.sourceVersion,
      })
    })
  })
}
