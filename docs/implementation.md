# Current status and remaining work

This document describes the product as it exists today. For rationale and
component design see [architecture](architecture.md). This file describes
current state, not how each capability got there — this repository's public
history is a single clean export, not a record of the development process.
Claims here are limited to what has been measured; the measured evidence itself is
kept internally rather than shipped in this distribution.

## Implemented

### Ingestion

Controlled Kaggle search, source/version resolution and preview. Supported
tabular formats are CSV, Parquet, JSON/JSONL and XLSX; archives are quarantined
and validated (a hard 1 GiB uncompressed-content cap, enforced before
extraction) before any file is read. The analyst reviews a proposed
table/column layout — including unknown-license, provenance, quality and
skipped-file information — before a trusted writer loads a private staging
database. Typed ingestion diagnostics report per-column cast-null counts and
row-count breakdowns. CSV ingestion normalizes to UTF-8 per record (not just
per file), so a file that mixes UTF-8 and windows-1252 encoded rows decodes
each row correctly instead of mis-decoding the minority encoding. The database
is validated and closed, then published as an immutable dataset version;
`preview_ingest_source` demand-pages schema the same way `get_schema` does, and
reports an explicit unsupported-format reason for anything outside the
supported formats rather than attempting a partial import. Mixed-currency
columns are detected automatically at ingest time, and a column the bounded scan
skips is reported as not scanned rather than left silent. A date/timestamp column
whose approved type parses none of its non-empty values is never published as an
all-NULL typed column: the raw values are kept as VARCHAR, `get_schema` reports the
column as VARCHAR with `fallbackFrom` naming the approved type, and the ingest
warnings carry the reason (typically a source whose day-first/month-first order is
ambiguous), so the analyst can name the format and re-ingest. That answer is now
actionable in the review: the column review lists the proposal's own warnings (the
same strings the model was given) and, for each table with a date or timestamp
column, a format control whose choice is saved onto the candidate proposal through
the same route as a type change, validated against the loader's own pattern rule.
Naming the order and re-ingesting therefore yields real DATE values; leaving it unset
means the loader still attempts a plain cast, so only wholly unparseable values stay
text. The choice behaves like a type edit in every other respect: it is part of the
session's recovery draft, approval stays blocked while it is unsaved (only Save type
changes applies it), and a choice equal to what the table already has is not a change
at all — so reverting to the current value cannot leave the review unable to approve,
save or reset. Timestamp columns read `timestampFormat`, so a table whose temporal
columns are timestamps gets its own control. A proposal warning the chosen format
answers (the detector's "ambiguous day/month order") stops being shown once a format is
set, and the warnings render once, beside the columns they belong to.

A text-held date column is also flagged where it can do harm: a query that reads one in
an order-sensitive way — a range comparison (including `BETWEEN`, which DuckDB
serializes as its own node with `input`/`lower`/`upper`), `ORDER BY` on the column, or
`MIN`/`MAX` as an aggregate or a window (`OVER ()`) — carries a `text-date-risk` warning
on its result, because those answers are lexicographic rather than chronological and
nothing else stops the query. (Date functions like `date_trunc` fail loudly on their
own, so they are not listed.) The check does not cover every shape, and the gaps are
documented for the model in the [sql-safety skill](../skills/sql-safety/SKILL.md):
`ORDER BY <alias>` and `ORDER BY <position>` carry no reference to the column, and an
aggregate read through a derived table or CTE resolves against that table. A missing
warning is therefore not evidence that a read is sound, and the skill says so.

Re-previewing a source that already has a candidate proposal reuses that candidate
(same pin id, no re-download) instead of minting a second pending review; scoped and
paged previews reuse it too and still page the proposal they return. Only a source
with no candidate, or a legacy `typed_recipe` pin that must be re-approved
adaptively, produces a new pin. **Deliberate, and disclosed:** reuse does not re-resolve
the source against the publisher's current version, so a candidate can pin a version
Kaggle has since superseded when the caller names no version — reuse must never
overwrite a candidate an analyst may have edited. The result therefore reports
`reusedCandidate: true` alongside the version it pinned, and the tool description
states that an explicit `sourceVersion` is how to propose against a newer one. The
behaviour is unchanged; the caller is no longer left to infer it. The analyst's column
review also reports source-shape problems the reader would otherwise hide: a
duplicated or blank header label (DuckDB renames those before the proposal is
built) and, for Excel, a merged title banner promoted to the table header or rows
whose width differs from the header row. A file that cannot be read at all leads
with the next step before the engine's own reason. When the typed load casts values
to NULL, the ingestion result names the affected columns and ranks them by cast-null
share, with the type that would have accepted the values (`typeReproposals`) — a
named re-proposal to raise with the analyst, not a count to interpret.

The publisher's own Kaggle description and any column dictionary written inside it
are captured with the source and labelled `publisher-supplied` / `unverified`
wherever they appear: `preview_ingest_source`, `resolve_kaggle_version`, the model's
observe text and the analyst's column review. The block carries a banner caveat and
stays quoted publisher text — bounded for the model (a description excerpt, up to 12
dictionary entries, per-note caps) while the review shows the full stored text.

### Semantic layer

Analyst-approved semantic definitions bind business terms to columns and
metrics (`get_metrics`/`propose_metric`). Session-scoped drafts survive reload;
revision checks reject stale saves and approvals. Definitions are resolved and
demand-paged into query context rather than loaded in full.

Publisher-supplied column notes are candidate evidence for a term and never a
definition. `get_metrics` returns either an analyst-approved alias or the term in
`unresolvedTerms` with `nextAction: "ask-analyst"`; publisher wording, a plausible
column name and a successful query cannot resolve or bind a term on their own.

### SQL and query

Read-only SQL against a published dataset version runs in an isolated worker
process with a scrubbed environment, resource limits and cancellation. Query
policy inspects the pinned DuckDB engine's own parsed AST
(`json_serialize_sql()`) rather than a custom SQL parser, applying table and
function allowlists; there is no writable SQL path and no model-accessible
shell. An AST-based advisory (not a hard gate) warns when a query mixes
currency-tagged columns without normalizing them. A `reconcile_totals` tool
compares two independent table totals behind an analyst-approved relationship,
and a `find_top_n` tool answers top-N/extrema questions through a fixed-shape
recipe rather than free-form SQL; both accept common synonyms for their
direction/comparison parameters, and `reconcile_totals` names the two tables
and points at `propose_structure`/`list_pending_structure` when no approved
relationship exists yet. Complete query results are stored outside model
context; the model receives a bounded preview, version identity and validated
complete-result facts (including exact DECIMAL/large-integer values,
integer-domain and distinct-count facts) with an explicit scope statement — a
successful query does not by itself establish uniqueness, missingness,
distribution shape or label trustworthiness.

### Charts, Studio and exports

Constrained chart intents compile to Vega-Lite/Vega specs through bounded
server templates; arbitrary specs, expressions and external data URLs are
rejected. A model or client selects one of a small set of named delivery
profiles (chat-card/sidebar-narrow/sidebar-wide/export); only the chart
service maps a profile to its actual pixel width, and that width bounds the
rendered plot for both faceted and non-faceted charts (single-panel
bar/line/point/area/heatmap, with or without a series legend) — a narrower
delivery context renders a visibly narrower canvas than a wider one, rather
than every chart shape rendering at the same fixed size regardless of where
it's delivered. A long chart title (naturally written when a chart carries
two or more dimensions) is wrapped across multiple lines, bounded by an
estimate of that delivery width's own rendered canvas width, rather than
left on one line — Vega-Lite otherwise widens the whole canvas to fit a long
single-line title, silently ignoring the delivery width the same way an
unbounded plot width once did. The full title is never truncated: it stays
available in full wherever a caller shows it as text (e.g. a Studio/
dashboard slot title), so only the on-image rendering ever wraps. An explicit
vertical bar orientation for long categorical
labels remains the caller's own choice and validates at any delivery width (measured
panel share 36.9–45.2% for a twelve-bar chart with six long labels); the
deterministic chart-choice policy still prefers horizontal for long labels unless a
caller overrides it. Charts default to a colorblind-safe palette with redundant
series encoding, and integer-only result domains get
integer axis ticks instead of invented fractional labels. A deterministic
post-render layout validator checks for collision/clipping defects (overlapping
titles, rotated-into-plot labels, unreadable legends) and for a canvas that is mostly
blank — measured as the plotted panels plus legend against the canvas area, with a
0.25 floor, rather than against estimated label text area, which made the verdict
depend on how long the tick labels happened to be. It also checks chart _correctness_
for aggregated marks: an encoding that emits one bar per input row instead of one per
group fails as `degenerate-aggregate`, which is how the histogram shape below was
caught. A bounded one-retry refinement step can fix a validator-flagged layout
automatically — dropping a facet-column override, or flipping a bar chart to the
horizontal orientation the chart-choice policy already prefers to relieve axis-label
pressure — and keeps whichever render validates better. When that retry reverses an
orientation the caller _explicitly_ asked for, the refinement record carries
`overrodeRequestedFormat` (set only when the retry is actually kept), the change text
names what was overridden and how to keep it vertical, and the tool description tells
the model to disclose it instead of presenting the chart as the one that was
requested. Deliberately not a chart subtitle: extra title lines grow the canvas and
could re-trip the check the repair exists to satisfy.

