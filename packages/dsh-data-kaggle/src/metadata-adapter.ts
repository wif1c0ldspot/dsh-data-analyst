/**
 * Bounded Kaggle dataset-metadata adapter.
 *
 * Kaggle's CLI metadata command accepts a dataset slug but does not document a
 * version selector. Callers may show the observed license during analyst
 * review, but must persist only `verifiedLicense`: it is non-null only when
 * the response itself identifies the exact requested source version.
 *
 * The same two payloads also carry the publisher's free-text description,
 * subtitle and keywords — quoted, labelled and bounded by
 * `./publisher-metadata.js`, never mixed into these version/license fields.
 * This module exposes the validated raw payload readers so one CLI call (or one
 * view-API call) can serve both purposes.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertKaggleExecutable,
  defaultPinnedKaggleExecutable,
  validateKaggleSlug,
  validateKaggleSourceVersion,
} from './download-adapter.js'

const METADATA_FILE = 'dataset-metadata.json'
const MAX_METADATA_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

export class InvalidKaggleMetadataError extends Error {}
export class KaggleMetadataVersionMismatchError extends Error {}

export interface KaggleMetadataRequest {
  slug: string
  sourceVersion: string
  /** Coordinator-owned scratch directory; never accepted as a model argument. */
  destinationDir: string
}

/** The `datasets metadata` command takes no version selector — slug + scratch dir only. */
export interface KaggleMetadataPayloadRequest {
  slug: string
  /** Coordinator-owned scratch directory; never accepted as a model argument. */
  destinationDir: string
}

export interface KaggleLatestVersionRequest {
  slug: string
  /** Coordinator-owned scratch directory; never accepted as a model argument. */
  destinationDir: string
}

export interface KaggleMetadataOptions {
  kaggleExecutable?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface KaggleDatasetMetadata {
  slug: string
  sourceVersion: string
  title: string | null
  observedLicense: string | null
  observedSourceVersion: string | null
  versionVerified: boolean
  /** Safe to persist on a versioned recipe; null unless versionVerified. */
  verifiedLicense: string | null
}

/** Version-discovery result: the current (latest) version the CLI reports. */
export interface KaggleLatestVersion {
  slug: string
  title: string | null
  /** Current version number; null when the metadata response omits it. */
  sourceVersion: string | null
  license: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength) return null
  return normalized
}

function observedVersion(metadata: Record<string, unknown>): string | null {
  const value = metadata.versionNumber ?? metadata.currentVersionNumber
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9][0-9]{0,8}$/.test(value.trim())) return value.trim()
  return null
}

function observedLicense(metadata: Record<string, unknown>): string | null {
  if (!Array.isArray(metadata.licenses) || metadata.licenses.length === 0) return null
  const names = metadata.licenses
    .slice(0, 8)
    .map((entry) => (isRecord(entry) ? boundedString(entry.name, 128) : null))
    .filter((name): name is string => name !== null)
  return names.length > 0 ? names.join(', ') : null
}

/**
 * Kaggle CLI 2.2.x returns `{ info: { datasetSlug, title, licenses } }` without
 * an owner or version. Older CLI/API responses use top-level `{ id:
 * "owner/dataset", ... }`. Accept both, but never infer an owner or version the
 * response did not carry. Returns the nested `info` record (or null) so callers
 * can fall back to it for title/license/version fields.
 */
function metadataInfo(
  value: Record<string, unknown>,
  expectedSlug: string,
): Record<string, unknown> | null {
  const info = isRecord(value.info) ? value.info : null
  const returnedSlug = boundedString(value.id, 250)
  if (returnedSlug !== null && returnedSlug.toLowerCase() !== expectedSlug.toLowerCase()) {
    throw new InvalidKaggleMetadataError('Kaggle metadata id does not match the requested slug')
  }
  const expectedDatasetSlug = expectedSlug.split('/')[1]!
  const returnedDatasetSlug = info ? boundedString(info.datasetSlug, 150) : null
  if (
    returnedDatasetSlug !== null &&
    returnedDatasetSlug.toLowerCase() !== expectedDatasetSlug.toLowerCase()
  ) {
    throw new InvalidKaggleMetadataError(
      'Kaggle metadata datasetSlug does not match the requested slug',
    )
  }
  if (returnedSlug === null && returnedDatasetSlug === null) {
    throw new InvalidKaggleMetadataError('Kaggle metadata does not identify the requested dataset')
  }
  return info
}

