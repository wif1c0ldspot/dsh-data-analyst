/**
 * Pluggable SQL generators for the P3 NL loop. Fixture is default; HTTP is
 * opt-in via env and never expands the dsh tool allowlist.
 */
import type { SqlGenerator } from './nl-loop.js'

export type { SqlGenerator }

export interface HttpTokenUsageTotals {
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

let httpTokenUsage: HttpTokenUsageTotals = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
}

export function resetHttpTokenUsage(): void {
  httpTokenUsage = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
}

export function getHttpTokenUsage(): HttpTokenUsageTotals {
  return { ...httpTokenUsage }
}

function recordUsageFromPayload(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return
  const usage = (payload as { usage?: Record<string, unknown> }).usage
  if (!usage) return
  const prompt = Number(usage.prompt_tokens ?? 0)
  const completion = Number(usage.completion_tokens ?? 0)
  const total = Number(usage.total_tokens ?? prompt + completion)
  if (![prompt, completion, total].every((n) => Number.isFinite(n))) return
  httpTokenUsage.calls += 1
  httpTokenUsage.promptTokens += prompt
  httpTokenUsage.completionTokens += completion
  httpTokenUsage.totalTokens += total
}

async function fetchJsonWithRetry(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  label: string,
  attempts = 3,
): Promise<unknown> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    if (init.signal?.aborted) {
      throw init.signal.reason instanceof Error
        ? init.signal.reason
        : new Error(`${label} cancelled`)
    }
    try {
      const response = await fetchImpl(input, init)
      if (!response.ok) {
        const body = await response.text()
        throw new Error(`${label} HTTP ${response.status}: ${body.slice(0, 400)}`)
      }
      const payload: unknown = await response.json()
      recordUsageFromPayload(payload)
      return payload
    } catch (error) {
      lastError = error
      if (init.signal?.aborted) {
        throw error instanceof Error ? error : new Error(`${label} cancelled`)
      }
      if (i + 1 < attempts) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 750 * (i + 1))
          const onAbort = () => {
            clearTimeout(timer)
            reject(new Error(`${label} cancelled`))
          }
          if (init.signal) {
            if (init.signal.aborted) {
              onAbort()
              return
            }
            init.signal.addEventListener('abort', onAbort, { once: true })
          }
        })
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** Shared chat body for local thinking models (Ollama qwen3) and cloud APIs. */
function openAiChatBody(opts: {
  model: string
  messages: Array<{ role: string; content: string }>
  maxTokens?: number
}): Record<string, unknown> {
  return {
    model: opts.model,
    temperature: 0,
    max_tokens: opts.maxTokens ?? 256,
    // Disable thinking on Ollama OpenAI-compat (qwen3); ignored by non-thinking APIs.
    reasoning_effort: 'none',
    think: false,
    messages: opts.messages,
  }
}

function messageContentFromChatPayload(payload: {
  choices?: Array<{ message?: { content?: string; reasoning?: string } }>
}): string {
  const message = payload.choices?.[0]?.message
  const content = message?.content?.trim()
  if (content) return content
  // Some Ollama thinking builds put the answer only in reasoning when content is empty.
  const reasoning = message?.reasoning?.trim()
  if (reasoning) return reasoning
  throw new Error('chat generator returned empty content')
}

