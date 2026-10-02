/**
 * Trusted preview → analyst-approved workspace pin → publish. No
 * network: `localArchivePath` stands in for a completed Kaggle download,
 * mirroring ingest-coordinator.integration.test.ts's pattern.
 */
import { createWriteStream } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { listPublishedDatasets } from 'dsh-data-core/catalog-query'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { UnsupportedSourceError } from 'dsh-data-core/recipes/registry'
import { resolveSourcePin } from 'dsh-data-core/recipes/workspace-registry'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { downloadDestinationForSlug } from 'dsh-data-kaggle/download-job'
import {
  MAX_MODEL_DESCRIPTION_CHARS,
  MAX_PUBLISHER_DESCRIPTION_CHARS,
} from 'dsh-data-kaggle/publisher-metadata'
import { runReviewedIngest } from '../src/ingest-coordinator.js'
import { datasetIdFromSlug, previewIngestSource } from '../src/preview-ingest.js'

const SLUG = 'someone/widgets'
const VERSION = '1'
const EXPECTED_DATASET_ID = datasetIdFromSlug(SLUG)

let directory: string

async function buildFixtureArchive(destination: string): Promise<string> {
  const fixtureCsvPath = fileURLToPath(
    new URL('../../../tests/fixtures/propose-ingest/orders.csv', import.meta.url),
  )
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(await readFile(fixtureCsvPath), 'orders.csv')
  const path = join(destination, 'source.zip')
  const writeStream = createWriteStream(path)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return path
}

/** Stubs Kaggle's public view API response (`currentVersionNumber` may be absent). */
function makeViewFetchStub(slug: string, currentVersionNumber: unknown): typeof fetch {
  return (async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      ref: slug,
      title: 'Widgets',
      currentVersionNumber,
      licenseName: 'CC0',
    }),
  })) as unknown as typeof fetch
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-preview-ingest-'))
  await mkdir(join(directory, 'sources'), { recursive: true })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('proposes a candidate workspace pin for an unreviewed slug without publishing', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)

  const result = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })

  expect(result.alreadyReviewed).toBe(false)
  expect(result.status).toBe('candidate')
  expect(result.pinId).toMatch(/^pin_/)
  expect(result.datasetId).toBe(EXPECTED_DATASET_ID)
  expect(result.tables).toHaveLength(1)
  expect(result.tables?.[0]?.tableId).toBe('orders')
  expect(result.tables?.[0]?.columns.map((column) => column.name)).toEqual(['region', 'sales'])
  expect(result.unsupportedFiles).toEqual([])
  expect(result.files).toEqual([
    { name: 'orders.csv', bytes: expect.any(Number), status: 'proposed' },
  ])

  const store = new MetadataStore(workspace.catalogPath)
  try {
    const pins = store.listWorkspaceSourcePins(SLUG)
    expect(pins).toHaveLength(1)
    expect(pins[0]?.status).toBe('candidate')
    expect(pins[0]?.actorId).toBe('analyst-session')

    // A candidate-only pin is not enough to ingest.
    expect(() => resolveSourcePin(SLUG, pins)).toThrow(UnsupportedSourceError)
  } finally {
    store.close()
  }
})

it('pages proposal columns with search/limit/offset, same nextOffset contract as get_schema', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)

  const full = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })
  expect(full.totalColumns).toBe(2)
  expect(full.columnsTruncated).toBe(false)
  expect(full.nextOffset).toBeNull()

  const firstPage = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
    limit: 1,
  })
  expect(firstPage.tables?.[0]?.columns.map((column) => column.name)).toEqual(['region'])
  expect(firstPage.columnsTruncated).toBe(true)
  expect(firstPage.nextOffset).toBe(1)

  const secondPage = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
    limit: 1,
    offset: firstPage.nextOffset!,
  })
  expect(secondPage.tables?.[0]?.columns.map((column) => column.name)).toEqual(['sales'])
  expect(secondPage.columnsTruncated).toBe(false)
  expect(secondPage.nextOffset).toBeNull()

  const searched = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
    search: 'sale',
  })
  expect(searched.tables?.[0]?.columns.map((column) => column.name)).toEqual(['sales'])
})