export function parseKaggleDatasetMetadata(
  value: unknown,
  expectedSlug: string,
  expectedSourceVersion: string,
): KaggleDatasetMetadata {
  validateKaggleSlug(expectedSlug)
  validateKaggleSourceVersion(expectedSourceVersion)
  if (!isRecord(value)) throw new InvalidKaggleMetadataError('Kaggle metadata must be an object')

  const info = metadataInfo(value, expectedSlug)

  const version = observedVersion(value) ?? (info ? observedVersion(info) : null)
  if (version !== null && version !== expectedSourceVersion) {
    throw new KaggleMetadataVersionMismatchError(
      `Kaggle metadata reports version ${version}, expected ${expectedSourceVersion}`,
    )
  }
  const license = observedLicense(value) ?? (info ? observedLicense(info) : null)
  const versionVerified = version === expectedSourceVersion
  return {
    slug: expectedSlug,
    sourceVersion: expectedSourceVersion,
    title: boundedString(value.title, 200) ?? (info ? boundedString(info.title, 200) : null),
    observedLicense: license,
    observedSourceVersion: version,
    versionVerified,
    verifiedLicense: versionVerified ? license : null,
  }
}

/**
 * Parse the same metadata payload without an expected version: returns the
 * current (latest) version the CLI reports, or null when the response omits it.
 * Never persists a "latest" keyword — callers must still pin the returned
 * number for provenance.
 */
export function parseKaggleLatestVersion(
  value: unknown,
  expectedSlug: string,
): KaggleLatestVersion {
  validateKaggleSlug(expectedSlug)
  if (!isRecord(value)) throw new InvalidKaggleMetadataError('Kaggle metadata must be an object')
  const info = metadataInfo(value, expectedSlug)
  const version = observedVersion(value) ?? (info ? observedVersion(info) : null)
  const license = observedLicense(value) ?? (info ? observedLicense(info) : null)
  return {
    slug: expectedSlug,
    title: boundedString(value.title, 200) ?? (info ? boundedString(info.title, 200) : null),
    sourceVersion: version,
    license,
  }
}

function executeMetadataCommand(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, signal },
      (error) => (error ? reject(error) : resolve()),
    )
  })
}

/**
 * Run the pinned CLI's `datasets metadata` command into a scratch dir and read
 * the bounded JSON payload back. Shared by the exact-version fetch, the
 * version-discovery fetch and the publisher-text reader so there is one
 * argv/read/bounds path.
 *
 * Exported for callers that need the raw payload as well as the parsed
 * version/license fields (publisher text) without running the CLI twice. The
 * payload is unvalidated: callers must still run `parseKaggleDatasetMetadata`
 * before quoting anything from it.
 */
export async function readKaggleDatasetMetadataPayload(
  request: KaggleMetadataPayloadRequest,
  options: KaggleMetadataOptions,
): Promise<unknown> {
  const { slug, destinationDir } = request
  await mkdir(destinationDir, { recursive: true })
  const metadataPath = join(destinationDir, METADATA_FILE)
  await rm(metadataPath, { force: true })
  const executable = options.kaggleExecutable ?? defaultPinnedKaggleExecutable()
  assertKaggleExecutable(executable)
  await executeMetadataCommand(
    executable,
    ['datasets', 'metadata', slug, '-p', destinationDir],
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  )

  const details = await stat(metadataPath)
  if (!details.isFile() || details.size > MAX_METADATA_BYTES) {
    throw new InvalidKaggleMetadataError(
      `Kaggle metadata file must be at most ${MAX_METADATA_BYTES} bytes`,
    )
  }
  try {
    return JSON.parse(await readFile(metadataPath, 'utf8'))
  } catch {
    throw new InvalidKaggleMetadataError('Kaggle metadata is not valid JSON')
  }
}

