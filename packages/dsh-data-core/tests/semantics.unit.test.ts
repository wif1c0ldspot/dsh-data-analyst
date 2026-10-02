import { expect, it } from 'vitest'
import {
  getCurrentSemantics,
  getFixtureSemantics,
  getWorkspaceBaseSemantics,
  OLIST_SEMANTICS_V1,
  resolveAlias,
  SUPERSTORE_SEMANTICS_V1,
} from '../src/semantics.js'

it('product getCurrentSemantics has no Core privilege', () => {
  expect(getCurrentSemantics('superstore')).toBeUndefined()
})

it('fixture helper resolves Superstore revenue alias', () => {
  const revision = getFixtureSemantics('superstore')
  expect(revision?.semanticRevisionId).toBe(SUPERSTORE_SEMANTICS_V1.semanticRevisionId)
  expect(resolveAlias(revision!, 'Revenue')?.expression).toBe('SUM(sales)')
})

it('returns undefined for unknown terms and datasets', () => {
  expect(getFixtureSemantics('missing')).toBeUndefined()
  expect(resolveAlias(SUPERSTORE_SEMANTICS_V1, 'not-a-metric')).toBeUndefined()
})

it('preserves historical Olist v1 while content-addressing reviewed product hints', () => {
  expect(OLIST_SEMANTICS_V1.semanticRevisionId).toBe('sem-olist-v1')
  expect(OLIST_SEMANTICS_V1.metricTermsRequiringApproval).toBeUndefined()

  const workspace = getWorkspaceBaseSemantics('olist')
  expect(workspace.aliases).toEqual([])
  expect(workspace.metricTermsRequiringApproval).toEqual(['revenue'])
  expect(workspace.semanticRevisionId).toMatch(
    /^sem-workspace-[a-f0-9]{12}-v1\+hints\.[a-f0-9]{12}$/,
  )

  expect(getWorkspaceBaseSemantics('superstore').semanticRevisionId).toMatch(
    /^sem-workspace-[a-f0-9]{12}-v1$/,
  )
})

it.each(['constructor', '__proto__'])(
  'treats inherited object key %s as an ordinary workspace dataset id',
  (datasetId) => {
    const workspace = getWorkspaceBaseSemantics(datasetId)

    expect(workspace.datasetId).toBe(datasetId)
    expect(workspace.aliases).toEqual([])
    expect(workspace.metricTermsRequiringApproval).toEqual([])
    expect(workspace.semanticRevisionId).toMatch(/^sem-workspace-[a-f0-9]{12}-v1$/)
  },
)