it('persists only an exact-version verified Kaggle license in the candidate recipe', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)
  const executable = join(directory, 'fake-kaggle')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const index = process.argv.indexOf('-p'); const destination = process.argv[index + 1];
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'dataset-metadata.json'), JSON.stringify({
  id: '${SLUG}', title: 'Widgets', versionNumber: ${VERSION}, licenses: [{ name: 'CC0' }]
}));
`,
    'utf8',
  )
  await chmod(executable, 0o755)

  const result = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: executable,
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })
  expect(result).toMatchObject({
    license: 'CC0',
    observedLicense: 'CC0',
    observedSourceVersion: VERSION,
    licenseVersionVerified: true,
    provenanceStatus: 'verified',
  })

  const store = new MetadataStore(workspace.catalogPath)
  try {
    expect(store.getWorkspaceSourcePin(result.pinId!)?.recipe.license).toBe('CC0')
  } finally {
    store.close()
  }
})

it('reports a coherent unverified provenance when metadata omits the version', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)
  const executable = join(directory, 'fake-kaggle')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const index = process.argv.indexOf('-p'); const destination = process.argv[index + 1];
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'dataset-metadata.json'), JSON.stringify({
  id: '${SLUG}', title: 'Widgets', licenses: [{ name: 'CC0' }]
}));
`,
    'utf8',
  )
  await chmod(executable, 0o755)

  const result = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: executable,
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })

  expect(result.provenanceStatus).toBe('version-unverified')
  expect(result.observedSourceVersion).toBeNull()
  expect(result.licenseVersionVerified).toBe(false)
  expect(result.license).toBeNull()
  expect(result.metadataWarning).toMatch(/version/)
})

it('auto-resolves the latest version when sourceVersion is omitted and no pin exists (no Core short-circuit)', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)

  const result = await previewIngestSource({
    slug: SLUG,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
    fetchImpl: makeViewFetchStub(SLUG, 7),
  })

  // Not already-reviewed: it resolved the current version and proposed a pin.
  expect(result.alreadyReviewed).toBe(false)
  expect(result.status).toBe('candidate')
  expect(result.sourceVersion).toBe('7')

  const store = new MetadataStore(workspace.catalogPath)
  try {
    expect(store.listWorkspaceSourcePins()).toHaveLength(1)
  } finally {
    store.close()
  }
})

it('rejects only when Kaggle reports no current version and none was provided', async () => {
  const workspace = resolveWorkspacePaths(directory)
  await expect(
    previewIngestSource({
      slug: SLUG,
      workspace,
      kaggleExecutable: '/bin/false',
      actorId: 'analyst-session',
      fetchImpl: makeViewFetchStub(SLUG, undefined),
    }),
  ).rejects.toThrow(/did not report a current version/)
})

it('short-circuits to alreadyReviewed once the workspace pin is approved, no re-download', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)
  const first = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })

  const store = new MetadataStore(workspace.catalogPath)
  try {
    store.setWorkspaceSourcePinStatus(
      first.pinId!,
      'approved',
      store.getWorkspaceSourcePin(first.pinId!)?.revision ?? 1,
    )
  } finally {
    store.close()
  }

  // No sourceVersion/localArchivePath passed this time — must not need a download.
  const second = await previewIngestSource({
    slug: SLUG,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
  })
  expect(second.alreadyReviewed).toBe(true)
  expect(second.datasetId).toBe(EXPECTED_DATASET_ID)
})

