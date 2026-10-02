# dsh-data-core

Shared Zod contracts, SQLite metadata transactions, approved semantics, immutable
analysis revisions, result storage/evidence and trusted report rendering.
JSON is a portable definition/export format, not the transactional store.

Keep CLI/tool/UI adapters thin. Operator capabilities such as backup/restore are
separate from model tools. `scripts/doctor.mjs` checks development prerequisites;
standard TypeScript, Vitest, ESLint and Prettier own build/test verification.

See [contracts](../../docs/contracts.md) and [current status](../../docs/implementation.md).
