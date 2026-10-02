/**
 * Operator ingest coordinator: archive (standing in for a completed download)
 * → optional encoding normalize → staging load → publish → fixed query.
 * No network; uses the same library path the CLI and later tools will call.
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { RETAIL_FIXTURE_RECIPE } from 'dsh-data-core/recipes/retail-fixture'
import * as yazl from 'yazl'
import { expect, it } from 'vitest'
import { runFixedQuery } from '../src/fixed-query.js'
import {
  assertPublicationQuality,
  publishPendingAdaptation,
  runIngestFromArchive,
} from '../src/ingest-pipeline.js'

const FIXED_QUERY =
  'SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region ORDER BY revenue DESC, region'

const FIXED_QUERY_ROWS = [
  ['North', '80.00'],
  ['South', '50.00'],
]

async function buildArchiveFromCsv(destination: string, csvBytes: Buffer): Promise<string> {
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(csvBytes, 'retail.csv')
  const archivePath = join(destination, 'source.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return archivePath
}

async function buildFixtureArchive(destination: string): Promise<string> {
  const fixtureCsvPath = fileURLToPath(
    new URL('../../../tests/fixtures/retail.csv', import.meta.url),
  )
  return buildArchiveFromCsv(destination, await readFile(fixtureCsvPath))
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function queryPublished(datasetPath: string): Promise<unknown[][]> {
  const reader = await DuckDBInstance.create(datasetPath, {
    access_mode: 'READ_ONLY',
    enable_external_access: 'false',
  })
  const connection = await reader.connect()
  try {
    const query = await runFixedQuery(connection, FIXED_QUERY)
    return query.rows
  } finally {
    connection.closeSync()
    reader.closeSync()
  }
}

it('ingests a local archive through the coordinator and publishes a queryable version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ingest-pipeline-'))
  try {
    const archivePath = await buildFixtureArchive(directory)
    const result = await runIngestFromArchive({
      archivePath,
      workspaceDir: directory,
      catalogPath: join(directory, 'catalog.sqlite'),
      recipe: RETAIL_FIXTURE_RECIPE,
      slug: 'test/fixture-retail',
      sourceVersion: '1',
      idempotencyKey: 'ingest-pipeline-test',
    })

    expect(result.datasetId).toBe('retail-fixture')
    expect(result.datasetVersionId).toMatch(/^retail-fixture-/)
    expect(result.tables[0]).toMatchObject({ id: 'retail', rows: 3, rejectedRows: 0 })

    const store = new MetadataStore(join(directory, 'catalog.sqlite'))
    try {
      const current = store.getCurrentDatasetVersion('retail-fixture')
      expect(current?.datasetVersionId).toBe(result.datasetVersionId)
      expect(current?.tables[0]?.rows).toBe(3)
    } finally {
      store.close()
    }

    expect(await queryPublished(result.datasetPath)).toEqual(FIXED_QUERY_ROWS)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('does not overwrite a published dataset when re-ingesting the same version under a new idempotency key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ingest-idempotent-'))
  try {
    const archivePath = await buildFixtureArchive(directory)
    const first = await runIngestFromArchive({
      archivePath,
      workspaceDir: directory,
      catalogPath: join(directory, 'catalog.sqlite'),
      recipe: RETAIL_FIXTURE_RECIPE,
      slug: 'test/fixture-retail',
      sourceVersion: '1',
      idempotencyKey: 'ingest-idempotent-first',
    })

    const shaBefore = await sha256File(first.datasetPath)
    const rowsBefore = await queryPublished(first.datasetPath)

    const second = await runIngestFromArchive({
      archivePath,
      workspaceDir: directory,
      catalogPath: join(directory, 'catalog.sqlite'),
      recipe: RETAIL_FIXTURE_RECIPE,
      slug: 'test/fixture-retail',
      sourceVersion: '1',
      idempotencyKey: 'ingest-idempotent-second',
    })

    expect(second.datasetVersionId).toBe(first.datasetVersionId)
    expect(second.datasetPath).toBe(first.datasetPath)
    expect(second.tables).toEqual(first.tables)
    expect(await sha256File(first.datasetPath)).toBe(shaBefore)
    expect(await queryPublished(first.datasetPath)).toEqual(rowsBefore)
    expect(rowsBefore).toEqual(FIXED_QUERY_ROWS)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects publication when staging produces rejected rows and leaves no published version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ingest-quality-'))
  try {
    const messyCsv = Buffer.from(
      'line_id,customer_id,order_date,region,amount\n' +
        '001,0007,2024-01-01,North,100.00\n' +
        '002,0008,2024-01-02,South,not-a-number\n' +
        '003,0007,2024-02-01,North,-20.00\n',
      'utf8',
    )
    const archivePath = await buildArchiveFromCsv(directory, messyCsv)

    await expect(
      runIngestFromArchive({
        archivePath,
        workspaceDir: directory,
        catalogPath: join(directory, 'catalog.sqlite'),
        recipe: RETAIL_FIXTURE_RECIPE,
        slug: 'test/fixture-retail',
        sourceVersion: '1',
        idempotencyKey: 'ingest-quality-reject',
      }),
    ).rejects.toThrow(/reject/i)

    const profilingPath = join(directory, 'staging', 'profiling.json')
    const profiling = JSON.parse(await readFile(profilingPath, 'utf8')) as {
      tables: Array<{ id: string; rows: number; rejectedRows: number }>
    }
    expect(profiling.tables[0]).toMatchObject({
      id: 'retail',
      rows: 2,
      rejectedRows: 1,
    })

    const store = new MetadataStore(join(directory, 'catalog.sqlite'))
    try {
      expect(store.getCurrentDatasetVersion('retail-fixture')).toBeUndefined()
    } finally {
      store.close()
    }

    const datasetVersionId = `${RETAIL_FIXTURE_RECIPE.datasetId}-v1-${createHash('sha256')
      .update(`${RETAIL_FIXTURE_RECIPE.datasetId}\0${'1'}\0${RETAIL_FIXTURE_RECIPE.recipeHash}`)
      .digest('hex')
      .slice(0, 12)}`
    await expect(
      access(join(directory, 'datasets', datasetVersionId, 'dataset.duckdb')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('pauses raw_then_typed on material cast-nulls then publishes after confirm', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ingest-adaptive-'))
  try {
    const messyCsv = Buffer.from(
      'line_id,customer_id,order_date,region,amount\n' +
        '001,0007,2024-01-01,North,100.00\n' +
        '002,0008,2024-01-02,South,not-a-number\n' +
        '003,0007,2024-02-01,North,-20.00\n',
      'utf8',
    )
    const archivePath = await buildArchiveFromCsv(directory, messyCsv)
    const recipe = {
      ...RETAIL_FIXTURE_RECIPE,
      recipeHash: 'retail-fixture-adaptive-v1',
      loadStrategy: 'raw_then_typed' as const,
    }
    const catalogPath = join(directory, 'catalog.sqlite')
    const paused = await runIngestFromArchive({
      archivePath,
      workspaceDir: directory,
      catalogPath,
      recipe,
      slug: 'test/fixture-retail',
      sourceVersion: 'adaptive-1',
      idempotencyKey: 'ingest-adaptive-v1',
    })

    expect(paused.status).toBe('needs-input')
    expect(paused.materiality?.material).toBe(true)
    expect(paused.tables[0]?.castNullCounts?.amount).toBe(1)

    const store = new MetadataStore(catalogPath)
    try {
      expect(store.getImportJob(paused.jobId)?.status).toBe('needs-input')
      expect(store.getCurrentDatasetVersion('retail-fixture')).toBeUndefined()
    } finally {
      store.close()
    }

    const result = await publishPendingAdaptation({
      catalogPath,
      workspaceDir: directory,
      jobId: paused.jobId,
    })
    expect(result.status).toBe('ready')

    const reader = await DuckDBInstance.create(result.datasetPath, {
      access_mode: 'READ_ONLY',
      enable_external_access: 'false',
    })
    const connection = await reader.connect()
    try {
      const raw = await connection.runAndReadAll('SELECT amount FROM raw_retail ORDER BY line_id')
      expect(raw.getRowsJson()).toEqual([['100.00'], ['not-a-number'], ['-20.00']])
      const typed = await connection.runAndReadAll('SELECT amount FROM retail ORDER BY line_id')
      expect(typed.getRowsJson()).toEqual([['100.00'], [null], ['-20.00']])
    } finally {
      connection.closeSync()
      reader.closeSync()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('assertPublicationQuality rejects when rejectedRows exceed the max', () => {
  expect(() =>
    assertPublicationQuality([
      { id: 'retail', sourceFile: 'retail.csv', rows: 2, rejectedRows: 1 },
    ]),
  ).toThrow(/reject/i)

  expect(() =>
    assertPublicationQuality(
      [{ id: 'retail', sourceFile: 'retail.csv', rows: 2, rejectedRows: 1 }],
      { maxRejectedRows: 1 },
    ),
  ).not.toThrow()

  expect(() =>
    assertPublicationQuality(
      [{ id: 'retail', sourceFile: 'retail.csv', rows: 2, rejectedRows: 1 }],
      { acceptRejectedRows: true },
    ),
  ).not.toThrow()
})

it('assertPublicationQuality appends the recovery hint to the rejection error', () => {
  expect(() =>
    assertPublicationQuality(
      [{ id: 'retail', sourceFile: 'retail.csv', rows: 2, rejectedRows: 1 }],
      { hint: 'Re-run preview_ingest_source to obtain a raw_then_typed revision' },
    ),
  ).toThrow(/preview_ingest_source/)
})

it('cancels ingest on AbortSignal and does not publish a ready version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ingest-cancel-'))
  try {
    const archivePath = await buildFixtureArchive(directory)
    const catalogPath = join(directory, 'catalog.sqlite')
    const controller = new AbortController()
    controller.abort()
    await expect(
      runIngestFromArchive({
        archivePath,
        workspaceDir: directory,
        catalogPath,
        recipe: RETAIL_FIXTURE_RECIPE,
        slug: 'test/fixture-retail',
        sourceVersion: '1',
        idempotencyKey: 'ingest-cancel-test',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'IngestCancelledError' })

    const store = new MetadataStore(catalogPath)
    try {
      expect(store.getCurrentDatasetVersion(RETAIL_FIXTURE_RECIPE.datasetId)).toBeUndefined()
      const jobs = store.listImportJobs()
      expect(jobs.some((job) => job.status === 'cancelled')).toBe(true)
      expect(jobs.every((job) => job.status !== 'ready')).toBe(true)
    } finally {
      store.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
