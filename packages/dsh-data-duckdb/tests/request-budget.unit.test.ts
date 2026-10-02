import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  MAX_REQUEST_MS,
  MAX_SQL_ATTEMPTS,
  MAX_TOOL_CALLS,
  budgetDenial,
  createRequestBudgetState,
  registerSqlAttempt,
  registerToolCall,
  requestIdFromToolExec,
  sessionBudgetKey,
  sessionIdFromToolExec,
} from '../src/request-budget.js'

describe('request budget', () => {
  const t0 = 1_000_000

  it('allows the first SQL attempt plus two repairs', () => {
    let state = createRequestBudgetState(t0)
    for (let attempt = 0; attempt < MAX_SQL_ATTEMPTS; attempt += 1) {
      expect(budgetDenial(state, t0)).toBeUndefined()
      state = registerToolCall(state, t0)
      state = registerSqlAttempt(state)
    }
    expect(state.sqlAttempts).toBe(MAX_SQL_ATTEMPTS)
    expect(budgetDenial(state, t0)).toBe('SQL_REPAIR_BUDGET')
  })

  it('denies when tool call budget is exhausted', () => {
    let state = createRequestBudgetState(t0)
    for (let call = 0; call < MAX_TOOL_CALLS; call += 1) {
      expect(budgetDenial(state, t0)).toBeUndefined()
      state = registerToolCall(state, t0)
    }
    expect(state.toolCalls).toBe(MAX_TOOL_CALLS)
    expect(budgetDenial(state, t0)).toBe('TOOL_BUDGET')
  })

  it('denies when the request time budget is exhausted', () => {
    const state = createRequestBudgetState(t0)
    expect(budgetDenial(state, t0 + MAX_REQUEST_MS - 1)).toBeUndefined()
    expect(budgetDenial(state, t0 + MAX_REQUEST_MS)).toBe('TIME_BUDGET')
  })

  it('reads session id from exec.session and falls back to default bucket key', () => {
    expect(sessionIdFromToolExec({ session: { id: 'sess-1' } })).toBe('sess-1')
    expect(sessionIdFromToolExec({ agent: { id: 'agent-session' } })).toBe('agent-session')
    expect(sessionIdFromToolExec({ agent: { session: { id: 'nested-session' } } })).toBe(
      'nested-session',
    )
    expect(sessionIdFromToolExec({})).toBeUndefined()
    expect(sessionBudgetKey(undefined)).toBe('default')
    expect(sessionBudgetKey('sess-2')).toBe('sess-2')
  })

  it('uses published dsh turn boundaries, not internal steps, as request discriminators', () => {
    const session = Session.create(SessionId('budget-session'))

    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    expect(requestIdFromToolExec({ agent: { session } })).toBe('turn-1')

    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    expect(requestIdFromToolExec({ agent: { session } })).toBe('turn-1')

    session.append('step/end', { turn: 1, step: 2 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    expect(requestIdFromToolExec({ agent: { session } })).toBe('turn-2')
  })

  it('skips malformed session events and uses a compatibility fallback', () => {
    const fallback = { requestId: 'fallback' }
    expect(
      requestIdFromToolExec({
        ...fallback,
        agent: { session: { snapshotEvents: () => [null] } },
      }),
    ).toBe('fallback')
    expect(
      requestIdFromToolExec({
        ...fallback,
        agent: {
          session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: Number.NaN } }] },
        },
      }),
    ).toBe('fallback')
    expect(
      requestIdFromToolExec({
        ...fallback,
        agent: { session: { snapshotEvents: () => [{ type: 'turn/start', data: {} }] } },
      }),
    ).toBe('fallback')
  })

  it('scopes the bucket key to sessionId:requestId only when a requestId is given', () => {
    expect(sessionBudgetKey('sess-1', 'req-1')).toBe('sess-1:req-1')
    expect(sessionBudgetKey('sess-1')).toBe('sess-1')
    expect(sessionBudgetKey(undefined, 'req-1')).toBe('default:req-1')
  })

  it('reads a request discriminator from exec.run.id, exec.turn, exec.message.id, or exec.requestId', () => {
    expect(requestIdFromToolExec({ run: { id: 'run-1' } })).toBe('run-1')
    expect(requestIdFromToolExec({ turn: 'turn-1' })).toBe('turn-1')
    expect(requestIdFromToolExec({ turn: 2 })).toBe('2')
    expect(requestIdFromToolExec({ message: { id: 'msg-1' } })).toBe('msg-1')
    expect(requestIdFromToolExec({ requestId: 'req-1' })).toBe('req-1')
    expect(requestIdFromToolExec({})).toBeUndefined()
    expect(requestIdFromToolExec(undefined)).toBeUndefined()
    expect(requestIdFromToolExec(null)).toBeUndefined()
  })

  it('prefers run.id, then turn, then message.id, then requestId, when several are present', () => {
    expect(
      requestIdFromToolExec({
        run: { id: 'run-1' },
        turn: 'turn-1',
        message: { id: 'msg-1' },
        requestId: 'req-1',
      }),
    ).toBe('run-1')
    expect(
      requestIdFromToolExec({ turn: 'turn-1', message: { id: 'msg-1' }, requestId: 'req-1' }),
    ).toBe('turn-1')
    expect(requestIdFromToolExec({ message: { id: 'msg-1' }, requestId: 'req-1' })).toBe('msg-1')
  })
})