it('re-proposes an approved legacy typed_recipe pin as a raw_then_typed candidate', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)

  // Seed an approved legacy pin whose recipe predates the adaptive loader
  // (no loadStrategy) — the GTD-style dead end this re-proposal guards against.
  const store = new MetadataStore(workspace.catalogPath)
  const legacyPin = store.createWorkspaceSourcePin({
    slug: SLUG,
    sourceVersion: VERSION,
    actorId: 'analyst-session',
    recipe: {
      datasetId: EXPECTED_DATASET_ID,
      recipeHash: 'legacy-typed-v1',
      importerVersion: '0.1.0',
      license: null,
      sourceUrl: `https://www.kaggle.com/datasets/${SLUG}`,
      tables: [
        {
          sourceFile: 'orders.csv',
          sourceFormat: 'csv',
          tableId: 'orders',
          columns: [
            { name: 'region', sourceName: 'region', type: 'VARCHAR' },
            { name: 'sales', sourceName: 'sales', type: 'DOUBLE' },
          ],
        },
      ],
    },
  })
  store.setWorkspaceSourcePinStatus(
    legacyPin.pinId,
    'approved',
    store.getWorkspaceSourcePin(legacyPin.pinId)?.revision ?? 1,
  )
  store.close()

  // No sourceVersion passed: the legacy pin already pins the version, and the
  // cached archive (localArchivePath) is reused — no network, no re-download.
  const re = await previewIngestSource({
    slug: SLUG,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })

  expect(re.alreadyReviewed).toBe(false)
  expect(re.status).toBe('candidate')
  expect(re.pinId).toMatch(/^pin_/)
  expect(re.pinId).not.toBe(legacyPin.pinId)
  expect(re.loadStrategy).toBe('raw_then_typed')

  const verify = new MetadataStore(workspace.catalogPath)
  try {
    const pins = verify.listWorkspaceSourcePins(SLUG)
    expect(pins).toHaveLength(2)
    const candidate = pins.find((pin) => pin.pinId === re.pinId)
    expect(candidate?.status).toBe('candidate')
    expect(candidate?.recipe.loadStrategy).toBe('raw_then_typed')
    // The original approved legacy pin is unchanged and still resolves.
    expect(resolveSourcePin(SLUG, pins).recipe.datasetId).toBe(EXPECTED_DATASET_ID)
  } finally {
    verify.close()
  }
})

it('candidate → approve → publish → list_datasets: only an approved pin can ingest', async () => {
  const workspace = resolveWorkspacePaths(directory)
  // Pre-place the archive exactly where a real download would land it, so
  // both previewIngestSource and the later runReviewedIngest call find the
  // same cached archive via `downloadDestinationForSlug` without any
  // model/test-only path override.
  const destinationDir = downloadDestinationForSlug(workspace.sourcesDir, SLUG, VERSION)
  await mkdir(destinationDir, { recursive: true })
  await buildFixtureArchive(destinationDir)

  const preview = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
  })

  const store = new MetadataStore(workspace.catalogPath)
  try {
    // Fail closed: a mere candidate cannot resolve to an ingestible pin.
    expect(() => resolveSourcePin(SLUG, store.listWorkspaceSourcePins(SLUG))).toThrow(
      UnsupportedSourceError,
    )

    store.setWorkspaceSourcePinStatus(
      preview.pinId!,
      'approved',
      store.getWorkspaceSourcePin(preview.pinId!)?.revision ?? 1,
    )
    const pin = resolveSourcePin(SLUG, store.listWorkspaceSourcePins(SLUG))
    expect(pin.recipe.datasetId).toBe(EXPECTED_DATASET_ID)

    // The archive previewIngestSource already downloaded is reused; no kaggle call.
    const ingestResult = await runReviewedIngest({
      slug: pin.slug,
      pin,
      workspace,
      kaggleExecutable: '/bin/false',
    })
    expect(ingestResult.status).toBe('ready')
    expect(ingestResult.datasetId).toBe(EXPECTED_DATASET_ID)
    expect(ingestResult.tables[0]).toMatchObject({ id: 'orders', rejectedRows: 0 })

    const published = listPublishedDatasets(store)
    expect(published.map((entry) => entry.datasetId)).toContain(EXPECTED_DATASET_ID)
    const widgets = published.find((entry) => entry.datasetId === EXPECTED_DATASET_ID)
    expect(widgets?.sourceSlug).toBe(SLUG)
    expect(widgets?.tables[0]).toMatchObject({ id: 'orders' })
  } finally {
    store.close()
  }
})

