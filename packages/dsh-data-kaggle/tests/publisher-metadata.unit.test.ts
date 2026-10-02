/**
 * Publisher-supplied Kaggle text: parsed, bounded, and — the point of the
 * module — always labelled `publisher-supplied` / `unverified`.
 *
 * These tests assert the labelling, the bounds, and the honest `notes` for
 * absent/odd/oversized input. None of them assert that an extraction is
 * correct about the data: the whole block is unverified by construction, and
 * the assertions below are about what we claim, not about what the publisher
 * claims.
 */
import { expect, it } from 'vitest'
import {
  MAX_MODEL_DESCRIPTION_CHARS,
  MAX_MODEL_DICTIONARY_ENTRIES,
  MAX_MODEL_NOTE_CHARS,
  MAX_PUBLISHER_DESCRIPTION_CHARS,
  MAX_PUBLISHER_DICTIONARY_ENTRIES,
  MAX_PUBLISHER_NOTE_CHARS,
  PUBLISHER_SOURCE_CLI_METADATA,
  PUBLISHER_SOURCE_VIEW_API,
  PUBLISHER_SUPPLIED_CAVEAT,
  extractPublisherColumnDictionary,
  modelPublisherSuppliedMetadata,
  normalizePublisherText,
  parsePublisherSuppliedMetadata,
  stripPublisherMarkdown,
} from '../src/publisher-metadata.js'

/** A description shaped like real publisher descriptions (prose + markdown table). */
const DESCRIPTION = [
  '# Widgets by Example Retail',
  '',
  'Welcome! This dataset contains anonymised widget orders.',
  '',
  '## Orders',
  '',
  '| Column | Description |',
  '| --- | --- |',
  '| `order_id` | Unique identifier of an order. |',
  '| `order_total` | **Gross** order value in the seller currency, before refunds. |',
  '| `status` | Delivery status as reported by the carrier. |',
  '',
  '## Items',
  '',
  '| Field | Type | Notes |',
  '| --- | --- | --- |',
  '| `order_id` | string | Order the item belongs to. |',
  '| `line_amount` | number | Line amount excluding freight. |',
].join('\n')

const PROPOSED_TABLES = [
  { tableId: 'orders', sourceFile: 'orders.csv' },
  { tableId: 'items', sourceFile: 'items.csv' },
]

it('quotes a markdown column dictionary and attributes entries via the publisher headings', () => {
  const block = parsePublisherSuppliedMetadata({
    cliMetadata: { info: { description: DESCRIPTION, subtitle: 'Anonymised orders' } },
    proposedTables: PROPOSED_TABLES,
  })

  expect(block.provenance).toBe('publisher-supplied')
  expect(block.verification).toBe('unverified')
  expect(block.caveat).toBe(PUBLISHER_SUPPLIED_CAVEAT)
  expect(block.sources).toEqual([PUBLISHER_SOURCE_CLI_METADATA])
  expect(block.subtitle).toBe('Anonymised orders')
  expect(block.description?.text).toContain('# Widgets by Example Retail')
  expect(block.description?.truncated).toBe(false)

  // Every entry carries its own label — a block-level label alone would let a
  // consumer treat an individual note as observed or approved.
  for (const entry of block.columnDictionary) {
    expect(entry.provenance).toBe('publisher-supplied')
    expect(entry.verification).toBe('unverified')
    expect(entry.note.length).toBeGreaterThan(0)
  }

  const orders = block.columnDictionary.filter((entry) => entry.tableId === 'orders')
  const items = block.columnDictionary.filter((entry) => entry.tableId === 'items')
  expect(orders.map((entry) => entry.column)).toEqual(['order_id', 'order_total', 'status'])
  expect(items.map((entry) => entry.column)).toEqual(['order_id', 'line_amount'])
  // Markdown emphasis/link/backtick formatting is stripped from the quoted
  // wording; the wording itself is never paraphrased.
  expect(orders.find((entry) => entry.column === 'order_total')?.note).toBe(
    'Gross order value in the seller currency, before refunds.',
  )
})

it('extracts the strict bullet form only when at least two entries appear', () => {
  const twoBullets = [
    '## Fields',
    '',
    '- `total`: Sum of all line amounts.',
    '- `tax`: Tax amount.',
  ].join('\n')
  const two = extractPublisherColumnDictionary(twoBullets)
  expect(two.entries.map((entry) => entry.column)).toEqual(['total', 'tax'])

  // A single backticked bullet is far more likely to be prose than a
  // dictionary row, so nothing is extracted from it.
  const oneBullet = '- `total`: The dataset is updated yearly.'
  expect(extractPublisherColumnDictionary(oneBullet).entries).toEqual([])
})

