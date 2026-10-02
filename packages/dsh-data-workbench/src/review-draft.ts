import { join } from 'node:path'
import { z } from 'zod'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import type { WorkspacePaths } from 'dsh-data-core/workspace-paths'
import { assertSafeDateFormat, assertSafeType } from 'dsh-data-duckdb/staging-loader'
import { withStudioState } from './studio-state.js'
import { isTrustedBrowserRequest } from './browser-trust.js'

const id = z.string().min(1).max(200)
const keySchema = z.strictObject({ sessionId: id, pinId: z.string().regex(/^pin_[a-f0-9]{16}$/) })

function isSafeDateFormat(value: string): boolean {
  try {
    assertSafeDateFormat(value)
    return true
  } catch {
    return false
  }
}

/** A strftime pattern the loader accepts, or '' for "no format chosen". */
const formatChoice = z
  .string()
  .max(64)
  .refine((value) => value === '' || isSafeDateFormat(value), {
    message: 'not an allowed strftime pattern',
  })
const draftSchema = z
  .strictObject({
    expectedRevision: z.number().int().positive(),
    sourceVersion: id,
    edits: z
      .array(
        z.strictObject({
          tableId: id,
          columns: z
            .array(z.strictObject({ name: id, type: z.string().min(1).max(100) }))
            .max(4096),
          // A date/timestamp format the analyst chose in the review is part of the
          // unsaved draft for the same reason a type edit is: the review promises to
          // recover unsaved changes. Validated with the loader's own pattern rule, so
          // a draft can never carry a format the ingest would refuse.
          dateFormat: formatChoice.optional(),
          timestampFormat: formatChoice.optional(),
        }),
      )
      .max(100),
  })
  .refine((draft) => draft.edits.reduce((n, t) => n + t.columns.length, 0) <= 4096)
const bodySchema = keySchema.extend({ draft: draftSchema.nullable() })
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })

/** Advisory browser draft; never changes a recipe or authorizes ingestion. */
export async function handleReviewDraftRequest(
  request: Request,
  workspace: WorkspacePaths,
): Promise<Response> {
  if (!isTrustedBrowserRequest(request)) return json({ error: 'Same-origin request required' }, 403)
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405)
  const store = new MetadataStore(workspace.catalogPath)
  try {
    const text = request.method === 'POST' ? await request.text() : ''
    if (Buffer.byteLength(text) > 524288) return json({ error: 'Draft exceeds size limit' }, 413)
    const url = new URL(request.url)
    const input: z.infer<typeof keySchema> & { draft?: z.infer<typeof draftSchema> | null } =
      request.method === 'POST'
        ? bodySchema.parse(JSON.parse(text))
        : keySchema.parse({
            sessionId: url.searchParams.get('sessionId'),
            pinId: url.searchParams.get('pinId'),
          })
    const pin = store.getWorkspaceSourcePin(input.pinId)
    if (!pin) return json({ error: 'Source proposal not found' }, 404)
    const path = join(workspace.root, 'studio.sqlite')
    if (input.draft !== undefined) {
      if (input.draft) {
        if (
          pin.revision !== input.draft.expectedRevision ||
          pin.sourceVersion !== input.draft.sourceVersion ||
          pin.status !== 'candidate'
        )
          return json(
            {
              error:
                'Source proposal changed; your draft remains unsaved. Discard and reload before continuing.',
            },
            409,
          )
        for (const table of input.draft.edits) {
          const stored = pin.recipe.tables.find((t) => t.tableId === table.tableId)
          if (!stored || table.columns.some((c) => !stored.columns.some((s) => s.name === c.name)))
            return json({ error: 'Unknown draft column' }, 400)
          for (const column of table.columns) assertSafeType(column.type)
        }
      }
      withStudioState(path, (db) =>
        input.draft === null
          ? db
              .prepare('DELETE FROM column_review_drafts WHERE session_id = ? AND pin_id = ?')
              .run(input.sessionId, input.pinId)
          : db
              .prepare(
                'INSERT OR REPLACE INTO column_review_drafts (session_id,pin_id,body) VALUES (?,?,?)',
              )
              .run(input.sessionId, input.pinId, JSON.stringify(input.draft)),
      )
      return json({ saved: true })
    }
    const row = withStudioState(
      path,
      (db) =>
        db
          .prepare('SELECT body FROM column_review_drafts WHERE session_id = ? AND pin_id = ?')
          .get(input.sessionId, input.pinId) as { body: string } | undefined,
    )
    const draft = row ? draftSchema.parse(JSON.parse(row.body)) : null
    return json({
      draft,
      stale: Boolean(
        draft &&
        (draft.expectedRevision !== pin.revision ||
          draft.sourceVersion !== pin.sourceVersion ||
          pin.status !== 'candidate'),
      ),
    })
  } catch {
    return json({ error: 'Invalid column review draft' }, 400)
  } finally {
    store.close()
  }
}
