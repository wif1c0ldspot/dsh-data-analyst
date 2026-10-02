import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DatasetManifest } from '../src/contracts.js'
import {
  getDatasetMetrics,
  getDatasetSchemaSlice,
  listPublishedDatasets,
} from '../src/catalog-query.js'
import { MetadataStore } from '../src/metadata-store.js'

const INGESTION_SCOPE =
  'rows and rejectedRows are ingestion counts only; they do not provide duplicate, NULL/missingness, or distribution-shape evidence'

let directory: string
let catalogPath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-catalog-query-'))
  catalogPath = join(directory, 'catalog.sqlite')
  const store = new MetadataStore(catalogPath)
  try {
    const manifest: DatasetManifest = {
      contractVersion: 1,
      datasetId: 'retail-fixture',
      datasetVersionId: 'retail-fixture-v1-test',
      source: {
        slug: 'test/fixture-retail',
        version: '1',
        url: 'https://example.invalid',
        retrievedAt: new Date().toISOString(),
        license: null,
      },
      files: [],
      recipeHash: 'retail-fixture-recipe-v1',
      importerVersion: '0.1.0',
      tables: [{ id: 'retail', sourceFile: 'retail.csv', rows: 3, rejectedRows: 0 }],
    }
    store.publishDatasetVersion(manifest)
  } finally {
    store.close()
  }
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('lists current published datasets and schema with grains; aliases require approval', () => {
  const store = new MetadataStore(catalogPath)
  try {
    const revenue = store.createAliasCandidate({
      datasetId: 'retail-fixture',
      term: 'revenue',
      expression: 'SUM(amount)',
      description: 'Line amount sum',
      tableId: 'retail',
      actorId: 'analyst-test',
    })
    store.setAliasCandidateStatus(revenue.candidateId, 'approved')

    const listed = listPublishedDatasets(store)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.datasetId).toBe('retail-fixture')
    expect(listed[0]?.qualityScope).toBe(INGESTION_SCOPE)
    const schema = getDatasetSchemaSlice(store, 'retail-fixture')
    expect(schema.qualityScope).toBe(INGESTION_SCOPE)
    expect(schema.tables[0]?.columns?.some((column) => column.name === 'amount')).toBe(true)
    expect(schema.tables[0]?.grain?.primaryKey).toEqual(['line_id'])
    expect(getDatasetMetrics(store, 'retail-fixture', ['revenue'])[0]?.expression).toBe(
      'SUM(amount)',
    )
    expect(schema.rules.some((rule) => rule.column === 'amount' && rule.kind === 'currency')).toBe(
      true,
    )
  } finally {
    store.close()
  }
})

it('reads approved metrics without materializing schema structure', () => {
  const store = new MetadataStore(catalogPath)
  try {
    const revenue = store.createAliasCandidate({
      datasetId: 'retail-fixture',
      term: 'Revenue',
      expression: 'SUM(amount)',
      description: 'Line amount sum',
      tableId: 'retail',
      actorId: 'analyst-test',
    })
    store.setAliasCandidateStatus(revenue.candidateId, 'approved')
    store.createAliasCandidate({
      datasetId: 'retail-fixture',
      term: 'pending metric',
      expression: 'COUNT(*)',
      description: 'Unreviewed row count',
      tableId: 'retail',
      actorId: 'analyst-test',
    })

    const schemaAliases = getDatasetSchemaSlice(store, 'retail-fixture').aliases
    const listWorkspaceSourcePins = vi.spyOn(store, 'listWorkspaceSourcePins')
    const listStructureCandidates = vi.spyOn(store, 'listStructureCandidates')

    expect(getDatasetMetrics(store, 'retail-fixture')).toEqual(schemaAliases)
    expect(getDatasetMetrics(store, 'retail-fixture', ['  REVENUE  ', 'unknown'])).toEqual([
      {
        term: 'Revenue',
        expression: 'SUM(amount)',
        description: 'Line amount sum',
        tableId: 'retail',
      },
    ])
    expect(listWorkspaceSourcePins).not.toHaveBeenCalled()
    expect(listStructureCandidates).not.toHaveBeenCalled()
  } finally {
    store.close()
  }
})

it('rejects metric lookup for an unpublished dataset', () => {
  const store = new MetadataStore(catalogPath)
  try {
    expect(() => getDatasetMetrics(store, 'not-published')).toThrow(
      'No published dataset "not-published"',
    )
  } finally {
    store.close()
  }
})

