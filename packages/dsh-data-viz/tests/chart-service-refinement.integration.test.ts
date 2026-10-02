/**
 * Integration coverage
 * for `createChartArtifact`'s bounded single-retry refinement. Reproduces a
 * synthetic bad-layout case beyond the three reproduction fixtures, which —
 * after the layout fixes and the facet-wrap-columns-placement bug fix in
 * `chart.ts` (see the "Duplicate shared row-header title" comment in
 * `withFacet`) — all now pass cleanly
 * with zero diagnostics even at high facet cardinality, so a *new* synthetic
 * shape is needed to exercise the retry path itself: an analyst-forced
 * `facetColumns` override wide enough to breach the absolute canvas cap at a
 * narrow delivery width, which only the post-render validator can detect
 * (the compiler has no way to know in advance that an explicit override is
 * unsafe).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createChartArtifact } from '../src/chart-service.js'
import { validateChartLayoutSvg } from '../src/chart-layout-validator.js'

let directory: string
let resultStoreDir: string
let artifactStoreDir: string

/** 8 distinct facet groups x 4 regions: enough cardinality for the wrap-columns bug/fix to matter. */
function forcedWideFacetRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 4; j++) {
      rows.push({ region: `Region ${j}`, group: `Group ${i}`, value: (i * 7 + j * 3) % 50 })
    }
  }
  return rows
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-chart-refinement-'))
  resultStoreDir = join(directory, 'results')
  artifactStoreDir = join(directory, 'artifacts')
  await mkdir(resultStoreDir, { recursive: true })
  await mkdir(artifactStoreDir, { recursive: true })
  await writeFile(
    join(resultStoreDir, 'res_forced.json'),
    JSON.stringify({
      resultId: 'res_forced',
      columns: [
        { name: 'region', logicalType: 'VARCHAR' },
        { name: 'group', logicalType: 'VARCHAR' },
        { name: 'value', logicalType: 'DOUBLE' },
      ],
      rows: forcedWideFacetRows().map((row) => [row.region, row.group, row.value]),
    }),
  )
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const forcedIntent = {
  mark: 'bar' as const,
  title: 'Value by region, faceted by group',
  x: 'region',
  y: 'value',
  facet: 'group',
  facetColumns: 6,
}

it('first render of the forced facetColumns override actually fails layout validation (sanity: the fixture reproduces a real defect)', async () => {
  const result = await createChartArtifact({
    resultId: 'res_forced',
    intent: forcedIntent,
    deliveryProfile: 'sidebar-narrow',
    resultStoreDir,
    artifactStoreDir,
  })
  // Whether or not the retry resolved it, the raw fact that a retry was
  // needed at all proves the first render was not already clean.
  expect(result.refinement.attempted).toBe(true)
})

it('reintroduces a synthetic bad-layout case and confirms one retry makes it clean', async () => {
  const result = await createChartArtifact({
    resultId: 'res_forced',
    intent: forcedIntent,
    deliveryProfile: 'sidebar-narrow',
    resultStoreDir,
    artifactStoreDir,
  })
  expect(result.layoutValidation.ok).toBe(true)
  expect(result.layoutValidation.diagnostics).toEqual([])
  expect(result.refinement).toMatchObject({
    attempted: true,
    resolvedCodes: expect.arrayContaining(['excessive-output-bounds']),
    remainingDiagnostics: [],
  })
  expect(result.refinement.changes.length).toBeGreaterThan(0)

  // The kept artifact on disk must be the retry's (clean) SVG, not the
  // original failing one — an artifact ID that fails validation must never
  // reach the artifact store.
  const svg = await readFile(join(artifactStoreDir, `${result.artifactId}.svg`), 'utf8')
  expect(validateChartLayoutSvg(svg)).toMatchObject({ ok: true, diagnostics: [] })

  // Only one artifact is ever written for this call — the rejected first
  // render never reaches disk as a separate artifact.
  const { readdir } = await import('node:fs/promises')
  const svgFiles = (await readdir(artifactStoreDir)).filter((name) => name.endsWith('.svg'))
  expect(svgFiles).toHaveLength(1)
})

it('does not attempt a retry, and reports refinement as not attempted, when the first render already validates cleanly', async () => {
  await writeFile(
    join(resultStoreDir, 'res_clean.json'),
    JSON.stringify({
      resultId: 'res_clean',
      columns: [
        { name: 'region', logicalType: 'VARCHAR' },
        { name: 'revenue', logicalType: 'DECIMAL(18,2)' },
      ],
      rows: [
        ['North', '80.00'],
        ['South', '50.00'],
      ],
    }),
  )
  const result = await createChartArtifact({
    resultId: 'res_clean',
    intent: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    resultStoreDir,
    artifactStoreDir,
  })
  expect(result.layoutValidation.ok).toBe(true)
  expect(result.refinement).toEqual({
    attempted: false,
    changes: [],
    resolvedCodes: [],
    remainingDiagnostics: [],
  })
})

it('preserves result identity and row values across the retry: same resultId, same underlying data', async () => {
  const before = await readFile(join(resultStoreDir, 'res_forced.json'), 'utf8')
  const result = await createChartArtifact({
    resultId: 'res_forced',
    intent: forcedIntent,
    deliveryProfile: 'sidebar-narrow',
    resultStoreDir,
    artifactStoreDir,
  })
  expect(result.refinement.attempted).toBe(true)

  const sidecar = JSON.parse(
    await readFile(join(artifactStoreDir, `${result.artifactId}.json`), 'utf8'),
  ) as { resultId: string; vegaLiteSpec: { data: { values: unknown[] } } }
  expect(sidecar.resultId).toBe('res_forced')
  // The refined chart's compiled data values are still exactly the 32 rows
  // read from the stored result — the retry never re-reads or re-queries.
  expect(sidecar.vegaLiteSpec.data.values).toHaveLength(32)

  // The stored result file itself is untouched by the refinement attempt.
  const after = await readFile(join(resultStoreDir, 'res_forced.json'), 'utf8')
  expect(after).toBe(before)
})

/**
 * A failed retry does not advance a saved-analysis revision:
 * `createChartArtifact`/`proposeChartRefinement` — the entire
 * refinement path — never call `saveAnalysisRevision` or otherwise
 * touch analysis persistence, whether or not the retry resolves the
 * diagnostics. `make_chart` is a standalone tool; only the separate
 * `save_analysis`/rechart-apply tools ever advance a revision. Proved
 * structurally (source never imports the analysis-store module or
 * references `saveAnalysisRevision`) rather than by mocking, since the
 * absence of any code path is the actual guarantee.
 */
it('never imports or calls into analysis persistence from the refinement path', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const relative of ['../src/chart-service.ts', '../src/chart-refinement.ts']) {
    const source = await readFile(join(here, relative), 'utf8')
    expect(source).not.toMatch(/analysis-store/)
    expect(source).not.toMatch(/saveAnalysisRevision/)
  }
})
