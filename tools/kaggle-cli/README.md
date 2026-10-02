# Pinned Kaggle CLI

A `uv`-managed Python environment containing only the official `kaggle`
console script (`kaggle==2.2.4`, pinned in `pyproject.toml`/`uv.lock`), per
[architecture rationale](../../docs/architecture.md):
"Use the official Kaggle CLI for acquisition; pin its Python environment."
This is not a Python package the product imports; `packages/dsh-data-kaggle`'s
`download-adapter.ts` invokes the compiled venv's `kaggle` executable directly
by absolute path and fixed argv, never a shell string.

## Setup

```sh
cd tools/kaggle-cli
uv sync
uvx pip-audit --path .venv   # re-run after any dependency change
```

`.venv/` is gitignored; `uv.lock` is committed so the resolved graph is
reproducible. `uv sync` recreates `.venv/` from the lock on a fresh checkout.

## Credentials

Never commit, log, or paste a Kaggle API token into this repository, a chat
session, or a shell history. Configure credentials entirely outside this
project's version control. Our pinned CLI (`kaggle==2.2.4`) authenticates
with an **API access token only** — no username is required; the CLI
introspects the account from the token.

Preferred (verified path in this workspace):

1. On [kaggle.com](https://www.kaggle.com) → Settings → API, create/copy an
   API access token.
2. Save **only the token string** (one line) to `~/.kaggle/access_token` and
   restrict permissions:

```sh
mkdir -p ~/.kaggle
# write the token into ~/.kaggle/access_token, then:
chmod 600 ~/.kaggle/access_token
```

Equivalents the CLI also accepts (still API-token-only):

- `export KAGGLE_API_TOKEN=...` (token value), or
- `export KAGGLE_API_TOKEN="$HOME/.kaggle/access_token"`

Legacy `~/.kaggle/kaggle.json` (`username` + `key`) remains a CLI fallback but
is not required for this project and is not the documented operator path here.
Our TypeScript adapter never reads credentials itself — the `kaggle`
executable resolves them from the environment / `~/.kaggle`.

Verify without printing the token:

```sh
tools/kaggle-cli/.venv/bin/kaggle datasets list -s superstore --csv | head -3
```

## Evaluation dataset examples

- `vivek468/superstore-dataset-final` — BI smoke test (single table).
- `olistbr/brazilian-ecommerce` — flagship relational/join dataset.
- `mashlyn/online-retail-ii-uci` — data-quality (returns/cancellations) dataset.
