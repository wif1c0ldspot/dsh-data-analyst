import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const PRESET_PATH = fileURLToPath(
  new URL('../profiles/data-analyst/presets/analyst/agent.cordis.yml', import.meta.url),
)

const PROTOCOL_STEPS = [
  'Protocol for every analyst request:',
  '1. Load skill ingest-kaggle, semantic-layer, sql-safety, or viz-conventions when that stage starts; do not skip get_schema before duckdb_query.',
  '2. If a business term has no approved alias, ask and propose a small set of question-relevant metric candidates (with the reason each is useful), never every numeric column; numeric IDs, scores and percentages are not automatically additive measures. Do not invent revenue. In responses separate observed facts, proposed interpretations, and analyst-approved definitions; ask only about decisions that change interpretation or results, and reuse compatible approved decisions.',
  '3. After a dataset is published, return a compact briefing: source/version, tables, row-grain status, date coverage, missingness, key/relationship evidence, and important exclusions, plus two or three grounded next analyses.',
  '4. On binder/schema errors, repair at most twice via duckdb_query. Do not retry POLICY_DENIED, CANCELLED, or RESOURCE_LIMIT.',
  '5. Mark-only changes call make_chart with the same resultId. Filters call duckdb_query again.',
  '6. When a tool observe block contains warnings, quote them to the analyst. Do not infer upstream source changes.',
  '7. Never call shell, filesystem, web, or subagent tools; they are unavailable.',
]

function readPersonaPrefix(): string {
  const text = readFileSync(PRESET_PATH, 'utf8')
  const match = text.match(/^\s+prefix:\s*>-\s*\n([\s\S]*?)(?=^\s+complete:)/m)
  expect(match, 'persona prefix block in agent.cordis.yml').toBeTruthy()
  return match![1]!.replace(/^\s+/gm, ' ').replace(/\s+/g, ' ').trim()
}

it('closed analyst persona prefix includes the always-on ReAct protocol steps', () => {
  const prefix = readPersonaPrefix()
  for (const step of PROTOCOL_STEPS) {
    expect(prefix, `missing protocol line: ${step}`).toContain(step)
  }
})

it('closed analyst preset keeps the skill root install placeholder', () => {
  const text = readFileSync(PRESET_PATH, 'utf8')
  expect(text).toContain('__DSH_ANALYST_SKILL_ROOT__')
})