/** OpenAI-compatible chat completions → raw SQL string (no markdown fences). */
export function createOpenAiCompatibleSqlGenerator(opts: {
  apiKey: string
  baseUrl: string
  model: string
  fetchImpl?: typeof fetch
}): SqlGenerator {
  const fetchImpl = opts.fetchImpl ?? fetch
  const endpoint = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`
  return {
    async generateSql({ question, datasetId, schemaSummary, signal }) {
      const payload = (await fetchJsonWithRetry(
        fetchImpl,
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
          },
          signal,
          body: JSON.stringify(
            openAiChatBody({
              model: opts.model,
              maxTokens: 384,
              messages: [
                {
                  role: 'system',
                  content:
                    'You write a single DuckDB SELECT (or WITH … SELECT) statement. ' +
                    'No markdown, no commentary, no thinking tags, no semicolons after the statement. ' +
                    'Output ONLY the SQL. ' +
                    'Use unqualified table names only (never schema.table or catalog.schema.table). ' +
                    'Use only column names from Schema. For money/SUM aggregates prefer round(expr, 2). ' +
                    'When ranking, add a stable secondary ORDER BY key. ' +
                    `Dataset id: ${datasetId}. Schema: ${schemaSummary}`,
                },
                { role: 'user', content: question },
              ],
            }),
          ),
        },
        'SQL generator',
      )) as { choices?: Array<{ message?: { content?: string; reasoning?: string } }> }
      const content = messageContentFromChatPayload(payload)
      return normalizeGeneratedSql(stripSqlFences(content), datasetId)
    },
  }
}

export function stripSqlFences(text: string): string {
  // Drop chain-of-thought wrappers from local reasoning models (e.g. qwen3).
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/\/think\b/gi, '')
    .trim()
  const fenced = cleaned.match(/```(?:sql)?\s*([\s\S]*?)```/i)
  const raw = (fenced?.[1] ?? cleaned).trim()
  // Prefer the first SELECT/WITH line if prose remains.
  const selectMatch = raw.match(/\b(WITH\b[\s\S]+|SELECT\b[\s\S]+)/i)
  return (selectMatch?.[1] ?? raw).replace(/;\s*$/, '').trim()
}

/**
 * Strip `@name` placeholders and, when provided, an accidental dataset qualifier
 * outside SQL string literals only. Never rewrite single-quoted literal contents.
 */
export function stripAtPlaceholdersOutsideStrings(sql: string, datasetId?: string): string {
  const qualifier = datasetId
    ? new RegExp(`\\b${datasetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`, 'gi')
    : null
  let out = ''
  let unquoted = ''
  let i = 0
  const flushUnquoted = () => {
    const withoutQualifier = qualifier ? unquoted.replace(qualifier, '') : unquoted
    out += withoutQualifier.replace(/@(?=[A-Za-z_])/g, '')
    unquoted = ''
  }
  while (i < sql.length) {
    const ch = sql[i]!
    if (ch === "'") {
      flushUnquoted()
      out += ch
      i += 1
      while (i < sql.length) {
        const inner = sql[i]!
        out += inner
        i += 1
        if (inner === "'") {
          // SQL escaped quote: ''
          if (sql[i] === "'") {
            out += "'"
            i += 1
            continue
          }
          break
        }
      }
      continue
    }
    unquoted += ch
    i += 1
  }
  flushUnquoted()
  return out
}

/** Drop accidental dataset-id schema qualifiers local models invent. */
export function normalizeGeneratedSql(sql: string, datasetId: string): string {
  // The scanner below intentionally handles ordinary SQL string literals only.
  // Preserve the complete statement when another quoted form or a comment is present.
  if (
    sql.includes('$') ||
    sql.includes('"') ||
    sql.includes('--') ||
    sql.includes('/*') ||
    /\bE'/i.test(sql)
  ) {
    return sql
  }
  return stripAtPlaceholdersOutsideStrings(sql, datasetId)
}

/**
 * Resolve generator from env for workbench / eval scripts.
 * - fixture | echo → caller should use fixtureSqlGenerator
 * - http → OpenAI-compatible endpoint (requires DSH_NL_API_KEY)
 * - oracle → returns reviewed goldenSql by question match (harness wiring only;
 *   NOT a Core v1 model score)
 */
export function resolveHttpSqlGeneratorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SqlGenerator | null {
  const mode = (env.DSH_NL_GENERATOR ?? 'fixture').toLowerCase()
  if (mode !== 'http') return null
  const apiKey = env.DSH_NL_API_KEY ?? env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('DSH_NL_GENERATOR=http requires DSH_NL_API_KEY (or DEEPSEEK_API_KEY)')
  }
  return createOpenAiCompatibleSqlGenerator({
    apiKey,
    baseUrl: env.DSH_NL_API_BASE ?? 'https://api.deepseek.com/v1',
    model: env.DSH_NL_MODEL ?? 'deepseek-chat',
  })
}

/** Test/harness-only generator: maps held-out questions to reviewed goldenSql. */
export function createOracleSqlGenerator(
  cases: ReadonlyArray<{ datasetId: string; question: string; goldenSql: string }>,
): SqlGenerator {
  return {
    async generateSql({ question, datasetId }) {
      const needle = question.trim().toLowerCase()
      const match = cases.find(
        (c) => c.datasetId === datasetId && c.question.trim().toLowerCase() === needle,
      )
      if (!match) {
        throw new Error(`Oracle has no golden SQL for ${datasetId}: ${question}`)
      }
      return match.goldenSql
    },
  }
}

export type ChartIntentGenerator = {
  generateChartIntent(input: {
    question: string
    datasetId: string
    schemaSummary: string
    signal?: AbortSignal
  }): Promise<{ mark: string; x?: string; y?: string }>
}

/** OpenAI-compatible chat → constrained chart intent JSON. */
export function createOpenAiCompatibleChartIntentGenerator(opts: {
  apiKey: string
  baseUrl: string
  model: string
  fetchImpl?: typeof fetch
}): ChartIntentGenerator {
  const fetchImpl = opts.fetchImpl ?? fetch
  const endpoint = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`
  return {
    async generateChartIntent({ question, datasetId, schemaSummary, signal }) {
      const payload = (await fetchJsonWithRetry(
        fetchImpl,
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
          },
          signal,
          body: JSON.stringify(
            openAiChatBody({
              model: opts.model,
              maxTokens: 128,
              messages: [
                {
                  role: 'system',
                  content:
                    'Propose one chart intent as JSON only: {"mark":"bar"|"line"|"point","x":"<name>","y":"<name>"}. ' +
                    'No markdown, no commentary, no thinking tags. ' +
                    'x and y MUST be plain identifiers only — never SQL like SUM(...), COUNT(...), or DISTINCT. ' +
                    'Prefer result aliases: revenue, n, qty, profit, invoices, total_price, total, orders. ' +
                    `Dataset id: ${datasetId}. Schema: ${schemaSummary}`,
                },
                { role: 'user', content: question },
              ],
            }),
          ),
        },
        'Chart intent',
      )) as { choices?: Array<{ message?: { content?: string; reasoning?: string } }> }
      return parseChartIntentJson(messageContentFromChatPayload(payload))
    },
  }
}

