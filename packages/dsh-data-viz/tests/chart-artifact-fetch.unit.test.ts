import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { handleChartArtifactRequest } from '../src/chart-artifact-fetch.js'

let directory: string
let artifactsDir: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-chart-fetch-'))
  artifactsDir = join(directory, 'artifacts')
  await mkdir(artifactsDir, { recursive: true })
  await writeFile(
    join(artifactsDir, 'art_demo123.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'utf8',
  )
  await writeFile(
    join(artifactsDir, 'art_demo123.json'),
    JSON.stringify({
      artifactId: 'art_demo123',
      resultId: 'res_demo',
      intent: { title: 'Demo', mark: 'bar' },
    }),
    'utf8',
  )
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('serves SVG for a valid artifact id', async () => {
  const response = await handleChartArtifactRequest(
    new Request('http://127.0.0.1/api/analyst/artifacts?id=art_demo123&format=svg'),
    artifactsDir,
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toMatch(/image\/svg\+xml/)
  expect(await response.text()).toContain('<svg')
})

it('serves PNG rasterized from the stored SVG', async () => {
  const response = await handleChartArtifactRequest(
    new Request('http://127.0.0.1/api/analyst/artifacts?id=art_demo123&format=png'),
    artifactsDir,
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/png')
  const bytes = Buffer.from(await response.arrayBuffer())
  expect(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true)
})

it('serves sidecar JSON without embedding SVG markup', async () => {
  const response = await handleChartArtifactRequest(
    new Request('http://127.0.0.1/api/analyst/artifacts?id=art_demo123&format=json'),
    artifactsDir,
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { artifactId?: string; intent?: { title?: string } }
  expect(body.artifactId).toBe('art_demo123')
  expect(body.intent?.title).toBe('Demo')
})

it('rejects path traversal and unknown formats', async () => {
  const traversal = await handleChartArtifactRequest(
    new Request('http://127.0.0.1/api/analyst/artifacts?id=../secret&format=svg'),
    artifactsDir,
  )
  expect(traversal.status).toBe(400)
  const badFormat = await handleChartArtifactRequest(
    new Request('http://127.0.0.1/api/analyst/artifacts?id=art_demo123&format=html'),
    artifactsDir,
  )
  expect(badFormat.status).toBe(400)
})

it('returns 404 for a missing artifact', async () => {
  const response = await handleChartArtifactRequest(
    new Request('http://127.0.0.1/api/analyst/artifacts?id=art_missing000&format=svg'),
    artifactsDir,
  )
  expect(response.status).toBe(404)
})
