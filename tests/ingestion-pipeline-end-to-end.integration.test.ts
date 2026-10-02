/**
 * End-to-end test of the underlying pipeline seams, not the `ingest_dataset`
 * tool path itself (see ingest-pipeline.integration.test.ts for that, driven
 * through `runIngestFromArchive`). This test builds a zip fixture from the
 * synthetic retail CSV (standing in for a Kaggle download's archive shape)
 * and drives the lower-level primitives directly: archive-safety
 * validation/extraction (dsh-data-kaggle) -> trusted CSV staging load with
 * quarantine profiling (dsh-data-duckdb) -> checkpoint/close/read-only reopen
 * -> atomic dataset-version publication (dsh-data-core's MetadataStore) ->
 * a fixed authorized query against the published, read-only dataset. No
 * network, no credentials, no model call.
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import * as yazl from 'yazl'
import { expect, it } from 'vitest'
import { safeExtractZip } from '../packages/dsh-data-kaggle/dist/archive-safety.js'
import { loadCsvIntoStaging } from '../packages/dsh-data-duckdb/dist/staging-loader.js'
import { runFixedQuery } from '../packages/dsh-data-duckdb/dist/fixed-query.js'
import { MetadataStore } from '../packages/dsh-data-core/dist/metadata-store.js'

async function buildFixtureArchive(destination: string): Promise<string> {
  const fixtureCsvPath = fileURLToPath(new URL('./fixtures/retail.csv', import.meta.url))
  const csvBytes = await readFile(fixtureCsvPath)
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(csvBytes, 'retail.csv')
  const archivePath = join(destination, 'source.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return archivePath
}

it('runs archive validation -> extraction -> staging load -> publish -> authorized query end to end', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-p1-pipeline-'))
  try {
    // 1. "Download": a zip archive shaped like a Kaggle dataset download.
    const archivePath = await buildFixtureArchive(directory)

    // 2. Validate and extract (never trusting the archive before checking it).
    const sourcesDir = join(directory, 'sources')
    const extracted = await safeExtractZip(archivePath, sourcesDir)
    expect(extracted).toEqual([
      { name: 'retail.csv', bytes: expect.any(Number), sha256: expect.any(String) },
    ])
    const csvPath = join(sourcesDir, 'retail.csv')

    // 3. Load into a writable staging DuckDB with quarantine + null profiling.
    const stagingPath = join(directory, 'staging.duckdb')
    const writer = await DuckDBInstance.create(stagingPath)
    const writerConnection = await writer.connect()
    let loadResult
    try {
      loadResult = await loadCsvIntoStaging(writerConnection, {
        csvPath,
        tableId: 'retail',
        columns: [
          { name: 'line_id', type: 'VARCHAR' },
          { name: 'customer_id', type: 'VARCHAR' },
          { name: 'order_date', type: 'DATE' },
          { name: 'region', type: 'VARCHAR' },
          { name: 'amount', type: 'DECIMAL(18,2)' },
        ],
      })
      await writerConnection.run('CHECKPOINT')
    } finally {
      writerConnection.closeSync()
      writer.closeSync()
    }
    expect(loadResult.rowCount).toBe(3)
    expect(loadResult.rejectedRows).toEqual([])

    // 4. Publish an immutable dataset version through the metadata coordinator,
    //    only after the staging artifact is fully written and closed.
    const store = new MetadataStore(join(directory, 'catalog.sqlite'))
    try {
      const job = store.createImportJob({
        idempotencyKey: 'pipeline-test',
        slug: 'test/fixture-retail',
      })
      store.updateImportJobStatus(job.jobId, 'downloading')
      store.updateImportJobStatus(job.jobId, 'validating')
      store.updateImportJobStatus(job.jobId, 'loading')
      store.updateImportJobStatus(job.jobId, 'profiling')
      store.updateImportJobStatus(job.jobId, 'ready', { datasetVersionId: 'retail-fixture-v1' })
      store.publishDatasetVersion({
        contractVersion: 1,
        datasetId: 'retail-fixture',
        datasetVersionId: 'retail-fixture-v1',
        source: {
          slug: 'test/fixture-retail',
          version: '1',
          url: 'https://example.invalid/test-fixture',
          retrievedAt: new Date().toISOString(),
          license: null,
        },
        files: extracted.map((file) => ({
          name: file.name,
          sha256: file.sha256,
          bytes: file.bytes,
          format: 'csv',
        })),
        recipeHash: 'test-recipe-v1',
        importerVersion: '0.1.0',
        tables: [
          {
            id: 'retail',
            sourceFile: 'retail.csv',
            rows: loadResult.rowCount,
            rejectedRows: loadResult.rejectedRows.length,
          },
        ],
      })

      const published = store.getCurrentDatasetVersion('retail-fixture')
      expect(published?.datasetVersionId).toBe('retail-fixture-v1')
      expect(published?.tables[0]?.rows).toBe(3)
    } finally {
      store.close()
    }

    // 5. Reopen the staging artifact read-only (the published, queryable
    //    dataset) and run a fixed authorized query against it.
    const reader = await DuckDBInstance.create(stagingPath, {
      access_mode: 'READ_ONLY',
      enable_external_access: 'false',
    })
    const readerConnection = await reader.connect()
    try {
      const result = await runFixedQuery(
        readerConnection,
        'SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region ORDER BY revenue DESC, region',
      )
      expect(result.rows).toEqual([
        ['North', '80.00'],
        ['South', '50.00'],
      ])
      // The reopened dataset is still genuinely read-only.
      await expect(readerConnection.run('DELETE FROM retail')).rejects.toThrow()
    } finally {
      readerConnection.closeSync()
      reader.closeSync()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