it('does not treat a publisher type column as a description', () => {
  const typesOnly = ['| Column | Type |', '| --- | --- |', '| order_id | VARCHAR |'].join('\n')
  const extraction = extractPublisherColumnDictionary(typesOnly)
  expect(extraction.entries).toEqual([])
  expect(extraction.undecodableTables).toBe(1)

  const block = parsePublisherSuppliedMetadata({
    cliMetadata: { info: { description: typesOnly } },
  })
  expect(block.columnDictionary).toEqual([])
  expect(block.notes.join(' ')).toMatch(/had no description-like column/)
  expect(block.notes.join(' ')).toMatch(/never treated as a definition/)
})

it('records an honest note when the publisher description contains no dictionary', () => {
  const block = parsePublisherSuppliedMetadata({
    cliMetadata: { info: { description: 'Just prose about the dataset, no table at all.' } },
  })
  expect(block.description?.text).toBe('Just prose about the dataset, no table at all.')
  expect(block.columnDictionary).toEqual([])
  expect(block.columnDictionaryTotal).toBe(0)
  expect(block.notes.join(' ')).toMatch(/No markdown column dictionary was found/)
})

it('states plainly when Kaggle supplied no description at all', () => {
  const block = parsePublisherSuppliedMetadata({ cliMetadata: { info: { title: 'Widgets' } } })
  expect(block.description).toBeUndefined()
  expect(block.columnDictionary).toEqual([])
  expect(block.notes.join(' ')).toMatch(/no publisher description/)
  // Still labelled: an empty block must never read as "nothing to declare".
  expect(block.provenance).toBe('publisher-supplied')
  expect(block.verification).toBe('unverified')
})

it('keeps the block labelled even when no endpoint returned anything', () => {
  const block = parsePublisherSuppliedMetadata({})
  expect(block.sources).toEqual([])
  expect(block.notes.join(' ')).toMatch(/no publisher metadata from either endpoint/)
  expect(block.columnDictionary).toEqual([])
})

it('reads the public view payload shape (including the *Nullable field names)', () => {
  const block = parsePublisherSuppliedMetadata({
    viewApi: {
      ref: 'owner/widgets',
      title: 'Widgets',
      descriptionNullable: DESCRIPTION,
      subtitleNullable: 'Anonymised orders',
      tags: [{ name: 'retail' }, { name: 'tabular' }],
    },
  })
  expect(block.sources).toEqual([PUBLISHER_SOURCE_VIEW_API])
  expect(block.subtitle).toBe('Anonymised orders')
  expect(block.keywords).toEqual(['retail', 'tabular'])
  expect(block.columnDictionary.length).toBeGreaterThan(0)
})

it('prefers the CLI payload when both endpoints are readable and records both sources', () => {
  const block = parsePublisherSuppliedMetadata({
    cliMetadata: { info: { description: 'CLI description text.' } },
    viewApi: { description: 'View API description text.' },
  })
  expect(block.description?.text).toBe('CLI description text.')
  expect(block.sources).toEqual([PUBLISHER_SOURCE_CLI_METADATA, PUBLISHER_SOURCE_VIEW_API])
})

it('normalizes odd publisher text instead of trusting it verbatim', () => {
  expect(normalizePublisherText(12345)).toBeNull()
  expect(normalizePublisherText(null)).toBeNull()
  expect(normalizePublisherText('   \n\t  ')).toBeNull()
  expect(normalizePublisherText({ text: 'nope' })).toBeNull()
  // CRLF folded, control characters replaced, blank-line runs collapsed.
  expect(normalizePublisherText('a\r\nb\u0007c\n\n\n\nd')).toBe('a\nb c\n\nd')

  const block = parsePublisherSuppliedMetadata({
    cliMetadata: { info: { description: 42, subtitle: ['not', 'a', 'string'], keywords: 'nope' } },
  })
  expect(block.description).toBeUndefined()
  expect(block.subtitle).toBeUndefined()
  expect(block.keywords).toBeUndefined()
  expect(block.notes.join(' ')).toMatch(/no publisher description/)
})