Data caveats that describe the result ride on the chart image itself. The
tool-payload transport notice ("Preview capped at N of M rows") is deliberately not
one of them: it describes how much of the result the _model_ was shown, not the data,
and captioning a chart that draws every row with it misled the reader. The notice
stays in the tool payload, and results stored before that split are filtered on the
way into a caption.

Analysis Studio is a native dsh sidebar sharing services and persisted state
with chat tools: a column grid, recoverable drafts, revision-checked approval,
direct field/filter/chart-styling edits that reuse the same query policy as
chat, saved revisions and dashboards. Dashboard filters support `eq`, `range`
(numeric or date/timestamp, either bound optional) and `in` (up to 50 discrete
values) shapes, applied/replaced/cleared atomically with explicit scope
disclosure, through a 10-filter bound and the same typed query/service
boundary as any other query. Series color encoding shows up to 20 values from
the current values page. Recent-report cards and portable offline exports
persist across restarts; a style-only edit reuses the exact result ID rather
than minting a new one.

Computed findings and Studio's interpretation-review flow separate
deterministic result facts from generated free-text interpretation: exports
default to facts-only, and approving an interpretation is a same-origin,
revision-bound action. The dashboard report applies the same rule to the summary and
narrative it is handed: they are rendered only when the caller opted in _and_ every
pinned revision's interpretation was approved for export, and a withheld summary is
replaced by the one-line facts-only note rather than dropped silently
(`interpretationApproved` is authoritative, so a caller cannot print an unapproved
interpretation through the narrative either — while an _approved_ review is a ceiling,
not an instruction: it can withhold interpretation, never force it into a report whose
caller explicitly asked to keep it facts-only).

