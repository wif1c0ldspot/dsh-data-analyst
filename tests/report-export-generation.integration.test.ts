/**
 * Runs a fixed approved
 * aggregate against the read-only-reopened synthetic fixture, compiles a fixed
 * chart intent to Vega-Lite, renders actual SVG, and generates an actual fixed
 * HTML report file. Verifies total, axis labels, sorting, source caption, an
 * empty-result state, and a Decimal/date case without unsafe coercion. No
 * model call. Writes real files to a temp directory and reads them back so
 * the assertion is against on-disk output, not just in-memory strings.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { expect, it } from 'vitest'
import { runFixedQuery } from '../packages/dsh-data-duckdb/dist/fixed-query.js'
import {
  compileChartIntent,
  renderChartSvg,
  renderEmptyResultSvg,
  toChartNumber,
} from '../packages/dsh-data-viz/dist/chart.js'
import { renderHtmlReport } from '../packages/dsh-data-core/dist/report-template.js'

async function withReadOnlyFixture<T>(
  fn: (connection: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-p0-3-'))
  const databasePath = join(directory, 'fixture.duckdb')
  const fixturePath = fileURLToPath(new URL('../tests/fixtures/retail.csv', import.meta.url))
  try {
    const writer = await DuckDBInstance.create(databasePath)
    try {
      const connection = await writer.connect()
      try {
        await connection.run(
          `CREATE TABLE retail AS SELECT * FROM read_csv(?, header=true,
          columns={'line_id':'VARCHAR','customer_id':'VARCHAR','order_date':'DATE','region':'VARCHAR','amount':'DECIMAL(18,2)'})`,
          [fixturePath],
        )
        await connection.run('CHECKPOINT')
      } finally {
        connection.closeSync()
      }
    } finally {
      writer.closeSync()
    }
    const reader = await DuckDBInstance.create(databasePath, {
      access_mode: 'READ_ONLY',
      enable_external_access: 'false',
    })
    try {
      const connection = await reader.connect()
      try {
        return await fn(connection)
      } finally {
        connection.closeSync()
      }
    } finally {
      reader.closeSync()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

it('renders an actual offline-openable HTML report with SVG chart, correct total, axis labels, and sorting', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'dsh-report-export-generation-'))
  try {
    await withReadOnlyFixture(async (connection) => {
      const result = await runFixedQuery(
        connection,
        'SELECT region, SUM(amount) AS revenue FROM retail GROUP BY region ORDER BY revenue DESC, region',
      )

      // Sorting: DuckDB itself already returned North (80.00) before South (50.00).
      expect(result.rows).toEqual([
        ['North', '80.00'],
        ['South', '50.00'],
      ])

      const chartRows = result.rows.map(([region, revenue]) => ({
        region: region as string,
        revenue: toChartNumber(revenue as string),
      }))
      const total = chartRows.reduce((sum, row) => sum + row.revenue, 0)
      expect(total).toBe(130) // gross 150.00 minus a -20.00 return, per docs/contracts.md.

      const intent = {
        mark: 'bar' as const,
        title: 'Net sales by region',
        x: 'region',
        y: 'revenue',
        xLabel: 'Region',
        yLabel: 'Net sales (USD)',
        sort: { field: 'revenue', direction: 'descending' as const },
      }
      const spec = compileChartIntent(intent, chartRows)
      const svg = await renderChartSvg(spec)
      expect(svg).toContain('<svg')
      expect(svg).toContain('Region')
      expect(svg).toContain('Net sales (USD)')

      const html = renderHtmlReport({
        title: intent.title,
        svgMarkup: svg,
        columns: result.columns.map((column) => ({
          name: column.name,
          logicalType: column.logicalType,
        })),
        rows: result.rows.map((row) => row.map((cell) => String(cell))),
        rowCount: result.rowCount,
        previewTruncated: result.previewTruncated,
        sourceCaption: 'Synthetic retail fixture (development split), tests/fixtures/retail.csv',
        datasetVersionId: 'synthetic-retail-v1',
        semanticRevisionId: 'retail-semantics-v1',
        generatedAt: new Date('2026-09-13T00:00:00.000Z').toISOString(),
        warnings: result.warnings,
      })

      const svgPath = join(outputDirectory, 'net-sales-by-region.svg')
      const htmlPath = join(outputDirectory, 'net-sales-by-region.html')
      await writeFile(svgPath, svg, 'utf8')
      await writeFile(htmlPath, html, 'utf8')

      const svgOnDisk = await readFile(svgPath, 'utf8')
      const htmlOnDisk = await readFile(htmlPath, 'utf8')
      expect(svgOnDisk).toContain('<svg')
      expect(htmlOnDisk).toContain('<!doctype html>')
      expect(htmlOnDisk).toContain(svgOnDisk) // Report embeds the actual rendered SVG.
      expect(htmlOnDisk).toContain('Region')
      expect(htmlOnDisk).toContain('Net sales (USD)')
      expect(htmlOnDisk).toContain(
        'Synthetic retail fixture (development split), tests/fixtures/retail.csv',
      )
      expect(htmlOnDisk).toContain('<td>North</td>')
      expect(htmlOnDisk).toContain('<td>80.00</td>')
      expect(htmlOnDisk).toContain('<td>South</td>')
      expect(htmlOnDisk).toContain('<td>50.00</td>')
      // North (80.00) row precedes South (50.00) row in the on-disk table markup.
      expect(htmlOnDisk.indexOf('<td>North</td>')).toBeLessThan(
        htmlOnDisk.indexOf('<td>South</td>'),
      )
      // No script, remote stylesheet, or remote image reference in the offline
      // artifact. SVG's static xmlns namespace URIs are not network fetches.
      expect(htmlOnDisk).not.toMatch(/<script|<image|(?:href|src)=["']https?:/)
    })
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

it('renders an explicit empty-result report instead of an implicit zero total', async () => {
  await withReadOnlyFixture(async (connection) => {
    const result = await runFixedQuery(
      connection,
      "SELECT region, SUM(amount) AS revenue FROM retail WHERE region = 'Nonexistent' GROUP BY region",
    )
    expect(result.rowCount).toBe(0)
    const svg = await renderEmptyResultSvg('Net sales by region')
    expect(svg).toContain('No rows returned for this query')
    const html = renderHtmlReport({
      title: 'Net sales by region',
      svgMarkup: svg,
      columns: result.columns.map((column) => ({
        name: column.name,
        logicalType: column.logicalType,
      })),
      rows: [],
      rowCount: 0,
      previewTruncated: false,
      sourceCaption: 'Synthetic retail fixture (development split)',
      datasetVersionId: 'synthetic-retail-v1',
      semanticRevisionId: 'retail-semantics-v1',
      generatedAt: new Date().toISOString(),
      warnings: [],
    })
    expect(html).toContain('This query returned no rows')
    expect(html).not.toMatch(/<td>0(\.00)?<\/td>/)
  })
})

it('preserves exact DECIMAL and DATE values end to end without unsafe numeric coercion', async () => {
  await withReadOnlyFixture(async (connection) => {
    const result = await runFixedQuery(
      connection,
      'SELECT line_id, order_date, amount FROM retail ORDER BY line_id',
    )
    // DATE stays an ISO display string; DECIMAL stays an exact display string.
    expect(result.rows[0]).toEqual(['001', '2024-01-01', '100.00'])
    for (const [, , amount] of result.rows) {
      expect(() => toChartNumber(amount as string)).not.toThrow()
    }
    // An unsafe-integer BIGINT string must be rejected by the chart numeric
    // conversion rather than silently truncated to a lossy JS number.
    expect(() => toChartNumber('9007199254740993')).toThrow(/safe-integer range/)
  })
})
