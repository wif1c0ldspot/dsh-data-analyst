/**
 * Deterministic Kaggle dataset search adapter. Runs exactly one
 * `kaggle datasets list -s <query> --csv` invocation with a fixed argument
 * array (never a shell, never string-concatenated into a shell). The query is
 * a bounded user keyword string passed as a single argv element, so shell
 * metacharacters cannot be interpreted. Results are parsed in trusted code and
 * bounded to a fixed count.
 */
import { spawn } from 'node:child_process'
import { assertKaggleExecutable, defaultPinnedKaggleExecutable } from './download-adapter.js'

export const MAX_SEARCH_QUERY_LENGTH = 200
export const MAX_SEARCH_RESULTS = 20

export class InvalidKaggleSearchQueryError extends Error {}
export class KaggleSearchTimeoutError extends Error {}

export interface KaggleSearchResult {
  /** `owner/dataset-slug`; usable as the `slug` for `preview_ingest_source`. */
  ref: string
  title: string
  size: string | null
  lastUpdated: string | null
  downloadCount: number | null
  license: string | null
}

export interface KaggleSearchOptions {
  kaggleExecutable?: string
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputBytes?: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 256 * 1024

/** Bounded CSV line parser for the CLI `--csv` output (quoted fields handled). */
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === ',') {
      fields.push(current)
      current = ''
      continue
    }
    current += char
  }
  fields.push(current)
  return fields
}

function parseResults(csv: string): KaggleSearchResult[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) return []
  const header = parseCsvLine(lines[0]!).map((name) => name.trim())
  const refIndex = header.indexOf('ref')
  const titleIndex = header.indexOf('title')
  const sizeIndex = header.indexOf('size')
  const updatedIndex = header.indexOf('lastUpdated')
  const countIndex = header.indexOf('downloadCount')
  const licenseIndex = header.indexOf('license')
  if (refIndex === -1 || titleIndex === -1) return []

  const results: KaggleSearchResult[] = []
  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line)
    const ref = fields[refIndex]?.trim()
    const title = fields[titleIndex]?.trim()
    if (!ref || !title) continue
    results.push({
      ref,
      title: title.slice(0, 200),
      size: sizeIndex >= 0 ? fields[sizeIndex]?.trim() || null : null,
      lastUpdated: updatedIndex >= 0 ? fields[updatedIndex]?.trim() || null : null,
      downloadCount:
        countIndex >= 0 && fields[countIndex] ? Number(fields[countIndex]) || null : null,
      license: licenseIndex >= 0 ? fields[licenseIndex]?.trim() || null : null,
    })
    if (results.length >= MAX_SEARCH_RESULTS) break
  }
  return results
}

/**
 * Run one bounded `kaggle datasets list -s` search. Non-zero exit surfaces a
 * plain error; the CSV body is parsed in trusted code and capped at
 * {@link MAX_SEARCH_RESULTS} rows.
 */
export async function searchKaggleSources(
  query: string,
  options: KaggleSearchOptions = {},
): Promise<KaggleSearchResult[]> {
  const trimmed = query.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new InvalidKaggleSearchQueryError(
      `Search query must be 1-${MAX_SEARCH_QUERY_LENGTH} characters`,
    )
  }
  const executable = options.kaggleExecutable ?? defaultPinnedKaggleExecutable()
  assertKaggleExecutable(executable)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES

  // Fixed argv array; `trimmed` is a single element so it can never be
  // interpreted as flags or shell syntax.
  const args = ['datasets', 'list', '-s', trimmed, '--csv']

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false

    const onData = (current: string, chunk: Buffer): string => {
      if (current.length >= maxOutputBytes) return current
      const next = current + chunk.toString('utf8')
      return next.length > maxOutputBytes ? next.slice(0, maxOutputBytes) : next
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = onData(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = onData(stderr, chunk)
    })

    const killAndWait = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 2_000).unref()
    }

    const timer = setTimeout(() => killAndWait(), timeoutMs)
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
      if (signalName === 'SIGTERM' || signalName === 'SIGKILL') {
        reject(
          new KaggleSearchTimeoutError(
            `kaggle datasets list exceeded ${timeoutMs}ms and was terminated`,
          ),
        )
        return
      }
      if (exitCode !== 0) {
        reject(new Error(stderr.slice(0, 2_000) || `kaggle datasets list failed (${exitCode})`))
        return
      }
      resolve(parseResults(stdout))
    })
  })
}
