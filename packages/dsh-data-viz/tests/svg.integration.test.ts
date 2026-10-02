import { compile } from 'vega-lite'
import { parse, View } from 'vega'
import { expect, it } from 'vitest'

it('compiles a fixed Vega-Lite chart and exports server-side SVG without external assets', async () => {
  const { spec } = compile({
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    title: 'Net sales by region (USD)',
    width: 400,
    height: 240,
    data: {
      values: [
        { region: 'North', revenue: 80 },
        { region: 'South', revenue: 50 },
      ],
    },
    mark: 'bar',
    encoding: {
      x: { field: 'region', type: 'nominal', title: 'Region' },
      y: { field: 'revenue', type: 'quantitative', title: 'Net sales (USD)' },
    },
  })
  const view = new View(parse(spec), { renderer: 'none' })
  try {
    const svg = await view.toSVG()
    expect(svg).toContain('<svg')
    expect(svg).toContain('Net sales by region (USD)')
    expect(svg).toContain('North')
    expect(svg).toContain('South')
    expect(svg).not.toMatch(/<script|<image|(?:href|src)=["']https?:/)
  } finally {
    view.finalize()
  }
})
