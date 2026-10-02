/**
 * One integration test per
 * deliberately "dirty" fixture condition, confirming the existing
 * quality-diagnostic machinery (`csv-encoding.ts`, `materiality.ts`,
 * `currency-detection.ts`, `analytical-recipes.ts`'s
 * `full-row-duplicate-excess`) correctly surfaces each condition through
 * typed tool output — not just "ingest didn't crash." Fixtures live in
 * tests/fixtures/dirty-data/ except the mixed-encoding case, whose bytes are constructed
 * in-test (matching the existing pattern in csv-encoding.integration.test.ts)
 * because a genuinely mixed-encoding file is easiest to review as
 * constructed bytes rather than as an opaque committed binary.
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import type { IngestRecipe } from 'dsh-data-core/recipes/types'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { buildAnalyticalRecipe, type AnalyticalRecipeScope } from '../src/analytical-recipes.js'
import { detectCsvEncoding, normalizeCsvToUtf8 } from '../src/csv-encoding.js'
import { detectCurrencyDimensions } from '../src/currency-detection.js'
import { runIngestFromArchive } from '../src/ingest-pipeline.js'
import { executeAuthorizedQuery } from '../src/query-service.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-dirty-data-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function buildArchiveFromCsv(destination: string, csvBytes: Buffer): Promise<string> {
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(csvBytes, 'data.csv')
  const archivePath = join(destination, 'source.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return archivePath
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../tests/fixtures/dirty-data/${name}`, import.meta.url))
}

async function readFixture(name: string): Promise<Buffer> {
  return readFile(fixturePath(name))
}

/** raw_then_typed recipe so cast failures surface as castNullCounts + materiality, not row rejection. */
function adaptiveRecipe(
  datasetId: string,
  columns: IngestRecipe['tables'][number]['columns'],
): IngestRecipe {
  return {
    datasetId,
    recipeHash: `${datasetId}-recipe-v1`,
    importerVersion: '0.1.0',
    loadStrategy: 'raw_then_typed',
    tables: [{ sourceFile: 'data.csv', tableId: 'orders', columns }],
    license: null,
    sourceUrl: 'https://example.invalid/dirty-data-fixture',
  }
}

it('1. mixed encodings within the same CSV file: per-record decoding recovers both rows correctly (fixed gap, previously silent mojibake)', async () => {
  // First data row genuinely UTF-8 ("Café" as 0xC3 0xA9), second genuinely
  // windows-1252 ("Café" as the single byte 0xE9) — a pathological file
  // csv-encoding.ts's whole-file *detection* still classifies as
  // windows-1252 overall (there is no whole-file encoding that is "correct"
  // for a genuinely mixed file), but `normalizeCsvToUtf8` now makes an
  // independent per-record decoding decision instead of applying that one
  // whole-file classification to every row.
  const header = Buffer.from('name,amount\n', 'utf8')
  const utf8Row = Buffer.from('Café,10\n', 'utf8')
  const windows1252Row = Buffer.from('Caf\xE9,20\n', 'binary')
  const mixedBytes = Buffer.concat([header, utf8Row, windows1252Row])

  // The whole file is not valid UTF-8 (the windows-1252 row's 0xE9 is not a
  // valid lone UTF-8 byte), so whole-file detection still reports
  // windows-1252 — that part of the model is unchanged and correct on its
  // own terms (some encoding hint is needed to know to even attempt a
  // windows-1252 fallback at all).
  expect(detectCsvEncoding(mixedBytes)).toBe('windows-1252')

  const sourcePath = join(directory, 'mixed.csv')
  const destinationPath = join(directory, 'normalized.csv')
  await writeFile(sourcePath, mixedBytes)
  await normalizeCsvToUtf8(sourcePath, destinationPath, { fromEncoding: 'windows-1252' })
  const normalized = await readFile(destinationPath, 'utf8')

  // FIXED: normalizeCsvToUtf8 now decides encoding per record, so the
  // genuinely-UTF-8 row decodes correctly ("Café") and the genuinely-
  // windows-1252 row also decodes correctly ("Café") — no mojibake despite
  // both rows sharing one file and one whole-file classification.
  expect(normalized).toBe('name,amount\nCafé,10\nCafé,20\n')
  expect(normalized).not.toContain('CafÃ©') // no mojibake anywhere in the output
})

