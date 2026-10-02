import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { handleLearningReviewRequest } from '../src/learning-review.js'

let directory: string
let catalogPath: string
let exampleId: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-learning-review-'))
  catalogPath = join(directory, 'catalog.sqlite')
  const store = new MetadataStore(catalogPath)
  exampleId = store.createLearningExample({
    analysisId: 'ana_abc123',
    analysisRevision: 1,
    datasetId: 'superstore',
    datasetVersionId: 'superstore-v1',
    schemaFingerprint: 'recipe-v1',
    semanticRevisionId: 'sem-superstore-v1',
    question: 'Sales by region',
    correctedSql: 'SELECT region, SUM(sales) FROM orders GROUP BY region',
    actorId: 'session',
  }).exampleId
  store.close()
})

afterEach(async () => rm(directory, { recursive: true, force: true }))

it('requires same-origin analyst action and persists approval', async () => {
  const denied = await handleLearningReviewRequest(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { origin: 'https://evil.example', host: 'localhost' },
      body: JSON.stringify({ exampleId, status: 'approved' }),
    }),
    catalogPath,
  )
  expect(denied.status).toBe(403)

  const response = await handleLearningReviewRequest(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { origin: 'http://localhost', host: 'localhost' },
      body: JSON.stringify({ exampleId, status: 'approved' }),
    }),
    catalogPath,
  )
  expect(response.status).toBe(200)
  const store = new MetadataStore(catalogPath)
  expect(
    store.listCompatibleLearningExamples({
      datasetId: 'superstore',
      schemaFingerprint: 'recipe-v1',
      semanticRevisionId: 'sem-superstore-v1',
    }),
  ).toHaveLength(1)
  store.close()
})