it('detects windows-1252 encoding during preview and ingests it via normalization', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const destinationDir = downloadDestinationForSlug(workspace.sourcesDir, SLUG, VERSION)
  await mkdir(destinationDir, { recursive: true })
  // windows-1252 CSV: 0xe9 is "é" under windows-1252 but not valid lone UTF-8.
  const csvBytes = Buffer.from('region,sales\nCaf\xE9,10\nNorth,20\n', 'binary')
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(csvBytes, 'orders.csv')
  const archivePath = join(destinationDir, 'source.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)

  const preview = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
  })

  // The proposal must carry the detected encoding so ingest can normalize it.
  expect(preview.tables?.[0]?.sourceEncoding).toBe('windows-1252')

  const store = new MetadataStore(workspace.catalogPath)
  try {
    store.setWorkspaceSourcePinStatus(
      preview.pinId!,
      'approved',
      store.getWorkspaceSourcePin(preview.pinId!)?.revision ?? 1,
    )
    const pin = resolveSourcePin(SLUG, store.listWorkspaceSourcePins(SLUG))
    // Without sourceEncoding normalization this would fail on invalid unicode.
    const ingest = await runReviewedIngest({
      slug: pin.slug,
      pin,
      workspace,
      kaggleExecutable: '/bin/false',
    })
    expect(ingest.status).toBe('ready')
    expect(ingest.tables[0]).toMatchObject({ id: 'orders', rejectedRows: 0 })
  } finally {
    store.close()
  }
})

it('rejects a revoked workspace pin the same way as no pin at all', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)
  const preview = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })

  const store = new MetadataStore(workspace.catalogPath)
  try {
    store.setWorkspaceSourcePinStatus(
      preview.pinId!,
      'revoked',
      store.getWorkspaceSourcePin(preview.pinId!)?.revision ?? 1,
    )
    expect(() => resolveSourcePin(SLUG, store.listWorkspaceSourcePins(SLUG))).toThrow(
      UnsupportedSourceError,
    )
  } finally {
    store.close()
  }
})

it('always removes preview-extracted/ after a successful preview, never leaving an extract behind', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)

  await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })

  const destinationDir = downloadDestinationForSlug(workspace.sourcesDir, SLUG, VERSION)
  await expect(access(join(destinationDir, 'preview-extracted'))).rejects.toThrow()
})

it('still removes preview-extracted/ when the proposal step throws (no usable CSV)', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(Buffer.from('not a csv'), 'notes.txt')
  const archivePath = join(directory, 'no-csv.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)

  await expect(
    previewIngestSource({
      slug: SLUG,
      sourceVersion: VERSION,
      workspace,
      kaggleExecutable: '/bin/false',
      actorId: 'analyst-session',
      localArchivePath: archivePath,
    }),
  ).rejects.toThrow(/No supported CSV, Parquet, JSON\/JSONL, or Excel files/)

  const destinationDir = downloadDestinationForSlug(workspace.sourcesDir, SLUG, VERSION)
  await expect(access(join(destinationDir, 'preview-extracted'))).rejects.toThrow()
})

it('proposes and publishes controlled Parquet and JSONL tables with collision-safe ids', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const parquetPath = join(directory, 'events.parquet')
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  try {
    await connection.run(
      `COPY (SELECT 1::BIGINT AS event_id, 12.50::DECIMAL(18,2) AS amount)
       TO ? (FORMAT PARQUET)`,
      [parquetPath],
    )
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(await readFile(parquetPath), 'warehouse/events.parquet')
  zipfile.addBuffer(Buffer.from('{"event_id":2,"label":"close"}\n', 'utf8'), 'logs/events.jsonl')
  const destinationDir = downloadDestinationForSlug(workspace.sourcesDir, SLUG, VERSION)
  await mkdir(destinationDir, { recursive: true })
  const archivePath = join(destinationDir, 'tabular.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)

  const preview = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: 'false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })
  expect(preview.tables?.map((table) => [table.tableId, table.sourceFormat])).toEqual([
    ['events', 'parquet'],
    ['events_2', 'json'],
  ])
  expect(preview.totalTables).toBe(2)
  expect(preview.tablesFiltered).toBe(false)

  const scoped = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: 'false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
    tables: ['events_2'],
  })
  expect(scoped.tables?.map((table) => table.tableId)).toEqual(['events_2'])
  expect(scoped.tablesFiltered).toBe(true)
  expect(scoped.totalTables).toBe(2)

  const store = new MetadataStore(workspace.catalogPath)
  try {
    const candidate = store.listWorkspaceSourcePins(SLUG)[0]!
    expect(candidate.recipe.tables.map((table) => table.sourceFormat)).toEqual(['parquet', 'json'])
    store.setWorkspaceSourcePinStatus(
      preview.pinId!,
      'approved',
      store.getWorkspaceSourcePin(preview.pinId!)?.revision ?? 1,
    )
    const pin = resolveSourcePin(SLUG, store.listWorkspaceSourcePins(SLUG))
    const ingest = await runReviewedIngest({
      slug: SLUG,
      pin,
      workspace,
      kaggleExecutable: 'false',
    })
    expect(ingest.tables).toEqual([
      {
        id: 'events',
        rows: 1,
        rejectedRows: 0,
        sourceRowCount: 1,
        rawRowCount: 1,
        projectionRowCount: 1,
        castNullCounts: { event_id: 0, amount: 0 },
      },
      {
        id: 'events_2',
        rows: 1,
        rejectedRows: 0,
        sourceRowCount: 1,
        rawRowCount: 1,
        projectionRowCount: 1,
        castNullCounts: { event_id: 0, label: 0 },
      },
    ])
  } finally {
    store.close()
  }
})

