/**
 * openMetadataStore recovers interrupted import jobs on coordinator open.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openMetadataStore } from '../src/catalog.js'
import { MetadataStore } from '../src/metadata-store.js'

let directory: string
let dbPath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-catalog-open-'))
  dbPath = join(directory, 'catalog.sqlite')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('openMetadataStore marks interrupted jobs failed with the default recovery message', () => {
  let stuckJobId: string
  const seed = new MetadataStore(dbPath)
  try {
    const stuck = seed.createImportJob({ idempotencyKey: 'key-stuck', slug: 'owner/dataset' })
    stuckJobId = stuck.jobId
    seed.updateImportJobStatus(stuck.jobId, 'downloading')
    seed.updateImportJobStatus(stuck.jobId, 'validating')
  } finally {
    seed.close()
  }

  const store = openMetadataStore(dbPath)
  try {
    expect(store.listInterruptedImportJobs()).toEqual([])
    const recovered = store.getImportJob(stuckJobId)
    expect(recovered?.status).toBe('failed')
    expect(recovered?.errorMessage).toBe('recovered interrupted import job on coordinator start')
  } finally {
    store.close()
  }
})
