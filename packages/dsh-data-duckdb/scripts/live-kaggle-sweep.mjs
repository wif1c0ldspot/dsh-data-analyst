#!/usr/bin/env node
/**
 * Live Kaggle sweep: ingest a list of REAL Kaggle slugs through the real pipeline
 * and report what happened. Operator tooling, deliberately opt-in.
 *
 * No model calls; the only credential is a Kaggle token. It drives the same entry
 * points the product uses (`previewIngestSource` -> analyst approval ->
 * `runReviewedIngest`), then calls the registered model-facing tools against the
 * published dataset and validates every returned payload against the schema the
 * runtime enforces. That is how generality on real data is measured, rather than
 * asserted in a document.
 *
 * Usage:
 *   DSH_DATA_WORKSPACE=/tmp/live-ws node packages/dsh-data-duckdb/scripts/live-kaggle-sweep.mjs \
 *     slug/one slug/two ... [--out /tmp/live-report.json]
 *
 * Failures are recorded with their error and the run exits non-zero: a sweep that
 * hides failures is worse than no sweep.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { resolveSourcePin } from 'dsh-data-core/recipes/workspace-registry'
import { defaultPinnedKaggleExecutable } from 'dsh-data-kaggle/download-adapter'
import { DuckdbAnalystService } from '../dist/plugin-service.js'
import { registerDuckdbAnalystTools } from '../dist/plugin-tools.js'
import { previewIngestSource } from '../dist/preview-ingest.js'
import { runReviewedIngest } from '../dist/ingest-coordinator.js'
import { publishPendingAdaptation } from '../dist/ingest-pipeline.js'

const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const out = outIndex >= 0 ? argv[outIndex + 1] : '/tmp/live-kaggle-sweep.json'
const slugs = argv.filter((arg, index) => !arg.startsWith('--') && index !== outIndex + 1)

if (slugs.length === 0) {
  console.error('Pass at least one Kaggle slug, e.g. vivek468/superstore-dataset-final')
  process.exit(2)
}
const workspaceDir = process.env.DSH_DATA_WORKSPACE
if (!workspaceDir) {
  console.error('Set DSH_DATA_WORKSPACE to a scratch directory (never the source tree).')
  process.exit(2)
}
await mkdir(workspaceDir, { recursive: true })

const workspace = resolveWorkspacePaths(workspaceDir)
const kaggleExecutable = process.env.DSH_KAGGLE_EXECUTABLE ?? defaultPinnedKaggleExecutable()
const signal = new AbortController().signal
const results = []
const total = (counts) => Object.values(counts ?? {}).reduce((sum, value) => sum + Number(value), 0)

for (const slug of slugs) {
  const started = Date.now()
  const record = { slug }
  const service = new DuckdbAnalystService(workspace)
  const tools = new Map()
  registerDuckdbAnalystTools(
    { tools: { register: (definition) => tools.set(definition.name, definition) } },
    service,
  )
  /** Call a registered tool and check its payload against the enforced schema. */
  const callTool = async (name, args) => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`tool "${name}" is not registered`)
    const value = await tool.execute(args, { signal })
    const violations = validateJsonSchemaValue(
      tool.output.schema,
      JSON.parse(JSON.stringify(value ?? null)),
      'value',
    )
    return { value, violations }
  }

  try {
    const previewStarted = Date.now()
    const preview = await previewIngestSource({
      slug,
      workspace,
      kaggleExecutable,
      actorId: 'operator:live-sweep',
      signal,
    })
    record.preview = {
      ms: Date.now() - previewStarted,
      alreadyReviewed: preview.alreadyReviewed === true,
      tables: (preview.tables ?? []).map((table) => ({
        id: table.tableId,
        columns: (table.columns ?? []).length,
        warningCount: (table.warnings ?? []).length,
      })),
    }
    // Validate the preview payload against the schema the runtime enforces, using
    // the payload already in hand rather than triggering a second download.
    record.previewSchemaViolations = validateJsonSchemaValue(
      tools.get('preview_ingest_source').output.schema,
      JSON.parse(JSON.stringify(preview ?? null)),
      'value',
    ).length

    const store = new MetadataStore(workspace.catalogPath)
    try {
      if (!preview.pinId) {
        // An approved pin already covers this slug (a re-run in the same
        // workspace, or a prior sweep): there is no new candidate to approve, so
        // reuse the approved pin instead of failing.
        if (!preview.alreadyReviewed) throw new Error('preview returned no candidate pin')
        if (!resolveSourcePin(slug, store.listWorkspaceSourcePins())) {
          throw new Error('alreadyReviewed but no approved workspace pin resolves')
        }
      } else {
        store.setWorkspaceSourcePinStatus(
          preview.pinId,
          'approved',
          store.getWorkspaceSourcePin(preview.pinId)?.revision ?? 1,
        )
      }
      const pin = resolveSourcePin(slug, store.listWorkspaceSourcePins())
      if (!pin) throw new Error('approved pin could not be resolved')

      const ingestStarted = Date.now()
      let ingest = await runReviewedIngest({
        slug: pin.slug,
        pin,
        workspace,
        kaggleExecutable,
        signal,
      })
      // A material cast-null finding pauses the ingest at needs-input: that IS the
      // product working as designed (raw_then_typed), so the operator confirms the
      // adaptive publish here exactly as the Studio confirm action would.
      if (ingest.status === 'needs-input') {
        record.materialityPause = {
          reasons: ingest.materialityReasons ?? [],
          typeReproposals: (ingest.materiality?.reproposals ?? []).map((proposal) => ({
            tableId: proposal.tableId,
            column: proposal.column,
            approvedType: proposal.approvedType,
            proposedType: proposal.proposedType,
            castNullCells: proposal.castNullCells,
            material: proposal.material,
          })),
        }
        ingest = await publishPendingAdaptation({
          catalogPath: workspace.catalogPath,
          workspaceDir: join(workspace.root, 'workspaces', ingest.datasetId),
          jobId: ingest.jobId,
        })
        record.confirmed = true
      }
      record.ingest = {
        ms: Date.now() - ingestStarted,
        status: ingest.status,
        datasetId: ingest.datasetId,
        tables: (ingest.tables ?? []).map((table) => ({
          id: table.id,
          rows: table.rows,
          rejectedRows: table.rejectedRows,
          castNullCells: total(table.castNullCounts),
          castNullColumns: Object.values(table.castNullCounts ?? {}).filter(
            (count) => Number(count) > 0,
          ).length,
          currencyDimensions: (table.currencyDimensions ?? []).map((dimension) => dimension.column),
          currencyScanSkipped: (table.currencyScanSkipped ?? []).map((skipped) => skipped.column),
          loadStrategy: table.loadStrategy,
        })),
        qualityWarnings: ingest.qualityWarnings ?? [],
        materialityReasons: ingest.materialityReasons ?? [],
        typeReproposals: (ingest.typeReproposals ?? []).length,
      }
      if (ingest.status !== 'ready') throw new Error(`ingest status ${ingest.status}`)

      // Tool calls against the published dataset, each payload schema-checked.
      const manifest = store.getCurrentDatasetVersion(ingest.datasetId)
      const table = manifest?.tables?.[0]
      record.tools = []
      if (table) {
        const numeric = (table.columns ?? []).find((column) =>
          /INT|DECIMAL|DOUBLE|FLOAT|REAL|NUMERIC/i.test(column.type),
        )
        const calls = [
          [
            'duckdb_query',
            {
              datasetId: ingest.datasetId,
              sql: `SELECT count(*) AS rows FROM ${table.id}`,
              parameters: [],
            },
          ],
          ['find_duplicate_rows', { datasetId: ingest.datasetId, table: table.id }],
          ...(numeric
            ? [
                [
                  'describe_column',
                  { datasetId: ingest.datasetId, table: table.id, valueColumn: numeric.name },
                ],
              ]
            : []),
        ]
        // The model-facing truth about types, and a real probe of any date/time
        // column: a column that is VARCHAR because every value failed to cast is
        // unusable for time analysis, and the manifest alone does not show that.
        try {
          const { value: schemaValue, violations } = await callTool('get_schema', {
            datasetId: ingest.datasetId,
            tables: [table.id],
          })
          record.schemaColumns = (schemaValue?.tables?.[0]?.columns ?? [])
            .slice(0, 30)
            .map((column) => `${column.name}:${column.type}`)
          if (violations.length > 0) record.schemaViolations = violations.slice(0, 3)
        } catch (error) {
          record.schemaColumns = [`error: ${String(error?.message ?? error).slice(0, 200)}`]
        }
        const dateColumn = (table.columns ?? []).find((column) => /date|time/i.test(column.name))
        if (dateColumn) {
          calls.push([
            'duckdb_query',
            {
              datasetId: ingest.datasetId,
              sql: `SELECT ${dateColumn.name} AS value FROM ${table.id} WHERE ${dateColumn.name} IS NOT NULL LIMIT 3`,
              parameters: [],
            },
          ])
        }

        for (const [name, args] of calls) {
          try {
            const { value, violations } = await callTool(name, args)
            record.tools.push({
              tool: name,
              ok: violations.length === 0,
              schemaViolations: violations.slice(0, 3),
              rowCount: value?.rowCount,
              preview: JSON.stringify(value?.preview?.[0] ?? null).slice(0, 200),
            })
          } catch (error) {
            record.tools.push({
              tool: name,
              ok: false,
              error: String(error?.message ?? error).slice(0, 300),
            })
          }
        }
      }
    } finally {
      store.close()
    }
    record.ok = record.ingest?.status === 'ready'
  } catch (error) {
    record.ok = false
    record.error = String(error?.message ?? error).slice(0, 400)
  } finally {
    service.dispose()
  }
  record.ms = Date.now() - started
  results.push(record)
  console.log(
    `${record.ok ? 'OK  ' : 'FAIL'} ${slug} ${(record.ms / 1000).toFixed(1)}s ` +
      (record.ok
        ? `rows=[${record.ingest.tables.map((table) => table.rows).join(',')}] ` +
          `warnings=${record.ingest.qualityWarnings.length} ` +
          `tools=${record.tools.map((tool) => `${tool.tool}${tool.ok ? '' : '!'}`).join(',')}`
        : `error=${record.error}`),
  )
}

await mkdir(dirname(out), { recursive: true })
await writeFile(
  out,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), workspace: workspaceDir, results },
    null,
    2,
  ),
)
console.log(`\nreport: ${out}`)
process.exit(results.every((result) => result.ok) ? 0 : 1)
