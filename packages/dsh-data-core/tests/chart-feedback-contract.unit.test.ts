/**
 * The analyst-facing chart-feedback issue type is a bounded enum, never
 * free-form text, and the mapping to `ChartLayoutIssueCode`'s own taxonomy
 * is total (every feedback type has an explicit entry, even when it maps
 * to `null`).
 */
import { describe, expect, it } from 'vitest'
import {
  CHART_FEEDBACK_ISSUE_TO_LAYOUT_CODE,
  ChartFeedbackIssueTypeSchema,
  ChartFeedbackSchema,
  ChartLayoutIssueCodeSchema,
} from '../src/contracts.js'

describe('ChartFeedbackIssueTypeSchema', () => {
  it('accepts exactly the five bounded issue types', () => {
    for (const issueType of [
      'overlap',
      'clipping',
      'unreadable-legend',
      'wrong-orientation',
      'excess-whitespace',
    ]) {
      expect(ChartFeedbackIssueTypeSchema.safeParse(issueType).success).toBe(true)
    }
  })

  it.each(['other', 'OVERLAP', 'text-collision', '', 'overlap ', 'ovrelap'])(
    'rejects free-form or near-miss value %j',
    (value) => {
      expect(ChartFeedbackIssueTypeSchema.safeParse(value).success).toBe(false)
    },
  )
})

describe('CHART_FEEDBACK_ISSUE_TO_LAYOUT_CODE', () => {
  it('maps every feedback issue type, with only valid layout issue codes or null', () => {
    for (const issueType of ChartFeedbackIssueTypeSchema.options) {
      expect(CHART_FEEDBACK_ISSUE_TO_LAYOUT_CODE).toHaveProperty(issueType)
      const mapped = CHART_FEEDBACK_ISSUE_TO_LAYOUT_CODE[issueType]
      if (mapped !== null) {
        expect(ChartLayoutIssueCodeSchema.safeParse(mapped).success).toBe(true)
      }
    }
  })
})

describe('ChartFeedbackSchema', () => {
  const valid = {
    feedbackId: 'cfb_0123456789abcdef',
    artifactId: 'art_9dd789f676df4f1e',
    analysisId: 'ana_abc123',
    analysisRevision: 1,
    issueType: 'overlap' as const,
    status: 'candidate' as const,
    actorId: 'analyst-session',
    createdAt: '2026-09-19T00:00:00.000Z',
    reviewedAt: null,
  }

  it('accepts a well-formed candidate record', () => {
    expect(ChartFeedbackSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects a free-form issueType even when every other field is valid', () => {
    expect(
      ChartFeedbackSchema.safeParse({ ...valid, issueType: 'axis-title-too-big' }).success,
    ).toBe(false)
  })

  it('rejects an unknown status value (e.g. "auto-approved")', () => {
    expect(ChartFeedbackSchema.safeParse({ ...valid, status: 'auto-approved' }).success).toBe(false)
  })

  it('rejects unknown extra fields (strictObject)', () => {
    expect(ChartFeedbackSchema.safeParse({ ...valid, approvedAutomatically: true }).success).toBe(
      false,
    )
  })
})