it('bounds an oversized description, note and entry count and says so', () => {
  const rows = Array.from(
    { length: MAX_PUBLISHER_DICTIONARY_ENTRIES + 41 },
    (_, index) => `| c_${index} | note ${index} |`,
  )
  // One over-long note near the top of the table, plus a description long
  // enough that only its prefix is stored at all.
  rows[1] = `| c_1 | ${'y'.repeat(MAX_PUBLISHER_NOTE_CHARS + 100)} |`
  const description = [
    '| Column | Description |',
    '| --- | --- |',
    ...rows,
    '',
    'x'.repeat(MAX_PUBLISHER_DESCRIPTION_CHARS + 500),
  ].join('\n')

  const block = parsePublisherSuppliedMetadata({
    cliMetadata: { info: { description } },
  })
  expect(block.description?.truncated).toBe(true)
  expect(block.description?.sourceLength).toBeGreaterThan(MAX_PUBLISHER_DESCRIPTION_CHARS)
  expect(Array.from(block.description!.text).length).toBeLessThanOrEqual(
    MAX_PUBLISHER_DESCRIPTION_CHARS,
  )
  expect(block.columnDictionary).toHaveLength(MAX_PUBLISHER_DICTIONARY_ENTRIES)
  expect(block.columnDictionaryTotal).toBeGreaterThan(MAX_PUBLISHER_DICTIONARY_ENTRIES)
  for (const entry of block.columnDictionary) {
    expect(Array.from(entry.note).length).toBeLessThanOrEqual(MAX_PUBLISHER_NOTE_CHARS)
  }
  // The over-long note is quoted up to the cap, marked by a trailing ellipsis.
  expect(block.columnDictionary[1]?.note.endsWith('…')).toBe(true)
  expect(block.notes.join(' ')).toMatch(/truncated to 8000 characters/)
  expect(block.notes.join(' ')).toMatch(/omitted at the 200-entry storage cap/)
})

it('bounds the model-facing projection harder than the stored block, keeping the labels', () => {
  const rows = Array.from(
    { length: MAX_PUBLISHER_DICTIONARY_ENTRIES * 3 },
    (_, index) => `| col_${index} | ${'z'.repeat(60)} |`,
  )
  const description = [
    '| Column | Description |',
    '| --- | --- |',
    ...rows,
    '',
    'd'.repeat(9_000),
  ].join('\n')
  const stored = parsePublisherSuppliedMetadata({ cliMetadata: { info: { description } } })
  const model = modelPublisherSuppliedMetadata(stored)

  expect(Array.from(model.descriptionExcerpt ?? '').length).toBeLessThanOrEqual(
    MAX_MODEL_DESCRIPTION_CHARS,
  )
  expect(model.descriptionTruncated).toBe(true)
  expect(model.descriptionChars).toBe(stored.description!.sourceLength)
  expect(model.columnNotes).toHaveLength(MAX_MODEL_DICTIONARY_ENTRIES)
  expect(model.columnDictionaryTotal).toBe(stored.columnDictionaryTotal)
  expect(model.columnNotesOmitted).toBe(
    stored.columnDictionary.length - MAX_MODEL_DICTIONARY_ENTRIES,
  )
  for (const entry of model.columnNotes) {
    expect(entry.provenance).toBe('publisher-supplied')
    expect(entry.verification).toBe('unverified')
    expect(Array.from(entry.note).length).toBeLessThanOrEqual(MAX_MODEL_NOTE_CHARS + 1)
  }
  expect(model.caveat).toBe(PUBLISHER_SUPPLIED_CAVEAT)
  expect(model.verification).toBe('unverified')
})

it('never files a note under a table the publisher did not unambiguously name', () => {
  const block = parsePublisherSuppliedMetadata({
    cliMetadata: { info: { description: DESCRIPTION } },
    // No proposed tables at all, and then a set where no heading matches.
  })
  expect(block.columnDictionary.every((entry) => entry.tableId === undefined)).toBe(true)

  const mismatched = parsePublisherSuppliedMetadata({
    cliMetadata: { info: { description: DESCRIPTION } },
    proposedTables: [{ tableId: 'invoices', sourceFile: 'invoices.csv' }],
  })
  expect(mismatched.columnDictionary.every((entry) => entry.tableId === undefined)).toBe(true)
})

it('strips inline markdown and links from quoted wording without paraphrasing it', () => {
  expect(stripPublisherMarkdown('[total](https://example.com/total) is **gross**')).toBe(
    'total is gross',
  )
  expect(stripPublisherMarkdown('`order_id`')).toBe('order_id')
  // Underscores are column-name characters, never emphasis to remove.
  expect(stripPublisherMarkdown('order_id')).toBe('order_id')
  expect(stripPublisherMarkdown('<script>alert(1)</script>safe')).toBe('alert(1) safe')
})
