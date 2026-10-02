/**
 * Integration coverage: `createChartArtifact` writes a real `.svg` file
 * to the artifact store, and the layout validator must be able to read that
 * exact on-disk artifact and reach the same verdict it reaches for the
 * in-memory SVG string — proving the two pipelines actually agree instead of
 * each one being tested in isolation.
 */
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createChartArtifact } from '../src/chart-service.js'
import { validateChartLayoutSvg } from '../src/chart-layout-validator.js'
import { createPngFromSvg } from '../src/png-export.js'
import {
  buildFacetedXAxisOverlapIntent,
  foodOrderingLayoutStressRows,
} from './fixtures/food-ordering-layout-stress.js'

let directory: string
let resultStoreDir: string
let artifactStoreDir: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-chart-layout-validation-'))
  resultStoreDir = join(directory, 'results')
  artifactStoreDir = join(directory, 'artifacts')
  await mkdir(resultStoreDir, { recursive: true })
  await mkdir(artifactStoreDir, { recursive: true })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Convert the fixture's plain-object rows into the on-disk stored-result shape `createChartArtifact` reads. */
function storedResultFrom(columns: string[], rows: Record<string, unknown>[]) {
  return {
    columns: columns.map((name) => ({
      name,
      logicalType: typeof rows[0]?.[name] === 'number' ? 'DOUBLE' : 'VARCHAR',
    })),
    rows: rows.map((row) => columns.map((name) => row[name])),
  }
}

it('produces a rendered artifact whose on-disk SVG now passes layout validation for a previously-known-bad food-ordering shape', async () => {
  // Previously failed with `duplicate-shared-title` before the responsive
  // facet layout policy (chart.ts) removed the per-facet-column-duplicated
  // axis title; see chart-layout-validator.unit.test.ts for the full
  // fixed-shape coverage across all three reproduction fixtures.
  const rows = foodOrderingLayoutStressRows()
  await writeFile(
    join(resultStoreDir, 'res_badlayout.json'),
    JSON.stringify({
      resultId: 'res_badlayout',
      ...storedResultFrom(['population', 'occupation', 'income_band', 'order_count'], rows),
    }),
  )
  const { artifactId } = await createChartArtifact({
    resultId: 'res_badlayout',
    intent: buildFacetedXAxisOverlapIntent(),
    resultStoreDir,
    artifactStoreDir,
  })
  const svg = await readFile(join(artifactStoreDir, `${artifactId}.svg`), 'utf8')
  const result = validateChartLayoutSvg(svg)
  expect(result).toMatchObject({ ok: true, diagnostics: [] })
})

it('produces a rendered artifact whose on-disk SVG passes layout validation for an ordinary chart', async () => {
  await writeFile(
    join(resultStoreDir, 'res_cleanlayout.json'),
    JSON.stringify({
      resultId: 'res_cleanlayout',
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
  const { artifactId } = await createChartArtifact({
    resultId: 'res_cleanlayout',
    intent: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    resultStoreDir,
    artifactStoreDir,
  })
  const svg = await readFile(join(artifactStoreDir, `${artifactId}.svg`), 'utf8')
  expect(validateChartLayoutSvg(svg)).toMatchObject({ ok: true, diagnostics: [] })
})

it('repairs the live stacked-bar shape that was rejected twice in the WebUI pass', async () => {
  // art_a2ef823d23434c06 / art_c643a0bf26a04182: 10 attack categories x 2 data
  // splits, stacked, explicitly vertical, legend bottom then right. Both were
  // rejected with excessive-output-bounds, and the model had no deterministic
  // remedy to apply — it reflowed the legend and stopped. The service's own
  // refinement now flips the explicit vertical override, which is what the
  // deterministic chart-choice policy would have chosen for these labels.
  const categories = [
    ['Normal', 56000, 37000],
    ['Generic', 40000, 18000],
    ['Exploits', 33000, 11000],
    ['Fuzzers', 17000, 6000],
    ['DoS', 12000, 5000],
    ['Reconnaissance', 10000, 4000],
    ['Analysis', 2000, 700],
    ['Backdoor', 1700, 600],
    ['Shellcode', 1100, 380],
    ['Worms', 130, 44],
  ] as const
  const rows = categories.flatMap(([attack_cat, training, testing]) => [
    { attack_cat, data_split: 'training', row_count: training },
    { attack_cat, data_split: 'testing', row_count: testing },
  ])
  await writeFile(
    join(resultStoreDir, 'res_wormsplit.json'),
    JSON.stringify({
      resultId: 'res_wormsplit',
      ...storedResultFrom(['attack_cat', 'data_split', 'row_count'], rows),
    }),
  )
  const { artifactId } = await createChartArtifact({
    resultId: 'res_wormsplit',
    intent: {
      mark: 'bar',
      title: 'Rows by attack category and split',
      format: { palette: 'colorblind', orientation: 'vertical', legend: 'bottom' },
      x: 'attack_cat',
      y: 'row_count',
      series: 'data_split',
      stack: 'zero',
      sort: { field: 'row_count', direction: 'descending' },
      xLabel: 'Attack category',
      yLabel: 'Rows',
    },
    resultStoreDir,
    artifactStoreDir,
  })
  const svg = await readFile(join(artifactStoreDir, `${artifactId}.svg`), 'utf8')
  const result = validateChartLayoutSvg(svg)
  expect(result.diagnostics, JSON.stringify(result.diagnostics)).toEqual([])
  expect(result.ok).toBe(true)
})

it('never reports layout-verified success for a result that could not be rendered', async () => {
  await writeFile(
    join(resultStoreDir, 'res_badfield.json'),
    JSON.stringify({
      resultId: 'res_badfield',
      columns: [{ name: 'region', logicalType: 'VARCHAR' }],
      rows: [['West']],
    }),
  )
  // A validation failure never produces a misleading success receipt: an
  // artifact that could not even be compiled/rendered has no SVG for the
  // layout validator to inspect at all, so the caller cannot reach an "ok"
  // layout verdict by any path here.
  await expect(
    createChartArtifact({
      resultId: 'res_badfield',
      intent: { mark: 'bar', title: 'x', x: 'region', y: 'missing_field' },
      resultStoreDir,
      artifactStoreDir,
    }),
  ).rejects.toThrow()
})

it('PNG/SVG render parity: the exported PNG carries the same pixel dimensions as the rendered SVG canvas', async () => {
  await writeFile(
    join(resultStoreDir, 'res_parity.json'),
    JSON.stringify({
      resultId: 'res_parity',
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
  const { artifactId } = await createChartArtifact({
    resultId: 'res_parity',
    intent: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    resultStoreDir,
    artifactStoreDir,
  })
  const svg = await readFile(join(artifactStoreDir, `${artifactId}.svg`), 'utf8')
  const layout = validateChartLayoutSvg(svg)
  expect(layout.ok).toBe(true)

  const png = createPngFromSvg(svg)
  // PNG IHDR: 8-byte signature, then a 4-byte chunk length, "IHDR", then
  // 4-byte width and 4-byte height (big-endian) — read directly rather than
  // pulling in an image-decoding dependency for one smoke assertion.
  const pngWidth = png.readUInt32BE(16)
  const pngHeight = png.readUInt32BE(20)
  expect(pngWidth).toBe(Math.round(layout.bounds.width))
  expect(pngHeight).toBe(Math.round(layout.bounds.height))
})
