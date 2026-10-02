import { expect, it } from 'vitest'
import {
  createOpenAiCompatibleSqlGenerator,
  normalizeGeneratedSql,
  parseChartIntentJson,
  stripSqlFences,
} from '../src/sql-generators.js'

it('stripSqlFences removes markdown fences and trailing semicolon', () => {
  expect(stripSqlFences('```sql\nSELECT 1;\n```')).toBe('SELECT 1')
  expect(stripSqlFences('SELECT region FROM orders;')).toBe('SELECT region FROM orders')
})

it('stripSqlFences drops think tags and keeps SELECT', () => {
  expect(stripSqlFences('<think>plan</think>\nSELECT 1')).toBe('SELECT 1')
  expect(stripSqlFences('SELECT 1 /think')).toBe('SELECT 1')
})

it('normalizeGeneratedSql strips dataset schema prefixes', () => {
  expect(normalizeGeneratedSql('SELECT * FROM superstore.orders', 'superstore')).toBe(
    'SELECT * FROM orders',
  )
  expect(normalizeGeneratedSql('SELECT @region FROM orders', 'superstore')).toBe(
    'SELECT region FROM orders',
  )
})

it('normalizeGeneratedSql preserves @ inside string literals', () => {
  expect(normalizeGeneratedSql("SELECT '@alice' AS handle FROM orders", 'superstore')).toBe(
    "SELECT '@alice' AS handle FROM orders",
  )
  expect(normalizeGeneratedSql("SELECT 'it''s @ok' AS t, @x AS x FROM orders", 'superstore')).toBe(
    "SELECT 'it''s @ok' AS t, x AS x FROM orders",
  )
})

it('normalizeGeneratedSql preserves dataset qualifiers inside string literals', () => {
  expect(
    normalizeGeneratedSql(
      "SELECT 'superstore.orders' AS source FROM superstore.orders",
      'superstore',
    ),
  ).toBe("SELECT 'superstore.orders' AS source FROM orders")
})

it('normalizeGeneratedSql leaves dollar-quoted SQL unchanged', () => {
  const dollarQuoted = 'SELECT $$superstore.orders @alice$$ AS source FROM superstore.orders'
  expect(normalizeGeneratedSql(dollarQuoted, 'superstore')).toBe(dollarQuoted)
})

it('normalizeGeneratedSql leaves non-ASCII dollar-tagged SQL unchanged', () => {
  const dollarQuoted = 'SELECT $é$superstore.orders @alice$é$ AS source FROM superstore.orders'
  expect(normalizeGeneratedSql(dollarQuoted, 'superstore')).toBe(dollarQuoted)
})

it('normalizeGeneratedSql leaves escape-string SQL unchanged', () => {
  const escapeQuoted = String.raw`SELECT E'it\'s superstore.orders @alice' AS source FROM superstore.orders`
  expect(normalizeGeneratedSql(escapeQuoted, 'superstore')).toBe(escapeQuoted)
})

it('normalizeGeneratedSql leaves commented SQL unchanged', () => {
  const commented = "-- Alice's note\nSELECT 'superstore.orders' AS label"
  expect(normalizeGeneratedSql(commented, 'superstore')).toBe(commented)
})

it('normalizeGeneratedSql leaves double-quoted SQL unchanged', () => {
  const doubleQuoted = `SELECT 1 AS "Alice's", 'superstore.orders' AS label`
  expect(normalizeGeneratedSql(doubleQuoted, 'superstore')).toBe(doubleQuoted)
})

it('parseChartIntentJson accepts fenced JSON', () => {
  expect(parseChartIntentJson('```json\n{"mark":"bar","x":"region","y":"revenue"}\n```')).toEqual({
    mark: 'bar',
    x: 'region',
    y: 'revenue',
  })
})

it('createOpenAiCompatibleSqlGenerator does not retry after abort', async () => {
  let calls = 0
  const controller = new AbortController()
  controller.abort()
  const generator = createOpenAiCompatibleSqlGenerator({
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    fetchImpl: async () => {
      calls += 1
      throw new Error('should not fetch')
    },
  })
  await expect(
    generator.generateSql({
      question: 'revenue by region',
      datasetId: 'retail-fixture',
      schemaSummary: 'tables: retail',
      signal: controller.signal,
    }),
  ).rejects.toThrow(/abort|cancel/i)
  expect(calls).toBe(0)
})

it('createOpenAiCompatibleSqlGenerator posts chat completions and returns SQL', async () => {
  const generator = createOpenAiCompatibleSqlGenerator({
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    fetchImpl: async (input, init) => {
      expect(String(input)).toBe('https://example.test/v1/chat/completions')
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe('test-model')
      expect(body.messages[1].content).toBe('revenue by region')
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '```sql\nSELECT 1 AS x\n```' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  await expect(
    generator.generateSql({
      question: 'revenue by region',
      datasetId: 'retail-fixture',
      schemaSummary: 'tables: retail',
    }),
  ).resolves.toBe('SELECT 1 AS x')
})
