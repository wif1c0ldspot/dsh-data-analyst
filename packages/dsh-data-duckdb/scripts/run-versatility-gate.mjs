#!/usr/bin/env node
/**
 * Versatility gate: how the real ingestion → analysis pipeline behaves on
 * genuinely messy tabular data. Credential-free — no model call, no Kaggle
 * token, no network (see `src/versatility-gate.ts` for the case list and the
 * contract each case asserts).
 *
 * Usage:
 *   node packages/dsh-data-duckdb/scripts/run-versatility-gate.mjs [options]
 *
 * Options:
 *   --report <path>   Write the machine-readable JSON report here.
 *                     Default: $DSH_VERSATILITY_REPORT or
 *                     packages/dsh-data-duckdb/.versatility-report.json
 *   --case <id>       Run only this case id (repeatable).
 *   --skip-heavy      Skip cases that generate a few hundred thousand rows.
 *   --keep-temp       Keep per-case workspaces and fixtures for inspection.
 *   --quiet           Print the summary only, not per-case lines.
 *
 * Exit code: 0 when every case passed, 1 when any case failed (a failing case
 * is recorded, never removed or softened), 2 on a usage error.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { runVersatilityGate } from '../dist/versatility-gate.js'

const argv = process.argv.slice(2)
const only = []
let reportPath = process.env.DSH_VERSATILITY_REPORT
let includeHeavy = true
let keepTemp = false
let quiet = false

for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index]
  if (argument === '--report') {
    reportPath = argv[++index]
    if (!reportPath) throw new Error('--report needs a path')
  } else if (argument === '--case') {
    const id = argv[++index]
    if (!id) throw new Error('--case needs a case id')
    only.push(id)
  } else if (argument === '--skip-heavy') {
    includeHeavy = false
  } else if (argument === '--keep-temp') {
    keepTemp = true
  } else if (argument === '--quiet') {
    quiet = true
  } else {
    console.error(`Unknown argument "${argument}"`)
    process.exit(2)
  }
}

if (process.env.DSH_VERSATILITY_SKIP_HEAVY === '1') includeHeavy = false

const root = resolve(import.meta.dirname, '../../..')
reportPath ??= join(root, 'packages/dsh-data-duckdb/.versatility-report.json')

const report = await runVersatilityGate({
  includeHeavy,
  keepTemp,
  ...(only.length > 0 ? { only } : {}),
  ...(quiet
    ? {}
    : {
        onCase: (line) => console.log(line),
      }),
})

await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log('')
console.log(`Versatility gate — ${report.totals.cases} case(s), ${report.runtimeSeconds}s`)
console.log(
  `  passed ${report.totals.passed}  failed ${report.totals.failed}  skipped ${report.totals.skipped}  ` +
    `findings ${report.totals.findings} (contract violations ${report.totals.contractViolations})`,
)
for (const entry of report.cases) {
  const marker = entry.status === 'pass' ? 'PASS' : entry.status === 'fail' ? 'FAIL' : 'SKIP'
  console.log(`  ${marker} ${entry.id} — ${entry.observed}`)
  for (const check of entry.checks) {
    if (!check.ok) {
      console.log(
        `       failed assertion: ${check.name}` +
          (check.detail === undefined ? '' : ` ${JSON.stringify(check.detail)}`),
      )
    }
  }
  for (const finding of entry.findings) {
    console.log(`       finding [${finding.severity}] ${finding.claim}`)
    console.log(`         observed: ${finding.observed}`)
    console.log(`         where: ${finding.where}`)
  }
}
const uncovered = Object.entries(report.requirementCoverage)
  .filter(([, caseIds]) => caseIds.length === 0)
  .map(([key]) => key)
if (uncovered.length > 0) {
  console.log(`  uncovered requirement(s): ${uncovered.join(', ')}`)
}
console.log(`  report: ${reportPath}`)
console.log(
  '  credentials: none — ' +
    `${report.credentials.modelCalls} model call(s), Kaggle token ${report.credentials.kaggleTokenUsed ? 'used' : 'unused'}`,
)

process.exit(report.totals.failed === 0 && uncovered.length === 0 ? 0 : 1)
