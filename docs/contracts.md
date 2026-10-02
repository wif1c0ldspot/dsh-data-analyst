# Domain and tool contracts

Current interface reference. Contracts in
[`packages/dsh-data-core/src/contracts.ts`](../packages/dsh-data-core/src/contracts.ts)
include Zod schemas for query/chart inputs with inferred TypeScript types.
Package services and their tests are authoritative for implemented behaviour. Services must call the schemas at inbound
boundaries and add authorization/semantic checks. Shape validation is not SQL
safety or artifact authorization.

## Identity and persistence

Use opaque server-generated IDs. Every request resolves workspace/session authority
from the runtime, not a model-provided workspace string. Every result/analysis pins
a dataset version and semantic revision. Do not let a tool select a filesystem
path, credential, model endpoint, or an arbitrary callback URL.

An import manifest retains source slug, source version, license metadata, file
checksums, byte counts, transform recipe hash, importer version and table mappings.
Version IDs are derived from the source/recipe identity; display names are mutable
labels. Multiple files mapping to one normalized identifier are rejected or mapped
explicitly. `ready` is published only after validation and a closed DB artifact.

The metadata coordinator uses SQLite transactions and revision checks through
`better-sqlite3`.
Revision-sensitive analysis/dashboard and source-review mutations reject stale
updates. Source drafts are advisory and never authorize publication.
Job submission carries an idempotency key. Write artifacts before committing their
metadata reference transaction; sweep orphan artifacts only after a grace period
and pin check. Use versioned SQL migrations, not a custom file transaction protocol.
After a crash, incomplete jobs become recoverable/failed; never infer success from
the mere presence of a file. Back up before schema upgrades; test versioned migrations against the prior format.

## Tool interface reference

The package registries implement these capability families against the pinned dsh
API. The isolated preset allowlist determines model access; internal/operator
helpers are not automatically model tools. See the inventory tests and
[current status](implementation.md) for verified scope.

- `resolve_kaggle_version(slug) →` current (latest) pinned source version, title,
  and license without downloading. Optional now that `preview_ingest_source` auto-
  resolves the latest version when none is named; version pinning is unchanged —
  preview/ingest still pin the returned number, never the `latest` keyword.
- `resolve_kaggle_source(slug) →` pinned source version, license, recipe tables, or
  `UNSUPPORTED_SOURCE`. `kaggle_download(slug, sourceVersion?) → {jobId, status}`.
  If no version is specified, use the reviewed pin. Download completion is not
  dataset readiness.
- `search_kaggle_sources(query) → {results}` — bounded, read-only keyword search
  over Kaggle (`datasets list -s`, up to 20 rows: ref/title/size/lastUpdated/
  downloadCount/license). A returned `ref` is the slug for `preview_ingest_source`.
- `ingest_dataset(slug) →` full download (when required) + validate + publish
  `{jobId, status: ready, datasetId, qualityWarnings}`. `dataset_status(jobId)` and
  `cancel_job(jobId)` cover bounded progress/cancel. Fails closed until an
  analyst-_approved_ workspace pin exists (no in-code Core privilege).
- `preview_ingest_source(slug, sourceVersion?) →` proposal + `candidate`
  workspace pin for a Kaggle tabular source, or
  `{alreadyReviewed: true}` when an approved workspace pin already covers it. Re-
  previewing a source that already has a _pending_ candidate reuses that candidate —
  same pin, no re-download — and reports `reusedCandidate: true` with the version it
  carries, which is the pinned version rather than necessarily the publisher's
  latest: pass `sourceVersion` to propose against a newer release. Never
  publishes; models cannot pass `approved` or a local path. Approval is an
  authenticated analyst action (same pattern as `propose_metric`).
- `resolve_kaggle_source` / `kaggle_download` resolve only approved workspace pins;
  otherwise fail closed and direct the agent to `preview_ingest_source`.
- `list_datasets() → summaries`; `get_schema(datasetId, {tables?, search?, limit?, offset?})`
  — demand-page a wide dataset: scope to `tables`, filter columns by `search`, and
  page columns with `limit`+`offset` (continue via the returned `nextOffset`);
  `get_metrics(datasetId, terms?)`.
- `propose_metric(..., {aggregation?, units?, dateColumn?, inclusion?}) → {proposalId, status: candidate}`.
  Structured fields (aggregation intent, units, date column, inclusion rule) are
  recorded for review but never enforce; approval is an authenticated analyst
  action, not a model-set `approved` field.
- `propose_structure(datasetId) → {grains, relationships}` — deterministic
  profiling proposes primary-key (uniqueness + null coverage) and join
  (multiplicity) candidates as `candidate` rows; re-running returns existing
  candidates without re-scanning. `list_pending_structure(datasetId?)` lists
  candidates for analyst approval. Approval is an authenticated analyst action
  (same-origin route), never a model-set field; only approved grains/relationships
  overlay `get_schema`.
- `duckdb_query(datasetId | datasetVersionId, sql, parameters) → QueryResultSummary`.
- `reconcile_totals(datasetId, primaryTable, primaryColumn, secondaryTable, secondaryColumn) →
QueryResultSummary` — compares two independent population sums from different
  tables (e.g. order-level vs. item-level totals) in one policy-gated call, for
  "do these two totals agree" questions. Requires an analyst-approved
  relationship between the two tables (`propose_structure`); fails closed
  otherwise. A population comparison, not a per-row join — use `duckdb_query`
  for a per-key breakdown.
