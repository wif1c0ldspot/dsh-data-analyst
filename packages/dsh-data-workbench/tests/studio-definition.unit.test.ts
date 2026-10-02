import { expect, it } from 'vitest'
import type { DatasetSchemaSlice } from 'dsh-data-core/catalog-query'
import {
  compileStudioDefinition,
  describeFilter,
  StudioApplySchema,
  StudioDefinitionSchema,
} from '../src/studio-definition.js'
const schema: DatasetSchemaSlice = {
  datasetId: 'bike',
  datasetVersionId: 'v1',
  semanticRevisionId: 's1',
  qualityScope:
    'rows and rejectedRows are ingestion counts only; they do not provide duplicate, NULL/missingness, or distribution-shape evidence',
  tables: [
    {
      id: 'hour',
      rows: 100,
      rejectedRows: 0,
      columns: [
        { name: 'count', type: 'INTEGER' },
        { name: 'hour', type: 'INTEGER' },
        { name: 'workingday', type: 'INTEGER' },
        { name: 'date', type: 'DATE' },
        { name: 'label', type: 'VARCHAR' },
        { name: 'recorded_at', type: 'TIMESTAMP' },
      ],
    },
  ],
  relationships: [],
  aliases: [],
  rules: [],
  columnsTruncated: false,
  nextOffset: null,
  totalColumns: 5,
}
const definition = () =>
  StudioDefinitionSchema.parse({
    datasetId: 'bike',
    datasetVersionId: 'v1',
    semanticRevisionId: 's1',
    table: 'hour',
    measure: { column: 'count', aggregation: 'avg' },
    groupBy: { column: 'hour' },
    filters: [{ column: 'workingday', value: 1 }],
    mark: 'line',
  })
it('compiles population filters before grouping and binds values', () => {
  const compiled = compileStudioDefinition(definition(), schema, 'Hourly means')
  expect(compiled.query.sql).toBe(
    'SELECT "hour" AS "group", AVG("count") AS "value" FROM "hour" WHERE "workingday" = ? GROUP BY "hour" ORDER BY 1',
  )
  expect(compiled.query.parameters).toEqual([{ logicalType: 'INTEGER', value: 1 }])
})
it('rejects stale versions, unknown fields, nonnumeric measures and invalid KPI', () => {
  expect(() =>
    compileStudioDefinition({ ...definition(), datasetVersionId: 'old' }, schema, 'x'),
  ).toThrow('revision changed')
  expect(() =>
    compileStudioDefinition({ ...definition(), table: 'read_csv' }, schema, 'x'),
  ).toThrow('published table')
  expect(() =>
    compileStudioDefinition(
      { ...definition(), measure: { aggregation: 'avg', column: 'label' } },
      schema,
      'x',
    ),
  ).toThrow('numeric')
  expect(() => compileStudioDefinition({ ...definition(), mark: 'kpi' }, schema, 'x')).toThrow(
    'single aggregate',
  )
})
it('only date columns accept time grain; SQL text is not an accepted input', () => {
  expect(() =>
    compileStudioDefinition(
      { ...definition(), groupBy: { column: 'hour', timeGrain: 'month' } },
      schema,
      'x',
    ),
  ).toThrow('date or timestamp')
  expect(
    StudioDefinitionSchema.safeParse({ ...definition(), sql: 'DROP TABLE hour' }).success,
  ).toBe(false)
  expect(
    StudioApplySchema.safeParse({ title: 'x', analysisId: 'ana_a', definition: definition() })
      .success,
  ).toBe(false)
  expect(
    compileStudioDefinition(
      { ...definition(), groupBy: { column: 'date', timeGrain: 'month' } },
      schema,
      'x',
    ).query.sql,
  ).toContain("date_trunc('month',")
})

