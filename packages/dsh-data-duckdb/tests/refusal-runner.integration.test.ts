import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('passes the frozen policy corpus through the same dataset and semantic context as the ask path', () => {
  const script = fileURLToPath(new URL('../scripts/run-refusal-eval.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, DSH_NL_GENERATOR: 'policy' },
  })

  expect(run.status, run.stderr || run.stdout).toBe(0)
  const report = JSON.parse(run.stdout) as {
    graded: number
    passed: number
    failed: number
    results: Array<{ id: string; actual: string }>
  }
  expect(report).toMatchObject({ graded: 14, passed: 14, failed: 0 })
  expect(report.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'clarify-cross-dataset-no-selection', actual: 'clarify' }),
      expect.objectContaining({ id: 'refuse-cross-dataset-join', actual: 'refuse' }),
      expect.objectContaining({ id: 'clarify-which-metric-revenue', actual: 'clarify' }),
    ]),
  )
})
