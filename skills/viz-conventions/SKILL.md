---
name: viz-conventions
description: Select and refine chart encodings over an authorized query result, report the actual completion state, and handle analyst chart-quality feedback. Load this whenever the analyst wants a chart, wants to save/export/dashboard saved work, or reports a chart layout problem — the fourth of four analyst-workflow stages, reloaded on every chart/save/export turn, not only once per session.
---

# Chart intent

Use the packaged chart-and-delivery reference at the end of this skill before
claiming that a visualization or persisted/exported deliverable is complete.

Use `make_chart` with an authorized result ID and constrained chart intent. Save
with `save_analysis`, add saved work with `add_to_dashboard`, and create portable
artifacts with `export_report`. After saving, call `check_studio_availability` to
independently confirm the revision is retrievable via the Studio sidebar rather
than assuming it from `save_analysis`'s success alone. Report tool failures
rather than emitting arbitrary executable HTML or JavaScript.

For report narrative fields, put the concise answer in `findings`, material
limitations in `caveats`, and a concrete follow-up only when useful in
`nextSteps`. Keep chat to the outcome, material caveat, and how to open the
persisted report; keep SQL, IDs, and detailed provenance in the report.

When the analyst asks to reuse saved work, call `list_analyses` first and open
matching revisions with `get_analysis` before running a new query or chart. Pin
those persisted analyses directly when their question, result and chart match;
do not recreate an existing saved view merely to compose a dashboard.

Immediately before `export_dashboard`, call `get_dashboard` and use that current
state when writing the report. After export, use the export receipt's captured
slot revisions and filter mappings for completion claims; older conversation
receipts describe historical states and must not be presented as current.

Prefer line for ordered time series, bar for category comparisons, point for two
quantitative measures, histogram for distributions, boxplot for distribution by
category, heatmap for a quantitative value across two categorical dimensions
that are both low-cardinality (each a bounded, human-scannable set of values —
a large or unbounded dimension makes the grid unreadable and belongs in a
table or a bar chart instead), area for ordered magnitude or composition, and
KPI/table for a scalar or exact values. Use
`series` plus `stack: "zero"` for additive composition or `"normalize"` for shares.
Use `facet` for bounded small multiples when one shared scale remains meaningful.
Use `y2` only for a line/area comparison of two result measures with compatible
units; otherwise produce separate charts. Choose based on the question, units,
grain and cardinality — a scalar may need a KPI, a precise comparison a table, a
time trend a line, a category comparison a bar, a relationship a point plot, and
a distribution a histogram/boxplot — not column type alone. Do not require
redundant graphics for every diagnostic query. Maps need validated coordinates or
licensed geometry/key mappings and are later scope. Avoid part-of-whole charts
with many categories or negative values.

Check field types, units, grain, sort, axes, labels, aggregation and cardinality.
Expose empty results and oversized data honestly. Keep original exact values in
the table/export even if the renderer needs a checked numeric conversion.
Occupied time bins do not establish complete observation coverage or exposure.
Means and medians alone do not establish tail prevalence or diagnose skew. Base
dominance and scale claims on checked values and, when visual appearance matters,
the rendered chart rather than a successful chart tool response.
Use only approved semantic metadata to decide whether a measure is additive or
rate-formatted. Never infer measure meaning from a column name. When semantics
are missing, prefer an unstacked exact-value view or ask the analyst to clarify.

When result evidence marks a field `integerDomain: true` (especially with low
`distinctCount`), treat it as a discrete dimension for category comparison:
prefer bar and rely on auto integer ticks, or set `format.xTicks: "integer"`.
Never infer discrete-ness from a column name. Fractional values keep continuous scales.

Presentation-only changes reuse the result ID. Filters, grouping, SQL, dataset or
semantic changes require a new result/revision. A local selection applies only to
loaded data, not the full source population.

