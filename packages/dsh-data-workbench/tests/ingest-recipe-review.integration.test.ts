import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import type { IngestRecipe } from 'dsh-data-core/recipes/types'
import {
  handleIngestRecipeGetRequest,
  handleIngestRecipeReviewRequest,
} from '../src/ingest-recipe-review.js'

let directory: string
let catalogPath: string
let pinId: string

const GENERIC_RECIPE: IngestRecipe = {
  datasetId: 'generic_widgets',
  recipeHash: 'workspace-csv-v1-abc123',
  importerVersion: '0.1.0',
  license: null,
  sourceUrl: 'https://www.kaggle.com/datasets/someone/widgets',
  tables: [
    {
      sourceFile: 'widgets.csv',
      tableId: 'widgets',
      columns: [{ name: 'region', sourceName: 'Region', type: 'VARCHAR' }],
    },
  ],
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-ingest-recipe-review-'))
  catalogPath = join(directory, 'catalog.sqlite')
  const store = new MetadataStore(catalogPath)
  pinId = store.createWorkspaceSourcePin({
    slug: 'someone/widgets',
    sourceVersion: '1',
    recipe: GENERIC_RECIPE,
    actorId: 'analyst-session',
  }).pinId
  store.close()
})

afterEach(async () => rm(directory, { recursive: true, force: true }))

it('requires same-origin authenticated UI intent and applies analyst review', async () => {
  const crossOrigin = await handleIngestRecipeReviewRequest(
    new Request('http://localhost/api/analyst/ingest-recipes/review', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expectedRevision: 1, pinId, status: 'approved' }),
    }),
    catalogPath,
  )
  expect(crossOrigin.status).toBe(403)

  const approved = await handleIngestRecipeReviewRequest(
    new Request('http://localhost/api/analyst/ingest-recipes/review', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expectedRevision: 1, pinId, status: 'approved' }),
    }),
    catalogPath,
  )
  expect(approved.status).toBe(200)
  expect(await approved.json()).toMatchObject({
    pinId,
    slug: 'someone/widgets',
    datasetId: 'generic_widgets',
    status: 'approved',
  })

  const store = new MetadataStore(catalogPath)
  expect(store.listWorkspaceSourcePins('someone/widgets')[0]?.status).toBe('approved')
  // This authenticated Studio approval route is the only place
  // "analyst approved" is ever recorded, with actor 'analyst-ui' — never
  // 'agent' — so it is structurally distinguishable from an agent's own
  // preview_ingest_source suggestion.
  const trail = store.listWorkflowTrail({ datasetVersionId: 'generic_widgets' })
  expect(trail).toHaveLength(1)
  expect(trail[0]).toMatchObject({
    milestone: 'analyst_approved',
    actor: 'analyst-ui',
    datasetVersionId: 'generic_widgets',
    receiptId: pinId,
  })
  store.close()
})

it('does not record an analyst_approved milestone on revoke', async () => {
  await handleIngestRecipeReviewRequest(
    new Request('http://localhost/api/analyst/ingest-recipes/review', {
      method: 'POST',
      headers: { host: 'localhost', origin: 'http://localhost' },
      body: JSON.stringify({ expectedRevision: 1, pinId, status: 'revoked' }),
    }),
    catalogPath,
  )
  const store = new MetadataStore(catalogPath)
  expect(store.listWorkflowTrail({ datasetVersionId: 'generic_widgets' })).toHaveLength(0)
  store.close()
})

it('rejects an invalid pin id and an unknown review status', async () => {
  const badId = await handleIngestRecipeReviewRequest(
    new Request('http://localhost/api/analyst/ingest-recipes/review', {
      method: 'POST',
      headers: { host: 'localhost', origin: 'http://localhost' },
      body: JSON.stringify({ expectedRevision: 1, pinId: 'not-a-pin', status: 'approved' }),
    }),
    catalogPath,
  )
  expect(badId.status).toBe(400)

  const badStatus = await handleIngestRecipeReviewRequest(
    new Request('http://localhost/api/analyst/ingest-recipes/review', {
      method: 'POST',
      headers: { host: 'localhost', origin: 'http://localhost' },
      body: JSON.stringify({ expectedRevision: 1, pinId, status: 'candidate' }),
    }),
    catalogPath,
  )
  expect(badStatus.status).toBe(400)
})

it('returns 404 for an unknown pin id', async () => {
  const response = await handleIngestRecipeReviewRequest(
    new Request('http://localhost/api/analyst/ingest-recipes/review', {
      method: 'POST',
      headers: { host: 'localhost', origin: 'http://localhost' },
      body: JSON.stringify({
        expectedRevision: 1,
        pinId: 'pin_0000000000000000',
        status: 'approved',
      }),
    }),
    catalogPath,
  )
  expect(response.status).toBe(404)
})

