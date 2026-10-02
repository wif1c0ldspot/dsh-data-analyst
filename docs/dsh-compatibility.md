# DeepSeek Harness compatibility

The reviewed runtime is recorded in
[upstream-lock.json](../profiles/data-analyst/upstream-lock.json): dsh
`0.1.5-rc.2`, commit `c291e7961a515f6d7af9304e7fd1d257929aef26`, Cordis `4.0.2`.
The pin is a compatibility boundary, not a claim that arbitrary newer releases work.

## Integration seams

- `dsh plugin --profile web add <checkout>` loads the root bundle patch and web client.
- Four capability entries register managed DuckDB, Kaggle, visualization and
  workbench services. The root package's bare entry supplies the client manifest.
- `configure:analyst-profile` installs the isolated preset and packaged skill roots.
  The standard web profile can retain other presets; isolation is checked for
  the analyst preset's effective runtime inventory.
- dsh tool/session/guard APIs own dispatch and the sole reasoning loop. Service
  request budgets remain active independently of evaluation-only guards.
- Native client extension points mount chat toolviews, commands and the Analysis
  Studio sidebar. Authenticated fetch routes expose controlled operations and artifacts.
- The closed composition under test fixtures supports opt-in production-loop
  evaluation. Component fixture/direct-provider adapters are not production evidence.

## Updating the pin

Inspect the changed upstream APIs before changing the lock and dependencies.
Run frozen install, `pnpm check`, `pnpm build` and `pnpm smoke:plugin:local`.
Then install into a fresh dsh home and verify preview → approve → ingest → query
→ chart → save/export → restart/reopen, including the effective closed tool/skill
inventory. Re-run live evaluation when the agent/tool behavior changes, and record
what actually ran.

An optional ignored `deepseek-harness/` source checkout may be used to inspect or
run the pinned harness; never modify it to make the plugin work. Default tests
use published dependencies and synthetic fixtures without API credentials.

## Version-mismatch behaviour (tested)

`dsh --version` prints the running harness version (e.g. `0.1.5-rc.2` for the
pinned build); a profile manifest dump (`dsh --profile web --dump-config`)
names every plugin package and version dsh actually resolved for that boot.
Neither is currently cross-checked against
[upstream-lock.json](../profiles/data-analyst/upstream-lock.json) before
`dsh plugin add` or `configure:analyst-profile` run.

**Tested 2026-09-20** against a real, different harness build — a fresh
`git clone` of [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
at tag `dsh-v0.1.6-alpha.2` (the next minor release after the pinned
`dsh-v0.1.5-rc.2`), built from source (`pnpm install --frozen-lockfile && pnpm build`,
required for any source checkout regardless of the pin), then
`dsh plugin --profile web add <this checkout>` →
`configure:analyst-profile --profile web --home <home>` → `dsh --profile web ...`
→ selected the **Data analyst (isolated)** preset in a real browser.

**Result: no reproducible mismatch symptom.** `dsh plugin add` and
`configure:analyst-profile` both succeeded silently (as they do on the pinned
build); the boot succeeded; the **Data analyst (isolated)** preset listed and
selected normally with zero browser console errors. This is a negative
result for this specific version delta, not a claim that the pin doesn't
matter — the compatibility boundary in the header above still stands, and a
larger version gap (a different major/minor line, or a release with an actual
breaking API change in one of the four integration seams above) was not
available to test and could behave differently. No preflight was added:
inventing one to guard against a failure that could not be reproduced would
mean guessing at both the symptom and the fix. If a real mismatch failure
turns up (a `dsh plugin add` or boot-time error naming a specific missing or
incompatible export), record its raw output here and decide then whether it
is self-explanatory or needs a preflight that names both the running and
pinned versions.
