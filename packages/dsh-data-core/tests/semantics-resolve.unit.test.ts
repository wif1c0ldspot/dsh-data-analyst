import { expect, it } from 'vitest'
import {
  getCurrentSemantics,
  getFixtureSemantics,
  OLIST_SEMANTICS_V1,
  resolveSemanticRevision,
  SUPERSTORE_SEMANTICS_V1,
} from '../src/semantics.js'

it('resolves a known fixture semantic revision for its dataset', () => {
  const revision = resolveSemanticRevision('superstore', SUPERSTORE_SEMANTICS_V1.semanticRevisionId)
  expect(revision.semanticRevisionId).toBe('sem-superstore-v1')
  expect(revision.datasetId).toBe('superstore')
})

it('rejects nonexistent semantic revisions', () => {
  expect(() => resolveSemanticRevision('superstore', 'sem-does-not-exist')).toThrow(
    /unknown|not found|nonexistent/i,
  )
})

it('rejects semantic revisions that belong to another dataset', () => {
  expect(() =>
    resolveSemanticRevision('olist', SUPERSTORE_SEMANTICS_V1.semanticRevisionId),
  ).toThrow(/dataset/i)
})

it('getCurrentSemantics is empty; fixtures use getFixtureSemantics', () => {
  expect(getCurrentSemantics('superstore')).toBeUndefined()
  expect(getFixtureSemantics('superstore')?.semanticRevisionId).toBe('sem-superstore-v1')
})

it('resolves the immutable historical Olist v1 without product review hints', () => {
  const revision = resolveSemanticRevision('olist', OLIST_SEMANTICS_V1.semanticRevisionId)
  expect(revision).toBe(OLIST_SEMANTICS_V1)
  expect(revision.metricTermsRequiringApproval).toBeUndefined()
})
