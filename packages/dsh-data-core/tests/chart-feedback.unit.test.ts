/**
 * MetadataStore persistence for analyst-facing chart-quality feedback.
 * Existence/FK
 * checks against a real artifact + analysis revision are enforced by the
 * `report_chart_issue` tool (dsh-data-workbench), not this store layer —
 * see chart-feedback-tool.integration.test.ts for that. This file proves
 * the store itself: always starts `candidate`, is listable/filterable, can
 * only advance status via an explicit call, and — the most important
 * negative check — never touches the separate `learning_examples` table
 * that backs the approved reusable-learning-evidence store.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ChartFeedbackNotFoundError, MetadataStore } from '../src/metadata-store.js'

let directory: string
let store: MetadataStore

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-chart-feedback-test-'))
  store = new MetadataStore(join(directory, 'catalog.sqlite'))
})

afterEach(async () => {
  store.close()
  await rm(directory, { recursive: true, force: true })
})

it('creates chart feedback starting as an unapproved candidate', () => {
  const feedback = store.createChartFeedback({
    artifactId: 'art_9dd789f676df4f1e',
    analysisId: 'ana_abc123',
    analysisRevision: 1,
    issueType: 'overlap',
    notes: 'Facet titles collide at the bottom edge.',
    actorId: 'session',
  })
  expect(feedback.status).toBe('candidate')
  expect(feedback.reviewedAt).toBeNull()
  expect(feedback.feedbackId).toMatch(/^cfb_[a-f0-9]{16}$/)
  expect(feedback.artifactId).toBe('art_9dd789f676df4f1e')
  expect(feedback.notes).toBe('Facet titles collide at the bottom edge.')
})

it('omits notes entirely when not provided, rather than storing an empty string', () => {
  const feedback = store.createChartFeedback({
    artifactId: 'art_1',
    analysisId: 'ana_1',
    analysisRevision: 1,
    issueType: 'wrong-orientation',
    actorId: 'session',
  })
  expect(feedback).not.toHaveProperty('notes')
})

it('lists chart feedback filtered by analysisId and status', () => {
  store.createChartFeedback({
    artifactId: 'art_1',
    analysisId: 'ana_1',
    analysisRevision: 1,
    issueType: 'clipping',
    actorId: 'session',
  })
  store.createChartFeedback({
    artifactId: 'art_2',
    analysisId: 'ana_2',
    analysisRevision: 1,
    issueType: 'excess-whitespace',
    actorId: 'session',
  })
  expect(store.listChartFeedback({ analysisId: 'ana_1' })).toHaveLength(1)
  expect(store.listChartFeedback({ status: 'candidate' })).toHaveLength(2)
  expect(store.listChartFeedback({ status: 'approved' })).toHaveLength(0)
})

it('only advances status via an explicit review call, and rejects an unknown id', () => {
  const feedback = store.createChartFeedback({
    artifactId: 'art_1',
    analysisId: 'ana_1',
    analysisRevision: 1,
    issueType: 'unreadable-legend',
    actorId: 'session',
  })
  const approved = store.setChartFeedbackStatus(feedback.feedbackId, 'approved')
  expect(approved.status).toBe('approved')
  expect(approved.reviewedAt).not.toBeNull()
  expect(() => store.setChartFeedbackStatus('cfb_0000000000000000', 'approved')).toThrow(
    ChartFeedbackNotFoundError,
  )
})

it('never writes to learning_examples — submitting chart feedback leaves approved reusable learning evidence untouched', () => {
  // Seed one genuinely approved learning example so the compatibility query
  // has something it *could* wrongly pick up if the two stores were
  // conflated.
  const example = store.createLearningExample({
    analysisId: 'ana_1',
    analysisRevision: 1,
    datasetId: 'food-ordering',
    datasetVersionId: 'food-ordering-v1',
    schemaFingerprint: 'recipe-v1',
    semanticRevisionId: 'sem-food-ordering-v1',
    question: 'Orders by occupation',
    correctedSql: 'SELECT occupation, COUNT(*) FROM orders GROUP BY occupation',
    actorId: 'session',
  })
  store.setLearningExampleStatus(example.exampleId, 'approved')
  const before = store.listCompatibleLearningExamples({
    datasetId: 'food-ordering',
    schemaFingerprint: 'recipe-v1',
    semanticRevisionId: 'sem-food-ordering-v1',
  })
  expect(before).toHaveLength(1)

  // Now submit chart feedback against the same analysis — this must never
  // add another row to learning_examples, approved or otherwise.
  store.createChartFeedback({
    artifactId: 'art_9dd789f676df4f1e',
    analysisId: 'ana_1',
    analysisRevision: 1,
    issueType: 'overlap',
    actorId: 'session',
  })

  const after = store.listCompatibleLearningExamples({
    datasetId: 'food-ordering',
    schemaFingerprint: 'recipe-v1',
    semanticRevisionId: 'sem-food-ordering-v1',
  })
  expect(after).toHaveLength(1)
  expect(after).toEqual(before)
  // And the chart feedback itself is still only a candidate — never approved.
  expect(store.listChartFeedback({ analysisId: 'ana_1', status: 'candidate' })).toHaveLength(1)
  expect(store.listChartFeedback({ analysisId: 'ana_1', status: 'approved' })).toHaveLength(0)
})
