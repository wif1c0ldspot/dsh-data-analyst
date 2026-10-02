import { expect, it } from 'vitest'
import { censusOutputSchemas } from '../scripts/census-output-schemas.mjs'

/**
 * Drift canary for the output-schema narrowing work (docs/implementation.md,
 * "Strict output schemas").
 *
 * `output.schema` is enforced at runtime against every successful result, so a
 * schema that is too strict breaks the tool and a schema that is silently
 * *loosened* removes that enforcement without failing anything else. Neither
 * shows up as a test failure on its own, so the split is pinned here: bump the
 * lists deliberately (and update docs/implementation.md in the same change)
 * when a tool's output shape genuinely changes.
 *
 * The strict set is the answer/receipt family: the tools whose returned fields
 * are facts the model, the skills' completion states, the client toolviews or
 * downstream persistence code reason about. The loose set is bulk or
 * service-owned payloads (dashboards, exports, proposals, catalog listings),
 * where a per-field schema would turn an additive service change into a hard
 * tool failure for no gain.
 *
 * The line runs between the tool's OWN contract and the records it passes
 * through: a strict schema here pins the top-level keys only, and nested
 * service-owned records stay `additionalProperties: true`, so a service that
 * adds a field inside a dashboard or candidate cannot break the tool. Tools whose
 * own contract the model parses (status, receipts, the ask-the-analyst signal)
 * belong in the strict list; bulk listings of service records do not.
 */
const STRICT_TOOLS = [
  'bin_elapsed_intervals',
  'cancel_job',
  'check_studio_availability',
  'dataset_status',
  'describe_column',
  'duckdb_query',
  'find_duplicate_rows',
  'find_top_n',
  'get_analysis',
  'get_metrics',
  'get_workflow_trail',
  'investigate_metric',
  'kaggle_download',
  'list_analyses',
  'make_chart',
  'ratio_of_sums',
  'reconcile_totals',
  'resolve_kaggle_source',
  'resolve_kaggle_version',
  'save_analysis',
  'search_kaggle_sources',
]

it('every registered tool declares an output schema', async () => {
  const census = await censusOutputSchemas()
  expect(census.totalTools).toBe(44)
  expect(census.toolsWithOutputSchema).toBe(44)
})

it('the strict output-schema set is exactly the answer/receipt family', async () => {
  const census = await censusOutputSchemas()
  expect(census.strictTools).toEqual(STRICT_TOOLS)
  expect(census.strict + census.loose).toBe(census.toolsWithOutputSchema)
})