it('2. inconsistent date formats across rows in the same column surface as castNullCounts + a material-cast-null reason', async () => {
  const archivePath = await buildArchiveFromCsv(
    directory,
    await readFixture('inconsistent-dates.csv'),
  )
  const result = await runIngestFromArchive({
    archivePath,
    workspaceDir: directory,
    catalogPath: join(directory, 'catalog.sqlite'),
    recipe: adaptiveRecipe('dirty-dates', [
      { name: 'line_id', type: 'VARCHAR' },
      { name: 'customer_id', type: 'VARCHAR' },
      { name: 'order_date', type: 'DATE' },
      { name: 'region', type: 'VARCHAR' },
      { name: 'amount', type: 'DECIMAL(18,2)' },
    ]),
    slug: 'test/dirty-dates',
    sourceVersion: '1',
    idempotencyKey: 'dirty-dates-1',
  })

  expect(result.status).toBe('needs-input')
  // ISO ("2024-01-15", "2024-02-20") and slash-ISO ("2024/03/10") parse;
  // US-style, "DD-Mon-YYYY", and "Mon DD YYYY" do not — 3 of 6 rows.
  expect(result.tables[0]?.castNullCounts?.order_date).toBe(3)
  expect(result.materiality?.material).toBe(true)
  expect(result.materiality?.reasons.some((reason) => reason.includes('order_date'))).toBe(true)
})

it('3. embedded quotes/commas/newlines inside quoted CSV fields (RFC4180) are parsed correctly, not mangled or dropped', async () => {
  const archivePath = await buildArchiveFromCsv(
    directory,
    await readFixture('rfc4180-edge-cases.csv'),
  )
  const result = await runIngestFromArchive({
    archivePath,
    workspaceDir: directory,
    catalogPath: join(directory, 'catalog.sqlite'),
    recipe: {
      datasetId: 'dirty-rfc4180',
      recipeHash: 'dirty-rfc4180-recipe-v1',
      importerVersion: '0.1.0',
      tables: [
        {
          sourceFile: 'data.csv',
          tableId: 'orders',
          columns: [
            { name: 'line_id', type: 'VARCHAR' },
            { name: 'customer_id', type: 'VARCHAR' },
            { name: 'note', type: 'VARCHAR' },
            { name: 'amount', type: 'DECIMAL(18,2)' },
          ],
        },
      ],
      license: null,
      sourceUrl: 'https://example.invalid/dirty-data-fixture',
    },
    slug: 'test/dirty-rfc4180',
    sourceVersion: '1',
    idempotencyKey: 'dirty-rfc4180-1',
  })

  expect(result.status).toBe('ready')
  expect(result.tables[0]).toMatchObject({ rows: 4, rejectedRows: 0 })

  const reader = await DuckDBInstance.create(result.datasetPath, {
    access_mode: 'READ_ONLY',
    enable_external_access: 'false',
  })
  const connection = await reader.connect()
  try {
    const notes = await connection.runAndReadAll('SELECT note FROM orders ORDER BY line_id')
    expect(notes.getRowsJson()).toEqual([
      ['Smith, John'], // embedded comma
      ['He said "hello"'], // embedded, doubled-quoted quotes
      ['Multi\nline\nnote'], // embedded newline inside a quoted field
      ['Simple note'],
    ])
  } finally {
    connection.closeSync()
    reader.closeSync()
  }
})