it('revokes a pin so it can no longer resolve for ingest', async () => {
  const response = await handleIngestRecipeReviewRequest(
    new Request('http://localhost/api/analyst/ingest-recipes/review', {
      method: 'POST',
      headers: { host: 'localhost', origin: 'http://localhost' },
      body: JSON.stringify({ expectedRevision: 1, pinId, status: 'revoked' }),
    }),
    catalogPath,
  )
  expect(response.status).toBe(200)
  const store = new MetadataStore(catalogPath)
  expect(store.listWorkspaceSourcePins('someone/widgets')[0]?.status).toBe('revoked')
  store.close()
})

it('GET returns the full stored candidate (tables included) for a same-origin request', async () => {
  const response = await handleIngestRecipeGetRequest(
    new Request(`http://localhost/api/analyst/ingest-recipes?pinId=${pinId}`, {
      headers: { host: 'localhost', origin: 'http://localhost' },
    }),
    catalogPath,
  )
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body).toMatchObject({
    pinId,
    slug: 'someone/widgets',
    datasetId: 'generic_widgets',
    status: 'candidate',
  })
  expect(body.tables).toEqual(GENERIC_RECIPE.tables)
  expect(body.sourceUrl).toBe(GENERIC_RECIPE.sourceUrl)
  expect(body.observedLicense).toBe(GENERIC_RECIPE.license)
  expect(body.sourceVersion).toBeTruthy()
  expect(body.reviewedAt).toBeNull()
})

it('GET rejects a cross-origin request with 403', async () => {
  const response = await handleIngestRecipeGetRequest(
    new Request(`http://localhost/api/analyst/ingest-recipes?pinId=${pinId}`, {
      headers: { host: 'localhost', origin: 'http://evil.example' },
    }),
    catalogPath,
  )
  expect(response.status).toBe(403)
})

it('GET allows authenticated loopback fetch when Origin is omitted (Chromium same-origin GET)', async () => {
  const response = await handleIngestRecipeGetRequest(
    new Request(`http://localhost/api/analyst/ingest-recipes?pinId=${pinId}`, {
      headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
    }),
    catalogPath,
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ pinId, status: 'candidate' })
})

it('GET rejects explicit cross-site Sec-Fetch-Site even without Origin', async () => {
  const response = await handleIngestRecipeGetRequest(
    new Request(`http://localhost/api/analyst/ingest-recipes?pinId=${pinId}`, {
      headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
    }),
    catalogPath,
  )
  expect(response.status).toBe(403)
})

it('GET rejects a malformed pin id with 400', async () => {
  const response = await handleIngestRecipeGetRequest(
    new Request('http://localhost/api/analyst/ingest-recipes?pinId=not-a-pin', {
      headers: { host: 'localhost', origin: 'http://localhost' },
    }),
    catalogPath,
  )
  expect(response.status).toBe(400)
})

it('GET returns 404 for an unknown pin id', async () => {
  const response = await handleIngestRecipeGetRequest(
    new Request('http://localhost/api/analyst/ingest-recipes?pinId=pin_0000000000000000', {
      headers: { host: 'localhost', origin: 'http://localhost' },
    }),
    catalogPath,
  )
  expect(response.status).toBe(404)
})

it('rejects stale approval after another tab edits and never approves a revoked proposal', async () => {
  const other = new MetadataStore(catalogPath)
  other.setWorkspaceSourcePinRecipe(pinId, { ...GENERIC_RECIPE, recipeHash: 'changed' }, 1)
  other.close()
  const review = (expectedRevision: number, status: string = 'approved') =>
    handleIngestRecipeReviewRequest(
      new Request('http://localhost/api/analyst/ingest-recipes/review', {
        method: 'POST',
        headers: { origin: 'http://localhost', host: 'localhost' },
        body: JSON.stringify({ pinId, status, expectedRevision }),
      }),
      catalogPath,
    )
  expect((await review(1)).status).toBe(409)
  expect((await review(2, 'revoked')).status).toBe(200)
  expect((await review(3)).status).toBe(409)
  const store = new MetadataStore(catalogPath)
  expect(store.getWorkspaceSourcePin(pinId)).toMatchObject({ revision: 3, status: 'revoked' })
  store.close()
})

it('requires a revision even for an otherwise valid approval', async () => {
  const response = await handleIngestRecipeReviewRequest(
    new Request('http://localhost/api/analyst/ingest-recipes/review', {
      method: 'POST',
      headers: { origin: 'http://localhost', host: 'localhost' },
      body: JSON.stringify({ pinId, status: 'approved' }),
    }),
    catalogPath,
  )
  expect(response.status).toBe(400)
})