Numbers are formatted for display, not for storage: a plain integer or decimal
cell gains digit grouping (`9688` renders as `9,688`) in Studio's values table
and in a report's display-values table, so both read like the chart axis beside
them, while the exact string the query produced is preserved for CSV, JSON,
result artifacts and provenance. Values that only look numeric - identifiers
with leading zeroes (`007`), ranges and labels (`1988-2017`) - are left
verbatim.

### Tool surface

Four packaged skills (ingestion, semantic layer, SQL, visualization) carry
owned references and tested analytical recipes. `dataset_status` surfaces
per-column profiling. `check_studio_availability` independently re-queries the
same catalog path Studio's overview reads, so an agent can state whether a
saved analysis is actually retrievable rather than assuming it from a save
response. `get_workflow_trail` lists an append-only, identifiers-only record
of ingestion/query/chart/persistence milestones for a dataset or analysis.

### Safety and policy boundaries

Services enforce policy independently of skills; input-intent and
output-outcome classifiers are kept distinct. Every capability sits behind a
narrow typed tool — no model-accessible shell, arbitrary filesystem/network
access, code execution or writable SQL. Analyst queries only ever open
published, immutable datasets read-only; trusted ingestion is the only path
that writes. Query success, a successful cast or an executable SQL statement
is evidence, not proof of business correctness. Only analyst feedback approves
a reusable example; query success alone never does.

