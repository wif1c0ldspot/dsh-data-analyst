/**
 * Defect 11: duckdb_query rejects unknown / mismatched semantic revisions
 * before running isolated SQL.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import type { DatasetManifest } from 'dsh-data-core/contracts'
import { resolveAuthorizedQueryArgs } from '../src/authorized-query-args.js'

let directory: string
let catalogPath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-sem-auth-'))
  catalogPath = join(directory, 'catalog.sqlite')
  const store = new MetadataStore(catalogPath)
  try {
    const manifest: DatasetManifest = {
      contractVersion: 1,
      datasetId: 'superstore',
      datasetVersionId: 'superstore-v1-test',
      source: {
        slug: 'test/superstore',
        version: '1',
        url: 'https://example.invalid',
        retrievedAt: new Date().toISOString(),
        license: null,
      },
      files: [],
      recipeHash: 'test',
      importerVersion: '0.1.0',
      tables: [{ id: 'orders', sourceFile: 'x.csv', rows: 1, rejectedRows: 0 }],
    }
    store.publishDatasetVersion(manifest)
  } finally {
    store.close()
  }
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('accepts a matching semantic revision for the dataset', () => {
  const store = new MetadataStore(catalogPath)
  try {
    const args = resolveAuthorizedQueryArgs(store, {
      datasetVersionId: 'superstore-v1-test',
      semanticRevisionId: 'sem-superstore-v1',
      sql: 'SELECT 1',
      parameters: [],
    })
    expect(args.semanticRevisionId).toMatch(/^sem-workspace-/)
    expect(args.datasetVersionId).toBe('superstore-v1-test')
  } finally {
    store.close()
  }
})

it('rebinds to effective overlay revision when approved aliases exist', () => {
  const store = new MetadataStore(catalogPath)
  try {
    const candidate = store.createAliasCandidate({
      datasetId: 'superstore',
      term: 'margin',
      expression: 'SUM(profit)/NULLIF(SUM(sales),0)',
      description: 'Margin',
      tableId: 'orders',
      actorId: 'operator-local',
    })
    store.setAliasCandidateStatus(candidate.candidateId, 'approved')
    const args = resolveAuthorizedQueryArgs(store, {
      datasetVersionId: 'superstore-v1-test',
      semanticRevisionId: 'sem-superstore-v1',
      sql: 'SELECT 1',
      parameters: [],
    })
    expect(args.semanticRevisionId).toMatch(/^sem-workspace-.+\+aliases\./)
  } finally {
    store.close()
  }
})

it('rejects unknown semantic revisions', () => {
  const store = new MetadataStore(catalogPath)
  try {
    expect(() =>
      resolveAuthorizedQueryArgs(store, {
        datasetVersionId: 'superstore-v1-test',
        semanticRevisionId: 'sem-nope',
        sql: 'SELECT 1',
        parameters: [],
      }),
    ).toThrow(/semantic/i)
  } finally {
    store.close()
  }
})

it('resolves the current published version from datasetId', () => {
  const store = new MetadataStore(catalogPath)
  try {
    const args = resolveAuthorizedQueryArgs(store, {
      datasetId: 'superstore',
      sql: 'SELECT 1',
      parameters: [],
    })
    expect(args.datasetVersionId).toBe('superstore-v1-test')
    expect(args.semanticRevisionId).toMatch(/^sem-workspace-/)
  } finally {
    store.close()
  }
})

it('rejects semantic revisions for the wrong dataset', () => {
  const store = new MetadataStore(catalogPath)
  try {
    expect(() =>
      resolveAuthorizedQueryArgs(store, {
        datasetVersionId: 'superstore-v1-test',
        semanticRevisionId: 'sem-olist-v1',
        sql: 'SELECT 1',
        parameters: [],
      }),
    ).toThrow(/dataset/i)
  } finally {
    store.close()
  }
})
