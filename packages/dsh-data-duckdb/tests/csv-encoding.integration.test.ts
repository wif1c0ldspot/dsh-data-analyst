import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { detectCsvEncoding, normalizeCsvToUtf8 } from '../src/csv-encoding.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-csv-encoding-test-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('rewrites a windows-1252 CSV containing 0xA0 into valid UTF-8', async () => {
  const sourcePath = join(directory, 'source.csv')
  const destinationPath = join(directory, 'normalized.csv')
  // "Product" + NBSP (0xA0) + "Name" under windows-1252, then a Latin-1 accented char.
  const bytes = Buffer.from('Product\xA0Name,Sales\nCaf\xE9,10\n', 'binary')
  await writeFile(sourcePath, bytes)

  await normalizeCsvToUtf8(sourcePath, destinationPath, { fromEncoding: 'windows-1252' })

  const text = await readFile(destinationPath, 'utf8')
  expect(text).toBe('Product\u00A0Name,Sales\nCafé,10\n')
})

it('detectCsvEncoding classifies valid UTF-8 as utf-8', () => {
  expect(detectCsvEncoding(Buffer.from('eventid,iyear\n1,1970\n', 'utf8'))).toBe('utf-8')
})

it('detectCsvEncoding classifies non-UTF-8 Latin-1/windows-1252 bytes as windows-1252', () => {
  // 0xe9 is é under windows-1252 but is not a valid lone UTF-8 byte.
  expect(detectCsvEncoding(Buffer.from('name\nCaf\xE9\n', 'binary'))).toBe('windows-1252')
})

it('detectCsvEncoding recognizes a UTF-8 BOM', () => {
  expect(detectCsvEncoding(Buffer.from('\uFEFFeventid\n', 'utf8'))).toBe('utf-8')
})

it('detectCsvEncoding recognizes UTF-16 LE and BE BOMs', () => {
  // UTF-16LE BOM (FF FE) followed by "e" as little-endian bytes.
  expect(detectCsvEncoding(Buffer.from([0xff, 0xfe, 0x65, 0x00]))).toBe('utf-16le')
  // UTF-16BE BOM (FE FF) followed by "e" as big-endian bytes.
  expect(detectCsvEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x65]))).toBe('utf-16be')
})

it('normalizeCsvToUtf8 decodes a mixed UTF-8/windows-1252 file per record, not per file', async () => {
  // Row 1 genuinely UTF-8, row 2 genuinely windows-1252 — the whole file is
  // not valid UTF-8, so detection reports windows-1252 for the file overall,
  // but normalization must still recover each row's own encoding.
  const header = Buffer.from('name,amount\n', 'utf8')
  const utf8Row = Buffer.from('Café,10\n', 'utf8')
  const windows1252Row = Buffer.from('Caf\xE9,20\n', 'binary')
  const bytes = Buffer.concat([header, utf8Row, windows1252Row])
  expect(detectCsvEncoding(bytes)).toBe('windows-1252')

  const sourcePath = join(directory, 'mixed.csv')
  const destinationPath = join(directory, 'normalized.csv')
  await writeFile(sourcePath, bytes)
  await normalizeCsvToUtf8(sourcePath, destinationPath, { fromEncoding: 'windows-1252' })

  const text = await readFile(destinationPath, 'utf8')
  expect(text).toBe('name,amount\nCafé,10\nCafé,20\n')
})

it('normalizeCsvToUtf8 fast-paths a genuinely all-UTF-8 file even when called with fromEncoding windows-1252', async () => {
  // Regression: the common case (one consistent encoding for the whole
  // file) must still be handled correctly and via the whole-file fast path,
  // not the per-record scan, when the bytes turn out to be fully valid UTF-8.
  const bytes = Buffer.from('name,amount\nCafé,10\nMüller,20\n', 'utf8')
  const sourcePath = join(directory, 'all-utf8.csv')
  const destinationPath = join(directory, 'normalized.csv')
  await writeFile(sourcePath, bytes)
  await normalizeCsvToUtf8(sourcePath, destinationPath, { fromEncoding: 'windows-1252' })

  const text = await readFile(destinationPath, 'utf8')
  expect(text).toBe('name,amount\nCafé,10\nMüller,20\n')
})

it('normalizeCsvToUtf8 correctly decodes a genuinely all-windows-1252 file (regression)', async () => {
  const bytes = Buffer.from('name,amount\nCaf\xE9,10\nM\xFCller,20\n', 'binary')
  const sourcePath = join(directory, 'all-windows-1252.csv')
  const destinationPath = join(directory, 'normalized.csv')
  await writeFile(sourcePath, bytes)
  await normalizeCsvToUtf8(sourcePath, destinationPath, { fromEncoding: 'windows-1252' })

  const text = await readFile(destinationPath, 'utf8')
  expect(text).toBe('name,amount\nCafé,10\nMüller,20\n')
})

it('normalizeCsvToUtf8 does not corrupt an RFC4180 quoted multi-line field when mixed with another encoding', async () => {
  // A quoted field embeds a literal newline (RFC4180) and is entirely
  // UTF-8; a separate windows-1252 row follows. The record-level splitter
  // must not treat the embedded newline as a record boundary (which would
  // both mis-split the quoted value and defeat correct per-record encoding
  // detection for it).
  const header = Buffer.from('name,note,amount\n', 'utf8')
  const quotedMultilineUtf8Row = Buffer.from('Café,"line one\nline two",10\n', 'utf8')
  const windows1252Row = Buffer.from('M\xFCller,plain,20\n', 'binary')
  const bytes = Buffer.concat([header, quotedMultilineUtf8Row, windows1252Row])
  expect(detectCsvEncoding(bytes)).toBe('windows-1252')

  const sourcePath = join(directory, 'quoted-multiline-mixed.csv')
  const destinationPath = join(directory, 'normalized.csv')
  await writeFile(sourcePath, bytes)
  await normalizeCsvToUtf8(sourcePath, destinationPath, { fromEncoding: 'windows-1252' })

  const text = await readFile(destinationPath, 'utf8')
  expect(text).toBe('name,note,amount\nCafé,"line one\nline two",10\nMüller,plain,20\n')
})
