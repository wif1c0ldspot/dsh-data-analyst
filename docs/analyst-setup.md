---
title: Setup for data analysts
status: local analyst preview via plugin on the standard dsh web profile
updated: '2026-09-20'
---

# Setup for data analysts

Install this checkout into the standard dsh **web** profile, load the isolated
**Data analyst** preset, and talk to the agent in the browser. Standard /
Creator remain available on the same profile when you need coding tools.

For a shorter overview see the repository [README](../README.md). Architecture
and gates: [architecture](architecture.md), [implementation](implementation.md).

## Prerequisites

| Tool                                                                | Version                                           | Why                             |
| ------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------- |
| [Node.js](https://nodejs.org)                                       | 24 LTS (`.node-version`)                          | Packages and tests              |
| [pnpm](https://pnpm.io)                                             | 11.7.0 (`package.json#packageManager`)            | Workspace install               |
| [uv](https://docs.astral.sh/uv/)                                    | recent                                            | Pinned Kaggle CLI venv          |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | pin in `profiles/data-analyst/upstream-lock.json` | `dsh` runtime + web UI          |
| DeepSeek API key                                                    | —                                                 | Live natural-language chat      |
| [Kaggle](https://www.kaggle.com) token                              | —                                                 | Only when downloading real data |

Build and tests need no model or Kaggle credentials.

**Supported platforms:** macOS and Linux, matching what `.github/workflows/check.yml`
actually runs in CI (`ubuntu-latest` and `macos-latest`, both x64 and arm64 —
this project's native dependencies, `@duckdb/node-api` and `@resvg/resvg-js`,
both publish prebuilt binaries for every combination CI covers, so no
compiler toolchain is needed on either). The setup commands below are POSIX
shell (bash/zsh). Windows is not tested; use WSL2 with a Linux distribution
rather than a native Windows shell.

## 1. Clone, install, build

Set `DSH_DATA_ANALYST_REPOSITORY` to the GitHub clone URL you were given.

```sh
git clone "$DSH_DATA_ANALYST_REPOSITORY" dsh-data-analyst
cd dsh-data-analyst
pnpm install --frozen-lockfile   # pnpm 11.7.0, pinned via package.json#packageManager
npm run build
# Optional full gate (no credentials):
# npm run check
```

Use the frozen pnpm lockfile for installation. `pnpm check` afterwards covers
documentation links, distribution files, lint, formatting, types and tests.

## 2. Install the plugin into dsh web

Match the harness revision in
[`profiles/data-analyst/upstream-lock.json`](../profiles/data-analyst/upstream-lock.json)
(`packageVersion` `0.1.5-rc.2`). Put `dsh` on your `PATH`, or run the CLI from a
harness checkout (`pnpm dsh …` / `node --import tsx/esm apps/cli/src/bin.ts …`).

If you do not already have the pinned harness, this optional source-checkout
setup defines `dsh` for the current Bash/Zsh shell. Run from this repository root:

```sh
analyst_repo="$PWD"
harness_revision="$(node -p 'JSON.parse(require("fs").readFileSync("profiles/data-analyst/upstream-lock.json", "utf8")).commit')"
git clone https://github.com/deepseek-ai/deepseek-harness.git deepseek-harness
git -C deepseek-harness checkout "$harness_revision"
pnpm --dir deepseek-harness install --frozen-lockfile
pnpm --dir deepseek-harness build          # required: the web UI's client bundles are build output
dsh() { pnpm --dir "$analyst_repo/deepseek-harness" dsh "$@"; }
```

Skip the clone if you already have that checkout and verify its revision instead.
The directory is ignored by this project and must not be edited for plugin changes.

The harness `build` step is easy to miss and fails late: without it `dsh web` exits with
`plugin tree failed to load: ... client-modules: 45 client packages failed to compose:
client bundles not found; run 'pnpm run build' before launch` and never serves a page.
Measured on a clean clone: install 12s, harness build ~90s, launch 30s.

**On Apple Silicon, make sure the harness is built for arm64.** If your shell runs under
Rosetta (`sysctl -n sysctl.proc_translated` prints `1`), `cc` targets x86_64 and the
harness's host addon is compiled for the wrong architecture while Node runs arm64. The
symptom appears mid-session, not at startup — dsh crashes with:

```
dlopen(.../native/system/packages/darwin-arm64/bin/system.node, 0x0001):
mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64')
```

Check both sides before filing it as a product bug:

```sh
node -p process.arch                                                    # expect: arm64
file deepseek-harness/native/system/packages/darwin-arm64/bin/system.node  # expect: arm64
```

If they disagree, rebuild the addon with the native toolchain and restart dsh:

```sh
arch -arm64 pnpm --dir deepseek-harness build:native-system
# or run the whole harness build under the native arch: arch -arm64 zsh -c 'pnpm --dir deepseek-harness build'
```

This project's own native dependencies (`@duckdb/node-api`, `@resvg/resvg-js`) ship
prebuilt binaries for both architectures and are not affected.

If `dsh plugin --profile web add` fails with `Cannot find package '.../corepack/…
/pnpm/<version>/bin/pnpm.cjs'` (a broken corepack-managed `pnpm` shim on `PATH`
ahead of a real `pnpm`), install `pnpm@11.7.0` directly rather than through
corepack and put its bin directory first on `PATH`, then retry.

```sh
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
export DSH_DATA_WORKSPACE="${DSH_DATA_WORKSPACE:-$HOME/.local/share/dsh-data-analyst}"
mkdir -p "$DSH_DATA_WORKSPACE"

dsh --profile web --dump-config >/dev/null
dsh plugin --profile web add "$PWD"
npm run configure:analyst-profile -- --profile web --home "$DSH_HOME"
npm run smoke:plugin:local
```

`configure:analyst-profile` copies `profiles/data-analyst/presets/analyst/` into
`$DSH_HOME/.agent-presets/analyst`, packages the skills straight into
`$DSH_HOME/.agent-presets/analyst/skills` (not the local `dist/analyst-skills`
build output — that path is only for running this checkout directly), and
rewrites the preset's skill-root placeholder to point at that copy. It
does **not** apply the closed-host deny-list to `web`.

The isolation the analyst gets therefore comes from the **preset's tool scope**,
not from removing the harness's own tool rows: with **Data analyst (isolated)**
selected the model can reach only the analyst tools and the skill loader, while
the same `web` profile's **Standard** and **Creator** presets deliberately expose
the harness's full toolset — including shell, filesystem and web access. Both
scopes are asserted in
[`tests/webapp-preset-tool-inventory.integration.test.ts`](../tests/webapp-preset-tool-inventory.integration.test.ts).
Keep the isolated analyst preset selected for analytical work, and switch presets
deliberately.

## 3. Set up Kaggle credentials

Required before live source preview or download (not for build/test). Prefer
token-only auth after `uv sync` (above):

```sh
cd tools/kaggle-cli && uv sync && cd ../..   # pinned kaggle==2.2.4 venv

mkdir -p ~/.kaggle
# Create an API token at https://www.kaggle.com/settings/api, then save the
# one-line token string (only the token — no username, no JSON) as:
#   ~/.kaggle/access_token
chmod 600 ~/.kaggle/access_token

# Proves the token works, without printing it:
tools/kaggle-cli/.venv/bin/kaggle datasets list -s superstore
```

Auth is **token-only**: no Kaggle username is required or read by this
project's code — the pinned CLI (`kaggle==2.2.4`) introspects the account
from the token itself. `export KAGGLE_API_TOKEN=...` (token value or a path
to the token file) works the same as the file. Never paste a token into chat,
a commit, or an issue; `pnpm doctor` and this project's own error messages
report only token presence/absence and the fix command, never the value.

If preview fails with a message about a missing pinned Kaggle CLI, the venv was
not created — re-run `cd tools/kaggle-cli && uv sync`. Override path with
`DSH_KAGGLE_EXECUTABLE` only when you intentionally use another install.

Five failure modes tested directly against this pinned CLI (2026-09-20):

| Case                                                      | Observed                                                                                                                                                                                                                                               | Actionable?                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| No token file, no `KAGGLE_API_TOKEN`                      | CLI prints "Authentication required...", both the `kaggle auth login` OAuth path and the manual-token option (URL + `~/.kaggle/access_token`), exit 1                                                                                                  | Yes                                             |
| Pinned venv missing (`tools/kaggle-cli/.venv` absent)     | This project's own preflight fails closed before spawning anything: `Pinned Kaggle CLI executable not found. From the repo root run: cd tools/kaggle-cli && uv sync. Or set DSH_KAGGLE_EXECUTABLE to an absolute path for an installed kaggle binary.` | Yes                                             |
| Malformed token (garbage string in `access_token`)        | Identical "Authentication required..." message as the no-token case                                                                                                                                                                                    | Yes, but not distinguishable from "no token"    |
| Well-formed but invalid/revoked-shaped token              | Identical "Authentication required..." message again                                                                                                                                                                                                   | Yes, but not distinguishable from the other two |
| Token file with wrong permissions (`644`, world-readable) | **No failure** — the CLI does not check file permissions and reads it successfully                                                                                                                                                                     | N/A — negative result                           |

The pinned CLI collapses "no token", "malformed token" and "invalid token"
into the same message; it always names the fix (generate a token, save it,
or run `kaggle auth login`), so it clears the actionable bar even without
distinguishing the three cases. `chmod 600` is this project's own defense-in-depth
recommendation, not something the CLI enforces — a world-readable token file
is still accepted.

Details: [tools/kaggle-cli/README.md](../tools/kaggle-cli/README.md).

## 4. Start dsh and load the analyst preset

```sh
export DEEPSEEK_API_KEY="..."   # shell only; never commit
dsh --profile web --host 127.0.0.1 --port 3080 --no-open
```

1. Open the printed `dsh web: http://127.0.0.1:3080/?token=…` URL (exchanges the
   token for a session cookie). The token is not one-time: it stays valid for the
   life of that server process, so treat the URL as a local credential — keep it
   out of chat and issues, and restart dsh to rotate it.
2. Select / attach the **Analyst data** workspace (`DSH_DATA_WORKSPACE`).
3. Set the agent preset to **Data analyst (isolated)** for the locked inventory
   (no shell / arbitrary fs / web / subagent tools in that preset).
4. Chat without pasting SQL or internal IDs.

Restart with the same `DSH_HOME` and `DSH_DATA_WORKSPACE` to restore conversations,
analyses, and dashboards.

## First session

This is the guided version of the README's one-line starter: what to say, what the
agent does with it, what you have to decide, and how to tell a real answer from a
plausible one. Budget about twenty minutes and keep the sidebar open — it is where
every decision that is yours to make actually happens.

The model **cannot approve anything on your behalf**. Preview, column review and
publication are three separate gates, and the middle one is yours.

### Before the first prompt

1. Select the **Analyst data** workspace and the **Data analyst (isolated)** preset
   (see step 4 above). With any other preset the agent has the harness's full
   toolset, which is not what this walkthrough assumes.
2. `/analyst-data` opens the Studio sidebar; `/analyst-reviews`, `/analyst-explore`,
   `/analyst-dashboard` and `/analyst-report` jump straight to the other panes. None
   of them costs a model turn.
3. Have a Kaggle slug ready, or use `vivek468/superstore-dataset-final` as below —
   it is small, and its two date columns are both deliberately awkward (the column
   review in step 1 shows why).

### 1. Preview a source, then review its columns yourself

> Preview `vivek468/superstore-dataset-final` and show the column review.

The agent may _not_ publish it. A preview only stages a candidate pin: an archive
inventory, a proposed table, per-column storage types inferred from a sample of at
most 200 records, and every warning it found. Read the warnings — that is the point
of the step — then open **Open column review** in the sidebar card (or
`/analyst-data`) and decide the storage types yourself:

- **Types are a proposal, not a promise.** They come from a sample; Save type changes
  is what applies your revisions.
- **Ambiguous dates are still text.** For superstore the detector reports
  _"DATE format not persisted: ambiguous day/month order"_: `order_date` and
  `ship_date` published as `VARCHAR`, because 12/8/2016 could be either 12 August or
  8 December. Pick the calendar you know the source uses (month-first here) in the
  format control and save it with the types. Guessing is what produces a
  `text-date-risk` warning later.
- **Approve is a separate click from saving types.** Save the edits, then Approve (the
  pair sits in the decision footer at the bottom of the review). Approve means "this
  source, at this version, with these types, may be published".
- **Unsaved edits survive a reload** within the same session, and the review says so.
  A save or approval against a proposal that moved meanwhile is rejected rather than
  applied; the Refresh buttons re-fetch it and tell you what changed.

Ask what the agent knows about the source while you are here:

> Which quality checks are established for this source, and which are still unknown?

Expect a split answer: row counts, null shares and sample-based type inference are
established; anything the publisher did not document (units, exchange, version
identity, licence) should come back as unknown, and the proposal says so.

### 2. Ingest it, and ask what you got

> Ingest the approved source, then tell me what a row means, what the key is, and
> which columns carry quality caveats.

Publication is a real load into DuckDB, not a copy: read the briefing that comes
back — row count, grain, key uniqueness across every row, date coverage, continuity,
missingness and extremes, each as a _full-coverage_ query rather than a sample. For
scale, the same path on a 392 MB / 7,740,126-row Kaggle CSV previewed in 20 seconds
and ingested in about 30. If a claim in the briefing is load-bearing for your analysis,
ask for the query or re-run it in **Explore** — on superstore the row count the ingest
reported (9,994) and the two text-held date columns are the ones worth confirming.

The ingest is also where you learn what the source cannot answer, and that answer is
specific to what you loaded. Superstore publishes both dates as ambiguous text, so the
agent should refuse a time-based answer until the format is set in the column review.
The bitcoin dataset has no column dictionary, so volume and price units stay
unresolved until you say what they mean. Expect such a gap to be named rather than
papered over.

### 3. Ask the three questions that need a tool

Good first questions force a real computation and tell you something about the data
rather than the model:

> Show the distribution of order-line value (sales per row), so I can see the shape.

> Which rows look unsafe for a time analysis — duplicated order IDs, missing ship
> dates, or ship dates before order dates?

> Show monthly sales for 2017 as a line chart.

Expand the tool group under an answer to reopen its **Open column review**, **Open in
Analysis Studio** or **Open report** card directly.

Each answer should name the **grain and denominator** ("sum of sales per month",
"9,994 order lines", "how many candidate rows before the filter drops them"), state
**active filters** ("order_date within 2017, applied to source rows
before aggregation"), and list the **definitions it had to choose** (which sales
column is the measure, whether returns and unshipped rows are excluded). Those are the
parts worth challenging. Numbers are worth challenging too — spot-check any of them in
Explore against the same published dataset, and ask whether the question is even the
right one; a distribution question answered from a capped or biased subset is worth
less than the caveat that says so.

#### Asking a question this agent can answer well

The agent is good at compressing a dataset into an answer; it cannot guess what you
meant by "performance". Four habits make the difference between an answer you can use
and one you have to re-ask:

- **Name the measure and the grain**, not the topic: "sum of sales per order line, by
  month" beats "sales trend". The grain is what tells you whether the number is per
  row, per order or per day.
- **Ask what was excluded.** Returns, unshipped rows, NULL discounts, rows outside the
  date range and a capped preview all change the denominator, and the answer should
  say which of them applied ("active filters", "source rows before aggregation").
- **Ask for the query when you intend to quote the number.** Every answer comes from
  SQL you can read, and Studio's **Query and provenance** panel shows the exact
  statement, the pinned dataset version and the semantic revision behind it.
- **Spot-check one number yourself** in Explore before the answer travels any further.
  It is the cheapest way to catch a wrong grain or a filter you did not intend.

When a term is ambiguous ("revenue", "close", "performance"), expect to be asked back
rather than guessed at — that question is the agent refusing to invent a definition.

### 4. Iterate on the chart without paying for it again

> Change this to a point chart without rerunning the query.

A style-only edit reuses the saved result: no new SQL, no new model turn, same result
ID. Filters and field changes _do_ re-run the query, and the Studio says which is
which (Apply/Discard for drafts; source-population filters are distinct from
dashboard shared-result filters).

Two things that look like failures and are not: a chart the deterministic layout
validator refuses comes back _reported as refused_, with what was wrong (rotated
labels, a colliding title, a mostly-blank canvas); and a histogram's bins are chosen
by the chart template, so ask for explicit bins when you intend to quote bin counts.

One thing to hold the agent to: if you asked for a vertical bar chart and the render
had to be reversed to be readable, the answer should say so rather than hand you a
horizontal chart as if it were what you asked for.

### 5. Save it, pin it, export it

> Save this analysis, add it to a dashboard called "Daily returns", and export a
> presentation report.

A saved analysis is a revision: re-saving the same view creates revision 2 of it, and
a style-only change keeps the result ID. Dashboards pin specific revisions; when a
newer revision exists the dashboard says so rather than silently moving.

Reports open in the browser; the offline HTML/ZIP files are the portable copy. The
exported report is deliberately **facts-only**: it carries verified result facts and
the chart, and it _omits_ generated interpretation until an analyst approves that
interpretation in Studio ("Interpretation review: unreviewed"). Approve it and
re-export when you want the narrative included — the report then labels it as
generated.

### 6. Restart and reopen

Stop dsh and start it again with the same `DSH_HOME` and `DSH_DATA_WORKSPACE`: the
published dataset, saved revisions, dashboard and reports are still there. If you are
picking up a review you left open, **Refresh status** or **Refresh workspace**
re-fetches it — if the proposal moved elsewhere you will be told, and your unsaved
column edits are kept and marked stale rather than discarded.

### The whole first session, paste-ready

```text
Preview `vivek468/superstore-dataset-final` and show the column review.
Which quality checks are established for this source, and which are still unknown?
Ingest the approved source, then tell me what a row means, what the key is, and which
columns carry quality caveats.
Show the distribution of order-line value (sales per row), so I can see the shape.
Which rows look unsafe for a time analysis - duplicated order IDs, missing ship dates,
or ship dates before order dates?
Show monthly sales for 2017 as a line chart.
Change this to a point chart without rerunning the query.
Save this analysis, add it to a dashboard called "Sales", and export a presentation
report.
```

Between the first and third prompt you approve in the sidebar, and you set the
day/month format there too. Everything after that is refinement: the same numbers,
cheaper, or the same chart, prettier.

### Where the agent should push back

Not every refusal is a bug, and this is the list to hold it to:

- an unresolved business term ("revenue", "close") is asked back, not assumed;
- a report export without an approved interpretation omits the narrative and says so;
- a query reading a text-held date comes back with a `text-date-risk` warning — treat
  it as a request to set the format, not as a caveat on a usable number;
- an unsupported or non-tabular source is refused with a reason and a next step;
- an unknown licence is surfaced for you to accept, never silently allowed or blocked.

The full list, with what each one looks like in practice, is in the
[README](../README.md#expected-behaviour-that-can-look-like-a-failure).

### Costs to expect

Model turns are what cost. Measured: the 25,000-row superstore arc above (preview →
approve → ingest → query → chart → style-only change → save → dashboard → report) ran
about 657K tokens across five turns, and on the 392 MB bitcoin dataset the preview
took 20 seconds, the ingest about 30, and individual analysis questions between 9 and
52 seconds. Previews and profiling dominate the spend; direct Studio controls, saved
views and re-renders of a stored result cost nothing.

## Optional: operator CLI ingest

Same libraries as the tools, without the LLM:

```sh
npm run build
npm run ingest -- superstore
npm run ingest -- online-retail
npm run ingest -- olist
```

## Support boundaries

- Plugin install on standard `web` + isolated analyst preset.
- Generic tabular Kaggle ingest (CSV / Parquet / JSON/JSONL / XLSX) via
  preview → approve → publish (`raw_then_typed` for new pins).
- Query, chart, save analysis, dashboard pin/filter, portable export.
- Restart/reopen of sessions and metadata on the same home + workspace.
- Production-loop SQL/chart/turn results recorded with narrative limitations.

Still deferred: Learning v1.1 paired lift, multi-user deployment, RLS,
legacy XLS / SQLite adapters.

## Expected behaviour that can look like a failure

See the [README](../README.md#expected-behaviour-that-can-look-like-a-failure)
for the list (a rejected chart, a flagged interpretation, an unresolved
business term, a refused legacy/non-tabular source, an unrecognized licence) —
each of these is the product working as designed, not a bug to report.

## If you get stuck

- `npm run doctor` — local prerequisites (not product completion).
- [implementation.md](implementation.md) — ordered gates and next work.
- [architecture.md](architecture.md) — design rationale and boundaries.
- [Studio guide](analyst-studio-design.md) — supported editing controls.