async function buildOutOfScopeArchive(
  destination: string,
  archiveName: string,
  entries: Array<{ fixtureName: string; archivePath: string }>,
): Promise<string> {
  const zipfile = new yazl.ZipFile()
  for (const entry of entries) {
    const fixturePath = fileURLToPath(
      new URL(`../../../tests/fixtures/out-of-scope/${entry.fixtureName}`, import.meta.url),
    )
    zipfile.addBuffer(await readFile(fixturePath), entry.archivePath)
  }
  const path = join(destination, archiveName)
  const writeStream = createWriteStream(path)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return path
}

it('reports the named-adapter unsupportedReason for a SQLite-only archive and throws the aggregate error', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildOutOfScopeArchive(directory, 'sqlite-only.zip', [
    { fixtureName: 'catalog.sqlite', archivePath: 'catalog.sqlite' },
  ])

  await expect(
    previewIngestSource({
      slug: SLUG,
      sourceVersion: VERSION,
      workspace,
      kaggleExecutable: '/bin/false',
      actorId: 'analyst-session',
      localArchivePath: archivePath,
    }),
  ).rejects.toThrow(
    /No supported CSV, Parquet, JSON\/JSONL, or Excel files.*catalog\.sqlite: SQLite requires a dedicated reviewed adapter \(not enabled yet\)/,
  )
})

it('reports the named-adapter unsupportedReason for a legacy-XLS-only archive and throws the aggregate error', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildOutOfScopeArchive(directory, 'xls-only.zip', [
    { fixtureName: 'legacy.xls', archivePath: 'legacy.xls' },
  ])

  await expect(
    previewIngestSource({
      slug: SLUG,
      sourceVersion: VERSION,
      workspace,
      kaggleExecutable: '/bin/false',
      actorId: 'analyst-session',
      localArchivePath: archivePath,
    }),
  ).rejects.toThrow(
    /No supported CSV, Parquet, JSON\/JSONL, or Excel files.*legacy\.xls: Legacy XLS requires a dedicated reviewed adapter/,
  )
})

it('reports the generic fallback unsupportedReason for an image-dataset archive (no tabular files at all)', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildOutOfScopeArchive(directory, 'images-only.zip', [
    { fixtureName: 'photo1.jpg', archivePath: 'images/photo1.jpg' },
    { fixtureName: 'photo2.png', archivePath: 'images/photo2.png' },
  ])

  await expect(
    previewIngestSource({
      slug: SLUG,
      sourceVersion: VERSION,
      workspace,
      kaggleExecutable: '/bin/false',
      actorId: 'analyst-session',
      localArchivePath: archivePath,
    }),
  ).rejects.toThrow(
    /No supported CSV, Parquet, JSON\/JSONL, or Excel files.*File format is not supported by a controlled tabular adapter/,
  )
})

