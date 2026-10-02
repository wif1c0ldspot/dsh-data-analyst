import { expect, it } from 'vitest'
import {
  carryInterpretationReview,
  isStyleOnlyRevisionCarry,
} from '../src/interpretation-review.js'
import type { AnalysisRevision } from '../src/contracts.js'

const base: AnalysisRevision = {
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
  chart: { mark: 'bar', title: 'Revenue', x: 'a', y: 'b' },
  artifactIds: ['art_1'],
  createdAt: '2026-09-18T00:00:00.000Z',
  interpretation: { findings: ['ok'] },
  interpretationReview: {
    status: 'approved',
    resultId: 'res_1',
    reviewedAt: '2026-09-18T00:00:00.000Z',
  },
}

it('detects style-only carries when result and narrative match', () => {
  expect(
    isStyleOnlyRevisionCarry(base, { resultId: 'res_1', interpretation: { findings: ['ok'] } }),
  ).toBe(true)
  expect(
    isStyleOnlyRevisionCarry(base, {
      resultId: 'res_1',
      interpretation: { findings: ['changed'] },
    }),
  ).toBe(false)
  expect(
    carryInterpretationReview(base, { resultId: 'res_1', interpretation: { findings: ['ok'] } }),
  ).toEqual({
    status: 'approved',
    resultId: 'res_1',
    reviewedAt: '2026-09-18T00:00:00.000Z',
  })
})
