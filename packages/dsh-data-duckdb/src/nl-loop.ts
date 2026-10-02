/**
 * Deterministic-first NL ask loop (P3). Pluggable SqlGenerator; default fixture
 * maps held-out golden questions to reviewed SQL (no model required).
 */
import { getDatasetSchemaSlice, type DatasetSchemaSlice } from 'dsh-data-core/catalog-query'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { getEffectiveSemantics } from 'dsh-data-core/semantics'
import type { WorkspacePaths } from 'dsh-data-core/workspace-paths'
import { createChartArtifact } from 'dsh-data-viz/chart-service'
import { buildDefaultChartIntent } from './chart-mark.js'
import { GOLDEN_CASES, SYNTHETIC_GOLDEN_CASES } from './nl-eval.js'
import { classifyAnalystQuestion, clarifyRefuseMessage } from './question-intent.js'
import type { AuthorizedQuerySummary } from './query-service.js'
import { executeIsolatedQuery } from './query-worker.js'
export type { AnalystQuestionIntent } from './question-intent.js'
export { classifyAnalystQuestion, clarifyRefuseMessage } from './question-intent.js'

export interface SqlGenerator {
  generateSql(input: {
    question: string
    datasetId: string
    schemaSummary: string
    signal?: AbortSignal
  }): Promise<string>
}

/**
 * Map known golden / synthetic questions to reviewed SQL. Used when no model
 * generator is configured (`DSH_NL_GENERATOR=fixture`, default).
 */
export const fixtureSqlGenerator: SqlGenerator = {
  async generateSql({ question, datasetId }) {
    const needle = question.trim().toLowerCase()
    const match = [...SYNTHETIC_GOLDEN_CASES, ...GOLDEN_CASES].find(
      (testCase) =>
        testCase.datasetId === datasetId && testCase.question.trim().toLowerCase() === needle,
    )
    if (!match) {
      throw new Error(
        `No fixture SQL for dataset "${datasetId}" question "${question.trim()}". ` +
          'Use a known golden question or plug in another SqlGenerator.',
      )
    }
    return match.goldenSql
  },
}

const SCHEMA_COLUMN_PAGE_LIMIT = 50

function buildSchemaSummary(schema: DatasetSchemaSlice): string {
  // Prefer the bounded published catalog slice + effective aliases — not in-code Core recipes.
  const tablePart = schema.tables
    .map((table) => {
      const columns = (table.columns ?? [])
        .map((column) => `${column.name} ${column.type}`)
        .join(', ')
      return `${table.id}(${table.rows} rows${columns ? `; columns: ${columns}` : ''})`
    })
    .join(', ')
  const returnedColumns = schema.tables.reduce(
    (total, table) => total + (table.columns?.length ?? 0),
    0,
  )
  const columnPagePart = `columns: ${returnedColumns}/${schema.totalColumns}${
    schema.nextOffset === null ? '' : `; next offset: ${schema.nextOffset}`
  }`
  const aliasPart =
    schema.aliases.length === 0
      ? 'none'
      : schema.aliases
          .map((alias) => `${alias.term} on ${alias.tableId}=${alias.expression}`)
          .join('; ')
  return `tables: ${tablePart}; ${columnPagePart}; aliases: ${aliasPart}`
}

/** Bounded reviewed examples; SQL policy still authorizes every generated query. */
export function formatLearningExamples(
  examples: ReadonlyArray<{ question: string; correctedSql: string }>,
): string {
  if (examples.length === 0) return ''
  return `; reviewed examples: ${examples
    .slice(0, 3)
    .map(
      (example) =>
        `Q=${JSON.stringify(example.question.slice(0, 300))} SQL=${JSON.stringify(example.correctedSql.slice(0, 2000))}`,
    )
    .join(' | ')}`
}

export interface AnalystAnswerResult {
  kind: 'answer'
  sql: string
  summary: AuthorizedQuerySummary
  chartArtifactId?: string
  /** Analyst turns consumed for this answer (1 = single generate→query→chart). */
  analystTurns: number
  /** Remaining turns before the Core ≤2 budget is exhausted. */
  turnsRemaining: number
}

