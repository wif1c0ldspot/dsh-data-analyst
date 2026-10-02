import { expect, it, vi } from 'vitest'
import { HELD_OUT_CASES } from '../src/nl-eval.js'
import { gradeDshLoopTrace } from '../src/dsh-loop-eval.js'
import {
  DEFAULT_MAX_TOOL_CALLS_PER_TURN,
  assertProductionLoop,
  createToolCallBudgetGuard,
  readDshLoopTokenUsage,
  runDshLoopQuestionsWithExecutor,
  type ExecuteTurn,
} from '../src/dsh-loop-driver.js'

it('refuses to treat nl-loop as the production driver', () => {
  expect(() => assertProductionLoop('nl-loop')).toThrow(/nl-loop is component evidence/)
})

it('grades a canned retail-fixture tool trace as a dsh-loop case', () => {
  const fixture = HELD_OUT_CASES.find((entry) => entry.datasetId === 'retail-fixture')
  if (!fixture) throw new Error('expected synthetic held-out case')
  const scored = gradeDshLoopTrace(
    {
      caseId: fixture.id,
      question: fixture.question,
      datasetId: fixture.datasetId,
      analystTurns: 1,
      outcome: 'answer',
      toolCalls: [
        {
          name: 'duckdb_query',
          args: { datasetId: 'retail-fixture', sql: fixture.goldenSql, parameters: [] },
          result: { preview: fixture.expectedPreview },
        },
      ],
    },
    fixture,
  )
  expect(scored.sqlPass).toBe(true)
  expect(scored.turnsPass).toBe(true)
})

it('grades a canned retail-fixture trace produced by the driver-loop helper with a fake executeTurn', async () => {
  const fixture = HELD_OUT_CASES.find((entry) => entry.datasetId === 'retail-fixture')
  if (!fixture) throw new Error('expected synthetic held-out case')

  const fakeExecuteTurn: ExecuteTurn = vi.fn(async () => ({
    toolCalls: [
      {
        name: 'duckdb_query',
        args: { datasetId: 'retail-fixture', sql: fixture.goldenSql, parameters: [] },
        result: { preview: fixture.expectedPreview },
      },
    ],
    outcome: 'answer' as const,
    finalText: 'South revenue is 50.',
    tokenUsage: {
      uncachedInputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    },
  }))

  const [trace] = await runDshLoopQuestionsWithExecutor(
    {
      questions: [{ caseId: fixture.id, datasetId: fixture.datasetId, question: fixture.question }],
      maxAnalystTurns: 2,
      maxToolCallsPerTurn: 12,
    },
    fakeExecuteTurn,
  )

  expect(fakeExecuteTurn).toHaveBeenCalledOnce()
  expect(trace).toBeDefined()
  const scored = gradeDshLoopTrace(trace, fixture)
  expect(scored.sqlPass).toBe(true)
  expect(scored.turnsPass).toBe(true)
  expect(trace?.finalText).toBe('South revenue is 50.')
  expect(trace?.elapsedMs).toBeGreaterThanOrEqual(0)
  expect(trace?.toolCallsComplete).toBe(true)
  expect(trace?.tokenUsage?.outputTokens).toBe(4)
})

it('does not call executeTurn when maxAnalystTurns <= 0', async () => {
  const fakeExecuteTurn: ExecuteTurn = vi.fn(async () => ({
    toolCalls: [],
    outcome: 'answer' as const,
    finalText: '',
  }))

  const [trace] = await runDshLoopQuestionsWithExecutor(
    {
      questions: [{ caseId: 'q1', datasetId: 'retail-fixture', question: 'anything' }],
      maxAnalystTurns: 0,
      maxToolCallsPerTurn: 12,
    },
    fakeExecuteTurn,
  )

  expect(fakeExecuteTurn).not.toHaveBeenCalled()
  expect(trace?.outcome).toBe('error')
  expect(trace?.analystTurns).toBe(0)
  expect(trace?.toolCalls).toEqual([])
})

it('a negative maxAnalystTurns also skips calling executeTurn', async () => {
  const fakeExecuteTurn: ExecuteTurn = vi.fn(async () => ({
    toolCalls: [],
    outcome: 'answer' as const,
    finalText: '',
  }))

  await runDshLoopQuestionsWithExecutor(
    {
      questions: [{ caseId: 'q1', datasetId: 'retail-fixture', question: 'anything' }],
      maxAnalystTurns: -1,
      maxToolCallsPerTurn: 12,
    },
    fakeExecuteTurn,
  )

  expect(fakeExecuteTurn).not.toHaveBeenCalled()
})

