import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

export interface RequestBudgetState {
  toolCalls: number
  sqlAttempts: number
  startedAtMs: number
}

export const MAX_TOOL_CALLS = 12
export const MAX_SQL_ATTEMPTS = 3
export const MAX_REQUEST_MS = 120_000

export function createRequestBudgetState(nowMs: number): RequestBudgetState {
  return { toolCalls: 0, sqlAttempts: 0, startedAtMs: nowMs }
}

export function registerToolCall(state: RequestBudgetState, nowMs: number): RequestBudgetState {
  return {
    ...state,
    toolCalls: state.toolCalls + 1,
    startedAtMs: state.startedAtMs || nowMs,
  }
}

export function registerSqlAttempt(state: RequestBudgetState): RequestBudgetState {
  return { ...state, sqlAttempts: state.sqlAttempts + 1 }
}

export function budgetDenial(
  state: RequestBudgetState,
  nowMs: number,
): 'TOOL_BUDGET' | 'SQL_REPAIR_BUDGET' | 'TIME_BUDGET' | undefined {
  if (nowMs - state.startedAtMs >= MAX_REQUEST_MS) return 'TIME_BUDGET'
  if (state.toolCalls >= MAX_TOOL_CALLS) return 'TOOL_BUDGET'
  if (state.sqlAttempts >= MAX_SQL_ATTEMPTS) return 'SQL_REPAIR_BUDGET'
  return undefined
}

export function policyDeniedMessage(
  reason: 'TOOL_BUDGET' | 'SQL_REPAIR_BUDGET' | 'TIME_BUDGET',
): string {
  return `POLICY_DENIED: ${reason}`
}

/**
 * Session id is always the outer bucket; a `requestId` (when present)
 * scopes the bucket further to one analyst request within that session —
 * never the reverse, and never a bare `requestId` bucket shared across
 * sessions. Missing session id always falls back to the shared `default`
 * bucket, per plan intent (never keyed by agent id).
 */
export function sessionBudgetKey(sessionId: string | undefined, requestId?: string): string {
  const base = sessionId ?? 'default'
  return requestId ? `${base}:${requestId}` : base
}

/**
 * Session id from dsh tool execution. Published dsh 0.1.5 tool contexts expose
 * it through `exec.agent.session.id`; the top-level `session` and agent-id
 * reads remain compatibility fallbacks for older or host-augmented contexts.
 */
export function sessionIdFromToolExec(exec: unknown): string | undefined {
  if (typeof exec !== 'object' || exec === null) return undefined
  const record = exec as {
    session?: { id?: string }
    agent?: { id?: string; session?: { id?: string } }
  }
  const id = record.session?.id ?? record.agent?.session?.id ?? record.agent?.id
  return typeof id === 'string' && id ? id : undefined
}

/**
 * Per-request discriminator from dsh tool execution. The supported dsh
 * 0.1.5 path is `ToolRunContext.agent.session.snapshotEvents()`: the agent
 * loop appends one `turn/start` for each analyst turn and any additional
 * model/tool iterations use `step/start`, so the latest turn number is the
 * analyst-request boundary. The remaining fields are compatibility probes
 * for possible host-augmented contexts; they are absent from the published
 * 0.1.5 ToolRunContext. If neither path is present, callers retain service
 * enforcement with a per-session bucket.
 */
export function requestIdFromToolExec(exec: unknown): string | undefined {
  if (typeof exec !== 'object' || exec === null) return undefined
  const record = exec as Record<string, unknown>

  // Guard the unknown boundary before narrowing to the published ToolRunContext
  // agent type. This keeps compatibility callers fail-safe without weakening
  // the typechecked production seam.
  const agent = record.agent
  if (typeof agent === 'object' && agent !== null) {
    const session = (agent as { session?: { snapshotEvents?: unknown } }).session
    if (typeof session?.snapshotEvents === 'function') {
      const events: readonly unknown[] = (
        agent as NonNullable<ToolRunContext['agent']>
      ).session.snapshotEvents()
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (typeof event !== 'object' || event === null) continue
        const typed = event as { type?: unknown; data?: { turn?: unknown } }
        if (typed.type !== 'turn/start') continue
        const turn = typed.data?.turn
        if (typeof turn === 'number' && Number.isFinite(turn)) return `turn-${turn}`
      }
    }
  }

  const run = record.run
  if (typeof run === 'object' && run !== null) {
    const id = (run as { id?: unknown }).id
    if (typeof id === 'string' && id) return id
  }

  const turn = record.turn
  if (typeof turn === 'string' && turn) return turn
  if (typeof turn === 'number' && Number.isFinite(turn)) return String(turn)

  const message = record.message
  if (typeof message === 'object' && message !== null) {
    const id = (message as { id?: unknown }).id
    if (typeof id === 'string' && id) return id
  }

  const requestId = record.requestId
  if (typeof requestId === 'string' && requestId) return requestId

  return undefined
}
