# Local operation

Install using [Analyst setup](../docs/analyst-setup.md). The supported deployment
is one analyst using the standard dsh `web` profile on loopback. Keep the isolated
Data analyst preset selected for analytical work.

## Start and restart

```sh
export DSH_HOME="$HOME/.dsh"
export DSH_DATA_WORKSPACE="$HOME/.local/share/dsh-data-analyst"
# DEEPSEEK_API_KEY must already be securely configured in the environment.
dsh --profile web --host 127.0.0.1 --port 3080 --no-open
```

Open the printed token URL locally; do not share it. Reuse both directories across
restarts. `DSH_HOME` holds dsh sessions/configuration; `DSH_DATA_WORKSPACE` holds
published data, metadata, results, artifacts and Studio state. Neither belongs in Git.

## Backup and restore

Stop the harness and ingestion before copying state. The existing operator
snapshot helper copies the catalog, published databases, results and artifacts:

```sh
pnpm backup:workspace "$DSH_DATA_WORKSPACE" /path/to/empty-backup-directory
pnpm restore:workspace /path/to/backup-directory /path/to/empty-restored-workspace
```

Restore refuses a non-empty destination. Verify the restored workspace beside the
original before switching `DSH_DATA_WORKSPACE` to it.

**Scope:** the helper does not back up `DSH_HOME`, source downloads, staging files
or `studio.sqlite` draft/UI state. For a complete local recovery copy, stop all
writers and back up the entire data workspace and dsh home using your normal
filesystem backup tool. Treat the home backup as sensitive because it may contain
credentials and conversations. Do not publish backup archives.

## Operational checks

- `pnpm doctor`: development prerequisites and pinned runtime diagnostics.
- `pnpm smoke:plugin:local`: bundle patch parsing and capability entry-point imports.
- `pnpm probe:isolation`: query-worker environment/database isolation.
- `pnpm smoke:analyst:session`: opt-in persistent composition probe.
- `scripts/r9-live-ui-walkthrough.sh`: developer route/fragment walkthrough.

These helpers do not replace the full browser path or credentialed model
verification. See [test protocol](../tests/README.md). Internet-facing hosting and multi-user
access are outside the supported security model.
