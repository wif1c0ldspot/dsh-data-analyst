# dsh-data-duckdb

Managed dsh plugin for trusted staging ingestion, immutable publication, bounded
schema access, engine-parsed SQL policy and isolated read-only query workers.
The writer preserves raw values and surfaces material type/cast decisions before
publication. Analyst tools cannot bypass the published-table/function allowlist.

Native integration tests cover ingestion, worker policy, cancellation and exact
typed results. The direct-provider NL loop is a component/evaluation adapter;
the production reasoning loop belongs to dsh.

See [contracts](../../docs/contracts.md), [setup](../../docs/analyst-setup.md),
and [current status](../../docs/implementation.md).
