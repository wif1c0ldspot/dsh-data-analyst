# Testing and evaluation

## Default verification

```sh
pnpm check
pnpm build
```

Vitest runs unit and integration tests against synthetic fixtures without model
or Kaggle credentials. Package tests live in `packages/*/tests/`; cross-package
inventory, lifecycle and safety tests live here. Native workers need permission
to bind loopback sockets. A sandbox bind failure is not a passed or failed
analytical assertion; rerun in the supported local environment.

`pnpm check` also checks documentation links, public distribution files, lint,
formatting and types. Do not replace runtime checks with file-existence tests.
[Current status](../docs/implementation.md) records implemented capability and open gates.

## Analytical and model evaluation

- `pnpm fixture:analytical-recipes`: execute hand-auditable math fixtures through
  the trusted DuckDB path (bins, NULLs, ratios, duplicates and precision).
- `pnpm eval:heldout`: reference SQL/chart checks on published datasets by default.
  Direct-provider or oracle modes are component evidence, not production-loop scores.
- `pnpm eval:kaggle-sweep <slug> ...`: opt-in live sweep of REAL Kaggle datasets
  through the real pipeline (preview -> approval -> ingest), then the registered
  tools against each published dataset with every payload checked against the
  schema the runtime enforces. Needs a Kaggle token and `DSH_DATA_WORKSPACE`; no
  model calls. Failures are recorded and the run exits non-zero.
- `pnpm eval:refusal`: the 14-case deterministic clarification/refusal policy
  corpus with known dataset and semantic context. HTTP mode is separately opt-in.
- `pnpm eval:versatility`: the credential-free versatility gate — no Kaggle
  token, no model call, no network. It generates its messy fixtures at run time
  in a temp directory (nothing is committed; this distribution ships no sample
  datasets), drives the real pipeline (`preview_ingest_source` → analyst
  approval → `runReviewedIngest` → `publishPendingAdaptation` → the registered
  `duckdb_query`/`reconcile_totals`/`propose_structure` tools through the
  isolated workers) and asserts the documented contract per case: a correct
  result, or an explicit refusal naming the reason and the next step — never
  silent coercion, never a wrong number, never an unhandled crash. Cases: a
  column whose type changes beyond the 200-row sniff sample, duplicate and blank
  headers, RFC4180 quoted commas/newlines, ragged and merged-cell XLSX, a
  two-table CSV set with no declared keys, a mixed ISO-4217 currency column
  (three codes, and one beyond the distinct-value scan cap), windows-1252 /
  UTF-16LE / UTF-16BE / per-record mixed encodings, a 350-column table,
  250,000 rows, inconsistent date formats in one column, an all-NULL column,
  full-row duplicates and leading-zero identifiers. It writes a
  machine-readable JSON report (`packages/dsh-data-duckdb/.versatility-report.json`,
  `--report <path>` to change it, gitignored) plus a printed summary, and exits
  non-zero when a case fails. Runtime is roughly seven seconds here, the
  250,000-row case included. Case definitions and the contract each one asserts
  live in
  [versatility-gate.ts](../packages/dsh-data-duckdb/src/versatility-gate.ts).

  The gate is deliberately **not** wired into
  [`.github/workflows/check.yml`](../.github/workflows/check.yml) yet: it
  currently exits non-zero for a real, recorded contract violation (below), and
  a failing step would turn the shared workflow red. Wire it as
  `- run: pnpm eval:versatility` once that finding is resolved or formally
  accepted as a known gap.

  Current recorded outcome, uncurated:

  - **`mixed-currency-beyond-distinct-scan-cap` — FAIL (contract violation).** A
    monetary column with 30 distinct ISO-4217 codes is neither detected nor
    disclosed: `currency-detection.ts` skips any column with more than
    `MAX_DISTINCT_TO_SCAN` (25) distinct values, while
    [current status](../docs/implementation.md) states mixed-currency columns
    are detected automatically at ingest time. A three-currency column is
    detected and produces the advisory query warning correctly.
  - **`xlsx-merged-title-and-ragged-rows` — pass, two documentation gaps.** A
    merged title banner becomes the header of all three columns
    (`quarterly_sales_report`, `_1`, `_2`) while the real header row loads as
    data, with no warning; the ragged sheet then fails ingest with a raw DuckDB
    dialect-sniff error that names the file but offers no next step. Nothing is
    published in that case, which is the required behaviour.
  - **`duplicate-and-blank-header-names` — pass, one documentation gap.**
    DuckDB's reader renames duplicate and blank headers (`region`, `region_1`,
    `column3`) before the proposer sees them, so a proposal cannot tell the
    analyst that a label was duplicated or blank. Every value still loads
    positionally and no column is lost.

- `pnpm eval:dsh-loop --live`: the actual closed dsh agent/tool pipeline.
  Requires securely configured `DEEPSEEK_API_KEY`, `DSH_DATA_WORKSPACE` with all
  three reviewed datasets, and a separate `DSH_HOME`. Use `DSH_DSHLOOP_REPORT`
  for a local JSON report. Model calls incur provider usage.
- `pnpm eval:dsh-loop --traces <file>`: score saved traces without model calls.
  This output is explicitly a replay/component score, not a fresh run.
- `pnpm eval:narrative`: frozen narrative claim corpus (SQL/provenance/receipts
  deterministic; interpretation via human claim annotations). Default grades
  synthetic baseline traces. `--traces` grades operator JSON; `--live` uses the
  pinned closed composition and leaves interpretation pending until reviewed.
  Corpus: [narrative-eval.ts](../packages/dsh-data-duckdb/src/narrative-eval.ts).

