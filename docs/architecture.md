# Architecture and rationale

## Product boundary

One analyst uses a local DeepSeek Harness (dsh) web profile to import reviewed
**tabular** Kaggle sources (CSV, Parquet, JSON/JSONL, XLSX), ask questions, edit
visualizations and share saved reports. The **Data analyst (isolated)** preset
supplies one reasoning agent with four skills. Analysis Studio is a native dsh
sidebar; it shares services and persisted state with chat tools. dsh owns the
agent loop, sessions, authentication and UI lifecycle.

The scope is tabular Kaggle data only. Non-tabular Kaggle content (images, audio,
text corpora, pretrained-model archives) and legacy XLS/SQLite source files are
not supported — `preview_ingest_source` reports an explicit unsupported-format
reason rather than attempting a partial or silent import. See
[current status](implementation.md) for the full remaining-work list.

The product is distributed as a Git checkout linked through `dsh plugin add`.
The optional `deepseek-harness/` checkout is an upstream reference, never modified
by this project. The [compatibility pin](../profiles/data-analyst/upstream-lock.json)
identifies the reviewed API revision.

## Components

- **Core:** Zod contracts, SQLite metadata, dataset manifests, semantic definitions,
  immutable analysis revisions, result evidence and fixed report templates.
- **Kaggle plugin:** bounded search, source/version resolution, official CLI
  acquisition and archive validation. Downloads are quarantined before ingestion.
- **DuckDB plugin:** source preview, controlled writer, publication, schema lookup,
  engine-parsed SQL policy and isolated read-only query workers.
- **Visualization plugin:** constrained chart intents, Vega-Lite/Vega rendering,
  authorized artifacts, chat cards and the React Analysis Studio client.
- **Workbench plugin:** review actions, analysis/dashboard persistence, Studio and
  fragment routes, persistent report history and export orchestration.

Each capability uses dsh configuration, services and lifecycle hooks. The core is
shared library code; it is not a second application. Internal workers and fixture
adapters are deterministic helpers, not additional reasoning agents.

## Data and approval flow

1. Search or identify a Kaggle source and pin a numeric source version.
2. Inspect supported files and propose table/column storage types. Show unknown
   license, provenance, quality and skipped-file information explicitly.
3. The analyst reviews and approves the proposal. Session-scoped drafts survive
   reload; required revision checks reject stale saves and approvals.
4. A trusted writer loads private staging databases. Raw-preserving typed
   projections expose cast failures and material changes for analyst decisions.
5. Validate and close the database before publishing an immutable dataset version.
6. Resolve approved definitions and demand-page the schema. Execute an authorized,
   bounded SELECT against the published version in a read-only worker.
7. Store complete capped results outside model context. Return a bounded preview,
   version identity and validated complete-result facts with explicit scope.
8. Render a chart, save an analysis revision and pin chosen revisions to dashboards.
   Exports capture those revisions and become persistent report cards only after
   their files are ready.

A source download, successful cast or executable SQL query does not establish
business correctness. Catalog row/rejection counts are ingestion evidence, not
proof of uniqueness, missingness, distribution shape or trustworthy labels.

## Why these choices

### One dsh agent and one analyst interface

Using dsh's existing session, tool and sidebar APIs keeps chat and direct editing
in the same workflow. Skills can change guidance without creating separate agent
loops or maintaining another UI framework. Standard coding presets may coexist on
`web`; their tools are not granted to the isolated analyst preset.

What this rules out is a separate analyst application, or a second agent loop
owning chat. Either would duplicate the session, authentication, streaming and
permission plumbing the harness already owns, and would have to re-implement the
per-preset tool permission model that dsh already applies. The legacy HTMX analyst
surface in `dsh-data-workbench` (`server.ts`, `pages.ts`) is kept for internal test
coverage only: the native sidebar replaced it as the analyst-facing path, which is
the shape this choice produced.

### DuckDB for analysis; SQLite for workflow state

DuckDB provides analytical SQL and native tabular readers without a separate
server. Published databases are immutable so saved results and exports remain
reproducible. SQLite transactions suit small mutable records such as jobs, review
status, revisions and dashboard layouts. JSON remains an interchange format,
not a custom transactional database.

