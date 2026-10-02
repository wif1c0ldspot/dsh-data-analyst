# Contributing

Thanks for improving dsh-data-analyst. The project is a DeepSeek Harness plugin,
so product code belongs in `packages/`, `profiles/`, `skills/` and `scripts/`.
The `deepseek-harness/` directory is an optional, ignored source reference and
must never be modified as part of a contribution.

## Development setup

Use Node 24 LTS and pnpm 11.7.0:

```sh
pnpm install --frozen-lockfile
npm run check
```

The default check is credential-free. It validates documentation, public
distribution structure, formatting, types, unit tests, integration tests and the
named safety suite. Network and model evaluations are opt-in and must record the
model, dataset versions, prompts, numerator/denominator and failures.

## Change guidelines

- Keep every product capability behind a managed dsh plugin service and narrow
  typed tool. Do not add a second agent loop or model-accessible shell, arbitrary
  filesystem, network or code execution.
- Keep analyst query databases immutable and read-only. Ingestion writes private
  staging databases and atomically publishes validated versions.
- Enforce policy in services. Skills guide tool use but are not security controls.
- Use established libraries and ESM TypeScript. Add focused tests for observable
  behavior, boundary failures, cancellation and recovery.
- Never commit credentials, Kaggle archives, DuckDB databases, reports containing
  private data, local dsh homes or generated dependency/build directories.
- Update the relevant architecture, setup and current-status documents when
  behavior or a release claim changes. Measured evidence and open release gates
  are tracked internally, not in this distribution.

Keep pull requests focused and explain the user-visible behavior, validation and
any remaining limits.
