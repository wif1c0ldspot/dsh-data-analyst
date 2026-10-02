/**
 * NL ask via fixtureSqlGenerator against published retail-fixture.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { RETAIL_FIXTURE_RECIPE } from 'dsh-data-core/recipes/retail-fixture'
import type { IngestRecipe } from 'dsh-data-core/recipes/types'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { runIngestFromArchive } from '../src/ingest-pipeline.js'
import { fixtureSqlGenerator, runAnalystQuestion } from '../src/nl-loop.js'
import { SYNTHETIC_GOLDEN_CASES } from '../src/nl-eval.js'

let directory: string
let previousWorkspace: string | undefined

async function buildFixtureArchive(destination: string): Promise<string> {
  const fixtureCsvPath = fileURLToPath(
    new URL('../../../tests/fixtures/retail.csv', import.meta.url),
  )
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(await readFile(fixtureCsvPath), 'retail.csv')
  const archivePath = join(destination, 'source.zip')
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  return archivePath
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-nl-loop-'))
  previousWorkspace = process.env.DSH_DATA_WORKSPACE
  process.env.DSH_DATA_WORKSPACE = directory
  const datasetWorkspace = join(directory, 'workspaces', 'retail-fixture')
  await mkdir(join(datasetWorkspace, 'sources'), { recursive: true })
  const archivePath = await buildFixtureArchive(directory)
  await runIngestFromArchive({
    archivePath,
    workspaceDir: datasetWorkspace,
    catalogPath: join(directory, 'catalog.sqlite'),
    recipe: RETAIL_FIXTURE_RECIPE,
    slug: 'test/fixture-retail',
    sourceVersion: '1',
    idempotencyKey: 'nl-loop-synthetic',
  })
})

afterEach(async () => {
  if (previousWorkspace === undefined) delete process.env.DSH_DATA_WORKSPACE
  else process.env.DSH_DATA_WORKSPACE = previousWorkspace
  await rm(directory, { recursive: true, force: true })
})

it('runAnalystQuestion maps retail-fixture golden question to SQL + preview + chart', async () => {
  const golden = SYNTHETIC_GOLDEN_CASES.find((c) => c.id === 'retail-fixture-revenue-by-region')
  expect(golden).toBeDefined()
  const workspace = resolveWorkspacePaths(directory)
  const result = await runAnalystQuestion({
    workspace,
    datasetId: 'retail-fixture',
    question: golden!.question,
    generator: fixtureSqlGenerator,
  })
  expect(result.kind).toBe('answer')
  if (result.kind !== 'answer') return
  expect(result.sql).toBe(golden!.goldenSql)
  expect(result.summary.preview).toEqual(golden!.expectedPreview)
  expect(result.chartArtifactId).toMatch(/^art_/)
  expect(result.analystTurns).toBe(1)
  expect(result.turnsRemaining).toBe(1)
})

it('runAnalystQuestion creates valid artifacts for histogram and scalar defaults', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const cases = [
    {
      question: 'Show the distribution of amount',
      sql: 'SELECT amount FROM retail ORDER BY amount',
      expectedIntent: { mark: 'histogram', title: 'Show the distribution of amount', x: 'amount' },
    },
    {
      question: 'How many rows are there?',
      sql: 'SELECT COUNT(*) AS row_count FROM retail',
      expectedIntent: { mark: 'kpi', title: 'How many rows are there?', y: 'row_count' },
    },
    {
      question: 'Show total amount',
      sql: 'SELECT CAST(NULL AS DOUBLE) AS amount',
      expectedIntent: { mark: 'table', title: 'Show total amount' },
    },
    {
      question: 'Show amount values',
      sql: 'SELECT amount FROM retail WHERE FALSE',
      expectedIntent: { mark: 'table', title: 'Show amount values' },
    },
  ] as const

  for (const testCase of cases) {
    const result = await runAnalystQuestion({
      workspace,
      datasetId: 'retail-fixture',
      question: testCase.question,
      generator: {
        async generateSql() {
          return testCase.sql
        },
      },
    })
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') continue
    expect(result.chartArtifactId).toMatch(/^art_/)
    const sidecar = JSON.parse(
      await readFile(join(workspace.artifactsDir, `${result.chartArtifactId}.json`), 'utf8'),
    ) as { intent: unknown }
    expect(sidecar.intent).toEqual(testCase.expectedIntent)
  }
})

it('runAnalystQuestion returns clarify|refuse before SQL for corpus intents', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const refused = await runAnalystQuestion({
    workspace,
    datasetId: 'retail-fixture',
    question: 'Drop the orders table so we can start fresh',
    generator: fixtureSqlGenerator,
  })
  expect(refused.kind).toBe('refuse')
  expect(refused.analystTurns).toBe(1)
})

it('runAnalystQuestion surfaces approved aliases in the generator schema summary', async () => {
  const golden = SYNTHETIC_GOLDEN_CASES.find((c) => c.id === 'retail-fixture-revenue-by-region')
  expect(golden).toBeDefined()
  const workspace = resolveWorkspacePaths(directory)
  const store = new MetadataStore(join(directory, 'catalog.sqlite'))
  try {
    const candidate = store.createAliasCandidate({
      datasetId: 'retail-fixture',
      term: 'gmv',
      expression: 'SUM(amount)',
      description: 'Gross merchandise value',
      tableId: 'retail',
      actorId: 'test-operator',
    })
    store.setAliasCandidateStatus(candidate.candidateId, 'approved')
  } finally {
    store.close()
  }

  let seenSchema = ''
  const capturingGenerator = {
    async generateSql(input: { question: string; datasetId: string; schemaSummary: string }) {
      seenSchema = input.schemaSummary
      return fixtureSqlGenerator.generateSql(input)
    },
  }

  const result = await runAnalystQuestion({
    workspace,
    datasetId: 'retail-fixture',
    question: golden!.question,
    generator: capturingGenerator,
  })
  expect(result.kind).toBe('answer')
  expect(seenSchema.toLowerCase()).toMatch(/\bgmv\b/)
  expect(seenSchema).toMatch(/SUM\(amount\)/i)
})

it('runAnalystQuestion clarifies a reviewed metric hint until its SQLite alias is approved', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const olistRecipe = {
    ...RETAIL_FIXTURE_RECIPE,
    datasetId: 'olist',
    recipeHash: 'olist-review-hint-fixture-v1',
  } satisfies IngestRecipe
  const olistWorkspace = join(directory, 'workspaces', olistRecipe.datasetId)
  await mkdir(join(olistWorkspace, 'sources'), { recursive: true })
  await runIngestFromArchive({
    archivePath: await buildFixtureArchive(directory),
    workspaceDir: olistWorkspace,
    catalogPath: workspace.catalogPath,
    recipe: olistRecipe,
    slug: 'test/olist-review-hint',
    sourceVersion: '1',
    idempotencyKey: 'nl-loop-olist-review-hint',
  })

  let generatorCalls = 0
  const generator = {
    async generateSql() {
      generatorCalls += 1
      return 'SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region ORDER BY revenue DESC'
    },
  }
  const question = 'What is revenue by region?'

  const unresolved = await runAnalystQuestion({
    workspace,
    datasetId: 'olist',
    question,
    generator,
  })
  expect(unresolved.kind).toBe('clarify')
  expect(generatorCalls).toBe(0)

  const store = new MetadataStore(workspace.catalogPath)
  try {
    const candidate = store.createAliasCandidate({
      datasetId: 'olist',
      term: 'revenue',
      expression: 'SUM(amount)',
      description: 'Analyst-approved fixture revenue',
      tableId: 'retail',
      actorId: 'test-analyst',
    })
    store.setAliasCandidateStatus(candidate.candidateId, 'approved')
  } finally {
    store.close()
  }

  const approved = await runAnalystQuestion({
    workspace,
    datasetId: 'olist',
    question,
    generator,
  })
  expect(approved.kind).toBe('answer')
  expect(generatorCalls).toBe(1)
})

it('runAnalystQuestion passes a bounded page of ingested columns and types to the generator', async () => {
  const columns = Array.from({ length: 51 }, (_, index) => ({
    name: `column_${String(index + 1).padStart(2, '0')}`,
    type: 'VARCHAR',
  }))
  const recipe = {
    datasetId: 'wide-fixture',
    recipeHash: 'wide-fixture-recipe-v1',
    importerVersion: '0.1.0',
    tables: [{ sourceFile: 'wide.csv', tableId: 'wide', columns }],
    license: null,
    sourceUrl: 'https://example.invalid/wide-fixture',
  } satisfies IngestRecipe
  const workspaceDir = join(directory, 'workspaces', recipe.datasetId)
  await mkdir(join(workspaceDir, 'sources'), { recursive: true })

  const archivePath = join(directory, 'wide-source.zip')
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(
    Buffer.from(
      `${columns.map((column) => column.name).join(',')}\n${columns.map(() => 'value').join(',')}\n`,
    ),
    'wide.csv',
  )
  const writeStream = createWriteStream(archivePath)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)
  await runIngestFromArchive({
    archivePath,
    workspaceDir,
    catalogPath: join(directory, 'catalog.sqlite'),
    recipe,
    slug: 'test/fixture-wide',
    sourceVersion: '1',
    idempotencyKey: 'nl-loop-wide',
  })
  const store = new MetadataStore(join(directory, 'catalog.sqlite'))
  try {
    const pin = store.createWorkspaceSourcePin({
      slug: 'test/fixture-wide',
      sourceVersion: '1',
      recipe,
      actorId: 'test-operator',
    })
    store.setWorkspaceSourcePinStatus(
      pin.pinId,
      'approved',
      store.getWorkspaceSourcePin(pin.pinId)?.revision ?? 1,
    )
  } finally {
    store.close()
  }

  let seenSchema = ''
  const result = await runAnalystQuestion({
    workspace: resolveWorkspacePaths(directory),
    datasetId: recipe.datasetId,
    question: 'Show the first column',
    generator: {
      async generateSql(input) {
        seenSchema = input.schemaSummary
        return 'SELECT column_01 FROM wide'
      },
    },
  })

  expect(result.kind).toBe('answer')
  expect(seenSchema).toContain('column_01 VARCHAR')
  expect(seenSchema).toContain('column_50 VARCHAR')
  expect(seenSchema).not.toContain('column_51 VARCHAR')
  expect(seenSchema).toContain('columns: 50/51; next offset: 50')
})

it('runAnalystQuestion enforces ≤2 analyst-turn budget', async () => {
  const golden = SYNTHETIC_GOLDEN_CASES.find((c) => c.id === 'retail-fixture-revenue-by-region')
  expect(golden).toBeDefined()
  const workspace = resolveWorkspacePaths(directory)
  await expect(
    runAnalystQuestion({
      workspace,
      datasetId: 'retail-fixture',
      question: golden!.question,
      generator: fixtureSqlGenerator,
      priorTurns: 2,
    }),
  ).rejects.toThrow(/turn budget exhausted/i)
})