it('proposes the supported table from a mixed archive while listing the unsupported files, not dropping or blocking either', async () => {
  const workspace = resolveWorkspacePaths(directory)
  // A single archive containing one supported CSV table plus two unsupported
  // out-of-scope files (an image and a SQLite database).
  const fixtureCsvPath = fileURLToPath(
    new URL('../../../tests/fixtures/propose-ingest/orders.csv', import.meta.url),
  )
  const combined = new yazl.ZipFile()
  combined.addBuffer(await readFile(fixtureCsvPath), 'orders.csv')
  combined.addBuffer(
    await readFile(
      fileURLToPath(new URL('../../../tests/fixtures/out-of-scope/photo1.jpg', import.meta.url)),
    ),
    'images/photo1.jpg',
  )
  combined.addBuffer(
    await readFile(
      fileURLToPath(
        new URL('../../../tests/fixtures/out-of-scope/catalog.sqlite', import.meta.url),
      ),
    ),
    'catalog.sqlite',
  )
  const combinedPath = join(directory, 'combined-mixed.zip')
  const writeStream = createWriteStream(combinedPath)
  combined.outputStream.pipe(writeStream)
  combined.end()
  await finished(writeStream)

  const result = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: combinedPath,
  })

  expect(result.status).toBe('candidate')
  expect(result.tables).toHaveLength(1)
  expect(result.tables?.[0]?.tableId).toBe('orders')
  expect(result.unsupportedFiles).toEqual(
    expect.arrayContaining([
      {
        name: 'images/photo1.jpg',
        reason: 'File format is not supported by a controlled tabular adapter',
      },
      {
        name: 'catalog.sqlite',
        reason: 'SQLite requires a dedicated reviewed adapter (not enabled yet)',
      },
    ]),
  )
  expect(result.unsupportedFiles).toHaveLength(2)
})

it('does not reuse a cached archive under a different pinned version', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const staleDir = downloadDestinationForSlug(workspace.sourcesDir, SLUG, '2')
  await mkdir(staleDir, { recursive: true })
  await buildFixtureArchive(staleDir)

  // A stub that exists and exits non-zero, so the download adapter's
  // fail-closed executable check passes and spawn fails with a clean
  // "Kaggle download failed" — portable, unlike a bare `false` (now rejected
  // as a missing executable) or `/bin/false` (absent on this platform).
  const failing = join(directory, 'fail-kaggle')
  await writeFile(failing, '#!/bin/sh\nexit 1\n', 'utf8')
  await chmod(failing, 0o755)

  await expect(
    previewIngestSource({
      slug: SLUG,
      sourceVersion: VERSION,
      workspace,
      kaggleExecutable: failing,
      actorId: 'analyst-session',
    }),
  ).rejects.toThrow(/Kaggle download failed|no \.zip was found/)
})

/** A publisher description shaped like real ones: prose plus a markdown dictionary. */
const PUBLISHER_DESCRIPTION = [
  '# Widgets by Example Retail',
  '',
  'Welcome! This dataset contains anonymised widget orders.',
  '',
  '## orders',
  '',
  '| Column | Description |',
  '| --- | --- |',
  '| `region` | Sales region the order was booked in. |',
  '| `sales` | Gross order value in the seller currency, before refunds. |',
].join('\n')

/** Fake pinned CLI: writes `dataset-metadata.json` exactly as kaggle 2.2.4 does. */
async function writeMetadataStub(metadata: unknown): Promise<string> {
  const executable = join(directory, 'fake-kaggle-metadata')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const index = process.argv.indexOf('-p'); const destination = process.argv[index + 1];
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'dataset-metadata.json'), ${JSON.stringify(
      JSON.stringify(metadata),
    )});
