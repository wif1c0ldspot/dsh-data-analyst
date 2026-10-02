import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths, type WorkspacePaths } from 'dsh-data-core/workspace-paths'
import { handleReviewDraftRequest } from '../src/review-draft.js'
let workspace: WorkspacePaths
let pinId: string
beforeEach(async () => {
  workspace = resolveWorkspacePaths(await mkdtemp(join(tmpdir(), 'review-draft-')))
  const store = new MetadataStore(workspace.catalogPath)
  pinId = store.createWorkspaceSourcePin({
    slug: 'test/data',
    sourceVersion: '1',
    actorId: 'test',
    recipe: {
      datasetId: 'test',
      recipeHash: 'a',
      importerVersion: '1',
      license: null,
      sourceUrl: 'https://example.com',
      tables: [
        { tableId: 'data', sourceFile: 'data.csv', columns: [{ name: 'value', type: 'DOUBLE' }] },
      ],
    },
  }).pinId
  store.close()
})
afterEach(async () => rm(workspace.root, { recursive: true, force: true }))
const draft = {
  expectedRevision: 1,
  sourceVersion: '1',
  edits: [{ tableId: 'data', columns: [{ name: 'value', type: 'BIGINT' }] }],
}
function request(sessionId = 'one', body?: unknown) {
  return new Request(
    `http://localhost/api/analyst/studio/review-draft?sessionId=${sessionId}&pinId=${pinId}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: 'http://localhost', host: 'localhost' },
      ...(body === undefined ? {} : { body: JSON.stringify({ sessionId, pinId, draft: body }) }),
    },
  )
}
it('recovers across connections, isolates sessions and explicitly discards', async () => {
  expect((await handleReviewDraftRequest(request('one', draft), workspace)).status).toBe(200)
  expect(await (await handleReviewDraftRequest(request(), workspace)).json()).toEqual({
    draft,
    stale: false,
  })
  expect(await (await handleReviewDraftRequest(request('two'), workspace)).json()).toEqual({
    draft: null,
    stale: false,
  })
  expect((await handleReviewDraftRequest(request('one', null), workspace)).status).toBe(200)
  expect(await (await handleReviewDraftRequest(request(), workspace)).json()).toEqual({
    draft: null,
    stale: false,
  })
})
it('retains stale recovery drafts while refusing revision, source version and reviewed-status writes', async () => {
  await handleReviewDraftRequest(request('one', draft), workspace)
  expect(
    (await handleReviewDraftRequest(request('one', { ...draft, sourceVersion: '2' }), workspace))
      .status,
  ).toBe(409)
  const store = new MetadataStore(workspace.catalogPath)
  store.setWorkspaceSourcePinRecipe(pinId, store.getWorkspaceSourcePin(pinId)!.recipe, 1)
  expect((await handleReviewDraftRequest(request('one', draft), workspace)).status).toBe(409)
  expect(await (await handleReviewDraftRequest(request(), workspace)).json()).toEqual({
    draft,
    stale: true,
  })
  store.setWorkspaceSourcePinStatus(pinId, 'revoked', 2)
  store.close()
  expect(
    (await handleReviewDraftRequest(request('one', { ...draft, expectedRevision: 3 }), workspace))
      .status,
  ).toBe(409)
  expect((await handleReviewDraftRequest(request('one', null), workspace)).status).toBe(200)
})
it('bounds draft payloads and rejects unknown columns, unsafe types and cross-origin access', async () => {
  expect(
    (
      await handleReviewDraftRequest(
        request('one', {
          ...draft,
          edits: [{ tableId: 'data', columns: [{ name: 'missing', type: 'DOUBLE' }] }],
        }),
        workspace,
      )
    ).status,
  ).toBe(400)
  expect(
    (
      await handleReviewDraftRequest(
        request('one', {
          ...draft,
          edits: [{ tableId: 'data', columns: [{ name: 'value', type: 'DROP TABLE' }] }],
        }),
        workspace,
      )
    ).status,
  ).toBe(400)
  expect(
    (
      await handleReviewDraftRequest(
        request('one', { ...draft, extra: 'x'.repeat(524288) }),
        workspace,
      )
    ).status,
  ).toBe(413)
  expect(
    (
      await handleReviewDraftRequest(
        new Request('http://localhost/api/analyst/studio/review-draft'),
        workspace,
      )
    ).status,
  ).toBe(403)
})

it('never recovers another workspace draft', async () => {
  await handleReviewDraftRequest(request('one', draft), workspace)
  const other = resolveWorkspacePaths(await mkdtemp(join(tmpdir(), 'review-draft-other-')))
  try {
    expect((await handleReviewDraftRequest(request(), other)).status).toBe(404)
  } finally {
    await rm(other.root, { recursive: true, force: true })
  }
})

it('keeps an analyst-chosen date or timestamp format in the recovery draft', async () => {
  // A format choice is an unsaved change like a type edit, so the draft must carry it:
  // the review promises to recover unsaved changes, and once approval is blocked on it
  // losing the choice would strand the analyst.
  const withFormats = {
    ...draft,
    edits: [
      {
        tableId: 'data',
        columns: [{ name: 'value', type: 'BIGINT' }],
        dateFormat: '%m/%d/%Y',
        timestampFormat: '%Y-%m-%d %H:%M:%S',
      },
    ],
  }
  expect((await handleReviewDraftRequest(request('one', withFormats), workspace)).status).toBe(200)
  const recovered = (await (await handleReviewDraftRequest(request('one'), workspace)).json()) as {
    draft: { edits: Array<{ dateFormat?: string; timestampFormat?: string }> } | null
  }
  expect(recovered.draft?.edits[0]?.dateFormat).toBe('%m/%d/%Y')
  expect(recovered.draft?.edits[0]?.timestampFormat).toBe('%Y-%m-%d %H:%M:%S')

  // A format-only edit (no column changes at all) is still a draft worth keeping.
  expect(
    (
      await handleReviewDraftRequest(
        request('one', {
          ...draft,
          edits: [{ tableId: 'data', columns: [], dateFormat: '%d/%m/%Y' }],
        }),
        workspace,
      )
    ).status,
  ).toBe(200)

  // The loader's own pattern rule applies here too, so a draft can never carry a
  // format the ingest would refuse.
  expect(
    (
      await handleReviewDraftRequest(
        request('one', {
          ...draft,
          edits: [{ tableId: 'data', columns: [], dateFormat: '<%Y>' }],
        }),
        workspace,
      )
    ).status,
  ).toBe(400)
})
