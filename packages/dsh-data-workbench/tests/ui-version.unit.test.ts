import type { AnalysisRevision, Dashboard } from 'dsh-data-core/contracts'
import { expect, it } from 'vitest'
import {
  ANALYST_RESOURCE_VERSION_HEADER,
  analysisResourceVersion,
  conflictFragmentResponse,
  dashboardResourceVersion,
  expectedVersionFromRequest,
  fragmentResponse,
} from '../src/ui-version.js'

it('sets X-Analyst-Resource-Version on fragment responses', async () => {
  const res = fragmentResponse('<section>ok</section>', 'v3')
  expect(res.headers.get(ANALYST_RESOURCE_VERSION_HEADER)).toBe('v3')
  expect(await res.text()).toContain('<section>ok</section>')
})

it('defaults fragment responses to status 200 with text/html', () => {
  const res = fragmentResponse('<section>ok</section>', 'v1')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
})

it('returns 409 conflict fragments with optional version header', async () => {
  const withVersion = conflictFragmentResponse('<section>stale</section>', 'v5')
  expect(withVersion.status).toBe(409)
  expect(withVersion.headers.get(ANALYST_RESOURCE_VERSION_HEADER)).toBe('v5')
  expect(await withVersion.text()).toContain('<section>stale</section>')

  const withoutVersion = conflictFragmentResponse('<section>stale</section>')
  expect(withoutVersion.status).toBe(409)
  expect(withoutVersion.headers.get(ANALYST_RESOURCE_VERSION_HEADER)).toBeNull()
})

it('reads expectedVersion from JSON POST body', async () => {
  const request = new Request('http://localhost/api/analyst/ui/dashboard/dash_1/filter', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedVersion: '2026-09-15T12:00:00.000Z',
      column: 'region',
      value: 'West',
    }),
  })
  expect(await expectedVersionFromRequest(request)).toBe('2026-09-15T12:00:00.000Z')
})

it('returns null when expectedVersion is missing from JSON POST body', async () => {
  const request = new Request('http://localhost/api/analyst/ui/dashboard/dash_1/filter', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ column: 'region', value: 'West' }),
  })
  expect(await expectedVersionFromRequest(request)).toBeNull()
})

it('derives dashboard version from updatedAt', () => {
  const dashboard: Dashboard = {
    dashboardId: 'dash_abc123',
    title: 'Revenue board',
    layout: { slots: [] },
    archived: false,
    createdAt: '2026-09-15T10:00:00.000Z',
    updatedAt: '2026-09-15T12:00:00.000Z',
  }
  expect(dashboardResourceVersion(dashboard)).toBe('2026-09-15T12:00:00.000Z')
})

it('derives analysis version from revision counter', () => {
  const revision = {
    contractVersion: 1,
    analysisId: 'ana_abc123',
    revision: 3,
    datasetVersionId: 'superstore-v1',
    semanticRevisionId: 'sem-superstore-v1',
    question: 'Revenue by region',
    query: {
      sql: 'SELECT 1',
      datasetVersionId: 'superstore-v1',
      semanticRevisionId: 'sem-superstore-v1',
      parameters: [],
    },
    resultId: 'res_abc123',
    chart: { mark: 'bar', title: 'Revenue by region', x: 'region', y: 'sales' },
    artifactIds: ['art_abc123'],
    createdAt: '2026-09-15T12:00:00.000Z',
  } satisfies AnalysisRevision
  expect(analysisResourceVersion(revision)).toBe('3')
})