it('4. a high null(-equivalent)-rate column surfaces as high castNullCounts + a material-cast-null reason', async () => {
  const archivePath = await buildArchiveFromCsv(directory, await readFixture('high-null-rate.csv'))
  const result = await runIngestFromArchive({
    archivePath,
    workspaceDir: directory,
    catalogPath: join(directory, 'catalog.sqlite'),
    recipe: adaptiveRecipe('dirty-high-null', [
      { name: 'line_id', type: 'VARCHAR' },
      { name: 'customer_id', type: 'VARCHAR' },
      { name: 'order_date', type: 'DATE' },
      { name: 'region', type: 'VARCHAR' },
      { name: 'amount', type: 'DECIMAL(18,2)' },
      { name: 'discount_pct', type: 'DOUBLE' },
    ]),
    slug: 'test/dirty-high-null',
    sourceVersion: '1',
    idempotencyKey: 'dirty-high-null-1',
  })

  expect(result.status).toBe('needs-input')
  // 8 rows; only one ("0.10") is a real number. "N/A" (x5), "unknown", and
  // "-" are all non-empty non-numeric placeholder text, so they count as
  // cast failures (present-but-uncastable), not raw NULLs.
  expect(result.tables[0]?.castNullCounts?.discount_pct).toBe(7)
  expect(result.materiality?.material).toBe(true)
  expect(result.materiality?.reasons.some((reason) => reason.includes('discount_pct'))).toBe(true)
})

it('5. full-row duplicates surface through the existing full-row-duplicate-excess analytical recipe against a real ingested fixture', async () => {
  const archivePath = await buildArchiveFromCsv(
    directory,
    await readFixture('full-row-duplicates.csv'),
  )
  const result = await runIngestFromArchive({
    archivePath,
    workspaceDir: directory,
    catalogPath: join(directory, 'catalog.sqlite'),
    recipe: {
      datasetId: 'dirty-duplicates',
      recipeHash: 'dirty-duplicates-recipe-v1',
      importerVersion: '0.1.0',
      tables: [
        {
          sourceFile: 'data.csv',
          tableId: 'orders',
          columns: [
            { name: 'line_id', type: 'VARCHAR' },
            { name: 'customer_id', type: 'VARCHAR' },
            { name: 'region', type: 'VARCHAR' },
            { name: 'amount', type: 'DECIMAL(18,2)' },
          ],
        },
      ],
      license: null,
      sourceUrl: 'https://example.invalid/dirty-data-fixture',
    },
    slug: 'test/dirty-duplicates',
    sourceVersion: '1',
    idempotencyKey: 'dirty-duplicates-1',
  })
  expect(result.status).toBe('ready')
  expect(result.tables[0]).toMatchObject({ rows: 5, rejectedRows: 0 })

  const scope: AnalyticalRecipeScope = {
    table: 'orders',
    columns: ['line_id', 'customer_id', 'region', 'amount'],
    columnTypes: {
      line_id: 'VARCHAR',
      customer_id: 'VARCHAR',
      region: 'VARCHAR',
      amount: 'DECIMAL(18,2)',
    },
    grainStatus: 'approved',
  }
  const recipe = buildAnalyticalRecipe(scope, {
    kind: 'full-row-duplicate-excess',
    rowColumns: scope.columns,
  })
  const queried = await executeAuthorizedQuery({
    datasetPath: result.datasetPath,
    datasetVersionId: result.datasetVersionId,
    semanticRevisionId: 'fixture-sem-v1',
    sql: recipe.sql,
    parameters: recipe.parameters,
    allowedTables: [scope.table],
  })

  // 5 total rows, 3 distinct rows (two exact-duplicate pairs), so
  // duplicate_excess = (2-1) + (2-1) = 2.
  expect(queried.preview).toEqual([['5', '3', '2']])
})

it('6. a column mixing multiple ISO-4217 currencies is flagged by detectCurrencyDimensions against a real ingested fixture', async () => {
  const csvPath = fixturePath('mixed-currency.csv')
  const database = await DuckDBInstance.create(join(directory, 'currency.duckdb'))
  const connection = await database.connect()
  try {
    await connection.run(
      `CREATE TABLE orders AS SELECT * FROM read_csv(?, header=true, columns={'order_id':'BIGINT','currency':'VARCHAR','amount':'DECIMAL(18,2)'})`,
      [csvPath],
    )
    const dimensions = await detectCurrencyDimensions(connection, 'orders', [
      { name: 'order_id', type: 'BIGINT' },
      { name: 'currency', type: 'VARCHAR' },
      { name: 'amount', type: 'DECIMAL(18,2)' },
    ])
    expect(dimensions).toEqual([{ column: 'currency', currencies: ['EUR', 'GBP', 'JPY', 'USD'] }])
  } finally {
    connection.closeSync()
    database.closeSync()
  }
})
