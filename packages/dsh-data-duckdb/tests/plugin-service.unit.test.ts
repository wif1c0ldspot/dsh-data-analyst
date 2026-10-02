import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import {
  MAX_REQUEST_MS,
  MAX_SQL_ATTEMPTS,
  requestIdFromToolExec,
  sessionIdFromToolExec,
} from '../src/request-budget.js'
import { DuckdbAnalystService } from '../src/plugin-service.js'

it('owns ingest cancellation state and clears it on disposal', () => {
  const service = new DuckdbAnalystService(resolveWorkspacePaths('/tmp/dsh-service-test'))
  const controller = service.createJobController('slug:dataset')
  expect(service.inflightCount).toBe(1)
  service.dispose()
  expect(controller.signal.aborted).toBe(true)
  expect(service.inflightCount).toBe(0)
  expect(() => service.createJobController('slug:other')).toThrow(/disposed/)
})

it('refuses concurrent ingestion for the same reviewed source', () => {
  const service = new DuckdbAnalystService(resolveWorkspacePaths('/tmp/dsh-service-test'))
  service.createJobController('slug:dataset')
  expect(() => service.createJobController('slug:dataset')).toThrow(/already running/)
  expect(service.abortJob('slug:dataset')).toBe(true)
  service.finishJob('slug:dataset')
  service.dispose()
})

it('keeps SQL attempt counters independent per session id', () => {
  const service = new DuckdbAnalystService(resolveWorkspacePaths('/tmp/dsh-service-test'))
  const t0 = 1_000_000
  for (let attempt = 0; attempt < MAX_SQL_ATTEMPTS; attempt += 1) {
    service.consultQueryBudget('session-a', t0)
  }
  expect(() => service.consultQueryBudget('session-a', t0)).toThrow(/SQL_REPAIR_BUDGET/)
  expect(() => service.consultQueryBudget('session-b', t0)).not.toThrow()
  service.dispose()
})

it('denies with a message starting with POLICY_DENIED:', () => {
  const service = new DuckdbAnalystService(resolveWorkspacePaths('/tmp/dsh-service-test'))
  const t0 = 1_000_000
  for (let attempt = 0; attempt < MAX_SQL_ATTEMPTS; attempt += 1) {
    service.consultQueryBudget('session-denial', t0)
  }
  try {
    service.consultQueryBudget('session-denial', t0)
    throw new Error('expected consultQueryBudget to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message.startsWith('POLICY_DENIED:')).toBe(true)
  }
  service.dispose()
})

it('shares a default bucket when session id is missing', () => {
  const service = new DuckdbAnalystService(resolveWorkspacePaths('/tmp/dsh-service-test'))
  const t0 = 1_000_000
  for (let attempt = 0; attempt < MAX_SQL_ATTEMPTS; attempt += 1) {
    service.consultQueryBudget(undefined, t0)
  }
  expect(() => service.consultQueryBudget(undefined, t0)).toThrow(
    /^POLICY_DENIED: SQL_REPAIR_BUDGET/,
  )
  service.dispose()
})

it('starts a fresh request window instead of a permanent deny once MAX_REQUEST_MS has elapsed', () => {
  const service = new DuckdbAnalystService(resolveWorkspacePaths('/tmp/dsh-service-test'))
  const t0 = 1_000_000
  service.consultQueryBudget('session-time', t0)
  // A call MAX_REQUEST_MS later on the SAME session must be treated as a
  // new request window, not denied forever by the old window's clock.
  expect(() => service.consultQueryBudget('session-time', t0 + MAX_REQUEST_MS)).not.toThrow()
  // The new window's own clock is what now governs TIME_BUDGET.
  expect(() =>
    service.consultQueryBudget('session-time', t0 + MAX_REQUEST_MS + MAX_REQUEST_MS),
  ).not.toThrow()
  service.dispose()
})

it('resets the SQL-repair-attempt counter after a successful query, so only consecutive failures deny', () => {
  const service = new DuckdbAnalystService(resolveWorkspacePaths('/tmp/dsh-service-test'))
  const t0 = 1_000_000
  // Three attempts, then a recorded success — a 4th, 5th, 6th attempt must
  // still be allowed instead of permanently denying the session after any
  // 3 total lifetime attempts.
  for (let attempt = 0; attempt < MAX_SQL_ATTEMPTS; attempt += 1) {
    service.consultQueryBudget('session-success', t0)
  }
  service.recordSuccessfulQuery('session-success')
  expect(() => service.consultQueryBudget('session-success', t0)).not.toThrow()
  expect(() => service.consultQueryBudget('session-success', t0)).not.toThrow()
  service.recordSuccessfulQuery('session-success')
  expect(() => service.consultQueryBudget('session-success', t0)).not.toThrow()
  service.dispose()
})

it('still denies the 4th attempt after 3 CONSECUTIVE failures with no recorded success in between', () => {
  const service = new DuckdbAnalystService(resolveWorkspacePaths('/tmp/dsh-service-test'))
  const t0 = 1_000_000
  for (let attempt = 0; attempt < MAX_SQL_ATTEMPTS; attempt += 1) {
    service.consultQueryBudget('session-fail', t0)
  }
  expect(() => service.consultQueryBudget('session-fail', t0)).toThrow(/SQL_REPAIR_BUDGET/)
  service.dispose()
})

it('recordSuccessfulQuery is a no-op for an unknown bucket and after disposal', () => {
  const service = new DuckdbAnalystService(resolveWorkspacePaths('/tmp/dsh-service-test'))
  expect(() => service.recordSuccessfulQuery('never-consulted')).not.toThrow()
  service.dispose()
  expect(() => service.recordSuccessfulQuery('session-a')).not.toThrow()
})

it('uses published dsh turns to isolate service budgets within one session', () => {
  const service = new DuckdbAnalystService(resolveWorkspacePaths('/tmp/dsh-service-test'))
  const session = Session.create(SessionId('session-multi'))
  const exec = { agent: { session } }
  const t0 = 1_000_000

  session.append('turn/start', { turn: 1 })
  const sessionId = sessionIdFromToolExec(exec)
  const firstRequestId = requestIdFromToolExec(exec)
  for (let attempt = 0; attempt < MAX_SQL_ATTEMPTS; attempt += 1) {
    service.consultQueryBudget(sessionId, t0, firstRequestId)
  }
  expect(() => service.consultQueryBudget(sessionId, t0, firstRequestId)).toThrow(
    /SQL_REPAIR_BUDGET/,
  )

  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  const secondRequestId = requestIdFromToolExec(exec)
  expect(secondRequestId).toBe('turn-2')
  expect(() => service.consultQueryBudget(sessionId, t0, secondRequestId)).not.toThrow()
  service.dispose()
})
