import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { saveAnalysisRevision } from 'dsh-data-core/analysis-store'
import {
  carryInterpretationReview,
  interpretationApprovedForExport,
} from 'dsh-data-core/interpretation-review'
import type { AnalysisRevision } from 'dsh-data-core/contracts'
import { handleInterpretationReviewRequest } from '../src/interpretation-review.js'
import { renderAnalysisFragment } from '../src/ui-fragments.js'

let directory: string
let catalogPath: string
let analysisId: string

const chart = {
  mark: 'bar' as const,
  title: 'Revenue',
  x: 'region',
  y: 'amount',
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-interpretation-review-'))
  catalogPath = join(directory, 'catalog.sqlite')
  const saved = await saveAnalysisRevision(catalogPath, {
    datasetVersionId: 'dv_1',
    semanticRevisionId: 'sem_1',
    question: 'Revenue by region',
    query: {
      datasetVersionId: 'dv_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT region, amount FROM retail',
      parameters: [],
    },
    resultId: 'res_abc123',
    chart,
    artifactIds: ['art_1'],
    interpretation: { findings: ['North led'] },
  })
  analysisId = saved.analysisId
})

afterEach(async () => rm(directory, { recursive: true, force: true }))

it('requires same-origin and rejects stale revisions', async () => {
  const denied = await handleInterpretationReviewRequest(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { origin: 'https://evil.example', host: 'localhost' },
      body: JSON.stringify({
        analysisId,
        expectedRevision: 1,
        status: 'approved',
        findings: ['ok'],
      }),
    }),
    catalogPath,
  )
  expect(denied.status).toBe(403)

  const stale = await handleInterpretationReviewRequest(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { origin: 'http://localhost', host: 'localhost' },
      body: JSON.stringify({
        analysisId,
        expectedRevision: 99,
        status: 'approved',
        findings: ['ok'],
      }),
    }),
    catalogPath,
  )
  expect(stale.status).toBe(409)
})

it('ignores forged interpretationReview on the body and sets approval from status only', async () => {
  const response = await handleInterpretationReviewRequest(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { origin: 'http://localhost', host: 'localhost' },
      body: JSON.stringify({
        analysisId,
        expectedRevision: 1,
        status: 'rejected',
        findings: ['Should stay rejected'],
        interpretationReview: { status: 'approved', resultId: 'res_forged' },
        includeInterpretation: true,
      }),
    }),
    catalogPath,
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    interpretationReview: { status: string; resultId: string }
  }
  expect(body.interpretationReview.status).toBe('rejected')
  expect(body.interpretationReview.resultId).toBe('res_abc123')
})

it('persists approved interpretation against the current result identity', async () => {
  const response = await handleInterpretationReviewRequest(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { origin: 'http://localhost', host: 'localhost' },
      body: JSON.stringify({
        analysisId,
        expectedRevision: 1,
        status: 'approved',
        findings: ['North led with scope disclosed'],
        caveats: ['Filtered result'],
      }),
    }),
    catalogPath,
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    revision: number
    interpretationReview: { status: string; resultId: string }
  }
  expect(body.revision).toBe(2)
  expect(body.interpretationReview).toMatchObject({
    status: 'approved',
    resultId: 'res_abc123',
  })
})

it('carries approval on style-only changes and invalidates when resultId changes', () => {
  const previous: AnalysisRevision = {
    contractVersion: 1,
    analysisId: 'ana_1',
    revision: 2,
    datasetVersionId: 'dv_1',
    semanticRevisionId: 'sem_1',
    question: 'q',
    query: {
      datasetVersionId: 'dv_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_1',
    chart,
    artifactIds: ['art_1'],
    createdAt: '2026-09-18T00:00:00.000Z',
    interpretation: { findings: ['A'] },
    interpretationReview: {
      status: 'approved',
      resultId: 'res_1',
      reviewedAt: '2026-09-18T00:00:00.000Z',
    },
  }
  expect(
    carryInterpretationReview(previous, {
      resultId: 'res_1',
      interpretation: { findings: ['A'] },
    })?.status,
  ).toBe('approved')
  expect(
    carryInterpretationReview(previous, {
      resultId: 'res_2',
      interpretation: { findings: ['A'] },
    }),
  ).toBeUndefined()
  expect(
    interpretationApprovedForExport({
      ...previous,
      interpretationReview: { status: 'approved', resultId: 'res_other' },
    }),
  ).toBe(false)
})

it('renders facts-only export controls until interpretation is approved', () => {
  const analysis: AnalysisRevision = {
    contractVersion: 1,
    analysisId: 'ana_1',
    revision: 1,
    datasetVersionId: 'dv_1',
    semanticRevisionId: 'sem_1',
    question: 'q',
    query: {
      datasetVersionId: 'dv_1',
      semanticRevisionId: 'sem_1',
      sql: 'SELECT 1',
      parameters: [],
    },
    resultId: 'res_1',
    chart,
    artifactIds: ['art_1'],
    createdAt: '2026-09-18T00:00:00.000Z',
    interpretation: { findings: ['Draft'] },
  }
  const html = renderAnalysisFragment(analysis, 'v1')
  expect(html).toContain('Generated interpretation')
  expect(html).toContain('Facts-only export')
  expect(html).not.toContain('Include approved interpretation')

  const approved = renderAnalysisFragment(
    {
      ...analysis,
      interpretationReview: { status: 'approved', resultId: 'res_1' },
    },
    'v1',
  )
  expect(approved).toContain('Include approved interpretation')
})
