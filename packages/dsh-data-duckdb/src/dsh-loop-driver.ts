/**
 * Closed-composition dsh-loop driver (R4).
 *
 * Driver contract:
 *
 * 1. Inspected the pinned `@deepseek-ai` packages at 0.1.5-rc.2 for a
 *    supported "create session → send user message → collect tool
 *    calls/final text" API. `@deepseek-ai/dsh-agent` (`ctx.agents.create()` /
 *    `AgentHandle.agent.followup()` / `.whenIdle()`) is exactly that API. It
 *    is NOT a resolvable import target from this package (`pnpm ls` shows it
 *    nested only inside `dsh-base`'s own dependency tree, never hoisted to
 *    the workspace-root `node_modules/@deepseek-ai/` the way
 *    `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-app-boot` are — both are
 *    root devDependencies). Adding it as a new direct dependency of
 *    `dsh-data-duckdb` is outside this task's authorized file list.
 * 2. Resolution used instead: this driver never `import`s
 *    `@deepseek-ai/dsh-agent`/`dsh-session`. It boots the SAME closed
 *    composition `scripts/serve-analyst-session.mjs` runs (`dsh-base` +
 *    `dsh-web-app` + the closed `profiles/data-analyst` profile + the opt-in
 *    `tests/fixtures/cordis-overlays/cordis.webapp-product.candidate.patch.yml` overlay, `forceProduct:
 *    true` — required; the bare closed profile disables `llm`/`agent`/
 *    `session` by design). Once booted, `@deepseek-ai/dsh-agent`'s own
 *    Cordis module augmentation (`declare module '@deepseek-ai/cordis' {
 *    interface Context { agents: AgentRegistry } }`) means the LIVE `ctx`
 *    object already carries a real `ctx.agents` property at runtime — no
 *    import of its package is needed to read a property off an object we
 *    already hold. `detectAgentsApi()` below feature-detects
 *    `typeof ctx.agents?.create === 'function'` at runtime (duck typing, not
 *    a static import) and, when present, drives that real session API:
 *    `ctx.agents.create({ sessionId, meta: { agentPreset: 'analyst' },
 *    agentOptions })` → `agent.followup(userMessage)` →
 *    `agent.whenIdle()` → `agent.session.deriveMessages()` for the final
 *    assistant text, plus a `tools/result` listener scoped to
 *    `agent.ctx` (via `@deepseek-ai/dsh-scope`'s scope-filtered dispatch) to
 *    collect the exact structured tool name/args/result triples the same way
 *    `ctx.tools.execute()` produces them, plus `agent.ctx.tools.guard()`
 *    (`@deepseek-ai/dsh-tools`'s monotonic execution guard, evaluated
 *    synchronously before the tool body runs) to enforce
 *    `maxToolCallsPerTurn` PRE-execution — the `(limit + 1)`th tool call is
 *    denied and never executes; see `createToolCallBudgetGuard()`.
 *    `agent.followup()`'s
 *    `UserMessage` argument is built with `createUserMessage()`, a function
 *    this file already imports from the resolvable `@deepseek-ai/dsh-llm`
 *    (the same message shape `@deepseek-ai/dsh-session`'s `UserMessage`
 *    re-exports — no dsh-session import needed either).
 *    CONFIRMED PRESENT at runtime: booting this exact composition and
 *    logging `typeof ctx.agents`/`typeof ctx.agents.create` (see
 *    the internal verification record for the captured probe output)
 *    shows `ctx.agents.create` is a live function — so the real API is used
 *    whenever this composition boots successfully, and only a genuinely
 *    different future composition (missing `dsh-agent`/`dsh-agent-loop`
 *    entirely) would fall through to the tool-dispatch path below.
 * 3. Kept fallback (never removed, in case a future composition variant
 *    lacks `ctx.agents`): `executeTurnViaToolDispatch()` reads
 *    `ctx.tools.schemas()` for the analyst standing key exactly like
 *    `closedAnalystToolNames()` already does in
 *    `scripts/product-composition.mjs`, and runs its own bounded ReAct loop:
 *    assemble a persona + tool-schema request, call
 *    `ctx.llm.prepareCall({ provider, model }).stream(options)`, and dispatch
 *    every model-requested tool call through `ctx.tools.execute()`. This
 *    never calls `runAnalystQuestion` or `fixtureSqlGenerator`.
 * 4. Forbidden per the plan and honored here: this file does not score
 *    `eval:heldout` HTTP SQL as the Core v1 production number, does not
 *    scrape the web UI, and does not invent a second agent framework — both
 *    code paths are thin callers over the SAME `ctx.tools`/`ctx.llm`/
 *    `ctx.agents` services the production preset and agent loop already
 *    register; no new agent machinery is implemented here.
 *
 * Testability: `runDshLoopQuestionsWithExecutor()` is the boot-independent
 * loop (turn-budget enforcement, per-question trace assembly). It takes an
 * injected `ExecuteTurn` so tests can exercise turn/tool-call-bound
 * enforcement with a fake, without ever booting dsh or calling a model. See
 * `packages/dsh-data-duckdb/tests/dsh-loop-driver.integration.test.ts`.
 *
 * Scope note: each question is answered in exactly one analyst turn (one
 * `followup` call); `maxAnalystTurns` is honored as a hard cap — a value
 * `<= 0` skips the model call entirely for every question (no boot, no
 * `executeTurn` invocation) — but no multi-turn repair loop is implemented
 * in this pass. See the internal verification record.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type Message,
  type StreamChunk,
  type TextBlock,
  type ToolCallBlock,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {
  DshLoopOutcome,
  DshLoopTokenUsage,
  DshLoopToolCall,
  DshLoopTrace,
} from './dsh-loop-eval.js'

/** Generator/harness kinds that are component evidence only, never the Core v1 number. */
const COMPONENT_EVIDENCE_KINDS = new Set(['nl-loop', 'http-sql', 'fixture'])

