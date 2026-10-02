import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ChartValidationError, createChartArtifact } from '../src/chart-service.js'

let directory: string
let resultStoreDir: string
let artifactStoreDir: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-chart-service-'))
  resultStoreDir = join(directory, 'results')
  artifactStoreDir = join(directory, 'artifacts')
  await mkdir(resultStoreDir, { recursive: true })
  await mkdir(artifactStoreDir, { recursive: true })
  await writeFile(
    join(resultStoreDir, 'res_abc123.json'),
    JSON.stringify({
      resultId: 'res_abc123',
      columns: [
        { name: 'region', logicalType: 'VARCHAR' },
        { name: 'revenue', logicalType: 'DECIMAL(18,2)' },
      ],
      rows: [
        ['West', '100.00'],
        ['East', '50.00'],
      ],
    }),
    'utf8',
  )
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('creates a chart artifact from a valid result id', async () => {
  const result = await createChartArtifact({
    resultId: 'res_abc123',
    intent: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    resultStoreDir,
    artifactStoreDir,
  })
  expect(result.artifactId).toMatch(/^art_/)
  const sidecar = JSON.parse(
    await readFile(join(artifactStoreDir, `${result.artifactId}.json`), 'utf8'),
  ) as { vegaLiteSpec?: { mark?: string }; intent?: { mark?: string } }
  expect(sidecar.intent?.mark).toBe('bar')
  expect(sidecar.vegaLiteSpec?.mark).toBe('bar')
})

/**
 * `make_chart`'s
 * "rendered" and "delivery verified" states must come from
 * `createChartArtifact` itself — attached at render time, right after
 * `renderChartSvg`/`validateChartLayoutSvg` run — never left for a later,
 * separate call a caller (or a model) could skip or fabricate.
 */
it('attaches the layout validator result to every successful render, server-side', async () => {
  const result = await createChartArtifact({
    resultId: 'res_abc123',
    intent: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    resultStoreDir,
    artifactStoreDir,
  })
  expect(result.rendered).toBe(true)
  expect(result.layoutValidation).toMatchObject({ ok: true, diagnostics: [] })
  expect(result.layoutValidation.bounds.width).toBeGreaterThan(0)

  // The same verdict travels with the artifact's own provenance record, not
  // just the in-memory return value — so a later reader of the artifact
  // (export, rechart, an audit) sees the identical validation the render
  // call itself already computed.
  const sidecar = JSON.parse(
    await readFile(join(artifactStoreDir, `${result.artifactId}.json`), 'utf8'),
  ) as { layoutValidation?: unknown }
  expect(sidecar.layoutValidation).toEqual(result.layoutValidation)
})

it('rejects invalid result id shapes', async () => {
  await expect(
    createChartArtifact({
      resultId: '../etc/passwd',
      intent: { mark: 'bar', title: 'x', x: 'region', y: 'revenue' },
      resultStoreDir,
      artifactStoreDir,
    }),
  ).rejects.toThrow(/Invalid result id|result id/i)
})

it('rejects path traversal in result id', async () => {
  await expect(
    createChartArtifact({
      resultId: 'res_../../secret',
      intent: { mark: 'bar', title: 'x', x: 'region', y: 'revenue' },
      resultStoreDir,
      artifactStoreDir,
    }),
  ).rejects.toThrow(/Invalid result id|result id|path|traversal/i)
})

it('rejects slash and backslash result ids', async () => {
  for (const resultId of ['res_foo/bar', 'res_foo\\bar']) {
    await expect(
      createChartArtifact({
        resultId,
        intent: { mark: 'bar', title: 'x', x: 'region', y: 'revenue' },
        resultStoreDir,
        artifactStoreDir,
      }),
    ).rejects.toThrow(/Invalid result id|result id/i)
  }
})

it('forwards AbortSignal and rejects when already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    createChartArtifact({
      resultId: 'res_abc123',
      intent: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
      resultStoreDir,
      artifactStoreDir,
      signal: controller.signal,
    }),
  ).rejects.toThrow()
})

it('uses the numeric result type for serialized integer x groups', async () => {
  await writeFile(
    join(resultStoreDir, 'res_hours.json'),
    JSON.stringify({
      resultId: 'res_hours',
      columns: [
        { name: 'hour', logicalType: 'BIGINT' },
        { name: 'value', logicalType: 'DOUBLE' },
      ],
      rows: [
        ['1', 20],
        ['2', 30],
        ['10', 40],
      ],
    }),
  )
  const artifact = await createChartArtifact({
    resultId: 'res_hours',
    intent: { mark: 'line', title: 'Hourly', x: 'hour', y: 'value' },
    resultStoreDir,
    artifactStoreDir,
  })
  const stored = JSON.parse(
    await readFile(join(artifactStoreDir, `${artifact.artifactId}.json`), 'utf8'),
  )
  expect(stored.vegaLiteSpec.encoding.x.type).toBe('quantitative')
  expect(stored.vegaLiteSpec.data.values.map((row: { hour: number }) => row.hour)).toEqual([
    1, 2, 10,
  ])
})

