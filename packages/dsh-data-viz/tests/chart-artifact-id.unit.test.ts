import { expect, it } from 'vitest'
import { CHART_ARTIFACT_FETCH_PATH, parseMakeChartArtifactId } from '../src/chart-artifact-id.js'

it('parses artifact ids from make_chart JSON result text', () => {
  expect(parseMakeChartArtifactId(JSON.stringify({ artifactId: 'art_abc123def456' }))).toBe(
    'art_abc123def456',
  )
})

it('rejects traversal and non-artifact ids', () => {
  expect(parseMakeChartArtifactId('../etc/passwd')).toBeNull()
  expect(parseMakeChartArtifactId(JSON.stringify({ artifactId: 'art_../x' }))).toBeNull()
  expect(parseMakeChartArtifactId(JSON.stringify({ artifactId: 'res_abc' }))).toBeNull()
  expect(parseMakeChartArtifactId('{not json')).toBeNull()
})

it('exposes the authenticated fetch path below /api', () => {
  expect(CHART_ARTIFACT_FETCH_PATH).toBe('/api/analyst/artifacts')
})