/** Brief defaults: 2 analyst turns, 12 tool calls per analyst turn. */
export const DEFAULT_MAX_ANALYST_TURNS = 2
export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 12

/**
 * Refuse to treat a component-evidence generator/driver kind as the
 * production dsh-loop number. Call this before any code path could report a
 * `nl-loop` (or other component) score as a Core v1 result.
 */
export function assertProductionLoop(kind: string): void {
  if (COMPONENT_EVIDENCE_KINDS.has(kind)) {
    throw new Error('nl-loop is component evidence and cannot close Core v1')
  }
}

export interface DshLoopDriverQuestion {
  caseId: string
  datasetId: string
  question: string
}

export interface DshLoopDriverOptions {
  questions: ReadonlyArray<DshLoopDriverQuestion>
  /** Default 2. Counts user messages only. `<= 0` means: call the model zero times. */
  maxAnalystTurns: number
  /** Default 12 tool calls per analyst turn. Non-finite or non-positive falls back to the default. */
  maxToolCallsPerTurn: number
  signal?: AbortSignal
}

/** Resolve a caller-supplied tool-call bound, defaulting NaN/non-positive values to `DEFAULT_MAX_TOOL_CALLS_PER_TURN`. */
export function resolveMaxToolCallsPerTurn(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_TOOL_CALLS_PER_TURN
}

/** One turn's inputs, independent of how the turn is actually driven (real agent session vs. tool-dispatch fallback). */
export interface ExecuteTurnInput {
  caseId: string
  datasetId: string
  question: string
  /** Already-resolved bound (never NaN/non-positive by the time a turn executor sees it). */
  maxToolCallsPerTurn: number
  signal: AbortSignal
}

export interface ExecuteTurnResult {
  toolCalls: DshLoopToolCall[]
  outcome: DshLoopOutcome
  finalText: string
  tokenUsage?: DshLoopTokenUsage
}

/** Drives exactly one analyst turn and returns its tool calls plus classified outcome. Throws on failure. */
export type ExecuteTurn = (input: ExecuteTurnInput) => Promise<ExecuteTurnResult>