it('resolves the tool-call bound to a finite number, defaulting to 12 for NaN input', async () => {
  let observedMaxToolCallsPerTurn: number | undefined
  const fakeExecuteTurn: ExecuteTurn = vi.fn(async (input) => {
    observedMaxToolCallsPerTurn = input.maxToolCallsPerTurn
    return { toolCalls: [], outcome: 'answer' as const, finalText: '' }
  })

  await runDshLoopQuestionsWithExecutor(
    {
      questions: [{ caseId: 'q1', datasetId: 'retail-fixture', question: 'anything' }],
      maxAnalystTurns: 1,
      maxToolCallsPerTurn: Number.NaN,
    },
    fakeExecuteTurn,
  )

  expect(fakeExecuteTurn).toHaveBeenCalledOnce()
  expect(observedMaxToolCallsPerTurn).toBe(DEFAULT_MAX_TOOL_CALLS_PER_TURN)
  expect(observedMaxToolCallsPerTurn).toBe(12)
})

it('honors an explicit positive tool-call bound instead of the default', async () => {
  let observedMaxToolCallsPerTurn: number | undefined
  const fakeExecuteTurn: ExecuteTurn = vi.fn(async (input) => {
    observedMaxToolCallsPerTurn = input.maxToolCallsPerTurn
    return { toolCalls: [], outcome: 'answer' as const, finalText: '' }
  })

  await runDshLoopQuestionsWithExecutor(
    {
      questions: [{ caseId: 'q1', datasetId: 'retail-fixture', question: 'anything' }],
      maxAnalystTurns: 1,
      maxToolCallsPerTurn: 3,
    },
    fakeExecuteTurn,
  )

  expect(observedMaxToolCallsPerTurn).toBe(3)
})

it('reads the four disjoint token buckets from the session projection', () => {
  const session = {}
  expect(
    readDshLoopTokenUsage(
      {
        sessionProjections: {
          snapshot: (received: unknown) => ({
            values: {
              tokenUsage: {
                uncachedInputTokens: received === session ? 11 : 0,
                outputTokens: 7,
                cacheReadTokens: 5,
                cacheWriteTokens: 3,
              },
            },
          }),
        },
      },
      session,
    ),
  ).toEqual({
    uncachedInputTokens: 11,
    outputTokens: 7,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
  })
})

it('keeps absent token telemetry unavailable instead of reporting zero', () => {
  expect(
    readDshLoopTokenUsage({ sessionProjections: { snapshot: () => ({ values: {} }) } }, {}),
  ).toBeUndefined()
})

it('marks call counts incomplete when an executor fails before returning telemetry', async () => {
  const [trace] = await runDshLoopQuestionsWithExecutor(
    {
      questions: [{ caseId: 'q1', datasetId: 'superstore', question: 'anything' }],
      maxAnalystTurns: 1,
      maxToolCallsPerTurn: 12,
    },
    async () => {
      throw new Error('provider failed')
    },
  )

  expect(trace?.outcome).toBe('error')
  expect(trace?.toolCalls).toEqual([])
  expect(trace?.toolCallsComplete).toBe(false)
  expect(trace?.elapsedMs).toBeGreaterThanOrEqual(0)
  expect(trace?.tokenUsage).toBeUndefined()
})

it('denies a fake 13th tool call when the limit is 12, without denying the first 12', () => {
  // This is the exact bug this fix closes: the production ctx.agents path
  // used to only notice the budget was exceeded AFTER the 13th call's
  // tools/result fired, by which point the tool body had already run.
  // createToolCallBudgetGuard() is the pure, dsh-independent piece plugged
  // into ctx.tools.guard() (evaluated BEFORE the tool body), so this test
  // proves the 13th attempt is denied without booting dsh or a real agent.
  const onExceeded = vi.fn()
  const guard = createToolCallBudgetGuard(12, onExceeded)

  for (let callNumber = 1; callNumber <= 12; callNumber += 1) {
    expect(guard({})).toBeUndefined()
  }
  expect(onExceeded).not.toHaveBeenCalled()

  const thirteenthDenialReason = guard({})
  expect(thirteenthDenialReason).toBe('tool-call budget exceeded (12 per analyst turn)')
  expect(onExceeded).toHaveBeenCalledOnce()
})

it('keeps denying every call after the limit, but only fires onExceeded once', () => {
  const onExceeded = vi.fn()
  const guard = createToolCallBudgetGuard(1, onExceeded)

  expect(guard({})).toBeUndefined()
  expect(guard({})).toBe('tool-call budget exceeded (1 per analyst turn)')
  expect(guard({})).toBe('tool-call budget exceeded (1 per analyst turn)')
  expect(onExceeded).toHaveBeenCalledOnce()
})

it('never denies when the limit is never reached', () => {
  const onExceeded = vi.fn()
  const guard = createToolCallBudgetGuard(12, onExceeded)

  for (let callNumber = 1; callNumber <= 12; callNumber += 1) {
    expect(guard({})).toBeUndefined()
  }
  expect(onExceeded).not.toHaveBeenCalled()
})
