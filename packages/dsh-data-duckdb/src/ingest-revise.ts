/**
 * Analyst revision of a candidate ingest proposal (Finding 5 "revise a typed
 * ingest proposal"). Per-column type revision only: an analyst can correct a
 * column's reviewed type before approving, without re-downloading. Never a
 * model tool argument — same-origin authenticated POST, and it refuses
 * approved/revoked pins so a reviewed recipe cannot drift.
 */
import type { Context } from '@deepseek-ai/cordis'
import { MetadataStore, WorkspaceSourcePinConflictError } from 'dsh-data-core/metadata-store'
import type { IngestRecipe } from 'dsh-data-core/recipes/types'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { recipeHashFor } from './preview-ingest.js'
import {
  assertSafeDateFormat,
  assertSafeIdentifier,
  assertSafeType,
  InvalidIdentifierError,
} from './staging-loader.js'

const PIN_ID_RE = /^pin_[a-zA-Z0-9]+$/

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin')
  const requestHost = request.headers.get('host') ?? new URL(request.url).host
  let originHost = ''
  try {
    originHost = origin ? new URL(origin).host : ''
  } catch {
    // Invalid origins fail the comparison below.
  }
  return originHost !== '' && originHost === requestHost
}

export async function handleIngestRecipeReviseRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!isSameOriginRequest(request)) return json({ error: 'Same-origin request required' }, 403)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400)
  const { pinId, tables, expectedRevision } = body as Record<string, unknown>
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1
  )
    return json({ error: 'expectedRevision is required' }, 400)
  if (typeof pinId !== 'string' || !PIN_ID_RE.test(pinId)) {
    return json({ error: 'Invalid pin id' }, 400)
  }
  if (!Array.isArray(tables)) return json({ error: 'tables must be an array' }, 400)

  // Parse and validate the overrides before touching the store.
  const overrides = new Map<string, Map<string, string>>()
  /**
   * Analyst-chosen date/timestamp format per table. `undefined` leaves whatever
   * the detector proposed (or its absence) alone; `null` or '' clears it, which is
   * how the analyst says "keep these values as text"; a string is the chosen
   * strptime pattern, and it must pass the same rule the loader enforces.
   */
  const formatOverrides = new Map<
    string,
    { dateFormat?: string | null; timestampFormat?: string | null }
  >()
  try {
    for (const table of tables) {
      if (!table || typeof table !== 'object') return json({ error: 'Invalid table' }, 400)
      const { tableId, columns, dateFormat, timestampFormat } = table as Record<string, unknown>
      if (typeof tableId !== 'string') return json({ error: 'Invalid tableId' }, 400)
      if (!Array.isArray(columns)) return json({ error: 'columns must be an array' }, 400)
      const formats: { dateFormat?: string | null; timestampFormat?: string | null } = {}
      for (const [key, value] of [
        ['dateFormat', dateFormat],
        ['timestampFormat', timestampFormat],
      ] as const) {
        if (value === undefined) continue
        if (value === null || value === '') {
          formats[key] = null
          continue
        }
        if (typeof value !== 'string') {
          return json({ error: `${key} must be a string, null or empty` }, 400)
        }
        assertSafeDateFormat(value)
        formats[key] = value
      }
      if (dateFormat !== undefined || timestampFormat !== undefined) {
        formatOverrides.set(tableId, formats)
      }
      const byName = new Map<string, string>()
      for (const column of columns) {
        if (!column || typeof column !== 'object') return json({ error: 'Invalid column' }, 400)
        const { name, type } = column as Record<string, unknown>
        if (typeof name !== 'string' || typeof type !== 'string') {
          return json({ error: 'Invalid column name/type' }, 400)
        }
        assertSafeIdentifier(name, 'Column name')
        assertSafeType(type)
        byName.set(name, type)
      }
      overrides.set(tableId, byName)
    }
  } catch (error) {
    if (error instanceof InvalidIdentifierError) {
      return json({ error: error.message }, 400)
    }
    throw error
  }

  const store = new MetadataStore(resolveWorkspacePaths().catalogPath)
  try {
    const pin = store.getWorkspaceSourcePin(pinId)
    if (!pin) return json({ error: `Workspace source pin ${pinId} does not exist` }, 404)
    if (pin.status !== 'candidate' || pin.revision !== expectedRevision) {
      return json({ error: 'Source proposal changed; reload before saving' }, 409)
    }

    const revisedTables = pin.recipe.tables.map((table) => {
      const tableOverrides = overrides.get(table.tableId)
      const formats = formatOverrides.get(table.tableId)
      const columnsChanged = Boolean(tableOverrides && tableOverrides.size > 0)
      if (!columnsChanged && formats === undefined) return table
      const revised: Record<string, unknown> = {
        ...table,
        ...(columnsChanged
          ? {
              columns: table.columns.map((column) =>
                tableOverrides!.has(column.name)
                  ? { ...column, type: tableOverrides!.get(column.name)! }
                  : column,
              ),
            }
          : {}),
      }
      if (formats) {
        for (const key of ['dateFormat', 'timestampFormat'] as const) {
          if (!(key in formats)) continue
          const value = formats[key]
          // Clearing the key is how "these dates stay text" is expressed: the
          // typed load then falls back to the raw values rather than casting
          // every one of them to NULL.
          if (value === null) delete revised[key]
          else revised[key] = value
        }
      }
      return revised as unknown as (typeof pin.recipe.tables)[number]
    })
    const loadStrategy = pin.recipe.loadStrategy ?? 'typed_recipe'
    const revisedRecipe: IngestRecipe = {
      ...pin.recipe,
      recipeHash: `workspace-tabular-v2-${recipeHashFor(pin.slug, pin.sourceVersion, revisedTables, loadStrategy)}`,
      tables: revisedTables,
    }

    const updated = store.setWorkspaceSourcePinRecipe(pinId, revisedRecipe, expectedRevision)
    return json({
      pinId: updated.pinId,
      revision: updated.revision,
      sourceVersion: updated.sourceVersion,
      slug: updated.slug,
      datasetId: updated.recipe.datasetId,
      status: updated.status,
      tables: updated.recipe.tables,
      // Type revision never touches (or approves) publisher text — it rides
      // along unchanged so the review pane keeps showing it labelled.
      publisherSupplied: updated.recipe.publisherSupplied ?? null,
    })
  } catch (error) {
    if (error instanceof WorkspaceSourcePinConflictError) return json({ error: error.message }, 409)
    throw error
  } finally {
    store.close()
  }
}

export function registerIngestRecipeRevise(ctx: Context): void {
  ctx.inject(['connection'], (webCtx) => {
    const connection = Reflect.get(webCtx, 'connection') as
      | {
          fetch: {
            register: (route: {
              path: string
              methods: readonly string[]
              requestBody: 'buffered'
              fetch: (request: Request) => Promise<Response>
            }) => () => Promise<void>
          }
        }
      | undefined
    if (!connection?.fetch?.register) return
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/ingest-recipes/revise',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleIngestRecipeReviseRequest(request),
        }),
      'dsh-data-duckdb: ingest recipe revise',
    )
  })
}
