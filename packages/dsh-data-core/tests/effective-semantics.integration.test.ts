import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MetadataStore } from '../src/metadata-store.js'
import {
  approvedAliasOverlayFingerprint,
  getCurrentSemantics,
  getEffectiveSemantics,
  getFixtureSemantics,
  getWorkspaceBaseSemantics,
  resolveAlias,
  resolveEffectiveSemanticRevision,
  SUPERSTORE_SEMANTICS_V1,
} from '../src/semantics.js'

let directory: string
let store: MetadataStore

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-effective-sem-'))
  store = new MetadataStore(join(directory, 'catalog.sqlite'))
})

afterEach(async () => {
  store.close()
  await rm(directory, { recursive: true, force: true })
})

it('product getCurrentSemantics is empty; fixtures remain via getFixtureSemantics', () => {
  expect(getCurrentSemantics('superstore')).toBeUndefined()
  expect(getFixtureSemantics('superstore')).toBe(SUPERSTORE_SEMANTICS_V1)
  const effective = getEffectiveSemantics('superstore')
  expect(effective?.aliases).toEqual([])
  expect(effective?.semanticRevisionId).toMatch(/^sem-workspace-/)
})

it('provides a stable empty base and approved overlays for workspace datasets', () => {
  const base = getEffectiveSemantics('iris', store)!
  expect(base.semanticRevisionId).toMatch(/^sem-workspace-/)
  expect(base.aliases).toEqual([])

  const candidate = store.createAliasCandidate({
    datasetId: 'iris',
    term: 'average sepal length',
    expression: 'AVG(sepal_length_cm)',
    description: 'Mean sepal length in centimetres',
    tableId: 'iris',
    actorId: 'analyst-test',
  })
  store.setAliasCandidateStatus(candidate.candidateId, 'approved')
  const effective = resolveEffectiveSemanticRevision('iris', base.semanticRevisionId, store)
  expect(effective.semanticRevisionId).toContain('+aliases.')
  expect(resolveAlias(effective, 'average sepal length')?.expression).toBe('AVG(sepal_length_cm)')
})

it('candidate-only aliases do not enter effective semantics', () => {
  store.createAliasCandidate({
    datasetId: 'superstore',
    term: 'margin',
    expression: 'SUM(profit)/NULLIF(SUM(sales),0)',
    description: 'Margin',
    tableId: 'orders',
    actorId: 'operator-local',
  })
  const effective = getEffectiveSemantics('superstore', store)!
  expect(effective.aliases).toEqual([])
  expect(resolveAlias(effective, 'margin')).toBeUndefined()
})

it('approved alias overlays appear in effective semantics and bump revision id', () => {
  const candidate = store.createAliasCandidate({
    datasetId: 'superstore',
    term: 'margin',
    expression: 'SUM(profit)/NULLIF(SUM(sales),0)',
    description: 'Profit margin',
    tableId: 'orders',
    actorId: 'operator-local',
  })
  store.setAliasCandidateStatus(candidate.candidateId, 'approved')

  const effective = getEffectiveSemantics('superstore', store)!
  expect(resolveAlias(effective, 'margin')?.expression).toBe('SUM(profit)/NULLIF(SUM(sales),0)')
  expect(resolveAlias(effective, 'revenue')).toBeUndefined()

  const fingerprint = approvedAliasOverlayFingerprint([
    {
      term: 'margin',
      expression: 'SUM(profit)/NULLIF(SUM(sales),0)',
      tableId: 'orders',
    },
  ])
  const baseId = getWorkspaceBaseSemantics('superstore').semanticRevisionId
  expect(effective.semanticRevisionId).toBe(`${baseId}+aliases.${fingerprint}`)
  expect(getFixtureSemantics('superstore')?.aliases).toHaveLength(2)
  expect(SUPERSTORE_SEMANTICS_V1.aliases).toHaveLength(2)
})

it('approved alias terms apply without an in-code base', () => {
  const candidate = store.createAliasCandidate({
    datasetId: 'superstore',
    term: 'revenue',
    expression: 'SUM(sales * discount)',
    description: 'Discounted revenue',
    tableId: 'orders',
    actorId: 'operator-local',
  })
  store.setAliasCandidateStatus(candidate.candidateId, 'approved')

  const effective = getEffectiveSemantics('superstore', store)!
  expect(resolveAlias(effective, 'revenue')?.expression).toBe('SUM(sales * discount)')
  expect(effective.aliases.filter((a) => a.term.toLowerCase() === 'revenue')).toHaveLength(1)
})

it('revoked aliases leave the empty product base', () => {
  const candidate = store.createAliasCandidate({
    datasetId: 'superstore',
    term: 'margin',
    expression: 'SUM(profit)/NULLIF(SUM(sales),0)',
    description: 'Margin',
    tableId: 'orders',
    actorId: 'operator-local',
  })
  store.setAliasCandidateStatus(candidate.candidateId, 'approved')
  expect(resolveAlias(getEffectiveSemantics('superstore', store)!, 'margin')).toBeDefined()

  store.setAliasCandidateStatus(candidate.candidateId, 'revoked')
  const afterRevoke = getEffectiveSemantics('superstore', store)!
  expect(afterRevoke.aliases).toEqual([])
  expect(resolveAlias(afterRevoke, 'margin')).toBeUndefined()
})

it('resolveEffectiveSemanticRevision accepts workspace base id and returns overlay when approved', () => {
  const candidate = store.createAliasCandidate({
    datasetId: 'superstore',
    term: 'margin',
    expression: '1',
    description: 'x',
    tableId: 'orders',
    actorId: 'operator-local',
  })
  store.setAliasCandidateStatus(candidate.candidateId, 'approved')
  const baseId = getWorkspaceBaseSemantics('superstore').semanticRevisionId
  const effective = resolveEffectiveSemanticRevision('superstore', baseId, store)
  expect(effective.semanticRevisionId).toMatch(
    new RegExp(`^${baseId.replace('+', '\\+')}\\+aliases\\.`),
  )
  expect(resolveAlias(effective, 'margin')?.expression).toBe('1')
})

it('resolveEffectiveSemanticRevision rejects stale overlay ids', () => {
  const baseId = getWorkspaceBaseSemantics('superstore').semanticRevisionId
  expect(() =>
    resolveEffectiveSemanticRevision('superstore', `${baseId}+aliases.deadbeef`, store),
  ).toThrow(/unknown/i)
})