interface FailedTurnTelemetry {
  toolCalls: DshLoopToolCall[]
  finalText?: string
  tokenUsage?: DshLoopTokenUsage
}

class DshLoopTurnError extends Error {
  constructor(
    cause: unknown,
    readonly telemetry: FailedTurnTelemetry,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'DshLoopTurnError'
  }
}

/** Read the authoritative provider-usage projection without duplicating accounting. */
export function readDshLoopTokenUsage(
  ctx: unknown,
  session: unknown,
): DshLoopTokenUsage | undefined {
  const service = (ctx as { sessionProjections?: unknown } | null)?.sessionProjections
  if (
    service === undefined ||
    typeof service !== 'object' ||
    service === null ||
    typeof (service as { snapshot?: unknown }).snapshot !== 'function'
  ) {
    return undefined
  }
  const snapshot = (
    service as { snapshot(value: unknown): { values?: Record<string, unknown> } }
  ).snapshot(session)
  const usage = snapshot.values?.tokenUsage
  if (usage === undefined) return undefined
  if (typeof usage !== 'object' || usage === null) {
    throw new Error('tokenUsage projection returned an invalid value')
  }
  const record = usage as Record<string, unknown>
  const keys = [
    'uncachedInputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
  ] as const
  for (const key of keys) {
    const value = record[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`tokenUsage projection returned an invalid ${key}`)
    }
  }
  return {
    uncachedInputTokens: record.uncachedInputTokens as number,
    outputTokens: record.outputTokens as number,
    cacheReadTokens: record.cacheReadTokens as number,
    cacheWriteTokens: record.cacheWriteTokens as number,
  }
}

/** Loose shape of `scripts/product-composition.mjs`'s exports this driver needs. */
interface ProductCompositionModule {
  root: string
  resolveProductCompositionPatchPaths(options?: {
    env?: NodeJS.ProcessEnv
    forceProduct?: boolean
    includeWebApp?: boolean
  }): string[]
  installClosedAnalystPreset(dshHome: string, options?: { skillRoot?: string }): Promise<void>
  linkPackagesForPresetMount(configDir: string, packages: string[]): Promise<void>
  analystSurfacePackageNames(): Promise<string[]>
  closedAnalystToolNames(ctx: Context): Promise<{
    tools: string[]
    defaultPreset: string | null
    standingKey: unknown
    missing: string[]
    forbidden: string[]
  }>
}

/** Loose shape of `@deepseek-ai/dsh-app-boot`'s exports this driver needs. */
interface DshAppBootModule {
  boot(
    binName: string,
    absoluteConfigPath: string,
    patches?: unknown[],
    prepare?: (ctx: Context) => Promise<void> | void,
  ): Promise<Context>
  loadOverlayPatches(binName: string, file: string): unknown[]
}

/**
 * Dynamically import a sibling module by URL. Kept dynamic (non-literal
 * specifier) so tsc never tries to resolve `scripts/product-composition.mjs`
 * as a rootDir-bound TypeScript program input.
 */
async function importModule<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T
}

async function loadProductComposition(): Promise<ProductCompositionModule> {
  const specifier = new URL('../../../scripts/product-composition.mjs', import.meta.url).href
  return importModule<ProductCompositionModule>(specifier)
}

async function loadDshAppBoot(): Promise<DshAppBootModule> {
  return importModule<DshAppBootModule>('@deepseek-ai/dsh-app-boot')
}

const DRIVER_LABEL = 'dsh-loop-driver'

/** Mirrors the persona prefix in profiles/data-analyst/presets/analyst/agent.cordis.yml. */
function buildAnalystSystemPrompt(): string {
  return [
    'You are a data analyst assistant for published DuckDB datasets. Own the',
    'full workflow through provided tools: discover schema and approved',
    'semantics, authorize SQL, render charts, and answer the question.',
    'Never attempt shell, filesystem, or network tools — they are not',
    'available in this preset. Ask a brief clarifying question when the',
    'request is ambiguous, and refuse unsupported destructive or bulk-export',
    'requests instead of attempting them. Do not invent columns or treat',
    'query success as business correctness. The Active published dataset in',
    'the request is authoritative: inspect and query only that dataset. Match',
    'filters and top-N limits exactly. Prefer duckdb_query for reading data.',
    'After every successful multi-row category/measure query, call make_chart',
    'before answering. When you have the answer, reply with a concise',
    'final text answer and no further tool calls.',
  ].join(' ')
}