`,
    'utf8',
  )
  await chmod(executable, 0o755)
  return executable
}

function unverifiedMetadata(description: string): unknown {
  return {
    info: {
      datasetSlug: 'widgets',
      title: 'Widgets',
      versionNumber: Number(VERSION),
      licenses: [{ name: 'CC0' }],
      subtitle: 'Anonymised widget orders',
      keywords: ['retail', 'tabular'],
      description,
    },
  }
}

it('quotes the publisher description/dictionary as labelled, unverified metadata', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)
  const executable = await writeMetadataStub(unverifiedMetadata(PUBLISHER_DESCRIPTION))

  const result = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: executable,
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })

  // (a) It reaches the model-facing payload, labelled per entry.
  const publisher = result.publisherSupplied
  expect(publisher?.provenance).toBe('publisher-supplied')
  expect(publisher?.verification).toBe('unverified')
  expect(publisher?.caveat).toMatch(/not an approved definition/)
  expect(publisher?.sources).toEqual(['kaggle-cli-datasets-metadata'])
  expect(publisher?.subtitle).toBe('Anonymised widget orders')
  expect(publisher?.keywords).toEqual(['retail', 'tabular'])
  expect(publisher?.descriptionExcerpt).toContain('# Widgets by Example Retail')
  expect(publisher?.columnNotes.map((entry) => entry.column)).toEqual(['region', 'sales'])
  for (const entry of publisher!.columnNotes) {
    expect(entry.provenance).toBe('publisher-supplied')
    expect(entry.verification).toBe('unverified')
    expect(entry.tableId).toBe('orders')
  }
  expect(publisher?.columnDictionaryTotal).toBe(2)

  const store = new MetadataStore(workspace.catalogPath)
  try {
    const pin = store.getWorkspaceSourcePin(result.pinId!)
    // The analyst review can read the full stored block.
    expect(pin?.recipe.publisherSupplied?.description?.text).toContain(
      'Gross order value in the seller currency',
    )
    expect(pin?.recipe.publisherSupplied?.columnDictionary).toHaveLength(2)

    // (c) Observed facts stay clean: no publisher text is written into the
    // proposed columns, and the labelled block is a sibling of `tables`.
    for (const table of pin!.recipe.tables) {
      for (const column of table.columns) {
        expect(Object.keys(column).sort()).toEqual(['name', 'sourceName', 'type'])
      }
    }
    expect(Object.keys(pin!.recipe)).toContain('publisherSupplied')

    // (b) Nothing was auto-created or auto-approved from publisher text.
    expect(store.listAliasCandidates()).toEqual([])
    expect(store.listStructureCandidates()).toEqual([])
  } finally {
    store.close()
  }
})

it('bounds the model-facing publisher block while the analyst block keeps the full text', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)
  const longTail = 'lorem ipsum '.repeat(900) // ~10.8k characters after the table
  const executable = await writeMetadataStub(
    unverifiedMetadata(`${PUBLISHER_DESCRIPTION}\n\n## Notes\n\n${longTail}`),
  )

  const result = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: executable,
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })

  expect(result.publisherSupplied?.descriptionTruncated).toBe(true)
  expect(Array.from(result.publisherSupplied?.descriptionExcerpt ?? '').length).toBeLessThanOrEqual(
    MAX_MODEL_DESCRIPTION_CHARS,
  )
  expect(result.publisherSupplied?.descriptionChars).toBeGreaterThan(10_000)

  const store = new MetadataStore(workspace.catalogPath)
  try {
    const stored = store.getWorkspaceSourcePin(result.pinId!)?.recipe.publisherSupplied
    expect(stored?.description?.truncated).toBe(true)
    expect(Array.from(stored?.description?.text ?? '').length).toBeLessThanOrEqual(
      MAX_PUBLISHER_DESCRIPTION_CHARS,
    )
    expect(stored?.notes.join(' ')).toMatch(/truncated to 8000 characters/)
    expect(Array.from(result.publisherSupplied?.descriptionExcerpt ?? '').length).toBeLessThan(
      Array.from(stored?.description?.text ?? '').length,
    )
  } finally {
    store.close()
  }
})

it('omits the publisher block entirely when Kaggle returns no metadata', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)

  const result = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })

  expect(result.provenanceStatus).toBe('metadata-unavailable')
  // No payload was readable, so nothing is quoted — an empty block would
  // wrongly imply the publisher supplied nothing.
  expect(result.publisherSupplied).toBeUndefined()

  const store = new MetadataStore(workspace.catalogPath)
  try {
    expect(store.getWorkspaceSourcePin(result.pinId!)?.recipe.publisherSupplied).toBeUndefined()
  } finally {
    store.close()
  }
})