export interface AnalystClarifyRefuseResult {
  kind: 'clarify' | 'refuse'
  message: string
  analystTurns: number
  turnsRemaining: number
}

/** Ask-path outcome: answer with SQL/chart, or explicit clarify|refuse. */
export type AnalystQuestionResult = AnalystAnswerResult | AnalystClarifyRefuseResult

const MAX_ANALYST_TURNS = 2

export async function runAnalystQuestion(opts: {
  workspace: WorkspacePaths
  datasetId: string
  question: string
  generator: SqlGenerator
  /** Prior turns already spent in this analysis thread (default 0). */
  priorTurns?: number
  signal?: AbortSignal
}): Promise<AnalystQuestionResult> {
  const priorTurns = opts.priorTurns ?? 0
  if (priorTurns >= MAX_ANALYST_TURNS) {
    throw new Error(
      `Analyst turn budget exhausted (${priorTurns}/${MAX_ANALYST_TURNS}); clarify or start a new analysis`,
    )
  }
  const analystTurns = priorTurns + 1
  const turnsRemaining = MAX_ANALYST_TURNS - analystTurns

  const store = new MetadataStore(opts.workspace.catalogPath)
  try {
    const semantics = getEffectiveSemantics(opts.datasetId, store)
    if (!semantics) {
      throw new Error(`No semantics for dataset "${opts.datasetId}"`)
    }
    const intent = classifyAnalystQuestion(opts.question, {
      datasetId: opts.datasetId,
      knownDatasetIds: store.listCurrentDatasetVersions().map((version) => version.datasetId),
      semantics,
    })
    if (intent === 'clarify' || intent === 'refuse') {
      return {
        kind: intent,
        message: clarifyRefuseMessage(intent, opts.question),
        analystTurns,
        turnsRemaining,
      }
    }

    const manifest = store.getCurrentDatasetVersion(opts.datasetId)
    if (!manifest) {
      throw new Error(`Dataset "${opts.datasetId}" is not published`)
    }
    const schema = getDatasetSchemaSlice(store, opts.datasetId, {
      limit: SCHEMA_COLUMN_PAGE_LIMIT,
    })
    const schemaSummary =
      buildSchemaSummary(schema) +
      formatLearningExamples(
        store.listCompatibleLearningExamples({
          datasetId: opts.datasetId,
          schemaFingerprint: manifest.recipeHash,
          semanticRevisionId: semantics.semanticRevisionId,
        }),
      )
    const sql = await opts.generator.generateSql({
      question: opts.question,
      datasetId: opts.datasetId,
      schemaSummary,
      signal: opts.signal,
    })
    const summary = await executeIsolatedQuery({
      datasetPath: opts.workspace.datasetFile(manifest.datasetVersionId, manifest.datasetId),
      datasetVersionId: manifest.datasetVersionId,
      semanticRevisionId: semantics.semanticRevisionId,
      sql,
      parameters: [],
      allowedTables: manifest.tables.map((table) => table.id),
      resultStoreDir: opts.workspace.resultsDir,
      signal: opts.signal,
    })

    let chartArtifactId: string | undefined
    if (summary.columns.length > 0) {
      const chart = await createChartArtifact({
        resultId: summary.resultId,
        intent: buildDefaultChartIntent({
          question: opts.question,
          title: opts.question.trim() || 'Analysis',
          columns: summary.columns,
          rowCount: summary.rowCount,
          preview: summary.preview,
        }),
        resultStoreDir: opts.workspace.resultsDir,
        artifactStoreDir: opts.workspace.artifactsDir,
        signal: opts.signal,
      })
      chartArtifactId = chart.artifactId
    }

    return {
      kind: 'answer',
      sql,
      summary,
      chartArtifactId,
      analystTurns,
      turnsRemaining,
    }
  } finally {
    store.close()
  }
}
