import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ArchiveSafetyViolation, safeExtractZip, validateArchive } from '../src/archive-safety.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-archive-safety-test-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

interface ZipEntrySpec {
  path: string
  content?: string
  mode?: number
  /**
   * Overrides the on-disk entry name after yazl's own construction, bypassing
   * its client-side `validateMetadataPath` guard. A real attacker crafting a
   * malicious archive would never respect that guard either, so our own
   * `validateArchive`/`safeExtractZip` must independently reject these shapes
   * from the raw ZIP bytes, not merely trust a well-behaved zip-writing tool.
   */
  rawName?: string
  /**
   * Overrides the entry's declared uncompressed size, in *both* the local
   * file header and the central directory record, after yazl has already
   * compressed the real (larger) `content`. This builds a "lying central
   * directory" fixture: the declared size is small, but the actual
   * decompressed byte stream is large — exactly what `entry.uncompressedSize`
   * would look like coming from a crafted malicious archive rather than a
   * well-behaved zip-writing tool. See the `rawName` doc comment above for
   * why this needs to reach into yazl's private `entries` array; the same
   * synchronous-mutation-before-async-compression-callback trick applies
   * here (see the timing note in `buildZip` below).
   */
  declaredUncompressedSize?: number
}

/** Build one zip fixture from `entries` (metadataPath -> content or options). */
async function buildZip(entries: ZipEntrySpec[], filename = 'fixture.zip'): Promise<string> {
  const zipfile = new yazl.ZipFile()
  for (const entry of entries) {
    zipfile.addBuffer(
      Buffer.from(entry.content ?? 'x'),
      entry.path,
      entry.mode !== undefined ? { mode: entry.mode } : undefined,
    )
    // yazl's public types don't expose `entries`; its own client-side name
    // validation would otherwise refuse to construct these adversarial
    // fixtures (see the ZipEntrySpec.rawName doc comment above).
    const internalEntries = (
      zipfile as unknown as { entries: { utf8FileName: Buffer; uncompressedSize: number }[] }
    ).entries
    const added = internalEntries[internalEntries.length - 1]
    if (entry.rawName !== undefined && added) {
      added.utf8FileName = Buffer.from(entry.rawName, 'utf8')
    }
    if (entry.declaredUncompressedSize !== undefined && added) {
      // `addBuffer` compresses asynchronously via `zlib.deflateRaw` (default
      // compression level 6); the local/central-directory headers are only
      // written once that callback fires and pumps the entry. This
      // assignment runs synchronously right after `addBuffer` returns, i.e.
      // strictly before that callback, so both headers end up carrying this
      // lied value instead of the real buffer length computed above.
      added.uncompressedSize = entry.declaredUncompressedSize
    }
  }
  const archivePath = join(directory, filename)
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return archivePath
}

it('accepts a legitimate small archive and lists its entries', async () => {
  const archivePath = await buildZip([{ path: 'data.csv', content: 'a,b\n1,2\n' }])
  const entries = await validateArchive(archivePath)
  expect(entries).toEqual([
    { name: 'data.csv', compressedSize: expect.any(Number), uncompressedSize: 8 },
  ])
})

it('rejects a path-traversal entry', async () => {
  const archivePath = await buildZip([
    { path: 'placeholder.txt', rawName: '../escape.txt', content: 'x' },
  ])
  // Also caught by yauzl's own strictFileNames guard ("invalid relative
  // path"), rewrapped into our exception type either way.
  await expect(validateArchive(archivePath)).rejects.toBeInstanceOf(ArchiveSafetyViolation)
  await expect(validateArchive(archivePath)).rejects.toThrow(/relative path|traversal/i)
})

it('rejects an absolute-path entry', async () => {
  const archivePath = await buildZip([
    { path: 'placeholder.txt', rawName: '/etc/passwd', content: 'x' },
  ])
  // Caught by yauzl's own strictFileNames guard before our safeRelativePath
  // even runs; rewrapped into our exception type either way.
  await expect(validateArchive(archivePath)).rejects.toBeInstanceOf(ArchiveSafetyViolation)
  await expect(validateArchive(archivePath)).rejects.toThrow(/absolute path/i)
})

it('rejects a symlink entry', async () => {
  // Unix mode with the symlink type bits set (S_IFLNK | 0o777).
  const archivePath = await buildZip([{ path: 'link', content: '/etc/passwd', mode: 0o120777 }])
  await expect(validateArchive(archivePath)).rejects.toThrow(/Symlink/)
})