export function parseChartIntentJson(text: string): { mark: string; x?: string; y?: string } {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/\/think\b/gi, '')
    .trim()
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = (fenced?.[1] ?? cleaned).trim()
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`No JSON object in chart intent response: ${raw.slice(0, 120)}`)
  const parsed = JSON.parse(jsonMatch[0]!) as { mark?: unknown; x?: unknown; y?: unknown }
  if (typeof parsed.mark !== 'string') throw new Error('chart intent missing mark')
  return {
    mark: parsed.mark,
    ...(typeof parsed.x === 'string' ? { x: parsed.x } : {}),
    ...(typeof parsed.y === 'string' ? { y: parsed.y } : {}),
  }
}

export type ClarifyRefuseGenerator = {
  classify(input: { question: string; signal?: AbortSignal }): Promise<'clarify' | 'refuse'>
}

/** OpenAI-compatible classifier for clarify|refuse corpus grading. */
export function createOpenAiCompatibleClarifyRefuseGenerator(opts: {
  apiKey: string
  baseUrl: string
  model: string
  fetchImpl?: typeof fetch
}): ClarifyRefuseGenerator {
  const fetchImpl = opts.fetchImpl ?? fetch
  const endpoint = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`
  return {
    async classify({ question, signal }) {
      const payload = (await fetchJsonWithRetry(
        fetchImpl,
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
          },
          signal,
          body: JSON.stringify(
            openAiChatBody({
              model: opts.model,
              maxTokens: 32,
              messages: [
                {
                  role: 'system',
                  content:
                    'Classify the analyst question. Reply with exactly one token: clarify OR refuse. ' +
                    'clarify = ambiguous / missing required filter or metric. ' +
                    'refuse = unsupported, destructive, or out-of-scope for a read-only BI analyst. ' +
                    'No markdown, no thinking tags.',
                },
                { role: 'user', content: question },
              ],
            }),
          ),
        },
        'Clarify/refuse',
      )) as { choices?: Array<{ message?: { content?: string; reasoning?: string } }> }
      const content = messageContentFromChatPayload(payload)
      const cleaned = content
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<\/?think>/gi, '')
        .replace(/\/think\b/gi, '')
        .trim()
        .toLowerCase()
      if (/\brefuse\b/.test(cleaned)) return 'refuse'
      if (/\bclarify\b/.test(cleaned)) return 'clarify'
      throw new Error(`Expected clarify|refuse, got: ${content.slice(0, 120)}`)
    },
  }
}

export function resolveHttpChartIntentGeneratorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ChartIntentGenerator | null {
  const mode = (env.DSH_NL_GENERATOR ?? 'fixture').toLowerCase()
  if (mode !== 'http') return null
  const apiKey = env.DSH_NL_API_KEY ?? env.DEEPSEEK_API_KEY
  if (!apiKey) return null
  return createOpenAiCompatibleChartIntentGenerator({
    apiKey,
    baseUrl: env.DSH_NL_API_BASE ?? 'https://api.deepseek.com/v1',
    model: env.DSH_NL_MODEL ?? 'deepseek-chat',
  })
}

export function resolveHttpClarifyRefuseGeneratorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ClarifyRefuseGenerator | null {
  const mode = (env.DSH_NL_GENERATOR ?? 'fixture').toLowerCase()
  if (mode !== 'http') return null
  const apiKey = env.DSH_NL_API_KEY ?? env.DEEPSEEK_API_KEY
  if (!apiKey) return null
  return createOpenAiCompatibleClarifyRefuseGenerator({
    apiKey,
    baseUrl: env.DSH_NL_API_BASE ?? 'https://api.deepseek.com/v1',
    model: env.DSH_NL_MODEL ?? 'deepseek-chat',
  })
}