it.each(['constructor', '__proto__'])(
  'lists published dataset id %s and returns its empty approved metric set',
  (datasetId) => {
    const store = new MetadataStore(catalogPath)
    try {
      store.publishDatasetVersion({
        contractVersion: 1,
        datasetId,
        datasetVersionId: `${datasetId}-v1-test`,
        source: {
          slug: `test/${datasetId}`,
          version: '1',
          url: 'https://example.invalid',
          retrievedAt: new Date().toISOString(),
          license: null,
        },
        files: [],
        recipeHash: 'inherited-key-recipe-v1',
        importerVersion: '0.1.0',
        tables: [{ id: 'items', sourceFile: 'items.csv', rows: 1, rejectedRows: 0 }],
      })

      expect(
        listPublishedDatasets(store).find((dataset) => dataset.datasetId === datasetId),
      ).toEqual(
        expect.objectContaining({
          datasetId,
          datasetVersionId: `${datasetId}-v1-test`,
          semanticRevisionId: expect.stringMatching(/^sem-workspace-[a-f0-9]{12}-v1$/),
        }),
      )
      expect(getDatasetMetrics(store, datasetId)).toEqual([])
    } finally {
      store.close()
    }
  },
)

it('includes superstore grain and metric rules; revenue alias only after approval', () => {
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
      recipeHash: 'superstore-recipe-v1',
      importerVersion: '0.1.0',
      tables: [
        { id: 'orders', sourceFile: 'Sample - Superstore.csv', rows: 9994, rejectedRows: 0 },
      ],
    }
    store.publishDatasetVersion(manifest)
    const revenue = store.createAliasCandidate({
      datasetId: 'superstore',
      term: 'revenue',
      expression: 'SUM(sales)',
      description: 'Gross sales',
      tableId: 'orders',
      actorId: 'analyst-test',
    })
    store.setAliasCandidateStatus(revenue.candidateId, 'approved')

    const schema = getDatasetSchemaSlice(store, 'superstore')
    expect(schema.tables[0]?.grain?.primaryKey).toEqual(['row_id'])
    expect(
      schema.aliases.some((alias) => alias.term === 'revenue' && alias.expression === 'SUM(sales)'),
    ).toBe(true)
    expect(schema.rules.some((rule) => rule.column === 'sales' && rule.kind === 'currency')).toBe(
      true,
    )
    expect(schema.rules.every((rule) => rule.datasetId === 'superstore')).toBe(true)
    expect(schema.aliases.every((alias) => 'status' in alias === false)).toBe(true)
  } finally {
    store.close()
  }
})

it('uses an approved workspace recipe to expose columns for a generic dataset', () => {
  const store = new MetadataStore(catalogPath)
  try {
    const recipe = {
      datasetId: 'iris',
      recipeHash: 'workspace-tabular-v2-test',
      importerVersion: '0.1.0',
      license: null,
      sourceUrl: 'https://www.kaggle.com/datasets/uciml/iris',
      tables: [
        {
          sourceFile: 'Iris.csv',
          sourceFormat: 'csv' as const,
          tableId: 'iris',
          columns: [
            { name: 'id', sourceName: 'Id', type: 'BIGINT' },
            { name: 'species', sourceName: 'Species', type: 'VARCHAR' },
          ],
        },
      ],
    }
    const pin = store.createWorkspaceSourcePin({
      slug: 'uciml/iris',
      sourceVersion: '2',
      recipe,
      actorId: 'analyst-test',
    })
    store.setWorkspaceSourcePinStatus(
      pin.pinId,
      'approved',
      store.getWorkspaceSourcePin(pin.pinId)?.revision ?? 1,
    )
    store.publishDatasetVersion({
      contractVersion: 1,
      datasetId: 'iris',
      datasetVersionId: 'iris-v2-test',
      source: {
        slug: 'uciml/iris',
        version: '2',
        url: recipe.sourceUrl,
        retrievedAt: new Date().toISOString(),
        license: null,
      },
      files: [],
      recipeHash: recipe.recipeHash,
      importerVersion: recipe.importerVersion,
      tables: [{ id: 'iris', sourceFile: 'Iris.csv', rows: 150, rejectedRows: 0 }],
    })

    const schema = getDatasetSchemaSlice(store, 'iris')
    expect(schema.semanticRevisionId).toMatch(/^sem-workspace-/)
    expect(schema.tables[0]?.columns).toEqual([
      { name: 'id', type: 'BIGINT' },
      { name: 'species', type: 'VARCHAR' },
    ])
  } finally {
    store.close()
  }
})

