/**
 * `report_chart_issue`
 * / `list_chart_feedback` and the `chart-feedback-review.ts` analyst review
 * route. Proves the acceptance criteria directly:
 *  - rejected when artifactId/analysisId/revision doesn't reference a real,
 *    persisted analysis revision that actually carries that artifact
 *    (existence + relationship check, not just schema shape);
 *  - issueType must be one of the bounded enum values, no free-form value;
 *  - the record is listable via a bounded read path;
 *  - most importantly: submitting (and even analyst-approving) chart
 *    feedback never creates or surfaces a new row in the approved
 *    reusable-learning-evidence store (`listCompatibleLearningExamples`,
 *    backed by `learning_examples`) — that stays a separate, deliberately
 *    gated Learning v1.1 workstream (docs/implementation.md item 1).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { saveAnalysisRevision } from 'dsh-data-core/analysis-store'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { resolveWorkspacePaths, type WorkspacePaths } from 'dsh-data-core/workspace-paths'
import { registerWorkbenchAnalystTools } from '../src/plugin-tools.js'
import { handleChartFeedbackReviewRequest } from '../src/chart-feedback-review.js'

interface CapturedTool {
  name: string
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>
}

function fakeContext(): { ctx: unknown; registered: CapturedTool[] } {
  const registered: CapturedTool[] = []
  const ctx = {
    tools: {
      register: (tool: CapturedTool) => {
        registered.push(tool)
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

function findTool(registered: CapturedTool[], name: string): CapturedTool {
  const tool = registered.find((entry) => entry.name === name)
  if (!tool) throw new Error(`Tool ${name} was not registered`)
  return tool
}

let directory: string
let previousWorkspace: string | undefined
let workspace: WorkspacePaths
let analysisId: string
let revision: number
const ARTIFACT_ID = 'art_9dd789f676df4f1e'

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-chart-feedback-tool-'))
  previousWorkspace = process.env.DSH_DATA_WORKSPACE
  process.env.DSH_DATA_WORKSPACE = directory
  workspace = resolveWorkspacePaths(directory)

  const saved = await saveAnalysisRevision(workspace.catalogPath, {
    datasetVersionId: 'food-ordering-v1',
    semanticRevisionId: 'sem-food-ordering-v1',
    question: 'Orders by occupation',
    query: {
      datasetVersionId: 'food-ordering-v1',
      semanticRevisionId: 'sem-food-ordering-v1',
      sql: 'SELECT occupation, COUNT(*) FROM orders GROUP BY occupation',
      parameters: [],
    },
    resultId: 'res_abc123',
    chart: { mark: 'bar', title: 'Orders by occupation', x: 'occupation', y: 'count' },
    artifactIds: [ARTIFACT_ID],
  })
  analysisId = saved.analysisId
  revision = saved.revision

  // Seed one genuinely approved learning example (unrelated table) so the
  // negative test has something it could wrongly pick up if the two stores
  // were conflated.
  const store = new MetadataStore(workspace.catalogPath)
  const example = store.createLearningExample({
    analysisId,
    analysisRevision: revision,
    datasetId: 'food-ordering',
    datasetVersionId: 'food-ordering-v1',
    schemaFingerprint: 'recipe-v1',
    semanticRevisionId: 'sem-food-ordering-v1',
    question: saved.question,
    correctedSql: 'SELECT occupation, COUNT(*) FROM orders GROUP BY occupation',
    actorId: 'analyst-session',
  })
  store.setLearningExampleStatus(example.exampleId, 'approved')
  store.close()
})

afterEach(async () => {
  if (previousWorkspace === undefined) delete process.env.DSH_DATA_WORKSPACE
  else process.env.DSH_DATA_WORKSPACE = previousWorkspace
  await rm(directory, { recursive: true, force: true })
})

function approvedLearningEvidenceCount(): number {
  const store = new MetadataStore(workspace.catalogPath)
  try {
    return store.listCompatibleLearningExamples({
      datasetId: 'food-ordering',
      schemaFingerprint: 'recipe-v1',
      semanticRevisionId: 'sem-food-ordering-v1',
    }).length
  } finally {
    store.close()
  }
}

it('rejects a free-form issue type', async () => {
  const { ctx, registered } = fakeContext()
  registerWorkbenchAnalystTools(ctx as never)
  const tool = findTool(registered, 'report_chart_issue')
  await expect(
    tool.execute({
      artifactId: ARTIFACT_ID,
      analysisId,
      revision,
      issueType: 'axis-title-too-big',
    }),
  ).rejects.toThrow(/issueType must be one of/)
})

it('rejects an artifact that is not attached to the given analysis revision', async () => {
  const { ctx, registered } = fakeContext()
  registerWorkbenchAnalystTools(ctx as never)
  const tool = findTool(registered, 'report_chart_issue')
  await expect(
    tool.execute({
      artifactId: 'art_not_attached',
      analysisId,
      revision,
      issueType: 'overlap',
    }),
  ).rejects.toThrow(/is not attached to analysis/)
})

it('rejects an unknown analysisId/revision', async () => {
  const { ctx, registered } = fakeContext()
  registerWorkbenchAnalystTools(ctx as never)
  const tool = findTool(registered, 'report_chart_issue')
  await expect(
    tool.execute({
      artifactId: ARTIFACT_ID,
      analysisId: 'ana_does_not_exist',
      revision: 1,
      issueType: 'overlap',
    }),
  ).rejects.toThrow()
})

it('accepts a well-formed report, starts it as candidate, and lists it via the bounded read path', async () => {
  const { ctx, registered } = fakeContext()
  registerWorkbenchAnalystTools(ctx as never)
  const report = findTool(registered, 'report_chart_issue')
  const created = (await report.execute({
    artifactId: ARTIFACT_ID,
    analysisId,
    revision,
    issueType: 'overlap',
    notes: 'Faceted x-axis titles overlap at the bottom.',
  })) as { feedbackId: string; status: string; issueType: string }
  expect(created.status).toBe('candidate')
  expect(created.issueType).toBe('overlap')
  expect(created.feedbackId).toMatch(/^cfb_[a-f0-9]{16}$/)

  const list = findTool(registered, 'list_chart_feedback')
  const listed = (await list.execute({ analysisId })) as {
    feedback: Array<{ feedbackId: string; status: string }>
  }
  expect(listed.feedback).toHaveLength(1)
  expect(listed.feedback[0]!.feedbackId).toBe(created.feedbackId)
  expect(listed.feedback[0]!.status).toBe('candidate')
})

it('never creates or surfaces new approved reusable learning evidence after submitting chart feedback', async () => {
  const before = approvedLearningEvidenceCount()
  expect(before).toBe(1) // the unrelated seeded example only

  const { ctx, registered } = fakeContext()
  registerWorkbenchAnalystTools(ctx as never)
  const report = findTool(registered, 'report_chart_issue')
  await report.execute({
    artifactId: ARTIFACT_ID,
    analysisId,
    revision,
    issueType: 'overlap',
  })

  expect(approvedLearningEvidenceCount()).toBe(before)
})

it('even after an analyst approves the chart feedback via the review route, learning evidence is unaffected', async () => {
  const { ctx, registered } = fakeContext()
  registerWorkbenchAnalystTools(ctx as never)
  const report = findTool(registered, 'report_chart_issue')
  const created = (await report.execute({
    artifactId: ARTIFACT_ID,
    analysisId,
    revision,
    issueType: 'clipping',
  })) as { feedbackId: string }

  const denied = await handleChartFeedbackReviewRequest(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { origin: 'https://evil.example', host: 'localhost' },
      body: JSON.stringify({ feedbackId: created.feedbackId, status: 'approved' }),
    }),
    workspace.catalogPath,
  )
  expect(denied.status).toBe(403)

  const before = approvedLearningEvidenceCount()
  const response = await handleChartFeedbackReviewRequest(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { origin: 'http://localhost', host: 'localhost' },
      body: JSON.stringify({ feedbackId: created.feedbackId, status: 'approved' }),
    }),
    workspace.catalogPath,
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { status: string }
  expect(body.status).toBe('approved')

  // Approving the *feedback* record must never touch learning_examples.
  expect(approvedLearningEvidenceCount()).toBe(before)

  const store = new MetadataStore(workspace.catalogPath)
  try {
    expect(store.listChartFeedback({ status: 'approved' })).toHaveLength(1)
  } finally {
    store.close()
  }
})