function buildAnalystRequest(input: ExecuteTurnInput): string {
  return `Active published dataset: ${input.datasetId}\n\n${input.question}`
}

interface BootedComposition {
  ctx: Context
  standingKey: unknown
  tools: ToolSchema[]
  dispose(): Promise<void>
}

async function bootClosedAnalystComposition(): Promise<BootedComposition> {
  const [pc, { boot, loadOverlayPatches }] = await Promise.all([
    loadProductComposition(),
    loadDshAppBoot(),
  ])
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')

  const home = process.env.DSH_HOME ?? join(pc.root, '.dsh-home-loop-eval')
  const configDir = join(home, 'boot')
  const configPath = join(configDir, 'cordis.yml')
  await mkdir(home, { recursive: true })
  await mkdir(configDir, { recursive: true })
  await writeFile(configPath, '[]\n', 'utf8')
  process.env.DSH_HOME = home

  await pc.installClosedAnalystPreset(home)
  await pc.linkPackagesForPresetMount(configDir, await pc.analystSurfacePackageNames())

  const patchPaths = pc.resolveProductCompositionPatchPaths({ forceProduct: true })
  const patches = patchPaths.flatMap((path) => loadOverlayPatches(DRIVER_LABEL, path))

  // dsh-web-app (needed for the `analyst` agent preset — dsh-agent-presets is
  // one of its rows, not dsh-base's) needs a resolved `cmdlineArgs` service
  // before its own service graph can settle, exactly like
  // scripts/serve-analyst-session.mjs. This driver never serves traffic, so
  // `--no-open` plus an eval-only port keep it from colliding with a real
  // `npm run serve:analyst` instance.
  const host = process.env.DSH_DSHLOOP_HOST ?? '127.0.0.1'
  const port = process.env.DSH_DSHLOOP_PORT ?? '3090'
  const cmdlineArgs = ['--host', host, '--port', port, '--no-open']

  const ctx = await boot(DRIVER_LABEL, configPath, patches, (hostCtx) => {
    provideCmdline(hostCtx, {
      args: cmdlineArgs,
      exit: () => {
        // The web-app startup row may request an exit code on misconfiguration;
        // this driver owns process lifecycle itself and ignores that request.
      },
    })
  })
  const surface = await pc.closedAnalystToolNames(ctx)
  if (
    surface.defaultPreset !== 'analyst' ||
    surface.missing.length > 0 ||
    surface.forbidden.length > 0
  ) {
    await (ctx as unknown as { fiber: { dispose(): Promise<void> } }).fiber.dispose()
    throw new Error(
      `closed analyst surface assertion failed: defaultPreset=${String(surface.defaultPreset)} ` +
        `missing=${surface.missing.join(',')} forbidden=${surface.forbidden.join(',')}`,
    )
  }
  return {
    ctx,
    standingKey: surface.standingKey,
    tools: ctx.tools.schemas(surface.standingKey as never),
    dispose: () => (ctx as unknown as { fiber: { dispose(): Promise<void> } }).fiber.dispose(),
  }
}

interface CollectedStep {
  content: ContentBlock[]
  text: string
  finish?: FinishReason
}

