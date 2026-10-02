/**
 * Server-side SVG → PNG via @resvg/resvg-js (no browser Canvas).
 */
import { Resvg } from '@resvg/resvg-js'

/** Render an SVG document string to a PNG buffer. */
export function createPngFromSvg(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'original' },
    // Use installed fonts for chart labels; disabling font discovery drops SVG text.
    font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
  })
  return Buffer.from(resvg.render().asPng())
}