## Not implemented / out of scope

- **Publisher-supplied dictionaries are best-effort text, not a Kaggle schema
  feed.** Column notes are extracted from the publisher's own description (markdown
  table and bullet shapes only). A dataset whose description has no dictionary, or
  one written in an unrecognised shape, yields no notes — the number of tables that
  looked like a dictionary but did not decode is reported instead of guessed, and
  mapping a note to a table relies on the nearest markdown heading and stays
  unresolved when that is ambiguous. The text is quoted exactly as published: it is
  not verified against the loaded values, so it can be stale, wrong, or describe a
  different file in the same dataset. That is precisely why it is labelled
  unverified and cannot become a definition.

- **Learning v1.1.** Approval and retrieval exist, but positive paired
  held-out lift over the baseline is unproven, and no live gate has measured
  it. This remains a separate milestone from everything above.
- **Bounded UI coverage.** Analysis Studio edits a single table at a time —
  multi-table joins, brushing and arbitrary field roles are deliberately not
  built, to keep the product's scope explicit rather than becoming a general
  BI editor. Series color encoding is capped at 20 values from the current
  values page; raising that cap is not planned without a demonstrated need.
  Legacy filtered revisions saved before the current filter mechanism lack a
  trustworthy base and would need history recovery to reuse.
- **Chart encoding scope.** Value-domain evidence (integer-domain,
  distinct-count) is computed only for complete stored query rows and only
  drives the integer-tick decision; ordinal axis encodings, schema-level
  distinct-value profiles on `get_schema`, and capped `distinctValues` samples
  in query evidence are unbuilt follow-ons, not shipped capabilities.
- **Source format and deployment scope.** Legacy XLS, SQLite and non-tabular
  Kaggle content (images, audio, text corpora, pretrained-model archives) are
  not supported; `preview_ingest_source` reports this explicitly rather than
  attempting a partial import. Multi-user access, row-level security,
  scheduled reports and enterprise connectors are outside this product's
  single-analyst, loopback-only security model and would need separate design
  and security work.
- **Mixed-encoding residual gap.** Per-record encoding detection resolves a
  file that mixes UTF-8 and windows-1252 rows, but not a single quoted,
  multi-line field whose encoding genuinely changes partway through — there is
  no unambiguous sub-record boundary to split on. This narrower case remains
  undetectable.
- **Tool-surface backlog.** A handful of analytical-recipe/workflow ideas stay
  deliberately unbuilt pending a demonstrated repeat need: file
  inclusion/exclusion during dataset review (e.g. excluding a publisher's
  non-authoritative statistics file), dataset-realism/anomaly checks (e.g.
  suspiciously saturated categorical values), a first-class batched "business
  analysis pack" workflow composing quality/currency/KPI checks, and
  worked-example guidance for naming near-duplicate semantic fields (the
  semantic-layer mechanism itself already supports this; only the reference
  content is missing). All four single-table recipe kinds now have model-facing
  tools (`describe_column`, `find_duplicate_rows`, `bin_elapsed_intervals`,
  `ratio_of_sums`), so the remaining recipe backlog is the batched
  quality/currency/KPI pack described here, not the individual kinds.
  Per-tool model/effort tuning (e.g. a higher-effort model for a specific
  tool) is a deployment/cost tradeoff left to `profiles/data-analyst`, not
  something the packages decide. Studio's live-data staleness is handled by
  polling; push transport (SSE/WebSocket) was considered and set aside unless
  polling staleness proves unacceptable in practice.