// Range/multi-value filters extend the SAME source-row population-filter
// mechanism as the pre-existing eq filter (compileStudioDefinition compiles
// every filter shape into the query's WHERE clause, re-running against
// source rows — never a client-side filter over a saved/aggregate result).
it('compiles a numeric range filter with both bounds and binds min/max in order', () => {
  const compiled = compileStudioDefinition(
    {
      ...definition(),
      filters: [{ column: 'count', op: 'range', min: 10, max: 20 }],
    },
    schema,
    'x',
  )
  expect(compiled.query.sql).toContain('"count" >= ? AND "count" <= ?')
  expect(compiled.query.parameters).toEqual([
    { logicalType: 'INTEGER', value: 10 },
    { logicalType: 'INTEGER', value: 20 },
  ])
})
it('supports an open-ended range on either side (at least / at most)', () => {
  const atLeast = compileStudioDefinition(
    { ...definition(), filters: [{ column: 'count', op: 'range', min: 10 }] },
    schema,
    'x',
  )
  expect(atLeast.query.sql).toContain('WHERE "count" >= ?')
  expect(atLeast.query.parameters).toEqual([{ logicalType: 'INTEGER', value: 10 }])

  const atMost = compileStudioDefinition(
    { ...definition(), filters: [{ column: 'count', op: 'range', max: 20 }] },
    schema,
    'x',
  )
  expect(atMost.query.sql).toContain('WHERE "count" <= ?')
  expect(atMost.query.parameters).toEqual([{ logicalType: 'INTEGER', value: 20 }])
})
it('rejects a range filter with neither bound and a range filter on a non-numeric, non-date column', () => {
  expect(
    StudioDefinitionSchema.safeParse({
      ...definition(),
      filters: [{ column: 'count', op: 'range' }],
    }).success,
  ).toBe(false)
  expect(() =>
    compileStudioDefinition(
      { ...definition(), filters: [{ column: 'label', op: 'range', min: 'a', max: 'z' }] },
      schema,
      'x',
    ),
  ).toThrow('numeric or date/timestamp')
})
it('a DATE range upper bound is naturally inclusive of the whole day (no time component to lose)', () => {
  const compiled = compileStudioDefinition(
    { ...definition(), filters: [{ column: 'date', op: 'range', max: '2024-01-31' }] },
    schema,
    'x',
  )
  expect(compiled.query.sql).toContain('WHERE "date" <= ?')
  expect(compiled.query.parameters).toEqual([{ logicalType: 'DATE', value: '2024-01-31' }])
})
it('a bare-date upper bound on a TIMESTAMP column compiles to an exclusive next-day bound, inclusive of the whole final day', () => {
  const compiled = compileStudioDefinition(
    { ...definition(), filters: [{ column: 'recorded_at', op: 'range', max: '2024-01-31' }] },
    schema,
    'x',
  )
  expect(compiled.query.sql).toContain('WHERE "recorded_at" < ?')
  expect(compiled.query.parameters).toEqual([{ logicalType: 'TIMESTAMP', value: '2024-02-01' }])
})
it('a TIMESTAMP upper bound that already carries a time component is used exactly, not widened to the next day', () => {
  const compiled = compileStudioDefinition(
    {
      ...definition(),
      filters: [{ column: 'recorded_at', op: 'range', max: '2024-01-31 08:00:00' }],
    },
    schema,
    'x',
  )
  expect(compiled.query.sql).toContain('WHERE "recorded_at" <= ?')
  expect(compiled.query.parameters).toEqual([
    { logicalType: 'TIMESTAMP', value: '2024-01-31 08:00:00' },
  ])
})
it('compiles a multi-value (IN) filter with one placeholder per value', () => {
  const compiled = compileStudioDefinition(
    { ...definition(), filters: [{ column: 'label', op: 'in', values: ['east', 'west'] }] },
    schema,
    'x',
  )
  expect(compiled.query.sql).toContain('WHERE "label" IN (?, ?)')
  expect(compiled.query.parameters).toEqual([
    { logicalType: 'VARCHAR', value: 'east' },
    { logicalType: 'VARCHAR', value: 'west' },
  ])
})
it('rejects an empty or oversized multi-value list', () => {
  expect(
    StudioDefinitionSchema.safeParse({
      ...definition(),
      filters: [{ column: 'label', op: 'in', values: [] }],
    }).success,
  ).toBe(false)
  expect(
    StudioDefinitionSchema.safeParse({
      ...definition(),
      filters: [
        { column: 'label', op: 'in', values: Array.from({ length: 51 }, (_, i) => `v${i}`) },
      ],
    }).success,
  ).toBe(false)
})
it('clearing filters (empty array) fully resets to the unfiltered, all-source-rows state for every filter shape', () => {
  const compiled = compileStudioDefinition({ ...definition(), filters: [] }, schema, 'x')
  expect(compiled.query.sql).not.toContain('WHERE')
  expect(compiled.query.parameters).toEqual([])
})
it('range and IN filters exclude NULL rows, the same intentional SQL behavior as the pre-existing eq filter', () => {
  // Documents the decision (no separate "include NULLs" path exists): `>=`,
  // `<=` and `IN` all evaluate to NULL — not TRUE — against a NULL column
  // value, so DuckDB's WHERE drops that row exactly as `= value` already did.
  const rangeSql = compileStudioDefinition(
    { ...definition(), filters: [{ column: 'count', op: 'range', min: 0 }] },
    schema,
    'x',
  ).query.sql
  const inSql = compileStudioDefinition(
    { ...definition(), filters: [{ column: 'label', op: 'in', values: ['east'] }] },
    schema,
    'x',
  ).query.sql
  const eqSql = compileStudioDefinition(definition(), schema, 'x').query.sql
  for (const sql of [rangeSql, inSql, eqSql]) expect(sql).not.toMatch(/IS NULL|COALESCE/i)
})
it('describeFilter renders a readable summary for every filter shape', () => {
  expect(describeFilter({ column: 'workingday', value: 1 })).toBe('workingday = 1')
  expect(describeFilter({ column: 'count', op: 'range', min: 10, max: 20 })).toBe(
    'count >= 10 and <= 20',
  )
  expect(describeFilter({ column: 'count', op: 'range', min: 10 })).toBe('count >= 10')
  expect(describeFilter({ column: 'label', op: 'in', values: ['east', 'west'] })).toBe(
    'label in [east, west]',
  )
})
