# Data analyst profile assets

This directory ships the installable dsh bundle layer and the isolated
**Data analyst** custom-agent preset.

## Recommended install (standard web)

```sh
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
dsh --profile web --dump-config >/dev/null
dsh plugin --profile web add "$PWD"   # repo root, not this folder
npm run configure:analyst-profile -- --profile web --home "$DSH_HOME"
```

Then start dsh (`dsh --profile web --host 127.0.0.1 --port 3080 --no-open`), open
the token URL, and select **Data analyst (isolated)**. Full steps:
[README](../../README.md), [analyst setup](../../docs/analyst-setup.md).

`configure:analyst-profile` copies `presets/analyst/` into
`$DSH_HOME/.agent-presets/analyst`, packages the skills straight into
`$DSH_HOME/.agent-presets/analyst/skills` (not the local `dist/analyst-skills`
build output — that path is only for running this checkout directly), and
rewrites the preset's skill-root placeholder to point at that copy. It
does **not** apply the closed-host deny-list to `web`.

## Bundle

`cordis.bundle.patch.yml` mounts four managed capabilities:

| Id           | Package                                                  |
| ------------ | -------------------------------------------------------- |
| DuckDB       | `dsh-data-analyst/duckdb`                                |
| Kaggle       | `dsh-data-analyst/kaggle`                                |
| Viz + client | `dsh-data-analyst` (bare name required for `dsh.client`) |
| Workbench    | `dsh-data-analyst/workbench`                             |

## Custom agent

`presets/analyst/` is one reasoning agent with four skills:

- `ingest-kaggle`
- `semantic-layer`
- `sql-safety`
- `viz-conventions`

Default skill roots are disabled. With this preset selected, the model sees the
documented analyst tools plus the skill loader — not shell, arbitrary filesystem,
web, subagent, or generic code-execution tools.

## Closed evaluation host

`npm run configure:analyst-profile -- --closed-host` (or `--profile data-analyst`)
still writes the fail-closed host overlay used by evals. Prefer **web** for
interactive use. `cordis.patch.yml` is that deny-list fixture. Opt-in compatibility
overlays live under `tests/fixtures/cordis-overlays/`, not in this product tree.

## Compatibility

`upstream-lock.json` records the source-reviewed dsh commit, published package
version (`0.1.5-rc.2`), Cordis version and package manager.
