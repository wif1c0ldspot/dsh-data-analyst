/**
 * A date column whose values are genuinely ambiguous must not be published as an
 * all-NULL DATE. Found by the live Kaggle sweep on `vivek468/superstore-dataset-final`
 * (11/8/2016 next to 6/12/2016): the format detector correctly refuses to guess, and
 * DuckDB's native cast cannot parse M/D/YYYY at all, so every value became NULL —
 * a schema that advertises a date column holding nothing. The fix keeps the raw
 * values as VARCHAR and reports the fallback in the ingest warnings, so the analyst
 * can name the intended format and re-ingest.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { downloadDestinationForSlug } from 'dsh-data-kaggle/download-job'
import * as yazl from 'yazl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { handleIngestRecipeReviseRequest } from '../src/ingest-revise.js'
import { runReviewedIngest } from '../src/ingest-coordinator.js'
import { publishPendingAdaptation } from '../src/ingest-pipeline.js'
import { DuckdbAnalystService } from '../src/plugin-service.js'
import { registerDuckdbAnalystTools } from '../src/plugin-tools.js'
import { previewIngestSource } from '../src/preview-ingest.js'
import { resolveSourcePin } from 'dsh-data-core/recipes/workspace-registry'

const SLUG = 'someone/ambiguous-dates'
const VERSION = '1'

interface CapturedTool {
  name: string
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-ambiguous-dates-'))
  await mkdir(join(directory, 'sources'), { recursive: true })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('keeps an unparseable date column as VARCHAR instead of publishing all NULLs', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const destinationDir = downloadDestinationForSlug(workspace.sourcesDir, SLUG, VERSION)
  await mkdir(destinationDir, { recursive: true })
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(
    await readFile(
      fileURLToPath(
        new URL('../../../tests/fixtures/dirty-data/ambiguous-dates.csv', import.meta.url),
      ),
    ),
    'ambiguous-dates.csv',
  )
  const archive = join(destinationDir, 'source.zip')
  const writeStream = createWriteStream(archive)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)

  const signal = new AbortController().signal
  const preview = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: 'unused-in-this-test',
    actorId: 'test',
    signal,
  })
  const store = new MetadataStore(workspace.catalogPath)
  let ingest
  try {
    store.setWorkspaceSourcePinStatus(
      preview.pinId!,
      'approved',
      store.getWorkspaceSourcePin(preview.pinId!)?.revision ?? 1,
    )
    const pin = resolveSourcePin(SLUG, store.listWorkspaceSourcePins())!
    ingest = await runReviewedIngest({
      slug: pin.slug,
      pin,
      workspace,
      kaggleExecutable: 'unused-in-this-test',
      signal,
    })
    if (ingest.status === 'needs-input') {
      ingest = await publishPendingAdaptation({
        catalogPath: workspace.catalogPath,
        workspaceDir: join(workspace.root, 'workspaces', ingest.datasetId),
        jobId: ingest.jobId,
      })
    }
  } finally {
    store.close()
  }

  const warnings = (ingest as { qualityWarnings?: string[] }).qualityWarnings ?? []
  expect(ingest.status, 'the ingest must publish').toBe('ready')
  const table = ingest.tables[0]!
  expect(table.rows).toBe(4)

  // The fallback is reported to the analyst and the model.
  expect(warnings.join('\n')).toMatch(/no value matched any (DATE|TIMESTAMP) format/)
  expect(warnings.join('\n')).toContain('order_date')

  // The published column keeps its values as text rather than losing them.
  const service = new DuckdbAnalystService(workspace)
  const tools = new Map<string, CapturedTool>()
  registerDuckdbAnalystTools(
    {
      tools: { register: (definition: CapturedTool) => tools.set(definition.name, definition) },
    } as unknown as Context,
    service,
  )
  try {
    const schema = (await tools
      .get('get_schema')!
      .execute({ datasetId: ingest.datasetId, tables: [table.id] }, { signal })) as {
      tables: Array<{ columns: Array<{ name: string; type: string }> }>
    }
    const published = schema.tables[0]!.columns.find((column) => column.name === 'order_date')!
    expect(published.type, 'an unparseable date column must not stay DATE').toBe('VARCHAR')

    const value = (await tools.get('duckdb_query')!.execute(
      {
        datasetId: ingest.datasetId,
        sql: `SELECT count(order_date) AS kept FROM ${table.id}`,
        parameters: [],
      },
      { signal },
    )) as { preview: unknown[][] }
    expect(Number(value.preview[0]![0]), 'every raw value must survive').toBe(4)

    // A text date answers range comparisons lexicographically, not chronologically
    // (measured live on superstore: `ship_date < order_date` returned 1,565 rows
    // instead of 0, with no error). Nothing else stops the query, so the result has to
    // say so instead of looking like an answer.
    const comparison = (await tools.get('duckdb_query')!.execute(
      {
        datasetId: ingest.datasetId,
        sql: `SELECT count(*) AS inverted FROM ${table.id} WHERE shipped_at < order_date`,
        parameters: [],
      },
      { signal },
    )) as { preview: unknown[][]; warnings: string[] }
    expect(Number(comparison.preview[0]![0]), 'lexicographic, not chronological').toBeGreaterThan(0)
    expect(
      comparison.warnings.some((warning) => warning.startsWith('text-date-risk:')),
      `expected a text-date warning, got ${JSON.stringify(comparison.warnings)}`,
    ).toBe(true)

    const ordered = (await tools.get('duckdb_query')!.execute(
      {
        datasetId: ingest.datasetId,
        sql: `SELECT order_date FROM ${table.id} ORDER BY order_date LIMIT 1`,
        parameters: [],
      },
      { signal },
    )) as { warnings: string[] }
    expect(ordered.warnings.some((warning) => warning.startsWith('text-date-risk:'))).toBe(true)

    // BETWEEN is its own DuckDB node shape (`input`/`lower`/`upper`, not
    // `left`/`right`), so listing COMPARE_BETWEEN among the ordering comparisons was
    // not enough: a BETWEEN on a published text date answered 3,773 rows with no
    // warning. It now warns, including when a bound is itself the other text column.
    for (const sql of [
      `SELECT count(*) AS in_range FROM ${table.id} WHERE order_date BETWEEN '2016-01-01' AND '2016-06-01'`,
      `SELECT count(*) AS inverted FROM ${table.id} WHERE shipped_at BETWEEN order_date AND '2016-06-01'`,
    ]) {
      const between = (await tools
        .get('duckdb_query')!
        .execute({ datasetId: ingest.datasetId, sql, parameters: [] }, { signal })) as {
        warnings: string[]
      }
      expect(
        between.warnings.some((warning) => warning.startsWith('text-date-risk:')),
        `expected a text-date warning for BETWEEN, got ${JSON.stringify(between.warnings)}`,
      ).toBe(true)
    }

    // A window MIN/MAX serializes as `class: 'WINDOW'`, not `class: 'FUNCTION'`, and
    // was unwarned for the same reason.
    const windowMax = (await tools.get('duckdb_query')!.execute(
      {
        datasetId: ingest.datasetId,
        sql: `SELECT max(order_date) OVER () AS latest FROM ${table.id}`,
        parameters: [],
      },
      { signal },
    )) as { warnings: string[] }
    expect(
      windowMax.warnings.some((warning) => warning.startsWith('text-date-risk:')),
      `expected a text-date warning for a window MAX, got ${JSON.stringify(windowMax.warnings)}`,
    ).toBe(true)

    // Documented limits, pinned so the claim in the sql-safety skill cannot silently
    // widen: resolving an ORDER BY alias or position back to the column needs the
    // select list, and an aggregate read through a derived table resolves against the
    // derived table. These answer lexicographically with NO warning — which is exactly
    // why the skill says never to read a missing warning as proof a query is sound.
    const limitCases = [
      `SELECT order_date AS d FROM ${table.id} ORDER BY d`,
      `SELECT order_date FROM ${table.id} ORDER BY 1`,
      `WITH d AS (SELECT order_date FROM ${table.id}) SELECT max(order_date) FROM d`,
    ]
    for (const sql of limitCases) {
      const limited = (await tools
        .get('duckdb_query')!
        .execute({ datasetId: ingest.datasetId, sql, parameters: [] }, { signal })) as {
        warnings: string[]
      }
      expect(
        limited.warnings.some((warning) => warning.startsWith('text-date-risk:')),
        `documented limit: ${sql} is expected to go unwarned`,
      ).toBe(false)
    }
  } finally {
    service.dispose()
  }
})

it('turns the dates into real DATE values once the analyst names the format', async () => {
  const workspace = resolveWorkspacePaths(directory)
  const destinationDir = downloadDestinationForSlug(workspace.sourcesDir, SLUG, VERSION)
  await mkdir(destinationDir, { recursive: true })
  const zipfile = new yazl.ZipFile()
  zipfile.addBuffer(
    await readFile(
      fileURLToPath(
        new URL('../../../tests/fixtures/dirty-data/ambiguous-dates.csv', import.meta.url),
      ),
    ),
    'ambiguous-dates.csv',
  )
  const archive = join(destinationDir, 'source.zip')
  const writeStream = createWriteStream(archive)
  zipfile.outputStream.pipe(writeStream)
  zipfile.end()
  await finished(writeStream)

  const signal = new AbortController().signal
  const preview = await previewIngestSource({
    slug: SLUG,
    sourceVersion: VERSION,
    workspace,
    kaggleExecutable: 'unused-in-this-test',
    actorId: 'test',
    signal,
  })
  const store = new MetadataStore(workspace.catalogPath)
  // The revise route resolves the workspace from the environment, the same way the
  // authenticated same-origin route does in the running product.
  const previousWorkspace = process.env.DSH_DATA_WORKSPACE
  process.env.DSH_DATA_WORKSPACE = directory
  try {
    const pin = store.getWorkspaceSourcePin(preview.pinId!)!
    // The analyst answers the ambiguity through the review's format control.
    const revise = await handleIngestRecipeReviseRequest(
      new Request('http://localhost/api/analyst/ingest-recipes/revise', {
        method: 'POST',
        headers: {
          host: 'localhost',
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          pinId: pin.pinId,
          expectedRevision: pin.revision,
          tables: pin.recipe.tables.map((table) => ({
            tableId: table.tableId,
            columns: table.columns.map((column) => ({ name: column.name, type: column.type })),
            dateFormat: '%m/%d/%Y',
          })),
        }),
      }),
    )
    expect(revise.status, 'the format must be accepted').toBe(200)
    const revised = store.getWorkspaceSourcePin(pin.pinId)!
    store.setWorkspaceSourcePinStatus(
      revised.pinId,
      'approved',
      store.getWorkspaceSourcePin(revised.pinId)?.revision ?? 1,
    )
  } finally {
    if (previousWorkspace === undefined) delete process.env.DSH_DATA_WORKSPACE
    else process.env.DSH_DATA_WORKSPACE = previousWorkspace
    store.close()
  }

  const store2 = new MetadataStore(workspace.catalogPath)
  let ingest
  try {
    const pin = resolveSourcePin(SLUG, store2.listWorkspaceSourcePins())!
    ingest = await runReviewedIngest({
      slug: pin.slug,
      pin,
      workspace,
      kaggleExecutable: 'unused-in-this-test',
      signal,
    })
    if (ingest.status === 'needs-input') {
      ingest = await publishPendingAdaptation({
        catalogPath: workspace.catalogPath,
        workspaceDir: join(workspace.root, 'workspaces', ingest.datasetId),
        jobId: ingest.jobId,
      })
    }
  } finally {
    store2.close()
  }
  expect(ingest.status, 'the ingest must publish').toBe('ready')

  const service = new DuckdbAnalystService(workspace)
  const tools = new Map<string, CapturedTool>()
  registerDuckdbAnalystTools(
    {
      tools: { register: (definition: CapturedTool) => tools.set(definition.name, definition) },
    } as unknown as Context,
    service,
  )
  try {
    const table = ingest.tables[0]!
    const schema = (await tools
      .get('get_schema')!
      .execute({ datasetId: ingest.datasetId, tables: [table.id] }, { signal })) as {
      tables: Array<{ columns: Array<{ name: string; type: string }> }>
    }
    const published = schema.tables[0]!.columns.find((column) => column.name === 'order_date')!
    expect(published.type, 'the analyst format must produce a real date column').toBe('DATE')
    const asQuery = async (sql: string) =>
      (await tools
        .get('duckdb_query')!
        .execute({ datasetId: ingest.datasetId, sql, parameters: [] }, { signal })) as {
        preview: unknown[][]
      }

    const parsed = await asQuery(`SELECT count(order_date) AS parsed FROM ${table.id}`)
    expect(Number(parsed.preview[0]![0]), 'every value must parse').toBe(4)

    // Ordering and MIN/MAX warn too; grouping/aggregating a text date does not need to.

    // 11/8/2016 read month-first is 8 November; read day-first it would be August.
    const reading = await asQuery(
      `SELECT date_part('month', order_date) AS month, date_part('day', order_date) AS day FROM ${table.id} WHERE order_id = 'o1'`,
    )
    expect(Number(reading.preview[0]![0])).toBe(11)
    expect(Number(reading.preview[0]![1])).toBe(8)
  } finally {
    service.dispose()
  }
})