it('pages columns of a wide generic dataset with a continuation cursor', () => {
  const store = new MetadataStore(catalogPath)
  try {
    const columns = ['a', 'b', 'c', 'd', 'e'].map((name, index) => ({
      name,
      sourceName: name.toUpperCase(),
      type: index === 0 ? 'BIGINT' : 'VARCHAR',
    }))
    const recipe = {
      datasetId: 'wide',
      recipeHash: 'workspace-tabular-v2-wide',
      importerVersion: '0.1.0',
      license: null,
      sourceUrl: 'https://www.kaggle.com/datasets/example/wide',
      tables: [{ sourceFile: 'wide.csv', sourceFormat: 'csv' as const, tableId: 'wide', columns }],
    }
    const pin = store.createWorkspaceSourcePin({
      slug: 'example/wide',
      sourceVersion: '1',
      recipe,
      actorId: 'analyst-test',
    })
    store.setWorkspaceSourcePinStatus(
      pin.pinId,
      'approved',
      store.getWorkspaceSourcePin(pin.pinId)?.revision ?? 1,
    )
    store.publishDatasetVersion({
      contractVersion: 1,
      datasetId: 'wide',
      datasetVersionId: 'wide-v1-test',
      source: {
        slug: 'example/wide',
        version: '1',
        url: recipe.sourceUrl,
        retrievedAt: new Date().toISOString(),
        license: null,
      },
      files: [],
      recipeHash: recipe.recipeHash,
      importerVersion: recipe.importerVersion,
      tables: [{ id: 'wide', sourceFile: 'wide.csv', rows: 5, rejectedRows: 0 }],
    })

    const page1 = getDatasetSchemaSlice(store, 'wide', { limit: 2 })
    expect(page1.columnsTruncated).toBe(true)
    expect(page1.nextOffset).toBe(2)
    expect(page1.totalColumns).toBe(5)
    expect(page1.tables[0]?.columns?.map((column) => column.name)).toEqual(['a', 'b'])

    const page2 = getDatasetSchemaSlice(store, 'wide', { limit: 2, offset: 2 })
    expect(page2.columnsTruncated).toBe(true)
    expect(page2.nextOffset).toBe(4)
    expect(page2.tables[0]?.columns?.map((column) => column.name)).toEqual(['c', 'd'])

    const page3 = getDatasetSchemaSlice(store, 'wide', { limit: 2, offset: 4 })
    expect(page3.columnsTruncated).toBe(false)
    expect(page3.nextOffset).toBeNull()
    expect(page3.tables[0]?.columns?.map((column) => column.name)).toEqual(['e'])

    const searched = getDatasetSchemaSlice(store, 'wide', { search: 'c' })
    expect(searched.totalColumns).toBe(1)
    expect(searched.tables[0]?.columns?.map((column) => column.name)).toEqual(['c'])
  } finally {
    store.close()
  }
})

it('enforces one column page limit across multiple tables', () => {
  const store = new MetadataStore(catalogPath)
  try {
    const recipe = {
      datasetId: 'multi-table',
      recipeHash: 'workspace-tabular-v2-multi-table',
      importerVersion: '0.1.0',
      license: null,
      sourceUrl: 'https://www.kaggle.com/datasets/example/multi-table',
      tables: [
        {
          sourceFile: 'orders.csv',
          sourceFormat: 'csv' as const,
          tableId: 'orders',
          columns: ['order_id', 'customer_id', 'amount'].map((name) => ({
            name,
            sourceName: name,
            type: 'VARCHAR',
          })),
        },
        {
          sourceFile: 'customers.csv',
          sourceFormat: 'csv' as const,
          tableId: 'customers',
          columns: ['customer_id', 'name', 'region'].map((name) => ({
            name,
            sourceName: name,
            type: 'VARCHAR',
          })),
        },
      ],
    }
    const pin = store.createWorkspaceSourcePin({
      slug: 'example/multi-table',
      sourceVersion: '1',
      recipe,
      actorId: 'analyst-test',
    })
    store.setWorkspaceSourcePinStatus(
      pin.pinId,
      'approved',
      store.getWorkspaceSourcePin(pin.pinId)?.revision ?? 1,
    )
    store.publishDatasetVersion({
      contractVersion: 1,
      datasetId: 'multi-table',
      datasetVersionId: 'multi-table-v1-test',
      source: {
        slug: 'example/multi-table',
        version: '1',
        url: recipe.sourceUrl,
        retrievedAt: new Date().toISOString(),
        license: null,
      },
      files: [],
      recipeHash: recipe.recipeHash,
      importerVersion: recipe.importerVersion,
      tables: [
        { id: 'orders', sourceFile: 'orders.csv', rows: 10, rejectedRows: 0 },
        { id: 'customers', sourceFile: 'customers.csv', rows: 5, rejectedRows: 0 },
      ],
    })

    const firstPage = getDatasetSchemaSlice(store, 'multi-table', { limit: 2 })
    expect(firstPage.tables.map((table) => table.columns?.map((column) => column.name))).toEqual([
      ['order_id', 'customer_id'],
      [],
    ])
    expect(firstPage.tables.flatMap((table) => table.columns ?? [])).toHaveLength(2)

    const crossingPage = getDatasetSchemaSlice(store, 'multi-table', { limit: 2, offset: 2 })
    expect(crossingPage.tables.map((table) => table.columns?.map((column) => column.name))).toEqual(
      [['amount'], ['customer_id']],
    )
    expect(crossingPage.tables.flatMap((table) => table.columns ?? [])).toHaveLength(2)
  } finally {
    store.close()
  }
})