export async function fetchKaggleDatasetMetadata(
  request: KaggleMetadataRequest,
  options: KaggleMetadataOptions = {},
): Promise<KaggleDatasetMetadata> {
  validateKaggleSlug(request.slug)
  validateKaggleSourceVersion(request.sourceVersion)
  return parseKaggleDatasetMetadata(
    await readKaggleDatasetMetadataPayload(request, options),
    request.slug,
    request.sourceVersion,
  )
}

export async function fetchKaggleLatestVersion(
  request: KaggleLatestVersionRequest,
  options: KaggleMetadataOptions = {},
): Promise<KaggleLatestVersion> {
  validateKaggleSlug(request.slug)
  return parseKaggleLatestVersion(
    await readKaggleDatasetMetadataPayload(request, options),
    request.slug,
  )
}

/** Classified version-resolution failures (distinct from a valid no-version reply). */
export class KaggleAuthenticationError extends Error {}
export class KaggleDatasetNotFoundError extends Error {}
export class KaggleEndpointUnsupportedError extends Error {}

const KAGGLE_VIEW_API_URL = 'https://www.kaggle.com/api/v1/datasets/view/'

export interface KagglePublicMetadataOptions {
  signal?: AbortSignal
  /** Injectable for tests; defaults to the Node host global fetch. */
  fetchImpl?: typeof fetch
}

export interface KagglePublicMetadata {
  slug: string
  title: string | null
  /** `currentVersionNumber` from the public view API; null when genuinely absent. */
  sourceVersion: string | null
  license: string | null
}

function publicVersionNumber(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9][0-9]{0,8}$/.test(value.trim())) return value.trim()
  return null
}

/**
 * Resolve a dataset's current version from Kaggle's public `view` API. The
 * pinned CLI's `datasets metadata` omits `currentVersionNumber` for many
 * datasets, so the public endpoint is the authoritative version source.
 * Failures are classified: authentication (401/403), missing dataset (404),
 * and unsupported/unreachable endpoint (other non-2xx / non-JSON / mismatched
 * ref). A valid 200 without a version number yields `sourceVersion: null`.
 */
/**
 * Fetch and validate the public `view` API payload, returning it unparsed so one
 * call can serve both the version/license fields and the publisher description
 * (`./publisher-metadata.js`). Status and ref identity are checked here exactly
 * as before; field extraction stays with `parseKagglePublicMetadata`.
 */
export async function readKagglePublicMetadataPayload(
  slug: string,
  options: KagglePublicMetadataOptions = {},
): Promise<Record<string, unknown>> {
  validateKaggleSlug(slug)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const response = await fetchImpl(`${KAGGLE_VIEW_API_URL}${slug}`, { signal: options.signal })
  if (response.status === 404) {
    throw new KaggleDatasetNotFoundError(`Kaggle dataset "${slug}" was not found`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new KaggleAuthenticationError(
      `Kaggle API authentication failed (HTTP ${response.status})`,
    )
  }
  if (!response.ok) {
    throw new KaggleEndpointUnsupportedError(
      `Kaggle view API is unavailable (HTTP ${response.status})`,
    )
  }
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new KaggleEndpointUnsupportedError('Kaggle view API returned invalid JSON')
  }
  if (!isRecord(data)) {
    throw new KaggleEndpointUnsupportedError('Kaggle view API response is not an object')
  }
  const returnedRef = boundedString(data.ref, 250)
  if (returnedRef !== null && returnedRef.toLowerCase() !== slug.toLowerCase()) {
    throw new KaggleDatasetNotFoundError('Kaggle view API ref does not match the requested slug')
  }
  return data
}

/** Extract the version/license/title fields from a validated view payload. */
export function parseKagglePublicMetadata(
  data: Record<string, unknown>,
  slug: string,
): KagglePublicMetadata {
  return {
    slug,
    title: boundedString(data.title, 200) ?? boundedString(data.titleNullable, 200),
    sourceVersion:
      publicVersionNumber(data.currentVersionNumber) ??
      publicVersionNumber(data.currentVersionNumberNullable),
    license: boundedString(data.licenseName, 128) ?? boundedString(data.licenseNameNullable, 128),
  }
}

export async function fetchKagglePublicMetadata(
  slug: string,
  options: KagglePublicMetadataOptions = {},
): Promise<KagglePublicMetadata> {
  return parseKagglePublicMetadata(await readKagglePublicMetadataPayload(slug, options), slug)
}
