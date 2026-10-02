/**
 * CI-safe NL eval: ingest synthetic retail-fixture and grade SYNTHETIC_GOLDEN_CASES.
 * Credentialed Core golden cases remain in GOLDEN_CASES for `npm run eval:golden`.
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
import { runIngestFromArchive } from '../src/ingest-pipeline.js'
import { fixtureSqlGenerator } from '../src/nl-loop.js'
import { SYNTHETIC_GOLDEN_CASES, runGeneratedSqlEval, runGoldenEval } from '../src/nl-eval.js'

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
  directory = await mkdtemp(join(tmpdir(), 'dsh-nl-eval-'))
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
    idempotencyKey: 'nl-eval-synthetic',
  })
})

afterEach(async () => {
  if (previousWorkspace === undefined) delete process.env.DSH_DATA_WORKSPACE
  else process.env.DSH_DATA_WORKSPACE = previousWorkspace
  await rm(directory, { recursive: true, force: true })
})

it('grades synthetic golden SQL against a temp published retail-fixture', async () => {
  expect(SYNTHETIC_GOLDEN_CASES.length).toBeGreaterThanOrEqual(1)
  const report = await runGoldenEval(SYNTHETIC_GOLDEN_CASES)
  expect(report.failed, JSON.stringify(report.results, null, 2)).toBe(0)
  expect(report.passed).toBe(SYNTHETIC_GOLDEN_CASES.length)
})

it('grades fixture-generator SQL through the same held-out preview harness', async () => {
  const report = await runGeneratedSqlEval(SYNTHETIC_GOLDEN_CASES, fixtureSqlGenerator)
  expect(report.failed, JSON.stringify(report.results, null, 2)).toBe(0)
  expect(report.passed).toBe(SYNTHETIC_GOLDEN_CASES.length)
})

it('grades synthetic held-out retail-fixture case via reviewed SQL (not in fixture map)', async () => {
  const { HELD_OUT_CASES } = await import('../src/nl-eval.js')
  const syntheticHeldOut = HELD_OUT_CASES.filter((c) => c.datasetId === 'retail-fixture')
  expect(syntheticHeldOut.length).toBeGreaterThanOrEqual(1)
  const report = await runGoldenEval(syntheticHeldOut)
  expect(report.failed, JSON.stringify(report.results, null, 2)).toBe(0)
})