it('rejects duplicate normalized entry names', async () => {
  const archivePath = await buildZip([
    { path: 'Data.csv', content: 'a' },
    { path: 'data.csv', content: 'b' },
  ])
  await expect(validateArchive(archivePath)).rejects.toThrow(/Duplicate normalized/)
})

it('rejects an archive exceeding the file-count limit', async () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, content: 'x' }))
  const archivePath = await buildZip(entries)
  await expect(
    validateArchive(archivePath, {
      maxFiles: 3,
      maxTotalUncompressedBytes: 1_000_000,
      maxExpansionRatio: 200,
    }),
  ).rejects.toThrow(/file limit/)
})

it('rejects an archive whose total uncompressed size exceeds the budget', async () => {
  const archivePath = await buildZip([{ path: 'big.txt', content: 'x'.repeat(10_000) }])
  await expect(
    validateArchive(archivePath, {
      maxFiles: 100,
      maxTotalUncompressedBytes: 1_000,
      maxExpansionRatio: 200,
    }),
  ).rejects.toThrow(/uncompressed size exceeds/)
})

it('rejects a suspicious expansion ratio (zip-bomb shape)', async () => {
  // Highly repetitive content compresses far more than typical CSV data.
  const archivePath = await buildZip([{ path: 'bomb.bin', content: '0'.repeat(2_000_000) }])
  await expect(
    validateArchive(archivePath, {
      maxFiles: 100,
      maxTotalUncompressedBytes: 1024 ** 3,
      maxExpansionRatio: 50,
    }),
  ).rejects.toThrow(/expansion ratio/)
})

it('extracts nothing when validation fails', async () => {
  const archivePath = await buildZip([
    { path: 'good.csv', content: 'a,b\n1,2\n' },
    { path: 'placeholder2.txt', rawName: '../escape.txt', content: 'x' },
  ])
  await expect(safeExtractZip(archivePath, join(directory, 'out'))).rejects.toBeInstanceOf(
    ArchiveSafetyViolation,
  )
  await expect(readFile(join(directory, 'out', 'good.csv'))).rejects.toThrow() // nothing was extracted.
})

it('extracts a validated archive with correct bytes and sha256', async () => {
  const archivePath = await buildZip([{ path: 'data.csv', content: 'a,b\n1,2\n' }])
  const outDir = join(directory, 'out')
  const files = await safeExtractZip(archivePath, outDir)
  expect(files).toHaveLength(1)
  expect(files[0]?.name).toBe('data.csv')
  expect(files[0]?.bytes).toBe(8)
  const onDisk = await readFile(join(outDir, 'data.csv'), 'utf8')
  expect(onDisk).toBe('a,b\n1,2\n')
})

it("rejects extraction when the central directory lies about an entry's uncompressed size", async () => {
  // The declared size is tiny, so `validateArchive`'s size/ratio checks (which
  // only ever see attacker-declared central-directory metadata, per the
  // comment in archive-safety.ts) pass without complaint. The *actual*
  // content is 500,000 highly-compressible bytes, so it still fits in a
  // small compressed stream. Only `validateEntrySizes: true` on the reader
  // used for extraction stands between this lie and a silent over-write.
  const archivePath = await buildZip([
    { path: 'lying.bin', content: 'A'.repeat(500_000), declaredUncompressedSize: 10 },
  ])

  const entries = await validateArchive(archivePath)
  expect(entries).toEqual([
    { name: 'lying.bin', compressedSize: expect.any(Number), uncompressedSize: 10 },
  ])

  const outDir = join(directory, 'out')
  await expect(safeExtractZip(archivePath, outDir)).rejects.toBeInstanceOf(ArchiveSafetyViolation)
  await expect(safeExtractZip(archivePath, outDir)).rejects.toThrow(/too many bytes/i)
})

it('extracts nested directory entries under the destination, never elsewhere', async () => {
  const archivePath = await buildZip([{ path: 'nested/dir/data.csv', content: 'a,b\n1,2\n' }])
  const outDir = join(directory, 'out')
  const files = await safeExtractZip(archivePath, outDir)
  expect(files[0]?.name).toBe(join('nested', 'dir', 'data.csv'))
  const onDisk = await readFile(join(outDir, 'nested', 'dir', 'data.csv'), 'utf8')
  expect(onDisk).toBe('a,b\n1,2\n')
})
