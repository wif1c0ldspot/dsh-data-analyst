/**
 * Ask-first semantics (the guardrail half of publisher-supplied metadata):
 * publisher text is evidence to confirm with the analyst, never a definition to
 * adopt.
 *
 * Structural, not textual, assertions: a dataset whose stored pin carries a
 * publisher column dictionary that literally names a business term must still
 * return `aliases: []` for that term, must report it as unresolved with the
 * ask-the-analyst recovery action, and must leave the semantic catalog empty.
 * The positive control shows the same tool does return a definition once an
 * analyst has actually approved one — so this is not a tool that answers
 * "nothing" to everything.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PublisherSuppliedMetadata } from 'dsh-data-core/recipes/types'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { DuckdbAnalystService } from '../src/plugin-service.js'
import { registerDuckdbAnalystTools } from '../src/plugin-tools.js'

const DATASET_ID = 'publisher_evidence_fixture'
const DATASET_VERSION_ID = 'publisher_evidence_fixture-v1'
const SLUG = 'owner/publisher-evidence'

/** A publisher dictionary that claims the very term under test. */
const PUBLISHER_BLOCK: PublisherSuppliedMetadata = {
  provenance: 'publisher-supplied',
  verification: 'unverified',
  caveat: 'Publisher-supplied and unverified: quoted Kaggle metadata, not an approved definition.',
  sources: ['kaggle-cli-datasets-metadata'],
  subtitle: 'Anonymised orders',
  description: { text: 'Publisher prose about the dataset.', truncated: false, sourceLength: 34 },
  columnDictionary: [
    {
      provenance: 'publisher-supplied',
      verification: 'unverified',
      column: 'sales',
      note: 'Publisher writes: this is the total revenue for the order.',
    },
  ],
  columnDictionaryTotal: 1,
  notes: [],
}

interface CapturedTool {
  name: string
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

interface MetricsResult {
  aliases: Array<{ term: string; expression: string }>
  unresolvedTerms?: string[]
  nextAction?: string
  guidance?: string
}

let directory: string
let store: MetadataStore
const services: DuckdbAnalystService[] = []

function fakeToolsContext(captured: Map<string, CapturedTool>): Context {
  return {
    tools: {
      register: (definition: CapturedTool) => {
        captured.set(definition.name, definition)
      },
    },
  } as unknown as Context
}

/** Register the real duckdb analyst tools against this test's workspace. */
function metricsTool(catalogPath: string): CapturedTool {
  const workspace = resolveWorkspacePaths(directory)
  const service = new DuckdbAnalystService(workspace)
  services.push(service)
  const tools = new Map<string, CapturedTool>()
  registerDuckdbAnalystTools(fakeToolsContext(tools), service)
  const tool = tools.get('get_metrics')
  expect(tool).toBeDefined()
  expect(workspace.catalogPath).toBe(catalogPath)
  return tool!
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-ask-first-'))
  await mkdir(join(directory, 'sources'), { recursive: true })
  const workspace = resolveWorkspacePaths(directory)
  store = new MetadataStore(workspace.catalogPath)
  store.publishDatasetVersion({
    contractVersion: 1,
    datasetId: DATASET_ID,
    datasetVersionId: DATASET_VERSION_ID,
    source: {
      slug: SLUG,
      version: '1',
      url: `https://www.kaggle.com/datasets/${SLUG}`,
      retrievedAt: new Date().toISOString(),
      license: null,
    },
    files: [],
    recipeHash: 'hash',
    importerVersion: '0.1.0',
    tables: [{ id: 'orders', sourceFile: 'orders.csv', rows: 2, rejectedRows: 0 }],
  })
  store.createWorkspaceSourcePin({
    slug: SLUG,
    sourceVersion: '1',
    actorId: 'analyst-session',
    recipe: {
      datasetId: DATASET_ID,
      recipeHash: 'hash',
      importerVersion: '0.1.0',
      license: null,
      sourceUrl: `https://www.kaggle.com/datasets/${SLUG}`,
      loadStrategy: 'raw_then_typed',
      publisherSupplied: PUBLISHER_BLOCK,
      tables: [
        {
          sourceFile: 'orders.csv',
          tableId: 'orders',
          columns: [
            { name: 'region', sourceName: 'Region', type: 'VARCHAR' },
            { name: 'sales', sourceName: 'Sales', type: 'DOUBLE' },
          ],
        },
      ],
    },
  })
  store.close()
})

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  await rm(directory, { recursive: true, force: true })
})

