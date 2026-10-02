import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { apply } from '../src/index.js'

interface CapturedTool {
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

function fakeToolsContext(captured: Map<string, CapturedTool>): Context {
  return {
    tools: {
      register(definition: CapturedTool & { name: string }) {
        captured.set(definition.name, definition)
      },
    },
  } as unknown as Context
}

let directory: string
let previousWorkspace: string | undefined
let previousExecutable: string | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-kaggle-plugin-version-'))
  previousWorkspace = process.env.DSH_DATA_WORKSPACE
  previousExecutable = process.env.DSH_KAGGLE_EXECUTABLE
  process.env.DSH_DATA_WORKSPACE = directory
})

afterEach(async () => {
  if (previousWorkspace === undefined) delete process.env.DSH_DATA_WORKSPACE
  else process.env.DSH_DATA_WORKSPACE = previousWorkspace
  if (previousExecutable === undefined) delete process.env.DSH_KAGGLE_EXECUTABLE
  else process.env.DSH_KAGGLE_EXECUTABLE = previousExecutable
  await rm(directory, { recursive: true, force: true })
})

it('uses an explicitly requested version for the download argv, cache path, and job provenance', async () => {
  const markerPath = join(directory, 'argv.json')
  const executable = join(directory, 'kaggle-stub.mjs')
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`,
    'utf8',
  )
  await chmod(executable, 0o755)
  process.env.DSH_KAGGLE_EXECUTABLE = executable

  const captured = new Map<string, CapturedTool>()
  apply(fakeToolsContext(captured))
  const download = captured.get('kaggle_download')
  expect(download).toBeDefined()

  const { SUPERSTORE_RECIPE } = await import('dsh-data-core/recipes/superstore')
  const pinStore = new MetadataStore(resolveWorkspacePaths().catalogPath)
  try {
    const created = pinStore.createWorkspaceSourcePin({
      slug: 'vivek468/superstore-dataset-final',
      sourceVersion: '1',
      recipe: SUPERSTORE_RECIPE,
      actorId: 'analyst-session',
    })
    pinStore.setWorkspaceSourcePinStatus(
      created.pinId,
      'approved',
      pinStore.getWorkspaceSourcePin(created.pinId)?.revision ?? 1,
    )
  } finally {
    pinStore.close()
  }

  const result = (await download!.execute(
    { slug: 'vivek468/superstore-dataset-final', sourceVersion: '2' },
    { signal: new AbortController().signal },
  )) as { jobId: string; status: string }

  expect(result.status).toBe('validating')
  const workspace = resolveWorkspacePaths()
  expect(JSON.parse(await readFile(markerPath, 'utf8'))).toEqual([
    'datasets',
    'download',
    '-d',
    'vivek468/superstore-dataset-final/2',
    '-p',
    join(workspace.sourcesDir, 'vivek468__superstore-dataset-final', '2'),
    '-q',
  ])

  const store = new MetadataStore(workspace.catalogPath)
  try {
    const job = store.getImportJob(result.jobId)
    expect(job?.slug).toBe('vivek468/superstore-dataset-final')
    expect(job?.sourceVersion).toBe('2')
  } finally {
    store.close()
  }
})

it('resolve_kaggle_version reads the public view API and returns the current version', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      ref: 'owner/dataset',
      title: 'Widgets',
      currentVersionNumber: 7,
      licenseName: 'CC0-1.0',
      subtitle: 'Widget sales',
      tags: ['retail'],
      description:
        'Monthly widget sales.\n\n| Column | Description |\n| --- | --- |\n| `sales` | Net sales in USD |\n',
    }),
  })) as unknown as typeof fetch
  try {
    const captured = new Map<string, CapturedTool>()
    apply(fakeToolsContext(captured))
    const resolve = captured.get('resolve_kaggle_version')
    expect(resolve).toBeDefined()

    const result = (await resolve!.execute(
      { slug: 'owner/dataset' },
      { signal: new AbortController().signal },
    )) as {
      slug: string
      title: string | null
      sourceVersion: string | null
      license: string | null
      publisherSupplied: {
        provenance: string
        verification: string
        caveat: string
        descriptionExcerpt?: string
        columnNotes: { column: string; note: string }[]
        columnDictionaryTotal: number
      }
    }

    expect(result).toMatchObject({
      slug: 'owner/dataset',
      title: 'Widgets',
      sourceVersion: '7',
      license: 'CC0-1.0',
    })

    // The publisher's own text travels labelled as evidence, never as a definition.
    expect(result.publisherSupplied.provenance).toBe('publisher-supplied')
    expect(result.publisherSupplied.verification).toBe('unverified')
    expect(result.publisherSupplied.caveat).toMatch(/not an approved definition/i)
    expect(result.publisherSupplied.descriptionExcerpt).toContain('Monthly widget sales.')
    expect(result.publisherSupplied.columnDictionaryTotal).toBeGreaterThan(0)
    expect(
      result.publisherSupplied.columnNotes.map((entry) => [entry.column, entry.note]),
    ).toContainEqual(['sales', 'Net sales in USD'])
    // Nothing in the block can be read as an analyst-approved definition.
    expect(Object.keys(result.publisherSupplied)).not.toContain('term')
    expect(Object.keys(result.publisherSupplied)).not.toContain('metric')
  } finally {
    globalThis.fetch = originalFetch
  }
})
