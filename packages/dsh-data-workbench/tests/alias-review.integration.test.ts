import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { handleAliasBatchReviewRequest, handleAliasReviewRequest } from '../src/alias-review.js'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

it('requires same-origin authenticated UI intent and applies analyst review', async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-alias-review-'))
  const catalogPath = join(directory, 'catalog.sqlite')
  const store = new MetadataStore(catalogPath)
  const candidate = store.createAliasCandidate({
    datasetId: 'superstore',
    term: 'net revenue',
    expression: 'SUM(sales)',
    description: 'Reviewed net revenue',
    tableId: 'orders',
    actorId: 'analyst-session',
  })
  store.close()

  const crossOrigin = await handleAliasReviewRequest(
    new Request('http://localhost/api/analyst/aliases/review', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ candidateId: candidate.candidateId, status: 'approved' }),
    }),
    catalogPath,
  )
  expect(crossOrigin.status).toBe(403)

  const approved = await handleAliasReviewRequest(
    new Request('http://localhost/api/analyst/aliases/review', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ candidateId: candidate.candidateId, status: 'approved' }),
    }),
    catalogPath,
  )
  expect(approved.status).toBe(200)
  expect(await approved.json()).toMatchObject({
    candidateId: candidate.candidateId,
    status: 'approved',
  })

  const verify = new MetadataStore(catalogPath)
  expect(verify.listAliasCandidates('superstore', 'approved')).toHaveLength(1)
  verify.close()
})

it('approves or rejects multiple alias candidates in one batch review', async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-alias-batch-'))
  const catalogPath = join(directory, 'catalog.sqlite')
  const store = new MetadataStore(catalogPath)
  const first = store.createAliasCandidate({
    datasetId: 'superstore',
    term: 'net revenue',
    expression: 'SUM(sales)',
    description: 'Net revenue',
    tableId: 'orders',
    actorId: 'analyst-session',
  })
  const second = store.createAliasCandidate({
    datasetId: 'superstore',
    term: 'gross margin',
    expression: 'SUM(profit) / SUM(sales)',
    description: 'Gross margin',
    tableId: 'orders',
    actorId: 'analyst-session',
  })
  store.close()

  const response = await handleAliasBatchReviewRequest(
    new Request('http://localhost/api/analyst/aliases/review-batch', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        candidateIds: [first.candidateId, second.candidateId],
        status: 'approved',
      }),
    }),
    catalogPath,
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    reviewed: Array<{ candidateId: string; status: string }>
    failed: unknown[]
  }
  expect(body.reviewed).toHaveLength(2)
  expect(body.failed).toEqual([])

  const verify = new MetadataStore(catalogPath)
  expect(verify.listAliasCandidates('superstore', 'approved')).toHaveLength(2)
  expect(verify.listAliasCandidates('superstore', 'candidate')).toHaveLength(0)
  verify.close()
})
