import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { getEffectiveGrains, getEffectiveRelationships } from '../src/grains.js'
import { MetadataStore } from '../src/metadata-store.js'

let directory: string
let store: MetadataStore

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-structure-overlay-'))
  store = new MetadataStore(join(directory, 'catalog.sqlite'))
})

afterEach(async () => {
  store.close()
  await rm(directory, { recursive: true, force: true })
})

it('persists and overlays approved grain/relationship candidates for a new dataset', () => {
  const grain = store.createGrainCandidate({
    datasetId: 'gtd',
    tableId: 'events',
    primaryKey: ['event_id'],
    grainDescription: 'One row per event',
    evidence: { uniqueness: { event_id: 1 }, nullRatio: { event_id: 0 }, reason: 'unique' },
    actorId: 'analyst-test',
  })
  const relationship = store.createRelationshipCandidate({
    datasetId: 'gtd',
    fromTable: 'events',
    toTable: 'locations',
    fromColumns: ['location_id'],
    toColumns: ['location_id'],
    cardinality: 'n:1',
    evidence: { maxFromTo: 1, maxToFrom: 12, reason: 'many events per location' },
    actorId: 'analyst-test',
  })

  // Candidates are invisible until approved.
  expect(getEffectiveGrains('gtd', store)).toEqual([])
  expect(getEffectiveRelationships('gtd', store)).toEqual([])

  store.setStructureCandidateStatus(grain.candidateId, 'approved')
  store.setStructureCandidateStatus(relationship.candidateId, 'approved')

  expect(getEffectiveGrains('gtd', store)).toEqual([
    {
      datasetId: 'gtd',
      tableId: 'events',
      grainDescription: 'One row per event',
      primaryKey: ['event_id'],
    },
  ])
  expect(getEffectiveRelationships('gtd', store)).toEqual([
    {
      datasetId: 'gtd',
      fromTable: 'events',
      toTable: 'locations',
      fromColumns: ['location_id'],
      toColumns: ['location_id'],
      cardinality: 'n:1',
    },
  ])

  // Revoking removes it from the overlay.
  store.setStructureCandidateStatus(grain.candidateId, 'revoked')
  expect(getEffectiveGrains('gtd', store)).toEqual([])
})

it('approved overlays win over in-code fixture grains for a known dataset', () => {
  const candidate = store.createGrainCandidate({
    datasetId: 'superstore',
    tableId: 'orders',
    primaryKey: ['order_id'],
    grainDescription: 'One row per order',
    evidence: { reason: 'profiled' },
    actorId: 'analyst-test',
  })
  store.setStructureCandidateStatus(candidate.candidateId, 'approved')

  const grains = getEffectiveGrains('superstore', store)
  expect(grains.find((grain) => grain.tableId === 'orders')?.primaryKey).toEqual(['order_id'])
})
