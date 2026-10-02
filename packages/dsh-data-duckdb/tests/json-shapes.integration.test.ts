/**
 * Nested/non-flat JSON shapes. `inspectSourceFilesInProcess`
 * (source-inspector.ts) must accept a flat array-of-objects and
 * newline-delimited JSONL with zero row loss, and must degrade a genuinely
 * non-tabular top-level-object wrapper to a clear unsupported reason rather
 * than silently flattening it into a spurious 1-row table.
 *
 * Fixtures (see tests/fixtures/json-shapes/):
 * - records.json: a flat JSON array of 4 objects (event_id, label, amount).
 * - records.jsonl: the same shape as newline-delimited JSONL, 5 records.
 * - wrapper.json: a top-level object `{ metadata: {...}, records: [...] }`
 *   whose 4 real records are nested one level down -- not a bare array.
 *
 * This test documents a real bug found while building this fixture:
 * `read_json_auto` treats a top-level JSON *object* as exactly one row (its
 * top-level keys become columns), so `wrapper.json` used to be silently
 * proposed as a 1-row, 2-column VARCHAR table -- the 4 real records inside
 * "records" were never surfaced as rows. `source-inspector.ts`'s
 * `validateSingleJsonDocument` now rejects a non-array root before DuckDB
 * ever sees it, degrading to a clear `unsupportedFiles` reason instead.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { inspectSourceFilesInProcess } from '../src/source-inspector.js'

const FIXTURE_DIR = fileURLToPath(new URL('../../../tests/fixtures/json-shapes', import.meta.url))

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-json-shapes-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('inspects a flat JSON array of objects with zero row loss', async () => {
  const path = join(FIXTURE_DIR, 'records.json')
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown[]
  expect(raw).toHaveLength(4)

  const result = await inspectSourceFilesInProcess([{ sourceFile: 'records.json', path }])
  expect(result.unsupportedFiles).toEqual([])
  expect(result.tables).toHaveLength(1)
  expect(result.tables[0]).toMatchObject({ sourceFormat: 'json', tableId: 'records' })
  expect(result.tables[0]?.columns.map((c) => [c.name, c.type])).toEqual([
    ['event_id', 'BIGINT'],
    ['label', 'VARCHAR'],
    ['amount', 'DOUBLE'],
  ])
})

it('inspects newline-delimited JSONL with zero row loss', async () => {
  const path = join(FIXTURE_DIR, 'records.jsonl')
  const raw = await readFile(path, 'utf8')
  const lineCount = raw.trim().split('\n').length
  expect(lineCount).toBe(5)

  const result = await inspectSourceFilesInProcess([{ sourceFile: 'records.jsonl', path }])
  expect(result.unsupportedFiles).toEqual([])
  expect(result.tables).toHaveLength(1)
  expect(result.tables[0]).toMatchObject({ sourceFormat: 'json', tableId: 'records' })
  expect(result.tables[0]?.columns.map((c) => [c.name, c.type])).toEqual([
    ['event_id', 'BIGINT'],
    ['label', 'VARCHAR'],
    ['amount', 'DOUBLE'],
  ])
})

it('degrades a top-level-object JSON wrapper to a clear unsupported reason instead of mis-flattening', async () => {
  const path = join(FIXTURE_DIR, 'wrapper.json')
  const raw = JSON.parse(await readFile(path, 'utf8')) as { records: unknown[] }
  // Ground truth: this file actually contains 4 real records nested under
  // "records", not 1 -- proving any proposal claiming a 1-row table would be
  // a silent mis-flatten, not a faithful read of the source.
  expect(raw.records).toHaveLength(4)

  const result = await inspectSourceFilesInProcess([{ sourceFile: 'wrapper.json', path }])

  // No spurious table was proposed at all -- the top-level object is not
  // treated as a valid 1-row table, and it is never mistaken for a 4-row one.
  expect(result.tables).toEqual([])
  expect(result.unsupportedFiles).toHaveLength(1)
  expect(result.unsupportedFiles[0]?.name).toBe('wrapper.json')
  expect(result.unsupportedFiles[0]?.reason).toMatch(/not a flat array of records/i)
  expect(result.unsupportedFiles[0]?.reason).toMatch(/top-level object/i)
})

it('inspects all three shapes together in one archive: 2 supported, 1 clearly rejected', async () => {
  const result = await inspectSourceFilesInProcess([
    { sourceFile: 'records.json', path: join(FIXTURE_DIR, 'records.json') },
    { sourceFile: 'records.jsonl', path: join(FIXTURE_DIR, 'records.jsonl') },
    { sourceFile: 'wrapper.json', path: join(FIXTURE_DIR, 'wrapper.json') },
  ])
  expect(result.tables.map((t) => t.sourceFile).sort()).toEqual(['records.json', 'records.jsonl'])
  expect(result.unsupportedFiles.map((f) => f.name)).toEqual(['wrapper.json'])
})