async function collectStream(stream: AsyncIterable<StreamChunk>): Promise<CollectedStep> {
  const content: ContentBlock[] = []
  let text = ''
  let finish: FinishReason | undefined
  for await (const chunk of stream) {
    if (chunk.type === 'block-end') {
      content.push(chunk.block)
      if (chunk.block.type === 'text') text += chunk.block.text
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  return { content, text, finish }
}

function isToolCallBlock(block: ContentBlock): block is ToolCallBlock {
  return block.type === 'tool-call'
}

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text'
}

const REFUSAL_PATTERN =
  /\b(cannot|can't|won't|unable|not able|refuse|not supported|not permitted)\b/i
const CLARIFY_PATTERN = /\b(clarify|which time period|could you specify|what do you mean)\b/i

function classifyTextOnlyOutcome(finalText: string, toolCalls: DshLoopToolCall[]): DshLoopOutcome {
  const hadSuccessfulQuery = toolCalls.some(
    (call) => call.name === 'duckdb_query' && !isErrorResult(call.result),
  )
  if (hadSuccessfulQuery) return 'answer'
  if (REFUSAL_PATTERN.test(finalText)) return 'refuse'
  if (CLARIFY_PATTERN.test(finalText) || finalText.trim().endsWith('?')) return 'clarify'
  return 'answer'
}

function isErrorResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    (result as { error: unknown }).error !== undefined
  )
}

function resolveModelRoute(): { provider: string; model: string } {
  return {
    provider: process.env.DSH_DSHLOOP_PROVIDER ?? 'deepseek-official',
    model: process.env.DSH_DSHLOOP_MODEL ?? 'deepseek-flash',
  }
}

/**
 * Runtime shape of `ctx.agents` this driver drives when present. Deliberately
 * loose/duck-typed: never imported from `@deepseek-ai/dsh-agent` (see file
 * header, point 2) — only feature-detected off the live `ctx` object.
 */
interface RuntimeAgentHandle {
  agent: {
    followup(message: unknown): void
    whenIdle(): Promise<void>
    cancel(cause: { kind: string; reason?: string }): void
    ctx: Context & {
      tools: { guard(guard: (execution: unknown) => string | undefined): () => void }
    }
    session: { deriveMessages(): Message[] }
  }
  dispose(): Promise<void>
}

interface RuntimeAgentsApi {
  create(options: {
    sessionId: string
    meta?: { agentPreset?: string; cwd?: string }
    agentOptions?: { provider?: string; model?: string }
  }): Promise<RuntimeAgentHandle>
}

/**
 * Feature-detect a live `ctx.agents.create()` at runtime. Returns undefined
 * (and the caller falls back to tool-dispatch) only when the booted
 * composition genuinely lacks it — never because this file failed to import
 * `@deepseek-ai/dsh-agent`, which it never attempts to import.
 */
function detectAgentsApi(ctx: Context): RuntimeAgentsApi | undefined {
  const candidate = (ctx as unknown as Record<string, unknown>).agents
  if (
    candidate !== undefined &&
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as { create?: unknown }).create === 'function'
  ) {
    return candidate as RuntimeAgentsApi
  }
  return undefined
}

/**
 * Build a monotonic, `ctx.tools.guard`-compatible per-turn tool-call budget
 * check. Pure and synchronous — extracted so a test can exercise "the
 * (limit + 1)th call is denied" directly, without booting dsh, creating a
 * real agent, or calling a model.
 *
 * Each call to the returned function counts as one attempted tool
 * execution (matching one `ctx.tools.guard` invocation per call
 * `dsh-tools` evaluates immediately before the tool body runs — see
 * `ToolGuard`'s doc comment: "evaluated after every `tools/pre-execute`
 * listener and before the tool body"). The `limit + 1`th and every later
 * call returns a deny reason instead of `undefined`, so the pipeline never
 * reaches the tool body for it — this is the actual fix for the bug where
 * the (limit + 1)th call previously still executed because the old code
 * only counted `tools/result` (a POST-execution notification) and cancelled
 * the agent afterward. `onExceeded` fires exactly once, on the call that
 * first crosses the limit, so a caller can converge the turn (e.g. request
 * agent cancellation) without re-triggering on every later denied retry.
 */
export function createToolCallBudgetGuard(
  maxToolCallsPerTurn: number,
  onExceeded?: () => void,
): (execution: unknown) => string | undefined {
  let count = 0
  let exceeded = false
  return () => {
    count += 1
    if (count > maxToolCallsPerTurn) {
      if (!exceeded) {
        exceeded = true
        onExceeded?.()
      }
      return `tool-call budget exceeded (${maxToolCallsPerTurn} per analyst turn)`
    }
    return undefined
  }
}

function lastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'assistant') {
      return message.content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('')
    }
  }
  return ''
}

/**
 * Drive one analyst turn through the real `ctx.agents` session API: create an
 * agent under the `analyst` preset, follow up with the question, wait for
 * quiescence, and read back tool calls (via a `tools/result` listener scoped
 * to the created agent's own context — the same structured
 * name/args/result triple `ctx.tools.execute()` produces) and the final
 * assistant text (via `session.deriveMessages()`).
 *
 * Tool-call budget enforcement happens PRE-execution via
 * `agent.ctx.tools.guard()` (`@deepseek-ai/dsh-tools`'s monotonic execution
 * guard, evaluated "after every `tools/pre-execute` listener and before the
 * tool body" — confirmed by a runtime probe: a denied call's
 * `ToolExecutionResult` never carries the tool's actual return value, only
 * the guard's reason). This replaces an earlier version that only counted
 * `tools/result` (a POST-execution notification) and cancelled the agent
 * afterward — which let the (limit + 1)th call finish executing before the
 * limit was even noticed. `createToolCallBudgetGuard()` is the extracted,
 * dsh-independent piece of this logic.
 */
async function executeTurnViaAgentsApi(
  agentsApi: RuntimeAgentsApi,
  input: ExecuteTurnInput,
): Promise<ExecuteTurnResult> {
  const route = resolveModelRoute()
  const handle = await agentsApi.create({
    sessionId: `dsh-loop-${input.caseId}-${randomUUID()}`,
    // dsh's deployment persona suffix interpolates {{cwd}} even though this
    // closed preset exposes no filesystem or shell tools. Supply the validated
    // session cwd so prompt assembly follows the same contract as the web UI.
    meta: { agentPreset: 'analyst', cwd: process.cwd() },
    agentOptions: { provider: route.provider, model: route.model },
  })
  const toolCalls: DshLoopToolCall[] = []
  let budgetExceeded = false
  let agentError: unknown

  const offGuard = handle.agent.ctx.tools.guard(
    createToolCallBudgetGuard(input.maxToolCallsPerTurn, () => {
      budgetExceeded = true
      // Converge the turn as soon as the FIRST over-budget call is denied,
      // instead of letting the model keep retrying into more denials.
      handle.agent.cancel({
        kind: 'hook',
        reason: `tool-call budget exceeded (${input.maxToolCallsPerTurn} per analyst turn)`,
      })
    }),
  )
  const offToolResult = handle.agent.ctx.on('tools/result', (exec: unknown, result: unknown) => {
    const execRecord = exec as { name: string; arguments: unknown }
    const resultRecord = result as { isError: boolean; value?: unknown; error?: unknown }
    toolCalls.push({
      name: execRecord.name,
      args: (execRecord.arguments && typeof execRecord.arguments === 'object'
        ? execRecord.arguments
        : {}) as Record<string, unknown>,
      result: resultRecord.isError ? { error: resultRecord.error } : resultRecord.value,
    })
  }) as unknown as () => void
  const offAgentError = handle.agent.ctx.on('agent/error', (payload: { error?: unknown }) => {
    agentError = payload?.error
  }) as unknown as () => void

  try {
    handle.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: buildAnalystRequest(input) }],
        source: { kind: 'user' },
      }),
    )
    await handle.agent.whenIdle()
    if (budgetExceeded) {
      throw new Error(`tool-call budget exceeded (${input.maxToolCallsPerTurn} per analyst turn)`)
    }
    if (agentError !== undefined) {
      throw agentError instanceof Error ? agentError : new Error(String(agentError))
    }
    const finalText = lastAssistantText(handle.agent.session.deriveMessages())
    let tokenUsage: DshLoopTokenUsage | undefined
    try {
      tokenUsage = readDshLoopTokenUsage(handle.agent.ctx, handle.agent.session)
    } catch {
      // Telemetry completeness is reported separately from model accuracy.
    }
    return {
      toolCalls,
      outcome: classifyTextOnlyOutcome(finalText, toolCalls),
      finalText,
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
    }
  } catch (error) {
    let finalText: string | undefined
    let tokenUsage: DshLoopTokenUsage | undefined
    try {
      finalText = lastAssistantText(handle.agent.session.deriveMessages())
    } catch {
      // Preserve the original execution failure; partial text is optional.
    }
    try {
      tokenUsage = readDshLoopTokenUsage(handle.agent.ctx, handle.agent.session)
    } catch {
      // Preserve the original execution failure; malformed telemetry is not a zero reading.
    }
    throw new DshLoopTurnError(error, {
      toolCalls: [...toolCalls],
      ...(finalText === undefined ? {} : { finalText }),
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
    })
  } finally {
    offGuard()
    offToolResult()
    offAgentError()
    await handle.dispose()
  }
}