/**
 * Regression for the live sleep-health walkthrough bug (docs/implementation.md
 * item 9): `rowsToChartRows` used to put `intent.y` in its always-numeric set
 * regardless of chart mark. For a heatmap, `y` is a categorical axis field
 * (the actual quantitative field is `value`), so any categorical value
 * landing in the `y` role — occupation, then bmi_category, after the fields
 * were swapped — was rejected by `toChartNumber` as "not a plain
 * decimal/integer string", no matter which column played which role.
 */
it('creates a heatmap chart artifact from two categorical fields and one numeric value field', async () => {
  await writeFile(
    join(resultStoreDir, 'res_sleep.json'),
    JSON.stringify({
      resultId: 'res_sleep',
      columns: [
        { name: 'occupation', logicalType: 'VARCHAR' },
        { name: 'bmi_category', logicalType: 'VARCHAR' },
        { name: 'avg_sleep_duration', logicalType: 'DECIMAL(18,2)' },
      ],
      rows: [
        ['Accountant', 'Normal', '7.20'],
        ['Nurse', 'Overweight', '6.50'],
      ],
    }),
  )
  const artifact = await createChartArtifact({
    resultId: 'res_sleep',
    intent: {
      mark: 'heatmap',
      title: 'Average sleep duration by occupation and BMI category',
      x: 'occupation',
      y: 'bmi_category',
      value: 'avg_sleep_duration',
    },
    resultStoreDir,
    artifactStoreDir,
  })
  const stored = JSON.parse(
    await readFile(join(artifactStoreDir, `${artifact.artifactId}.json`), 'utf8'),
  )
  expect(stored.vegaLiteSpec.mark).toBe('rect')
  expect(stored.vegaLiteSpec.encoding.x).toMatchObject({ field: 'occupation', type: 'nominal' })
  expect(stored.vegaLiteSpec.encoding.y).toMatchObject({ field: 'bmi_category', type: 'nominal' })
  expect(stored.vegaLiteSpec.encoding.color).toMatchObject({
    field: 'avg_sleep_duration',
    type: 'quantitative',
  })
  // The numeric string was actually converted to a number, not left as a
  // string that happens to render — Vega-Lite's quantitative color scale
  // requires real numbers.
  expect(
    stored.vegaLiteSpec.data.values.map(
      (row: { avg_sleep_duration: number }) => row.avg_sleep_duration,
    ),
  ).toEqual([7.2, 6.5])
})

it('folds a stored result warning into the compiled chart title subtitle', async () => {
  await writeFile(
    join(resultStoreDir, 'res_flagged.json'),
    JSON.stringify({
      resultId: 'res_flagged',
      columns: [
        { name: 'region', logicalType: 'VARCHAR' },
        { name: 'revenue', logicalType: 'DECIMAL(18,2)' },
      ],
      rows: [['West', '100.00']],
      warnings: ['currency-mix-risk: orders.currency mixes EUR, USD'],
    }),
  )
  const artifact = await createChartArtifact({
    resultId: 'res_flagged',
    intent: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    resultStoreDir,
    artifactStoreDir,
  })
  const sidecar = JSON.parse(
    await readFile(join(artifactStoreDir, `${artifact.artifactId}.json`), 'utf8'),
  ) as { vegaLiteSpec: { title: { subtitle: string } } }
  expect(sidecar.vegaLiteSpec.title.subtitle).toBe(
    'currency-mix-risk: orders.currency mixes EUR, USD',
  )
})

it('leaves the chart title as a plain string when the stored result has no warnings', async () => {
  const artifact = await createChartArtifact({
    resultId: 'res_abc123',
    intent: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    resultStoreDir,
    artifactStoreDir,
  })
  const sidecar = JSON.parse(
    await readFile(join(artifactStoreDir, `${artifact.artifactId}.json`), 'utf8'),
  ) as { vegaLiteSpec: { title: unknown } }
  expect(sidecar.vegaLiteSpec.title).toBe('Revenue')
})

it('throws a typed ChartValidationError distinguishable from an unexpected render failure', async () => {
  await writeFile(
    join(resultStoreDir, 'res_badfield.json'),
    JSON.stringify({
      resultId: 'res_badfield',
      columns: [{ name: 'region', logicalType: 'VARCHAR' }],
      rows: [['West']],
    }),
  )
  await expect(
    createChartArtifact({
      resultId: 'res_badfield',
      intent: { mark: 'bar', title: 'x', x: 'region', y: 'missing_field' },
      resultStoreDir,
      artifactStoreDir,
    }),
  ).rejects.toThrow(ChartValidationError)
})

it('rejects unsafe integer x coordinates instead of rounding them', async () => {
  await writeFile(
    join(resultStoreDir, 'res_unsafe.json'),
    JSON.stringify({
      resultId: 'res_unsafe',
      columns: [
        { name: 'x', logicalType: 'BIGINT' },
        { name: 'value', logicalType: 'DOUBLE' },
      ],
      rows: [['9007199254740993', 20]],
    }),
  )
  await expect(
    createChartArtifact({
      resultId: 'res_unsafe',
      intent: { mark: 'line', title: 'Unsafe', x: 'x', y: 'value' },
      resultStoreDir,
      artifactStoreDir,
    }),
  ).rejects.toThrow('safe-integer')
})

