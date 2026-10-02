/**
 * Trusted CSV encoding normalize step for importers whose source files are
 * not UTF-8 (e.g. Superstore's windows-1252). Runs before DuckDB `read_csv`,
 * which does not accept CP1252; never used as a model-authored transform.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type SupportedSourceEncoding = 'windows-1252' | 'utf-8' | 'utf-16le' | 'utf-16be'

export interface NormalizeCsvToUtf8Options {
  fromEncoding: SupportedSourceEncoding
}

/**
 * Detect the source encoding of a byte sample. Handles BOM-marked UTF-8/UTF-16
 * first, then a strict UTF-8 decode, falling back to Windows-1252 (the common
 * "ANSI" encoding) when the bytes are not valid UTF-8. Deterministic and
 * side-effect-free; used by generic preview so a proposed recipe can carry
 * `sourceEncoding` and the pipeline can normalize before DuckDB `read_csv`.
 */
export function detectCsvEncoding(bytes: Uint8Array): SupportedSourceEncoding {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8'
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return 'utf-8'
  } catch {
    return 'windows-1252'
  }
}

/**
 * Split raw CSV bytes into records (including their line terminator) without
 * breaking RFC4180-quoted fields that embed a newline. Operates at the byte
 * level — `"` (0x22) and `\n` (0x0A) are single, unambiguous bytes in both
 * UTF-8 and windows-1252 (neither encoding produces either byte as part of a
 * multi-byte sequence for any other character), so this split is safe to run
 * *before* any encoding is known or applied.
 *
 * Uses the standard "toggle on every quote byte" trick: a doubled `""`
 * (RFC4180's escaped quote) toggles twice and net leaves the in-quotes state
 * unchanged, so it does not require distinguishing an escaped quote from a
 * field delimiter — only the interleaved parity of quote bytes matters for
 * finding record boundaries.
 */
function splitCsvRecordsBytes(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = []
  let recordStart = 0
  let inQuotedField = false
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]
    if (byte === 0x22) {
      inQuotedField = !inQuotedField
    } else if (byte === 0x0a && !inQuotedField) {
      records.push(bytes.subarray(recordStart, i + 1))
      recordStart = i + 1
    }
  }
  if (recordStart < bytes.length) {
    records.push(bytes.subarray(recordStart))
  }
  return records
}

/**
 * Decode bytes that were flagged as (at least partly) windows-1252, on a
 * per-record basis, so a file that genuinely mixes UTF-8 and windows-1252
 * rows does not have its UTF-8 rows corrupted into mojibake by a single
 * whole-file windows-1252 decode.
 *
 * Fast path: try a single strict whole-file UTF-8 decode first — this
 * matches `detectCsvEncoding`'s own whole-file check and covers the
 * overwhelmingly common cases (a genuinely all-UTF-8 file, handled here in
 * one decode call; a genuinely all-windows-1252 file, which fails this
 * attempt quickly at its first non-UTF-8 byte and falls through below).
 * Only a file that fails the whole-file check pays for the per-record scan.
 *
 * Residual limitation: this decides encoding once per *record* (a
 * quote-aware CSV row, which may itself span several physical lines when a
 * field is quoted and contains embedded newlines). A record is decoded
 * wholesale as UTF-8 or as windows-1252. A pathological file where the
 * encoding changes *in the middle of a single quoted multi-line field* — one
 * physical line of that field genuinely UTF-8, another physical line of the
 * *same* quoted field genuinely windows-1252 — is not resolvable by this (or
 * any purely line/record-oriented) model, because there is no unambiguous
 * sub-record boundary to split on inside one quoted value. That narrower
 * case remains an open gap; the record-level model here only guarantees
 * correct decoding when the encoding is consistent within each record,
 * which covers the reproduced bug (a whole row using one encoding, another
 * whole row using another).
 */
function decodeWindows1252WithPerRecordFallback(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Whole-file decode failed somewhere — fall through to the per-record scan.
  }
  const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
  const windows1252Decoder = new TextDecoder('windows-1252')
  let text = ''
  for (const record of splitCsvRecordsBytes(bytes)) {
    try {
      text += utf8Decoder.decode(record)
    } catch {
      text += windows1252Decoder.decode(record)
    }
  }
  return text
}

/**
 * Decode `sourcePath` with a reviewed source encoding and write a UTF-8 file
 * to `destinationPath` (parents created as needed). Idempotent for utf-8
 * sources (round-trips the bytes through TextDecoder).
 *
 * windows-1252 sources get a per-record (not whole-file) decoding decision —
 * see `decodeWindows1252WithPerRecordFallback` — since `windows-1252` is
 * exactly the value produced when a file is not valid UTF-8 as a whole,
 * which includes files that genuinely mix UTF-8 and windows-1252 rows.
 */
export async function normalizeCsvToUtf8(
  sourcePath: string,
  destinationPath: string,
  options: NormalizeCsvToUtf8Options,
): Promise<void> {
  const bytes = await readFile(sourcePath)
  const text =
    options.fromEncoding === 'windows-1252'
      ? decodeWindows1252WithPerRecordFallback(bytes)
      : new TextDecoder(options.fromEncoding, { fatal: true }).decode(bytes)
  await mkdir(dirname(destinationPath), { recursive: true })
  await writeFile(destinationPath, text, 'utf8')
}