The renderer validates/compiles templates and generates artifacts. The analyst
receives the chart, accessible table, SQL, filters and provenance through the UI;
the model receives compact IDs/summaries, never full SVG or all rows. Exports use
the saved analysis revision and fixed report templates. HTMX is not an export
format, and a downloaded static report cannot depend on a running server.

Only pass result-column names in `x`, `y`, `y2`, `value`, `series`, `facet`, and
`sort.field`. Never pass Vega/Vega-Lite, expressions, transforms, URLs, HTML, or
scripts. Complex charts are selected through the bounded intent fields and remain
server-compiled templates.

Recommend one view with a question-based reason. Offer a useful alternative only
when there is a real tradeoff (line for trend; table for exact month values).
Do not generate three variants, decorative KPIs or extra charts by default.
Use metric, unit, grain and population in titles; a filtered view must not be
introduced as the original comparison. Retain stable category colours and
consistent precision across related views, with exact values accessible.

Tables and reports group displayed digits (`9,688`) so they read like the chart
axis beside them, while exports and artifacts keep the exact value (`9688`).
These are the same number: never present the two forms as different figures, and
quote the exact value when reporting a count.

## Readable presentation and colour choices

Use `intent.format.orientation: "horizontal"` for long categorical bar labels. If a
chart is rejected for excessive blank space and you set an explicit vertical
orientation, the service already tries the horizontal form once; reflowing the legend
instead will not fix it, so report the rejection rather than retrying placements.
Use `intent.format.xTicks: "year"` only after confirming the X field represents
a year (numeric or date); do not infer that from a field name.

Suggest a restrained single colour (`format.color: "#0072B2"`) for one measure,
or `format.palette: "colorblind"` for distinct categorical series. Explain the
choice briefly, avoid assigning red/green to good/bad without agreed meaning,
and keep related views consistent. Colour alone must not communicate the finding.

Keep chart and card titles short. Put full methodology, source limitations and
interpretation in the saved analysis/report. State whether filters apply to
source rows before aggregation or to saved aggregate rows. Do not claim visual
inspection from a successful tool response; distinguish a created artifact from
a browser-verified artifact.

## Report the actual completion state, not the highest one available

Four distinct states exist, and each is backed by its own typed, tool-produced
fact — never by free-text self-attestation:

1. **Rendered** — `make_chart` returned `rendered: true` plus a `layoutValidation`
   result. This is _only_ a rendering fact. It is never a persistence or
   Studio-visibility claim, and `make_chart`'s schema has no field that could be
   read as either.
2. **Persisted** — `save_analysis` returned `persisted: true`. This proves an
   immutable revision exists; it says nothing about whether that revision is
   currently visible in the Studio sidebar.
3. **Available in Studio** — call `check_studio_availability` after saving and
   report only what it returns (`availableInStudio`, computed by re-querying the
   Studio overview route itself, not inferred from the save call succeeding).
4. **Delivery verified** — `layoutValidation.ok` is `true` _and_ the chart has
   actually been opened and inspected in Studio at a supported width. Rendering
   plus a passing validator is necessary but not sufficient for this state.

Report the exact state reached, for example: "Chart rendered and passed layout
validation; open it in Studio to confirm the visual result" when only states 1
(and optionally 2/3) are true. Never say a chart was "visually verified,"
"inspected," or "looks correct" unless it was actually opened in Studio — a
passing `layoutValidation` is a deterministic geometry check, not a substitute
for that.

## When the analyst reports a chart layout problem

If an analyst says a saved chart's layout is wrong — overlapping text, a
clipped label, an unreadable or blank legend, an orientation that doesn't fit
the labels, or excessive blank space — file it with `report_chart_issue`
(needs the artifact id and the analysis id/revision it belongs to) rather than
only apologizing or silently re-rendering. This creates a reviewable record an
analyst can act on later; it is never auto-approved into anything, and you
cannot approve it yourself. Use `list_chart_feedback` if the analyst asks what
has already been reported. Filing feedback does not replace fixing an
immediate problem you can actually resolve now (e.g. switching orientation for
long labels) — do both when a concrete fix is available.