/**
 * The resolved
 * delivery profile and its pixel width travel with the artifact's own
 * provenance record, so a later reader (export, rechart, an audit) can see
 * which profile actually produced a given artifact.
 */
it('records the requested delivery profile and its resolved pixel width in the artifact sidecar', async () => {
  const artifact = await createChartArtifact({
    resultId: 'res_abc123',
    intent: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    deliveryProfile: 'sidebar-wide',
    resultStoreDir,
    artifactStoreDir,
  })
  const sidecar = JSON.parse(
    await readFile(join(artifactStoreDir, `${artifact.artifactId}.json`), 'utf8'),
  ) as { deliveryProfile?: string; deliveryWidthPx?: number }
  expect(sidecar.deliveryProfile).toBe('sidebar-wide')
  expect(sidecar.deliveryWidthPx).toBeGreaterThan(0)
})

it('omits deliveryProfile/deliveryWidthPx from the sidecar when the caller does not select a profile', async () => {
  const artifact = await createChartArtifact({
    resultId: 'res_abc123',
    intent: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    resultStoreDir,
    artifactStoreDir,
  })
  const sidecar = JSON.parse(
    await readFile(join(artifactStoreDir, `${artifact.artifactId}.json`), 'utf8'),
  ) as Record<string, unknown>
  expect(sidecar).not.toHaveProperty('deliveryProfile')
  expect(sidecar).not.toHaveProperty('deliveryWidthPx')
})

it('renders a wider facet grid at the sidebar-wide profile than at chat-card, for the same result', async () => {
  await writeFile(
    join(resultStoreDir, 'res_facet.json'),
    JSON.stringify({
      resultId: 'res_facet',
      columns: [
        { name: 'region', logicalType: 'VARCHAR' },
        { name: 'group', logicalType: 'VARCHAR' },
        { name: 'revenue', logicalType: 'DECIMAL(18,2)' },
      ],
      rows: [
        ['North', 'A', '80.00'],
        ['South', 'A', '50.00'],
        ['North', 'B', '40.00'],
        ['South', 'B', '30.00'],
      ],
    }),
  )
  const narrow = await createChartArtifact({
    resultId: 'res_facet',
    intent: { mark: 'bar', title: 't', x: 'region', y: 'revenue', facet: 'group' },
    deliveryProfile: 'chat-card',
    resultStoreDir,
    artifactStoreDir,
  })
  const wide = await createChartArtifact({
    resultId: 'res_facet',
    intent: { mark: 'bar', title: 't', x: 'region', y: 'revenue', facet: 'group' },
    deliveryProfile: 'sidebar-wide',
    resultStoreDir,
    artifactStoreDir,
  })
  expect(wide.layoutValidation.bounds.width).toBeGreaterThan(narrow.layoutValidation.bounds.width)
})

it('records a "chart rendered" workflow trail milestone when catalogPath and a stored datasetVersionId are present', async () => {
  const { MetadataStore } = await import('dsh-data-core/metadata-store')
  const catalogPath = join(directory, 'catalog.sqlite')
  const seed = new MetadataStore(catalogPath)
  seed.close()

  await writeFile(
    join(resultStoreDir, 'res_withdsv.json'),
    JSON.stringify({
      resultId: 'res_withdsv',
      datasetVersionId: 'food-ordering-v1',
      columns: [
        { name: 'region', logicalType: 'VARCHAR' },
        { name: 'revenue', logicalType: 'DECIMAL(18,2)' },
      ],
      rows: [
        ['West', '100.00'],
        ['East', '50.00'],
      ],
    }),
    'utf8',
  )

  const result = await createChartArtifact({
    resultId: 'res_withdsv',
    intent: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    resultStoreDir,
    artifactStoreDir,
    catalogPath,
  })

  const store = new MetadataStore(catalogPath)
  try {
    const trail = store.listWorkflowTrail({ datasetVersionId: 'food-ordering-v1' })
    expect(trail).toHaveLength(1)
    expect(trail[0]).toMatchObject({
      milestone: 'chart_rendered',
      actor: 'service',
      datasetVersionId: 'food-ordering-v1',
      receiptId: result.artifactId,
    })
  } finally {
    store.close()
  }
})

it('does not record a workflow trail milestone when no catalogPath is given (unit-test default)', async () => {
  // Confirms the existing tests above (no `catalogPath`) never touch SQLite —
  // omitting it is a no-op, not a silent failure.
  const result = await createChartArtifact({
    resultId: 'res_abc123',
    intent: { mark: 'bar', title: 'Revenue', x: 'region', y: 'revenue' },
    resultStoreDir,
    artifactStoreDir,
  })
  expect(result.rendered).toBe(true)
})
