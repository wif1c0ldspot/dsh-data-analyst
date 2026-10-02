/**
 * Safe archive extraction. Validates every entry in a
 * downloaded ZIP archive *before* extracting anything, using the maintained
 * `yauzl` reader rather than a handwritten ZIP parser. Rejects
 * path traversal, absolute paths, symlinks, duplicate normalized names,
 * excess file counts, and oversized/suspicious expansion. A validation
 * failure extracts nothing.
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as yauzl from 'yauzl'

export class ArchiveSafetyViolation extends Error {}

export interface ArchiveSafetyLimits {
  maxFiles: number
  maxTotalUncompressedBytes: number
  /** uncompressedSize / compressedSize beyond this is treated as a zip-bomb shape. */
  maxExpansionRatio: number
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveSafetyLimits = {
  maxFiles: 100,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024, // 1 GiB, matching the architecture's extracted-size budget.
  maxExpansionRatio: 200,
}

export interface ValidatedArchiveEntry {
  name: string
  compressedSize: number
  uncompressedSize: number
}

const UNIX_FILE_TYPE_MASK = 0xf000
const UNIX_SYMLINK_TYPE = 0xa000

function isSymlinkEntry(entry: yauzl.Entry): boolean {
  // ZIP stores unix st_mode in the upper 16 bits of externalFileAttributes
  // when versionMadeBy's host system is unix; absent on most Windows-authored
  // archives, in which case this is simply 0 and never matches.
  const unixMode = entry.externalFileAttributes >>> 16
  return (unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_TYPE
}

function isDirectoryEntry(entry: yauzl.Entry): boolean {
  return /\/$/.test(entry.fileName)
}

/** Normalized, checked relative path, or throws with the specific reason. */
function safeRelativePath(rawName: string): string {
  if (rawName.length === 0) throw new ArchiveSafetyViolation('Empty entry name is not allowed')
  if (rawName.startsWith('/') || rawName.startsWith('\\') || /^[a-zA-Z]:/.test(rawName)) {
    throw new ArchiveSafetyViolation(`Absolute path entry is not allowed: "${rawName}"`)
  }
  const normalized = normalize(rawName)
  const segments = normalized.split(sep)
  if (segments.includes('..')) {
    throw new ArchiveSafetyViolation(`Path traversal entry is not allowed: "${rawName}"`)
  }
  return normalized
}

/**
 * Read every central-directory entry and validate it, without extracting any
 * file content. Throws {@link ArchiveSafetyViolation} on the first violation.
 */
/**
 * yauzl's own `strictFileNames` guard also rejects absolute paths and some
 * traversal shapes while decoding raw entry names, as an independent second
 * layer beneath our own checks; its errors are rewrapped here so callers see
 * one consistent exception type regardless of which layer caught the entry.
 */
function asArchiveSafetyViolation(error: unknown): ArchiveSafetyViolation {
  if (error instanceof ArchiveSafetyViolation) return error
  return new ArchiveSafetyViolation(error instanceof Error ? error.message : String(error))
}

export async function validateArchive(
  archivePath: string,
  limits: ArchiveSafetyLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<ValidatedArchiveEntry[]> {
  const zip = await yauzl.openPromise(archivePath, {
    lazyEntries: true,
    autoClose: false,
    strictFileNames: true,
    // The uncompressed-size cap below sums attacker-declared central-directory
    // metadata, not a byte count independently measured during extraction —
    // it is only trustworthy if yauzl itself refuses to stream past what an
    // entry's header declared. That already happens by yauzl's own default;
    // this makes the reliance explicit rather than inherited silently.
    validateEntrySizes: true,
  })
  try {
    const entries: ValidatedArchiveEntry[] = []
    const seenNormalizedNames = new Set<string>()
    let totalUncompressedBytes = 0

    try {
      for await (const entry of zip.eachEntry()) {
        if (isDirectoryEntry(entry)) continue // A directory entry has nothing to extract or validate as a file.
        if (isSymlinkEntry(entry)) {
          throw new ArchiveSafetyViolation(`Symlink entry is not allowed: "${entry.fileName}"`)
        }
        const normalizedName = safeRelativePath(entry.fileName)
        const key = normalizedName.toLowerCase()
        if (seenNormalizedNames.has(key)) {
          throw new ArchiveSafetyViolation(`Duplicate normalized entry name: "${normalizedName}"`)
        }
        seenNormalizedNames.add(key)

        if (entries.length + 1 > limits.maxFiles) {
          throw new ArchiveSafetyViolation(`Archive exceeds the ${limits.maxFiles}-file limit`)
        }
        totalUncompressedBytes += entry.uncompressedSize
        if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
          throw new ArchiveSafetyViolation(
            `Archive's total uncompressed size exceeds ${limits.maxTotalUncompressedBytes} bytes`,
          )
        }
        if (entry.compressedSize > 0) {
          const ratio = entry.uncompressedSize / entry.compressedSize
          if (ratio > limits.maxExpansionRatio) {
            throw new ArchiveSafetyViolation(
              `Entry "${normalizedName}" has a suspicious expansion ratio (${ratio.toFixed(1)}x); rejected as a possible zip bomb`,
            )
          }
        }
        entries.push({
          name: normalizedName,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
        })
      }
    } catch (error) {
      throw asArchiveSafetyViolation(error)
    }
    return entries
  } finally {
    zip.close()
  }
}

export interface ExtractedFile {
  name: string
  bytes: number
  sha256: string
}

/**
 * Validate the full archive, then extract every file entry under
 * `destinationDir` (never elsewhere — every write path is re-verified to
 * resolve inside it) and hash it while streaming. Extracts nothing if
 * validation fails.
 */
export async function safeExtractZip(
  archivePath: string,
  destinationDir: string,
  limits: ArchiveSafetyLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<ExtractedFile[]> {
  await validateArchive(archivePath, limits) // Fail closed before any extraction.

  const resolvedRoot = resolve(destinationDir)
  const zip = await yauzl.openPromise(archivePath, {
    lazyEntries: true,
    autoClose: false,
    strictFileNames: true,
    // Same explicit reliance as `validateArchive` above: the size cap that
    // already ran is only meaningful if extraction itself cannot stream past
    // a declared entry size.
    validateEntrySizes: true,
  })
  const results: ExtractedFile[] = []
  try {
    try {
      for await (const entry of zip.eachEntry()) {
        if (isDirectoryEntry(entry)) continue
        const normalizedName = safeRelativePath(entry.fileName)
        const destinationPath = resolve(resolvedRoot, normalizedName)
        if (destinationPath !== resolvedRoot && !destinationPath.startsWith(resolvedRoot + sep)) {
          // Re-check defensively even though validateArchive already rejected traversal above.
          throw new ArchiveSafetyViolation(
            `Entry resolves outside the destination directory: "${normalizedName}"`,
          )
        }
        await mkdir(dirname(destinationPath), { recursive: true })
        const readStream = await zip.openReadStreamPromise(entry)
        const hash = createHash('sha256')
        const writeStream = createWriteStream(destinationPath)
        readStream.on('data', (chunk: Buffer) => hash.update(chunk))
        await pipeline(readStream, writeStream)
        results.push({
          name: normalizedName,
          bytes: entry.uncompressedSize,
          sha256: hash.digest('hex'),
        })
      }
    } catch (error) {
      throw asArchiveSafetyViolation(error)
    }
  } finally {
    zip.close()
  }
  return results
}

// Re-exported for callers that want to build a destination path the same way
// this module validates it, without duplicating the join/resolve logic.
export function resolveWithinDestination(destinationDir: string, name: string): string {
  return join(resolve(destinationDir), safeRelativePath(name))
}