it('asks the analyst for a term only the publisher used, and invents no definition', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const tool = metricsTool(workspace.catalogPath)
  const result = (await tool.execute(
    { datasetId: DATASET_ID, terms: ['revenue'] },
    { signal: new AbortController().signal },
  )) as MetricsResult

  // (b) No auto-created or auto-approved definition, even though the publisher
  // supplied this exact column note.
  expect(result.aliases).toEqual([])
  // (d) The unchanged ask-first behaviour, now explicit in the payload.
  expect(result.unresolvedTerms).toEqual(['revenue'])
  expect(result.nextAction).toBe('ask-analyst')
  expect(result.guidance).toMatch(/No analyst-approved definition exists/)
  expect(result.guidance).toMatch(/publisher-supplied/i)
  expect(result.guidance).toMatch(/not an approved metric, alias or definition/)
  expect(result).not.toHaveProperty('definition')

  const reopened = new MetadataStore(workspace.catalogPath)
  try {
    // The publisher evidence is still there, still labelled, and still not a
    // semantic candidate.
    expect(reopened.listWorkspaceSourcePins(SLUG)[0]?.recipe.publisherSupplied?.verification).toBe(
      'unverified',
    )
    expect(reopened.listAliasCandidates()).toEqual([])
    expect(reopened.listStructureCandidates()).toEqual([])
  } finally {
    reopened.close()
  }
})

it('does not report an unresolved term when the analyst has approved that definition', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const reopening = new MetadataStore(workspace.catalogPath)
  try {
    const candidate = reopening.createAliasCandidate({
      datasetId: DATASET_ID,
      term: 'revenue',
      expression: 'SUM(sales)',
      description: 'Analyst-approved revenue definition',
      tableId: 'orders',
      actorId: 'analyst-ui',
    })
    reopening.setAliasCandidateStatus(candidate.candidateId, 'approved')
  } finally {
    reopening.close()
  }

  const tool = metricsTool(workspace.catalogPath)
  const result = (await tool.execute(
    { datasetId: DATASET_ID, terms: ['revenue'] },
    { signal: new AbortController().signal },
  )) as MetricsResult

  expect(result.aliases.map((alias) => alias.term)).toEqual(['revenue'])
  expect(result.aliases[0]?.expression).toBe('SUM(sales)')
  expect(result.unresolvedTerms).toBeUndefined()
  expect(result.nextAction).toBeUndefined()
})

it('reports a partly resolved term set per term, without inventing the missing one', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const reopening = new MetadataStore(workspace.catalogPath)
  try {
    const candidate = reopening.createAliasCandidate({
      datasetId: DATASET_ID,
      term: 'orders',
      expression: 'COUNT(*)',
      description: 'Approved order count',
      tableId: 'orders',
      actorId: 'analyst-ui',
    })
    reopening.setAliasCandidateStatus(candidate.candidateId, 'approved')
  } finally {
    reopening.close()
  }

  const tool = metricsTool(workspace.catalogPath)
  const result = (await tool.execute(
    { datasetId: DATASET_ID, terms: ['orders', 'churn'] },
    { signal: new AbortController().signal },
  )) as MetricsResult

  expect(result.aliases.map((alias) => alias.term)).toEqual(['orders'])
  expect(result.unresolvedTerms).toEqual(['churn'])
  expect(result.nextAction).toBe('ask-analyst')
})

it('lists approved definitions when no terms are requested, without a guidance payload', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const tool = metricsTool(workspace.catalogPath)
  const result = (await tool.execute(
    { datasetId: DATASET_ID },
    { signal: new AbortController().signal },
  )) as MetricsResult

  expect(result.aliases).toEqual([])
  expect(result.unresolvedTerms).toBeUndefined()
  expect(result.nextAction).toBeUndefined()
  expect(result.guidance).toBeUndefined()
})
