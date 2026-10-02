import type { WorkspacePaths } from 'dsh-data-core/workspace-paths'
import {
  budgetDenial,
  createRequestBudgetState,
  MAX_REQUEST_MS,
  policyDeniedMessage,
  registerSqlAttempt,
  registerToolCall,
  sessionBudgetKey,
  type RequestBudgetState,
} from './request-budget.js'

/** Plugin-owned runtime state. Its lifecycle is tied to the dsh plugin fiber. */
export class DuckdbAnalystService {
  readonly workspace: WorkspacePaths
  readonly #inflight = new Map<string, AbortController>()
  readonly #budgets = new Map<string, RequestBudgetState>()
  #disposed = false

  constructor(workspace: WorkspacePaths) {
    this.workspace = workspace
  }

  createJobController(key: string, parent?: AbortSignal): AbortController {
    if (this.#disposed) throw new Error('DuckDB analyst service is disposed')
    const existing = this.#inflight.get(key)
    if (existing) throw new Error(`An ingest is already running for "${key}"`)
    const controller = new AbortController()
    if (parent) {
      if (parent.aborted) controller.abort()
      else parent.addEventListener('abort', () => controller.abort(), { once: true })
    }
    this.#inflight.set(key, controller)
    return controller
  }

  finishJob(key: string): void {
    this.#inflight.delete(key)
  }

  abortJob(...keys: string[]): boolean {
    for (const key of keys) {
      const controller = this.#inflight.get(key)
      if (!controller) continue
      controller.abort()
      return true
    }
    return false
  }

  get inflightCount(): number {
    return this.#inflight.size
  }

  /**
   * Per-session (optionally per-request) request budget; missing session
   * id shares one default bucket. A bucket whose window has already run
   * `MAX_REQUEST_MS` past its first consult always starts a FRESH window
   * here instead of denying forever — the plan's `MAX_REQUEST_MS` bounds
   * one analyst request, not the lifetime of a session/bucket, and this
   * caller has no way to distinguish "still inside a genuinely oversized
   * in-flight request" from "a new question arrived on an old bucket", so
   * it always prefers the reading that keeps the session answering.
   */
  consultQueryBudget(sessionId: string | undefined, nowMs: number, requestId?: string): void {
    if (this.#disposed) throw new Error('DuckDB analyst service is disposed')
    const key = sessionBudgetKey(sessionId, requestId)
    let state = this.#budgets.get(key)
    if (!state || nowMs - state.startedAtMs >= MAX_REQUEST_MS) {
      state = createRequestBudgetState(nowMs)
    }
    const denial = budgetDenial(state, nowMs)
    if (denial) throw new Error(policyDeniedMessage(denial))
    state = registerToolCall(state, nowMs)
    state = registerSqlAttempt(state)
    this.#budgets.set(key, state)
  }

  /**
   * Reset the SQL-repair-attempt counter on a bucket after its query
   * actually succeeded, so three total *consecutive failures* deny the
   * next attempt — not three total attempts across an otherwise-healthy
   * session. A no-op for an unknown bucket (nothing to reset) and after
   * disposal (nothing left to mutate).
   */
  recordSuccessfulQuery(sessionId: string | undefined, requestId?: string): void {
    if (this.#disposed) return
    const key = sessionBudgetKey(sessionId, requestId)
    const state = this.#budgets.get(key)
    if (!state) return
    this.#budgets.set(key, { ...state, sqlAttempts: 0 })
  }

  dispose(): void {
    this.#disposed = true
    for (const controller of this.#inflight.values()) controller.abort()
    this.#inflight.clear()
  }
}