it('still labels publisher text when only the public view payload is readable', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)

  const result = await previewIngestSource({
    slug: SLUG,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: archivePath,
    fetchImpl: (async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        ref: SLUG,
        title: 'Widgets',
        currentVersionNumber: VERSION,
        licenseName: 'CC0',
        description: PUBLISHER_DESCRIPTION,
      }),
    })) as unknown as typeof fetch,
  })

  expect(result.sourceVersion).toBe(VERSION)
  expect(result.publisherSupplied?.sources).toEqual(['kaggle-view-api'])
  expect(result.publisherSupplied?.verification).toBe('unverified')
  expect(result.publisherSupplied?.columnNotes.map((entry) => entry.column)).toEqual([
    'region',
    'sales',
  ])
})

it('re-surfaces the stored, still-labelled publisher block on an already-reviewed slug', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const archivePath = await buildFixtureArchive(directory)
  const executable = await writeMetadataStub(unverifiedMetadata(PUBLISHER_DESCRIPTION))

  const first = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: executable,
    actorId: 'analyst-session',
    localArchivePath: archivePath,
  })
  const store = new MetadataStore(workspace.catalogPath)
  try {
    store.setWorkspaceSourcePinStatus(first.pinId!, 'approved', 1)
  } finally {
    store.close()
  }

  const second = await previewIngestSource({
    slug: SLUG,
    kaggleExecutable: executable,
    workspace,
    actorId: 'analyst-session',
  })
  expect(second.alreadyReviewed).toBe(true)
  expect(second.publisherSupplied?.verification).toBe('unverified')
  expect(second.publisherSupplied?.columnNotes.map((entry) => entry.column)).toEqual([
    'region',
    'sales',
  ])
})

it('reuses an existing candidate instead of creating a second pending review', async () => {
  // Live WebUI finding (dhoogla/unswnb15): the scoped schema view fell through the
  // approved-pin short-circuit and created its own candidate pin, so one dataset
  // produced TWO pending column reviews and the analyst could approve the narrower
  // one. A re-preview must reuse the candidate already under review.
  const workspace = resolveWorkspacePaths(directory)
  const destinationDir = downloadDestinationForSlug(workspace.sourcesDir, SLUG, VERSION)
  await mkdir(destinationDir, { recursive: true })
  await buildFixtureArchive(destinationDir)

  const first = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: destinationDir + '/source.zip',
  })
  expect(first.pinId).toMatch(/^pin_/)

  // A plain re-preview reuses it...
  const second = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: destinationDir + '/source.zip',
  })
  expect(second.pinId).toBe(first.pinId)
  // Reuse is reported, not silent: it pins whatever version the candidate already
  // carried, so an omitted sourceVersion cannot pick up a newer Kaggle release while
  // that candidate is pending. The caller can only ask for one if it is told.
  expect(second.reusedCandidate, 'a reused candidate must say so').toBe(true)
  expect(second.sourceVersion).toBe(first.sourceVersion)
  // Every column of the reused proposal still carries a non-empty reason: the recipe
  // does not persist the sampling that produced the types, so the reason says that
  // instead of rendering as a blank "why this type" cell. An empty string here is what
  // made the wide-table gate fail in CI (`columns.every((column) => Boolean(column.reason))`).
  const reusedColumns = (second.tables ?? []).flatMap((table) => table.columns)
  expect(reusedColumns.length).toBeGreaterThan(0)
  expect(reusedColumns.filter((column) => !column.reason)).toEqual([])
  expect(reusedColumns[0]!.reason).toMatch(/reused proposal/i)
  expect(first.reusedCandidate, 'the first, freshly proposed candidate is not a reuse').toBe(
    undefined,
  )

  // ...and so does a scoped/paged call, with paging still applied to the reuse.
  const scoped = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: '/bin/false',
    actorId: 'analyst-session',
    localArchivePath: destinationDir + '/source.zip',
    limit: 1,
    offset: 0,
  })
  expect(scoped.pinId).toBe(first.pinId)
  expect(scoped.tables ?? []).toHaveLength(1)

  const store = new MetadataStore(workspace.catalogPath)
  try {
    const candidates = store
      .listWorkspaceSourcePins(SLUG)
      .filter((pin) => pin.status === 'candidate')
    expect(candidates, 'exactly one candidate pin must exist').toHaveLength(1)
  } finally {
    store.close()
  }
})