The Core corpus contains 69 unique cases: 23 each for Superstore, Online Retail
and Olist. The extra synthetic retail case is CI-only. Missing datasets or
repeated case IDs cannot satisfy the production coverage gate. Corpus definitions
and expected values live in
[nl-eval.ts](../packages/dsh-data-duckdb/src/nl-eval.ts).

## Scoring contract

Expected results are independently reviewed. Compare returned values, types,
NULL behavior, order/ties and declared tolerances, not SQL text. Include boundary
values, returns, unequal subgroup sizes, many-to-many fanout and exact decimals.

Chart scoring checks reviewed marks and result-field roles. A chart must return
an artifact and reference the answer query result. Equivalent reviewed aliases
may be accepted; wrong axes, missing artifacts or unrelated data fail. Automated
chart scores do not replace browser inspection of labels, colours and clipping.

Record model/provider, code revision, dataset versions, semantic revisions,
questions, case denominators and failures. Report tool/query counts, per-case and
batch time, provider token buckets and metric coverage. Missing measurements are
unknown, not zero. Count analyst turns both with and without required approvals.
Preserve original results when correcting an evaluator and label any rescore.
Do not tune expected answers to make a run pass.

These corpora are definitions and expected values, not shipped data: no dataset
archive is distributed, so a live `eval:dsh-loop` run needs your own Kaggle-token
sources ingested into `DSH_DATA_WORKSPACE` first. Missing datasets skip rather than
pass.

Release targets are SQL ≥80%, chart ≥90%, answers within two analyst turns and
one refinement. Unsupported numeric/completion claims are a separate gate; do
not hide them inside aggregate accuracy. Multiple trials and paired comparisons
are needed before claiming stable improvements from nondeterministic models.

## Safety and workflow coverage

The named safety suite is
[safety-attack-suite.integration.test.ts](safety-attack-suite.integration.test.ts).
Tests cover SQL writes/external access, unauthorized datasets/artifacts, unsafe
rendering, prompt-data boundaries and the closed tool inventory. Other integration
suites cover archive handling, staged publication, cancellation, restart state,
revision conflicts, filter rollback and exact exports. Zero violations in these
cases is not a universal security guarantee.

Chart _correctness_ has its own frozen fixtures beside the layout corpus, under
`packages/dsh-data-viz/tests/fixtures/btc-run/`:
[chart-layout-validator-btc-run.unit.test.ts](../packages/dsh-data-viz/tests/chart-layout-validator-btc-run.unit.test.ts)
asserts that a correct 117-point line chart and a correct 34-bin bar chart validate,
and that the two per-row histograms from that run fail as `degenerate-aggregate` — an
aggregate that emitted one mark per input row. Both charts have one identical
560×320 panel and canvases within 0.6% of each other, so a change that flips one
verdict without the other is a regression in what the check measures. The
text-date-warning shapes are pinned the same way, in
[text-date-warnings.unit.test.ts](../packages/dsh-data-core/tests/text-date-warnings.unit.test.ts),
including the ORDER BY alias/position and derived-table cases that are documented
limits rather than covered shapes.

Browser acceptance should cover preview → type review → approval → ingestion →
metric review → analysis → chart refinement → save → dashboard filter/clear →
report → restart/reopen. Inspect light/dark modes, narrow panes and keyboard focus.
Verify a style-only edit retains its result ID and uses no new SQL/model call.

### WebUI dataset acceptance suite

`pnpm eval:kaggle-sweep` proves the pipeline and the tool payloads against real
Kaggle data without a model. This suite covers what it cannot: the agent and the
Studio on the same datasets. Bring your own Kaggle token; nothing ships with the
repo. Per dataset, record: whether the agent asked before assuming, which tools it
chose, token/time, and any refusal that named a next step.

| Dataset                                               | Shape it exercises                  | Watch for                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vivek468/superstore-dataset-final`                   | small CSV, 2 date columns           | dates publish as VARCHAR with a "no value matched any DATE format" warning — the agent must ask for day-first vs month-first, never guess                                                                                                                                                                                                                                                                                                                                     |
| `muratkokludataset/dry-bean-dataset`                  | XLSX, 16 numeric features           | Excel path; `describe_column` on a feature column                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `dhoogla/unswnb15`                                    | Parquet, 2 tables                   | Parquet path; two tables with no declared keys                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `rmisra/news-category-dataset`                        | JSON, 209 K rows, real `date`       | time grouping works (`date_trunc`); categorical grouping                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mczielinski/bitcoin-historical-data`                 | CSV, 7.7 M rows, epoch `timestamp`  | BIGINT epoch: the agent must use `TIMESTAMP '1970-01-01 00:00:00' + col * INTERVAL '1 second'` (see the sql-safety skill), and must not blow the request budget. Also the shape that exposed two chart-layer defects (both fixed): a 2,454-row histogram rendered as one full-height mark per row, and captions claiming a 20-row preview the chart never applied. Check that aggregate marks look like bins, and that no caption or export carries a payload-preview notice. |
| `jayeshsalunke101/brazilian-ecommerce-public-dataset` | multi-file CSV, 9 tables, 1 M+ rows | `propose_structure` then analyst approval before `reconcile_totals` will run                                                                                                                                                                                                                                                                                                                                                                                                  |

Steps per dataset: preview → column review (check every warning is visible in the
UI, not just in the payload) → approve → ingest → three questions that need a tool
(one distribution, one duplicate/quality, one time or ratio) → chart → dashboard →
report → restart and reopen. A dataset is accepted when each step either completes
or refuses with a reason and a next step.

## Learning evaluation

Learning v1.1 remains open. Compare the same frozen challenge set and model with
reviewed-example retrieval disabled/enabled. Exclude held-out questions and
corrections from retrieval. Report paired gains, regressions and uncertainty;
prove a reviewed correction changes a later compatible answer. Revoked and
incompatible examples must be excluded. Execution success never approves memory.
