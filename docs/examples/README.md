# Real output, unedited

These four files are actual artifacts from one live session, committed so you can look at
what this agent produces without installing anything, running a server, or holding a
DeepSeek or Kaggle credential. None of them is a mock-up.

**Source:** `mczielinski/bitcoin-historical-data`, pinned source version 727 (retrieved
2026-09-19), 392 MB CSV, 7,740,126 rows, 6 columns. Kaggle's metadata reports the licence
as CC-BY-SA-4.0 and omits a version number, so the pin cannot be verified and the agent
says so on every answer it gives for this dataset; the attribution and pin travel in the
report caption and in the chart provenance.

**Session:** preview → column review → approve → ingest → three tool-backed questions →
line chart → style-only edit → dashboard → report export. The prompts were the same shape
as [the first session](../analyst-setup.md#first-session).

| File                                | What it is                                                                                             | What it demonstrates                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bitcoin-daily-returns-report.html` | The exported management report (one dashboard card): self-contained offline HTML, opens in any browser | The shareable deliverable: title, four KPI cards, the chart as inline SVG, the pinned dataset version, the exact SQL, and the facts-only note. Interpretation is `unreviewed` here, so the narrative is withheld and the report says why |
| `bitcoin-daily-returns-bins.svg`    | Distribution of daily returns, 1 percentage-point bins (34 bins, 2,454 days)                           | A distribution the agent reached by binning in SQL after the histogram template's own binning proved too coarse to read                                                                                                                  |
| `bitcoin-histogram.svg`             | The same distribution through the `histogram` template                                                 | The template's own binning (five bins) — bar heights are day counts, not a normalized shape                                                                                                                                              |
| `bitcoin-monthly-close-line.svg`    | Monthly mean of 1-minute closes, 2017–2026 (117 points)                                                | A time series whose epoch-seconds column had to be converted with the allowlisted arithmetic idiom; 117 points, no truncation, no caveat pretending the chart is a preview                                                               |

## How to read them

- **The report is the product.** Open the HTML file directly (`open
bitcoin-daily-returns-report.html`); it needs no server. The ZIP that a user also gets
  alongside it bundles `chart.svg`, `chart.png`, `data.csv` and `specification.json` per
  section — the report links those as downloads.
- **Every number is checkable.** The report names the dataset version, the semantic
  revision and the SQL for each section, and the underlying figures came back from
  full-coverage queries rather than samples (row count, key uniqueness across all
  7,740,126 rows, date coverage, continuity, missingness, extremes).
- **What is deliberately absent.** No generated interpretation in the report until an
  analyst approves it; no claim that a successful query establishes business meaning; and
  no silent repair — when a chart's requested orientation has to be reversed to stay
  readable, or a preview candidate is reused at an older source version, the answer says so.

The hand-written semantic-pack example that used to sit in this folder lives with the
fixtures it belongs to: [`tests/fixtures/retail-semantics.json`](../../tests/fixtures/retail-semantics.json),
referenced by the contracts doc's worked synthetic example.
