/**
 * `datasetIdFromSlug` must produce stable, owner-namespaced ids with an
 * 8-hex SHA-256 suffix so differently-punctuated slugs stay distinct.
 * Expected hashes are never hand-computed — assertions compare outputs/shape.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { datasetIdFromSlug, readLinePrefix } from '../src/preview-ingest.js'

const RESERVED_CORE_IDS = ['superstore', 'olist', 'online-retail', 'olist-mini', 'retail-fixture']
const DATASET_ID_RE = /^[a-z_][a-z0-9_]*_[0-9a-f]{8}$/

it('does not let a different owner collide with the reserved "superstore" Core dataset id', () => {
  const id = datasetIdFromSlug('other/superstore')
  expect(id).not.toBe('superstore')
  expect(RESERVED_CORE_IDS).not.toContain(id)
  expect(id).toMatch(DATASET_ID_RE)
  expect(id.startsWith('other_superstore_')).toBe(true)
})

it('does not let a different owner collide with the reserved "olist" Core dataset id', () => {
  const id = datasetIdFromSlug('x/olist')
  expect(id).not.toBe('olist')
  expect(id.startsWith('x_olist_')).toBe(true)
})

it('does not let a different owner collide with the reserved "online-retail" Core dataset id', () => {
  const id = datasetIdFromSlug('x/online-retail')
  expect(id).not.toBe('online-retail')
  expect(id).not.toBe('online_retail')
  expect(id.startsWith('x_online_retail_')).toBe(true)
})

it('does not let a different owner collide with the reserved "olist-mini" Core dataset id', () => {
  const id = datasetIdFromSlug('x/olist-mini')
  expect(id).not.toBe('olist-mini')
  expect(id).not.toBe('olist_mini')
})

it('does not let a different owner collide with the reserved "retail-fixture" Core dataset id', () => {
  const id = datasetIdFromSlug('x/retail-fixture')
  expect(id).not.toBe('retail-fixture')
  expect(id).not.toBe('retail_fixture')
})

it('namespaces an unreserved slug name-part by owner', () => {
  const id = datasetIdFromSlug('someone/widgets')
  expect(id.startsWith('someone_widgets_')).toBe(true)
  expect(id).toMatch(DATASET_ID_RE)
})

it('still sanitizes and namespaces a bare (ownerless) name matching a reserved id', () => {
  // No "/" at all — still must not collide with the reserved dataset id.
  const id = datasetIdFromSlug('superstore')
  expect(id).not.toBe('superstore')
})

it('does not let two different owners of the same generic dataset name collide', () => {
  const someone = datasetIdFromSlug('someone/widgets')
  const other = datasetIdFromSlug('other/widgets')

  expect(someone.startsWith('someone_widgets_')).toBe(true)
  expect(other.startsWith('other_widgets_')).toBe(true)
  expect(someone).not.toBe(other)
  expect(someone).not.toBe('widgets')
  expect(other).not.toBe('widgets')

  for (const id of [someone, other]) {
    expect(RESERVED_CORE_IDS).not.toContain(id)
  }
})

it('is deterministic: calling it twice for the same slug returns the same id', () => {
  expect(datasetIdFromSlug('someone/widgets')).toBe(datasetIdFromSlug('someone/widgets'))
})

it('is collision-proof against "-" vs "_" sanitizing to the same readable stem', () => {
  // Both sanitize their name-part to the same "some_one_widgets" stem, but
  // the hash suffix is computed from the normalized (unsanitized) slug, so
  // the two hyphen/underscore variants must still produce distinct ids.
  const hyphenated = datasetIdFromSlug('some-one/widgets')
  const underscored = datasetIdFromSlug('some_one/widgets')
  expect(hyphenated).not.toBe(underscored)
})

it('is case-insensitive: differently-cased slugs that are the same source hash the same', () => {
  expect(datasetIdFromSlug('Someone/Widgets')).toBe(datasetIdFromSlug('someone/widgets'))
})

it('caps the total id length at 128 while always keeping the full 9-char hash suffix', () => {
  const longOwner = 'o'.repeat(80)
  const longName = 'n'.repeat(80)
  const id = datasetIdFromSlug(`${longOwner}/${longName}`)
  expect(id.length).toBeLessThanOrEqual(128)
  expect(id).toMatch(DATASET_ID_RE)
  // The last 9 characters ("_" + 8 hex) must survive truncation intact.
  expect(id.slice(-9)).toMatch(/^_[0-9a-f]{8}$/)
})

/**
 * `readLinePrefix` review (Important 3): a preview must never `readFile` an
 * entire extracted CSV into memory — only a bounded header + sampled-row
 * prefix, matching `recipe-proposer.ts`'s `SAMPLE_ROW_LIMIT`.
 */
let readLinePrefixDir: string

beforeEach(async () => {
  readLinePrefixDir = await mkdtemp(join(tmpdir(), 'dsh-read-line-prefix-'))
})

afterEach(async () => {
  await rm(readLinePrefixDir, { recursive: true, force: true })
})

it('reads only the first N lines of a much larger file, never the whole file', async () => {
  const path = join(readLinePrefixDir, 'big.csv')
  const totalLines = 5_000
  const content = Array.from({ length: totalLines }, (_, i) => `row-${i}`).join('\n')
  await writeFile(path, content, 'utf8')

  const prefix = await readLinePrefix(path, 201)
  const lines = prefix.split('\n')
  expect(lines).toHaveLength(201)
  expect(lines[0]).toBe('row-0')
  expect(lines[200]).toBe('row-200')
})

it('returns the whole file when it has fewer lines than the limit', async () => {
  const path = join(readLinePrefixDir, 'small.csv')
  await writeFile(path, 'a\nb\nc', 'utf8')

  const prefix = await readLinePrefix(path, 201)
  expect(prefix).toBe('a\nb\nc')
})