This split requires explicit version references and coordinated artifact
publication. Stale mutations are rejected; dashboard version tokens advance even
when several updates occur in the same millisecond. Metadata migrations are
versioned and require backup and compatibility checks when changed.

### Services enforce policy; skills guide analysis

The model receives narrow typed tools, not a shell, arbitrary filesystem/network
access or writable SQL. Query policy inspects the pinned DuckDB engine's AST using
`json_serialize_sql()` and applies table/function allowlists. There is no custom
SQL parser to maintain. Workers also enforce read-only access, resource limits,
cancellation and a scrubbed environment.

Four skills cover ingestion, semantics, SQL and visualization. Owned references
are packaged into installed skill content within a size budget. Executable
analytical recipes reuse trusted DuckDB services and independent fixtures; no
arbitrary script execution is exposed to the model. Guidance can reduce errors
but cannot guarantee truthful free-text interpretation.

### Bounded evidence and precise values

Full rows, SVG and report files stay out of model context. Complete-result facts
carry version and coverage information; unsafe or incomplete numeric evidence is
withheld. DECIMAL/large integers retain exact representations. Presentation
rounding does not rewrite underlying results. The analyst can inspect values,
query provenance and raw exact values.

### A wide, fixed tool surface, and what it costs

Each capability is a separate narrow tool with a fixed shape — an analytical
recipe, a bounded chart template, an authorised query, a receipt for a completed
action — so the policy boundary is checked per tool against declared arguments,
and the model cannot compose an unauthorised query out of general parts. The cost
is the surface width (40 tools). The alternative it avoids is a handful of general
tools: arbitrary SQL plus generic file and chart access would move policy
inspection into argument space, where "what is this tool allowed to do?" has no
per-tool answer. The inventory is therefore pinned by
`tests/closed-profile-tool-inventory.integration.test.ts`, and the cost of the
choice — a tool whose output contract is loose validates almost nothing at that
boundary — is tracked explicitly in current status.

### Direct controls and constrained rendering

Routine filters, chart styling and layout changes should not consume model turns.
React owns interactive sidebar state and explicit Apply/Discard actions. Styling
reuses a saved result; data changes run through the same query policy as chat.
Shared dashboard filters disclose which saved-result cards they affect and can
be cleared to their recorded base; source-population filters are distinct.

Vega-Lite/Vega supplies established chart generation. Bounded server templates
reject arbitrary specs, expressions and external data URLs. Fixed escaped HTML
reports are portable snapshots with provenance and optional structured findings.
Offline reports do not depend on a running dsh instance. Generated interpretation
is visibly separate from deterministic result facts.

## Security and deployment

The supported deployment is one trusted analyst on loopback. Authenticated dsh
routes resolve workspace authority; model-provided paths or approval flags cannot
override it. External source content is untrusted. Service boundaries remain in
force regardless of prompts, skill text or UI entry point.

No Docker deployment is required. Multi-user authorization, RLS, Internet-facing
hosting, scheduled distribution and enterprise connectors are outside this
security model. See [security](../SECURITY.md) and [operation](../deployment/README.md).

## Release criteria

- At least three datasets with reviewed semantics; SQL correctness ≥80%, chart
  appropriateness ≥90%, answers within two analyst turns and one refinement.
- Saved/reopened analyses, filters, dashboards and exports work through dsh.
- Zero destructive or policy-violating outcomes in the named adversarial suite;
  runtime installation, worker isolation and persistence/restore checks execute.
- Track unsupported numeric/completion claims separately; correct SQL does not
  excuse unsupported interpretation. The bounded narrative zero-unsupported-claims
  gate for the frozen suite was closed under Task 5; free-text chat is still not a
  universal correctness guarantee.
- Learning v1.1 requires positive paired held-out lift and evidence that a reviewed
  correction changes a later compatible answer. Query success never approves memory.

See [current status and remaining work](implementation.md) for what is implemented
and what remains. Unit tests, source
inspection and historical experiments are not interchangeable release evidence.