- **Tool output typing.** `output.schema` is enforced at runtime against every
  successful tool result (`@deepseek-ai/dsh-tools`), so a loose schema means the
  harness validates almost nothing at that boundary and the tool has to escape
  the declared contract with `as never`. Measured state: **44 tools, 21 strict,
  23 loose** (`node scripts/census-output-schemas.mjs`), pinned by
  [the schema-census canary](../tests/tool-output-schema-census.unit.test.ts).
  - **Strict (21)** — the answer/receipt family, whose returned fields are
    facts the model, the skills' completion states, the client toolviews or
    persistence reason about: `duckdb_query`, `find_top_n`, `reconcile_totals`,
    `investigate_metric`, `make_chart`, `save_analysis`, `list_analyses`,
    `get_analysis`, `check_studio_availability`, `get_workflow_trail`,
    `kaggle_download`, `search_kaggle_sources`, `resolve_kaggle_version`,
    `resolve_kaggle_source`, plus the tools whose own contract the model parses
    directly: `dataset_status` (job status and ingestion diagnostics before
    writing SQL), `cancel_job` (the cancellation receipt), `get_metrics` (the
    ask-the-analyst signal, `unresolvedTerms` + `nextAction`) and four
    recipe-backed analytical tools: `describe_column` (the distribution summary,
    including the `distribution_precision` flag that withholds an unsafe
    average), `find_duplicate_rows`, `bin_elapsed_intervals` and `ratio_of_sums`
    (which states its incomplete-pair rule and withholds a partial ratio). Each declares its
    top-level properties and keeps sub-objects and bulk arrays (`preview`,
    `columns`, `evidence`, `chart`, `profiling`, dashboard and candidate
    records) `additionalProperties: true`, so the line runs between the tool's
    own contract and the service-owned records it passes through.
  - **Loose (23) — deliberate.** Dashboard, export, proposal, job-lifecycle and
    catalog-listing tools carry bulk or service-owned payloads. A per-field
    schema there would convert an additive service change into a hard tool
    failure while buying nothing the allowlisted `renderObserve` projection
    doesn't already bound. Strictness was deliberately not pushed further just to
    raise the count: the remaining loose tools return service-owned records whose
    shapes change additively, and the projection already bounds what reaches the
    model.
  - **Still open:** the `chart` observation kind in `tool-observe.ts` is still
    `z.unknown().optional()`, and the strict set is a judgement about which
    fields are load-bearing, not a claim that the loose 23 are unimportant.