- `make_chart(resultId, intent) → {artifactId, rendered, layoutValidation}`.
  `intent` selects only bounded server templates: bar, line, point, area,
  heatmap, boxplot, histogram, table, KPI, optional bar/area stacking, a
  small-multiple field (at most six columns), or a fixed two-measure
  line/area layer. Encoding fields must name columns in the authorized
  result; raw Vega, transforms, expressions, URLs, scripts and external data
  are outside the contract. `rendered: true` and `layoutValidation` (the
  deterministic layout validator's own verdict: text collisions, labels outside the
  canvas, blank legend labels, a canvas whose plot area covers less than a quarter of
  it, and aggregated marks that collapsed into one geometry — `degenerate-aggregate`)
  are attached server-side by
  `createChartArtifact`; no input field on this tool can set either one, and
  neither is a persistence or Studio-availability claim. A chart whose first render
  failed validation carries a `refinement` record for the single bounded recompile:
  the changes applied, the codes they resolved, the diagnostics that remain, and
  `overrodeRequestedFormat` when that repair reversed an orientation the caller
  explicitly asked for. The tool description tells the model to disclose that rather
  than present the chart as the one that was requested.
- `save_analysis`, `get_analysis`, `add_to_dashboard`, `export_report` bind the
  selected immutable result/revision. `save_analysis` proves persistence
  (`persisted: true`) only — it makes no claim about Studio visibility.
- `check_studio_availability(analysisId, revision?) → StudioAvailabilityCheck`
  independently re-queries the same catalog data path
  `/api/analyst/overview` reads (`listAnalysisRevisions`) to report whether a
  saved revision is actually retrievable via the Studio sidebar, rather than
  inferring it from a `save_analysis` return value.
- `get_workflow_trail({datasetVersionId?, analysisId?, limit?}) → {trail:
WorkflowTrailEntry[]}` lists the append-only `workflow_trail` SQLite table's milestones
  (preview proposed, analyst approved, dataset published, query completed,
  chart rendered, analysis persisted, Studio opened), oldest first. Each
  entry is `{entryId, milestone, actor, datasetVersionId, analysisId,
receiptId, recordedAt}` — identifiers and an enum only, never rows, SQL or
  SVG. `actor` is `'agent'` (a model tool call proposed something, e.g.
  `preview_ingest_source`), `'service'` (a deterministic backend fact, e.g.
  `ingest_dataset` publishing, `duckdb_query` completing, `make_chart`
  rendering, `save_analysis` persisting, `check_studio_availability`
  confirming) or `'analyst-ui'` (set only by the authenticated
  `/api/analyst/ingest-recipes/review` approval route, never a tool
  argument) — so an analyst-approved ingest is structurally distinguishable
  from an agent's own proposal.

Keep export, save/dashboard controls, feedback approval/revocation, and backup
as deterministic analyst/operator actions. Add agent-facing variants only if a
real natural-language workflow requires them and authority remains explicit.
Never expose general shell/code execution just to invoke these operations.

## Result and rendering boundary

`QueryResultSummary` exposes columns (logical types and units), total emitted row
count, bounded preview, applied limits, warnings, data version and result ID.
Validated complete-result facts carry their own provenance and scope within the
observation byte budget; unsafe or incomplete facts are withheld.
The durable result stores complete capped query output, SQL/bound parameters,
semantic revision, execution time and type metadata. Do not serialize native
DuckDB objects directly. DECIMAL and unsafe BIGINT use decimal strings; dates use
ISO dates, timestamps declare timezone semantics, NULL is JSON null, and
non-finite/unsupported nested types require an explicit encoding or rejection.

Reaching a row/byte cap is an explicit oversized-result outcome, not an apparently
complete business answer. A preview may be truncated while the authorized full
artifact remains complete; those two states have separate fields. Chart artifacts
contain the compiled spec and a render version, and refer to a result by ID.
Only a trusted renderer can resolve that ID into data; URL fields are forbidden.

Use the registered tool observation renderer to project compact model content and presentation metadata to
carry artifact IDs where supported. Do not return SVG through a JSON stringify
renderer. The browser fetches the artifact through an authorized route; the tool
result is not an authorization grant. Analyses are persisted independently of dsh
session logs so replay does not depend on nested-call presentation metadata.

## Host and UI routes

Routes mount through the pinned dsh authenticated connection service. Studio
state, schema, analysis, drafts, review status, history, restore and reports use
`/api/analyst/studio/*`. Trusted analysis/dashboard fragments and pin/filter/export
controls use `/api/analyst/ui/*`. Ingest and semantic approval have dedicated
analyst review routes; approval is never a model-provided flag.

See [Studio route registration](../packages/dsh-data-workbench/src/studio-routes.ts)
and [fragment route registration](../packages/dsh-data-workbench/src/ui-routes.ts)
for exact methods and schemas. Report/artifact routes resolve authorized generated
IDs or filenames, not arbitrary filesystem paths. Invalid input, unavailable
resources, policy denials and stale revisions fail without a success receipt.

## Worked synthetic example

[The semantic example](../tests/fixtures/retail-semantics.json) and
[small fixture](../tests/fixtures/retail.csv) describe a synthetic line-item table,
not a downloaded Kaggle dataset. Gross sales are 150.00, net sales 130.00 after a
-20.00 return. IDs include leading zeroes. These demonstrate why the metric's
returns rule, exact decimals, and grain must be declared before answering revenue.
The [seed cases](../tests/fixtures/retail-cases.json) are development examples and
do not count toward the production held-out benchmark.