/**
 * Fallback: drive one analyst turn directly against `ctx.llm` + `ctx.tools`
 * (see file header, point 3). Used only when `detectAgentsApi()` cannot find
 * a live `ctx.agents.create()` on the booted composition.
 */
async function executeTurnViaToolDispatch(
  ctx: Context,
  tools: ToolSchema[],
  input: ExecuteTurnInput,
): Promise<ExecuteTurnResult> {
  const toolCalls: DshLoopToolCall[] = []
  const route = resolveModelRoute()
  const system = buildAnalystSystemPrompt()
  const messages: Message[] = [
    createUserMessage({
      content: [{ type: 'text', text: buildAnalystRequest(input) }],
      source: { kind: 'user' },
    }),
  ]

  let toolCallsThisTurn = 0
  try {
    for (;;) {
      const prepared = await ctx.llm.prepareCall(
        { provider: route.provider, model: route.model },
        input.signal,
      )
      const requestOptions: GenerateOptions = {
        provider: prepared.config.provider,
        model: prepared.config.model,
        messages,
        system,
        tools,
        signal: input.signal,
        ...(prepared.config.maxTokens !== undefined
          ? { maxTokens: prepared.config.maxTokens }
          : {}),
        ...(prepared.config.reasoningEffort !== undefined
          ? { reasoningEffort: prepared.config.reasoningEffort }
          : {}),
      }
      const step = await collectStream(prepared.stream(requestOptions))

      if (step.finish?.kind === 'error') {
        throw new Error(step.finish.failure.message)
      }
      if (step.finish?.kind === 'aborted') {
        throw new Error(step.finish.failure.message)
      }

      messages.push(
        createAssistantMessage({
          content: step.content,
          source: { provider: prepared.config.provider, model: prepared.config.model },
        }),
      )

      const toolCallBlocks = step.content.filter(isToolCallBlock)
      if (toolCallBlocks.length === 0) {
        return {
          toolCalls,
          outcome: classifyTextOnlyOutcome(step.text, toolCalls),
          finalText: step.text,
        }
      }

      for (const block of toolCallBlocks) {
        toolCallsThisTurn += 1
        if (toolCallsThisTurn > input.maxToolCallsPerTurn) {
          throw new Error(
            `tool-call budget exceeded (${input.maxToolCallsPerTurn} per analyst turn)`,
          )
        }
        let args: unknown
        try {
          args = JSON.parse(block.arguments) as unknown
        } catch {
          args = {}
        }
        const execResult: ToolExecutionResult = await ctx.tools.execute({
          callId: block.id,
          name: block.name,
          arguments: args,
          signal: input.signal,
        })
        messages.push(
          createToolResultMessage({
            callId: block.id,
            content: execResult.content,
            isError: execResult.isError,
          }),
        )
        const resultValue: unknown = execResult.isError
          ? { error: execResult.error }
          : execResult.value
        toolCalls.push({
          name: block.name,
          args: (args && typeof args === 'object' ? args : {}) as Record<string, unknown>,
          result: resultValue,
        })
      }
    }
  } catch (error) {
    throw new DshLoopTurnError(error, {
      toolCalls: [...toolCalls],
      finalText: lastAssistantText(messages),
    })
  }
}

