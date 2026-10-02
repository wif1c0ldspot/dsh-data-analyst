---
name: semantic-layer
description: Propose and clarify business metrics, table grains, and relationships with analyst-approved definitions. Load this whenever a business term (revenue, churn, a KPI) needs binding to schema, or a join's cardinality/safety is in question — the second of four analyst-workflow stages, reloaded whenever that need recurs, not only once per session.
---

# Semantic meaning

Use the packaged metric-contract reference at the end of this skill when proposing
or checking any reusable metric definition.

Resolve business terms against the selected dataset version and approved semantic
revision. Ask when meaning is unresolved, then persist/reuse the analyst's decision
through the available semantic tools and authenticated approval workflow.

A definition needs table grain/keys, expression, default aggregation, units and
currency, date/calendar/timezone, NULL handling and inclusion/exclusion rules.
Relationships need cardinality and verified key coverage. Proposed relationships
or metrics are not approved merely because a query executes. Separate observed
facts (profiled evidence), proposed interpretations, and analyst-approved
definitions; an unknown grain, key, or join cardinality stays unknown until it is
supported by evidence and an analyst decision — narrative alone does not make a
many-to-many join safe.

For Olist, items and payments can multiply each other when joined at order level:
use approved grain-safe aggregations and reference checks. When two tables carry
independently-summable totals for the same thing at different grains (e.g. an
order-level total column vs. an item-level line-amount column), use
`reconcile_totals` instead of writing a join yourself — it requires an
analyst-approved relationship between the two tables and returns the delta/
delta share directly. For retail, negative amounts may represent returns;
distinguish gross and net sales. Never average ratios when a ratio of
aggregates is intended. Churn/cohort questions require a business definition
and observation window.

## Link question terms to schema

Before SQL, make a compact working table with `question term`, `candidate
table.column or expression`, `evidence`, and `status`:

1. Separate requested measures, dimensions, filters and time terms.
2. For each term, call `get_schema` with `datasetId`, a focused `search`, and a
   bounded `limit`. Add `tables` when the relevant table is already known. Follow
   the returned `nextOffset` with `offset` until plausible candidates are resolved
   or exhausted; do not load the full schema merely to search it.
3. Compare names, types, table grain, relationships, aliases and quality evidence.
   Keep multiple candidates when the evidence does not distinguish them.
4. Call `get_metrics` with `datasetId` and the unresolved business `terms`.
   Prefer an approved, version-compatible definition. If none exists, or multiple
   candidates would materially change the result, ask the analyst and use
   `propose_metric` when the supported definition is ready for review.
5. Pass only resolved bindings, their grain and approved expressions to the SQL
   stage. An unresolved term stays unresolved; a plausible column name is not an
   approved metric.

A publisher-supplied column note (from the Kaggle source description, labelled
`publisher-supplied`/`unverified`) is candidate evidence for a term, never a
definition: it can suggest what to ask the analyst, but the term stays unresolved
until an analyst-approved definition exists, and a publisher's wording is not
approval. Never bind a term because the publisher's description, a column name or
a running query appears to agree with it.

Scripts/services validate definitions, profile evidence, check compatibility and
persist revisions; the model proposes meaning. Do not put the complete schema or
raw data into context. Scope examples and preferences by workspace/data/semantic
version; only external review promotes SQL examples, and presentation preferences
cannot override factual definitions.

## Review handoff

Explain only the unresolved meaning and its analytical impact; avoid repeating the
whole review form. Submit the supported proposal so an authenticated analyst can
review it. Saving source column types does not approve a metric, unit or
relationship. A proposed interpretation remains a proposal until its review
status confirms it.
