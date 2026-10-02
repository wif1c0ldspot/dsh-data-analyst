# dsh-data-workbench

The dsh report and persistence host plugin. It owns saved analyses, dashboards,
review actions, Studio state, persistent report history and export orchestration.
Core supplies SQLite contracts; DuckDB and visualization services enforce query
and rendering policy. The analyst interface lives in the dsh web UI.

Authenticated `/api/analyst/studio/*` and `/api/analyst/ui/*` routes back the native
sidebar and chat cards. Direct controls and model tools share domain services.
Revision checks protect updates; report cards reference successful immutable
exports. See [architecture](../../docs/architecture.md),
[contracts](../../docs/contracts.md) and [Studio](../../docs/analyst-studio-design.md).

`server.ts`, `pages.ts` and the fixture/direct-provider ask adapters are retained
for internal test coverage. They are not exported analyst applications or another
production agent loop. Use the [test protocol](../../tests/README.md) to distinguish
component checks from production evaluation.