function createExecuteTurn(boot: BootedComposition): ExecuteTurn {
  const agentsApi = detectAgentsApi(boot.ctx)
  if (agentsApi) {
    return (input) => executeTurnViaAgentsApi(agentsApi, input)
  }
  return (input) => executeTurnViaToolDispatch(boot.ctx, boot.tools, input)
}

/**
 * Boot-independent question loop: enforces `maxAnalystTurns` (a value `<= 0`
 * never invokes `executeTurn`, for any question) and resolves
 * `maxToolCallsPerTurn` to a safe default before handing it to the executor.
 * Exported so tests can inject a fake `executeTurn` without booting dsh or
 * calling a model.
 */
export async function runDshLoopQuestionsWithExecutor(
  options: DshLoopDriverOptions,
  executeTurn: ExecuteTurn,
): Promise<DshLoopTrace[]> {
  const maxToolCallsPerTurn = resolveMaxToolCallsPerTurn(options.maxToolCallsPerTurn)
  const traces: DshLoopTrace[] = []

  for (const item of options.questions) {
    if (options.maxAnalystTurns <= 0) {
      traces.push({
        caseId: item.caseId,
        question: item.question,
        datasetId: item.datasetId,
        analystTurns: 0,
        toolCalls: [],
        toolCallsComplete: true,
        outcome: 'error',
        elapsedMs: 0,
        errorMessage: `analyst turn budget is ${options.maxAnalystTurns}; the model was not called`,
      })
      continue
    }

    const signal = options.signal ?? new AbortController().signal
    const startedAt = performance.now()
    try {
      const result = await executeTurn({
        caseId: item.caseId,
        datasetId: item.datasetId,
        question: item.question,
        maxToolCallsPerTurn,
        signal,
      })
      traces.push({
        caseId: item.caseId,
        question: item.question,
        datasetId: item.datasetId,
        // A turn actually ran, so this is never clamped down to 0 — the
        // budget only ever narrows a real run to 1, never erases it.
        analystTurns: Math.min(1, options.maxAnalystTurns),
        toolCalls: result.toolCalls,
        toolCallsComplete: true,
        outcome: result.outcome,
        finalText: result.finalText,
        elapsedMs: performance.now() - startedAt,
        ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }),
      })
    } catch (error) {
      const partial = error instanceof DshLoopTurnError ? error.telemetry : undefined
      traces.push({
        caseId: item.caseId,
        question: item.question,
        datasetId: item.datasetId,
        analystTurns: Math.min(1, options.maxAnalystTurns),
        toolCalls: partial?.toolCalls ?? [],
        toolCallsComplete: false,
        outcome: 'error',
        ...(partial?.finalText === undefined ? {} : { finalText: partial.finalText }),
        elapsedMs: performance.now() - startedAt,
        ...(partial?.tokenUsage === undefined ? {} : { tokenUsage: partial.tokenUsage }),
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return traces
}

/**
 * Answer each question through the closed dsh tool-dispatch pipeline (see
 * the file-header driver contract) and return one `DshLoopTrace` per
 * question, in order. Boots one closed composition for the whole batch — but
 * only when at least one question can actually run a turn; a non-positive
 * `maxAnalystTurns` skips the boot entirely (no model call is possible).
 */
export async function runDshLoopQuestions(options: DshLoopDriverOptions): Promise<DshLoopTrace[]> {
  if (options.questions.length === 0) return []

  if (options.maxAnalystTurns <= 0) {
    return runDshLoopQuestionsWithExecutor(options, () => {
      throw new Error('executeTurn must not be called when maxAnalystTurns <= 0')
    })
  }

  const boot = await bootClosedAnalystComposition()
  try {
    const executeTurn = createExecuteTurn(boot)
    return await runDshLoopQuestionsWithExecutor(options, executeTurn)
  } finally {
    await boot.dispose()
  }
}
