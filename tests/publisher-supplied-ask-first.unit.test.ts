/**
 * Publisher-supplied text is evidence to confirm with the analyst, never a
 * definition to adopt.
 *
 * The functional halves of this guardrail are asserted where they run:
 * `packages/dsh-data-duckdb/tests/preview-ingest.integration.test.ts` (the
 * labelled block reaching the model payload, the analyst block, and no
 * publisher text inside observed columns) and
 * `packages/dsh-data-duckdb/tests/ask-first-unresolved-term.integration.test.ts`
 * (an unresolved term still asks the analyst and invents no definition). This
 * file pins the guidance the model is actually given, the unchanged always-on
 * ask-first protocol step, and the structural fact that the preview path that
 * carries publisher text has no way to create a semantic candidate at all.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const collapse = (text: string): string => text.replace(/\s+/g, ' ')

it('packaged skills describe publisher text as unverified evidence to confirm, never a definition', () => {
  const sources = [
    ['ingest skill', read('../skills/ingest-kaggle/SKILL.md')],
    ['ingest profiling reference', read('../skills/ingest-kaggle/references/profiling.md')],
    ['semantic-layer skill', read('../skills/semantic-layer/SKILL.md')],
  ] as const

  for (const [label, source] of sources) {
    const text = collapse(source)
    expect(text, `${label} must name publisher-supplied text`).toMatch(/publisher-supplied/i)
    expect(text, `${label} must mark it unverified`).toMatch(/unverified/i)
    // A bounded window rather than one literal phrase: the guardrail is that the
    // text denies definitional status for publisher wording, however it is phrased
    // ("not a definition", "never an approved definition", "never becomes a
    // metric, alias, grain or definition").
    expect(text, `${label} must deny definitional status for publisher text`).toMatch(
      /(?:never|not)(?:(?!\.)[\s\S]){0,60}?definition/i,
    )
    expect(text, `${label} must keep the analyst in the loop`).toMatch(
      /(?:confirm|ask) (?:it )?with the analyst|ask the analyst/i,
    )
  }

  // The ingest skill points at where the analyst sees the full text.
  expect(collapse(read('../skills/ingest-kaggle/SKILL.md'))).toContain(
    'preview_ingest_source` returns `publisherSupplied',
  )
})

it('keeps the always-on ask-the-analyst step for a business term with no approved alias', () => {
  const persona = collapse(read('../profiles/data-analyst/presets/analyst/agent.cordis.yml'))
  // Verbatim the step `tests/analyst-persona-protocol.unit.test.ts` pins; this
  // change must not weaken it.
  expect(persona).toContain(
    'If a business term has no approved alias, ask and propose a small set of question-relevant metric candidates',
  )
  expect(persona).toContain('Do not invent revenue.')
})

it('gives the preview path no route from publisher text to a semantic candidate', () => {
  const preview = read('../packages/dsh-data-duckdb/src/preview-ingest.ts')
  // Publisher text is only ever parsed into the labelled block…
  expect(preview).toContain('parsePublisherSuppliedMetadata(')
  // …and this module cannot create or approve a metric/alias/definition at all.
  expect(preview).not.toMatch(/createAliasCandidate|setAliasCandidateStatus|proposeMetric/)
})

it('states the ask-first recovery action in the get_metrics tool contract', () => {
  const tools = collapse(read('../packages/dsh-data-duckdb/src/plugin-tools.ts'))
  expect(tools).toContain('unresolvedTerms')
  expect(tools).toContain("nextAction: 'ask-analyst'")
  expect(tools).toMatch(/never an approved metric, alias or definition/)
})
