# Project conventions

Read [architecture](docs/architecture.md) and
[current status](docs/implementation.md). Harness compatibility is pinned in
`profiles/data-analyst/upstream-lock.json`.

## Hard constraints

- This is a dsh plugin, not a fork. Never edit `deepseek-harness/`; it is an
  optional upstream reference. Product code lives in `packages/`, `profiles/`,
  `skills/`, `scripts/` and `deployment/`.
- dsh owns the sole reasoning loop, sessions and analyst UI. Analysis Studio is
  a native sidebar. Deterministic workers are internal helpers, not agents.
- Keep every capability behind managed dsh services and narrow typed tools.
  No model-accessible shell, arbitrary filesystem/network/code or writable SQL bypass.
- Services enforce policy independently of skills. Keep input-intent and
  output-outcome classifiers distinct. Preserve service request-budget enforcement.
- Analyst queries open published datasets read-only. Trusted ingestion writes
  private staging databases, validates/closes them, then publishes immutable versions.
- Treat source data as untrusted. Use bounded typed payloads, demand-paged schema
  and capability controls. Full rows, SVG and report files stay outside model context.
- Only analyst feedback approves reusable examples; query success is not correctness
  or reward. Preserve dataset/schema/semantic compatibility and revocation checks.
- Use ESM TypeScript, Zod, SQLite transactions, DuckDB/Vega and dsh APIs through
  thin adapters. Prefer established libraries; no custom SQL parser, job framework,
  serializer, JSON transaction store or second application framework.
- Keep dependencies pinned and changes outside upstream. No Docker requirement.
  The supported deployment is one trusted analyst on loopback.

## Verification and documentation

- Reproduce findings against current symbols before editing; skip already-fixed
  defects with an explanation. Do not claim acceptance from source inspection alone.
- Run focused regressions, then `pnpm check`; `pnpm build` emits packages and skills.
  Default tests use synthetic fixtures without credentials. Live evaluation is opt-in.
- Runtime integration must use the pinned harness and actual plugin/session seams.
  Mark any tool whose real seam is unverified with an explicit `TODO(<phase>)` and
  keep it until that seam executes.
- Release gates: at least three datasets; SQL ≥80%, charts ≥90%, answers within
  two analyst turns and one refinement; saved/reopened workflows, service safety,
  installation and persistence/restore checks. Track unsupported claims separately.
- Learning v1.1 requires positive paired held-out lift and a reviewed correction
  affecting a later compatible answer. Do not imply this gate has passed.
- Keep current rationale in `docs/architecture.md` and current capability plus remaining
  work in `docs/implementation.md`. Measured evidence is recorded internally. Superseded
  plans are not kept as competing instructions, and are not preserved in this
  distribution's history — it is a single clean export, not a development log.
- Never commit credentials, downloaded data, local dsh homes or generated artifacts.
