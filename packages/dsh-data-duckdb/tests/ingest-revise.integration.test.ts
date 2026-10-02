import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import type { IngestRecipe } from 'dsh-data-core/recipes/types'
import { handleIngestRecipeReviseRequest } from '../src/ingest-revise.js'

let directory: string
let previousWorkspace: string | undefined

const RECIPE: IngestRecipe = {
  datasetId: 'widgets',
  recipeHash: 'workspace-tabular-v2-deadbeef',
  importerVersion: '0.1.0',
  license: null,
  sourceUrl: 'https://example.invalid',
  loadStrategy: 'raw_then_typed',
  tables: [
    {
      sourceFile: 'widgets.csv',
      sourceFormat: 'csv',
      tableId: 'orders',
      columns: [
        { name: 'region', type: 'VARCHAR' },
        { name: 'sales', type: 'DOUBLE' },
      ],
    },
  ],
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-ingest-revise-'))
  previousWorkspace = process.env.DSH_DATA_WORKSPACE
  process.env.DSH_DATA_WORKSPACE = directory
  const store = new MetadataStore(join(directory, 'catalog.sqlite'))
  store.createWorkspaceSourcePin({
    slug: 'someone/widgets',
    sourceVersion: '1',
    recipe: RECIPE,
    actorId: 'analyst-session',
  })
  store.close()
})

afterEach(async () => {
  if (previousWorkspace === undefined) delete process.env.DSH_DATA_WORKSPACE
  else process.env.DSH_DATA_WORKSPACE = previousWorkspace
  await rm(directory, { recursive: true, force: true })
})

function pinId(): string {
  const store = new MetadataStore(join(directory, 'catalog.sqlite'))
  try {
    return store.listWorkspaceSourcePins()[0]?.pinId ?? ''
  } finally {
    store.close()
  }
}

function reviseRequest(pin: string, tables: unknown): Request {
  return new Request('http://localhost/api/analyst/ingest-recipes/revise', {
    method: 'POST',
    headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 1, pinId: pin, tables }),
  })
}

it('accepts an analyst-chosen date format and persists it on the candidate recipe', async () => {
  // The analyst answers the ambiguity the preview raised (day-first vs month-first)
  // by naming the format; the loader applies it at ingest, so the dates become real
  // DATE values instead of every one of them casting to NULL.
  const response = await handleIngestRecipeReviseRequest(
    reviseRequest(pinId(), [
      {
        tableId: 'orders',
        columns: [
          { name: 'region', type: 'VARCHAR' },
          { name: 'sales', type: 'DOUBLE' },
        ],
        dateFormat: '%m/%d/%Y',
      },
    ]),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    tables: Array<{ dateFormat?: string }>
    revision: number
  }
  expect(body.tables[0]!.dateFormat).toBe('%m/%d/%Y')
  expect(body.revision).toBeGreaterThan(1)
})

it('clears a detected date format when the analyst says the dates stay text', async () => {
  const response = await handleIngestRecipeReviseRequest(
    reviseRequest(pinId(), [
      {
        tableId: 'orders',
        columns: [
          { name: 'region', type: 'VARCHAR' },
          { name: 'sales', type: 'DOUBLE' },
        ],
        dateFormat: '',
      },
    ]),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { tables: Array<{ dateFormat?: string }> }
  expect(body.tables[0]!.dateFormat).toBeUndefined()
})

it('rejects a format that is not an allowed strftime pattern', async () => {
  const response = await handleIngestRecipeReviseRequest(
    reviseRequest(pinId(), [
      {
        tableId: 'orders',
        columns: [
          { name: 'region', type: 'VARCHAR' },
          { name: 'sales', type: 'DOUBLE' },
        ],
        dateFormat: '<%Y>',
      },
    ]),
  )
  expect(response.status).toBe(400)
  const body = (await response.json()) as { error: string }
  expect(body.error).toMatch(/not an allowed strftime pattern/i)
})

it('revises a column type on a candidate pin and recomputes the recipe hash', async () => {
  const response = await handleIngestRecipeReviseRequest(
    reviseRequest(pinId(), [
      { tableId: 'orders', columns: [{ name: 'sales', type: 'DECIMAL(18,2)' }] },
    ]),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    tables: Array<{ tableId: string; columns: Array<{ name: string; type: string }> }>
  }
  const orders = body.tables.find((table) => table.tableId === 'orders')!
  expect(orders.columns.find((column) => column.name === 'sales')?.type).toBe('DECIMAL(18,2)')
  expect(orders.columns.find((column) => column.name === 'region')?.type).toBe('VARCHAR')

  const store = new MetadataStore(join(directory, 'catalog.sqlite'))
  try {
    const updated = store.getWorkspaceSourcePin(pinId())
    expect(updated?.recipe.recipeHash).not.toBe(RECIPE.recipeHash)
  } finally {
    store.close()
  }
})

it('rejects an unsafe column type before touching the store', async () => {
  const response = await handleIngestRecipeReviseRequest(
    reviseRequest(pinId(), [
      { tableId: 'orders', columns: [{ name: 'sales', type: 'DROP TABLE' }] },
    ]),
  )
  expect(response.status).toBe(400)
})

it('refuses an approved pin', async () => {
  const store = new MetadataStore(join(directory, 'catalog.sqlite'))
  store.setWorkspaceSourcePinStatus(
    pinId(),
    'approved',
    store.getWorkspaceSourcePin(pinId())?.revision ?? 1,
  )
  store.close()

  const response = await handleIngestRecipeReviseRequest(
    reviseRequest(pinId(), [{ tableId: 'orders', columns: [{ name: 'sales', type: 'BIGINT' }] }]),
  )
  expect(response.status).toBe(409)
})

it('requires same-origin intent', async () => {
  const response = await handleIngestRecipeReviseRequest(
    new Request('http://localhost/api/analyst/ingest-recipes/revise', {
      method: 'POST',
      headers: {
        host: 'localhost',
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expectedRevision: 1, pinId: pinId(), tables: [] }),
    }),
  )
  expect(response.status).toBe(403)
})

it('rejects a second tab save based on the old revision without overwriting the first', async () => {
  const id = pinId()
  const first = await handleIngestRecipeReviseRequest(
    reviseRequest(id, [{ tableId: 'orders', columns: [{ name: 'sales', type: 'BIGINT' }] }]),
  )
  expect(first.status).toBe(200)
  expect(await first.json()).toMatchObject({ revision: 2 })
  const stale = await handleIngestRecipeReviseRequest(
    reviseRequest(id, [{ tableId: 'orders', columns: [{ name: 'sales', type: 'VARCHAR' }] }]),
  )
  expect(stale.status).toBe(409)
  const store = new MetadataStore(join(directory, 'catalog.sqlite'))
  expect(store.getWorkspaceSourcePin(id)?.recipe.tables[0]?.columns[1]?.type).toBe('BIGINT')
  store.close()
})