- **Client bundle build step.** The visualization plugin's Studio client
  (`client.js`, ~4,600 lines) is committed as hand-authored `createElement`
  calls rather than compiled from JSX. Verified live against the real
  install path (`dsh plugin add` → `configure:analyst-profile` → `dsh
--profile web`, no local harness source checkout): Studio renders
  correctly, with zero browser console errors, so this is not an unverified
  or broken runtime path. The remaining gap is tooling parity, not
  correctness — reproducing the harness's own client-bundle build preset
  (bundle-purity gate, sourcemap chaining, exact runtime-loader contract)
  so this file could be authored as ordinary JSX and compiled like the
  harness's own client packages are, rather than hand-written. The code
  works and is tested today (`pnpm test` loads the actual `client.js` source
  and mounts its components against a small Node-side DOM/registry shim, not
  a real browser); converting it needs either a way to run the harness's
  real build preset against this package, or an accepted decision that the
  hand-authored form is fine to keep.
  - **Verified working through the real install path; broken only in one dev
    script.** Studio _does_ render correctly: `dsh plugin --profile web add
<checkout>` → `npm run configure:analyst-profile -- --profile web --home
"$DSH_HOME"` → `dsh --profile web ...` (the exact sequence in
    [analyst setup](analyst-setup.md) and the README), against a genuinely
    clean clone with no local harness source checkout — only the ordinary
    published `@deepseek-ai/*` packages `pnpm install` resolves — opens
    Analysis Studio with zero console errors: Data/Explore/Dashboard/Report
    tabs, dataset picker, review inbox, all functional. An earlier version of
    this document wrongly generalized a failure found through
    `scripts/serve-analyst-session.mjs` (a local dev/eval-harness
    convenience script, not part of the documented install path) run with
    `DSH_DATA_PRODUCT_COMPOSITION=webapp`, which layers in
    `tests/fixtures/cordis-overlays/cordis.webapp-product.candidate.patch.yml`
    — an overlay whose own header comment says plainly: "Production default
    path does NOT load this file — live boots stay on the closed profile
    alone." Under that test-only composition, the combined client-plugin
    bundle does throw `SyntaxError: Identifier 'dshDataVizClientModule' has
already been declared`, and the loader reports `dsh-data-viz` "loaded
    without registering ... via `__ModuleLoader__.load`". That symptom is
    real and worth someone eventually running down if that script keeps
    being used for local product-composition experiments, but it does not
    affect the analyst-facing product, and it was wrong to describe it here
    as a general Studio-rendering gap.
  - **2026-09-20 correction: the dev-script symptom was real, reachable, and
    is now fixed — the "does not affect the analyst-facing product" framing
    above was wrong.** `pnpm serve:analyst` (`DSH_DATA_PRODUCT_COMPOSITION=webapp`)
    is not a throwaway convenience script; `deployment/README.md` documents
    `pnpm smoke:analyst:session` (which drives the same composition) as an
    operational check. Reproduced live in a real browser against that
    composition: the app shell rendered "Failed to load plugins — failed to
    import loader entry ... (dsh-data-viz): client-modules: bundle
    /plugins/??… loaded without registering \"dsh-data-viz\" via
    `__ModuleLoader__.load`" — no composer, no preset seat, no Analysis
    Studio. Root cause: `packages/dsh-data-viz/client.js` hardcodes
    `id: 'dsh-data-analyst'` (the file's own contract comment says the
    registration id "MUST be the package name (`dsh-data-analyst`)"), but two
    packages declared a `dsh.client` face for that same file — the root
    `package.json` (id `dsh-data-analyst`, matching) and
    `packages/dsh-data-viz/package.json` (id `dsh-data-viz`, not matching).
    The documented install path (`dsh plugin add` → `cordis.bundle.patch.yml`'s
    bare `dsh-data-analyst` row) always resolved the root package's face, so
    it never showed the mismatch. `profiles/data-analyst/cordis.patch.yml`'s
    dev-boot `data-analyst-viz` row instead pointed straight at
    `packages/dsh-data-viz/dist/index.js`; client-face discovery walks up
    from a resolved module file to its _nearest_ ancestor `package.json`, so
    that row found `dsh-data-viz`'s manifest — and, because that manifest also
    declared a `dsh.client` face for the same file, discovered and served the
    entry under the wrong id, which the browser's `__ModuleLoader__` then
    refused to materialize. Fix: `packages/dsh-data-viz/package.json` no
    longer declares `dsh.client` or the `./client` export — the root package
    is the single declared owner, per its own contract and
    `scripts/public-readiness.mjs`'s requirement that the root package expose
    `dsh.client.platform` and `exports['./client']`. The dev-boot row was
    repointed at a new root-level file, `client-plugin-entry.js` (a one-line
    re-export of `packages/dsh-data-viz/dist/index.js`), so nearest-ancestor
    discovery for that row also lands on the root manifest. Verified after the
    fix: both `dsh --profile web` (53 client modules) and
    `DSH_DATA_PRODUCT_COMPOSITION=webapp pnpm serve:analyst` (50 client
    modules) serve a combined bundle whose single `dsh-data-viz` /
    `dsh-data-analyst` entry is named `dsh-data-analyst/client.js` and
    registers `id: 'dsh-data-analyst'` — entry name and module id now match in
    both compositions — `node --check` passes on both bundles, and both
    render Analysis Studio in a real browser with no "Failed to load plugins"
    error. `tests/client-face-identity.integration.test.ts` now asserts this
    invariant (single declared owner per client file; entry name equals the
    module's own declared id) for both compositions so it cannot silently
    regress again.
  - **Lint coverage (addressed).** `client.js` used to be invisible to
    `eslint.config.mjs` entirely (the config only scoped rules to `**/*.ts`).
    It now has its own config block scoped to that one file, using
    `js.configs.recommended` with `sourceType: 'script'` and an explicit
    browser-global allowlist (`window`, `document`, `fetch`, `AbortController`,
    etc.) instead of the TypeScript-aware block's Node/ESM assumptions, which
    don't hold for a file loaded via the `__ModuleLoader__` runtime contract
    with no module system. Running `pnpm run lint` against the newly-covered
    file surfaced zero real issues (no unused variables, no undeclared
    globals) — the file was already clean, so no code changes were needed
    here beyond turning the linter on.
  - **Type checking (evaluated, found impractical at current scope).** Adding
    `allowJs`/`checkJs` via a scoped experimental tsconfig (targeting only
    `client.js`, `{"target": "ES2022", "module": "ES2022", "moduleResolution":
"Bundler", "allowJs": true, "checkJs": true, "noEmit": true, "strict":
false}`, not wired into the real build or `tsc -b` graph) found 4 errors
    with no `@types/react` present, and 12 after installing `@types/react`
    for real `createElement` signature checking (these two counts move with
    the installed `@types/react` version and TypeScript version — reproduce
    with `npx tsc -p <that config>` against the current lockfile to get
    today's numbers) — all of them false positives stemming from the same
    root cause as the JSX question above: plain destructured parameters
    without JSDoc annotations are inferred as requiring every destructured
    key, `createElement`'s overload resolution can't narrow on a non-literal
    tag argument or an `aria-*` prop, and a handful of DOM/module-loader
    globals (`EventTarget.value`, `window.__ModuleLoader__`) aren't typed for
    this file's actual runtime. None were real logic bugs. Getting real value
    out of `checkJs` here would mean adding JSDoc type annotations across
    most of the file's component functions — the same order of effort as the
    JSX/build-step conversion above, not a lint-coverage-sized task. `tsc`
    still does not check this file; that gap is real and unchanged.
- **Unmeasured live-model pass rate.** The held-out evaluation corpus
  (`nl-eval.ts`) is verified correct in reference mode (executing the
  reviewed golden SQL directly, no model involved). The live NL-to-SQL and
  chart-choice pass rate for the current, expanded corpus has not been
  measured end-to-end in one fresh run. Replays and reference-mode results are
  not a substitute for it.
- **Live visual-QA release gate.** The layout validator itself is proven
  against known-good and known-bad chart shapes, but the statistical release
  gate it feeds (≥90% appropriate charts, zero P0 layout defects, scored by a
  live model opening charts in a booted Studio) has not been run as a gate —
  only as one non-statistical live walkthrough, which is not a gate result.

## Maintenance expectations

Verify a finding against the current tree before changing it. Keep policy in
services, guidance in skills, and raw datasets/artifacts outside model
context. Use existing dsh/DuckDB/Vega APIs, Zod schemas and SQLite
transactions. Update this document and run targeted tests plus `pnpm check` for
behavior changes. Do not edit the
upstream harness or describe an unexecuted gate as passed.
