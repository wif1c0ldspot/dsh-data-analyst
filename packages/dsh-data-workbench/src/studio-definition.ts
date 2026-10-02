import { z } from 'zod'
import type { DatasetSchemaSlice } from 'dsh-data-core/catalog-query'
import { ChartFormatSchema, type ChartIntent, type QueryRequest } from 'dsh-data-core/contracts'

const identifier = z.string().min(1).max(200)
const ScalarValueSchema = z.union([z.string().max(2000), z.number().finite(), z.boolean()])

// Population filters target source rows (they compile into a WHERE clause
// re-run against the underlying table), not the already-computed/saved
// result — see compileStudioDefinition below. Three shapes share one
// mechanism and one 10-filter bound:
// - eq (legacy default; `op` omitted means 'eq' so saved revisions written
//   before ranges/multi-value existed keep parsing unchanged): single value.
// - range: numeric/date-or-timestamp columns only; min and/or max, both
//   optional, at least one required.
// - in: any column; 1-50 discrete values (categorical multi-select).
const EqFilterSchema = z.strictObject({
  column: identifier,
  op: z.literal('eq').optional(),
  value: ScalarValueSchema,
})
const RangeFilterSchema = z
  .strictObject({
    column: identifier,
    op: z.literal('range'),
    min: ScalarValueSchema.optional(),
    max: ScalarValueSchema.optional(),
  })
  .refine((filter) => filter.min !== undefined || filter.max !== undefined, {
    message: 'A range filter needs at least a minimum or a maximum bound',
  })
const InFilterSchema = z.strictObject({
  column: identifier,
  op: z.literal('in'),
  values: z.array(ScalarValueSchema).min(1).max(50),
})
const FilterSchema = z.union([RangeFilterSchema, InFilterSchema, EqFilterSchema])
export type StudioFilter = z.infer<typeof FilterSchema>

export const StudioDefinitionSchema = z.strictObject({
  datasetId: identifier,
  datasetVersionId: identifier,
  semanticRevisionId: identifier,
  table: identifier,
  measure: z.strictObject({
    column: identifier.optional(),
    aggregation: z.enum(['sum', 'avg', 'min', 'max', 'count']),
  }),
  groupBy: z
    .strictObject({ column: identifier, timeGrain: z.enum(['day', 'month', 'year']).optional() })
    .optional(),
  series: identifier.optional(),
  filters: z.array(FilterSchema).max(10).default([]),
  mark: z.enum(['bar', 'line', 'point', 'area', 'table', 'kpi']),
  format: ChartFormatSchema.optional(),
})
export type StudioDefinition = z.infer<typeof StudioDefinitionSchema>

/** Human-readable population-filter summary used in question text and evidence captions. */
export function describeFilter(filter: StudioFilter): string {
  if (filter.op === 'range') {
    const bounds = [
      filter.min !== undefined ? `>= ${String(filter.min)}` : null,
      filter.max !== undefined ? `<= ${String(filter.max)}` : null,
    ].filter((part): part is string => part !== null)
    return `${filter.column} ${bounds.join(' and ')}`
  }
  if (filter.op === 'in') return `${filter.column} in [${filter.values.map(String).join(', ')}]`
  return `${filter.column} = ${String(filter.value)}`
}
export const StudioApplySchema = z
  .strictObject({
    analysisId: z
      .string()
      .regex(/^ana_[a-z0-9]+$/i)
      .optional(),
    expectedRevision: z.number().int().positive().optional(),
    title: z.string().trim().min(1).max(200),
    definition: StudioDefinitionSchema,
  })
  .refine(
    (value) => !value.analysisId || value.expectedRevision !== undefined,
    'expectedRevision is required for an existing analysis',
  )

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
const numeric = /^(?:U?(?:TINY|SMALL|BIG|HUGE)?INT(?:EGER)?|FLOAT|REAL|DOUBLE|DECIMAL(?:\(.+\))?)$/i

/** A fixed grammar of field choices; never parses or accepts analyst-authored SQL. */
export function compileStudioDefinition(
  definition: StudioDefinition,
  schema: DatasetSchemaSlice,
  title: string,
): { query: QueryRequest; chart: ChartIntent } {
  if (
    definition.datasetVersionId !== schema.datasetVersionId ||
    definition.semanticRevisionId !== schema.semanticRevisionId ||
    definition.datasetId !== schema.datasetId
  )
    throw new Error('Dataset or semantic revision changed; reload the schema')
  const table = schema.tables.find((entry) => entry.id === definition.table)
  if (!table?.columns?.length) throw new Error('Choose a published table with reviewed columns')
  const column = (name: string) => {
    const found = table.columns!.find((entry) => entry.name === name)
    if (!found) throw new Error(`Unknown column: ${name}`)
    return found
  }
  const { measure, groupBy, series } = definition
  if (
    measure.aggregation !== 'count' &&
    (!measure.column || !numeric.test(column(measure.column).type))
  )
    throw new Error('This aggregation requires a numeric column')
  if (measure.column) column(measure.column)
  if (series && !groupBy) throw new Error('A series requires a grouping field')
  if (definition.mark === 'kpi' && groupBy)
    throw new Error('KPI requires a single aggregate without groups')
  if (!groupBy && !['kpi', 'table'].includes(definition.mark))
    throw new Error('Choose a grouping field for this chart')
  const groups: string[] = []
  const select: string[] = []
  if (groupBy) {
    const field = column(groupBy.column)
    if (groupBy.timeGrain && !/^(DATE|TIMESTAMP)/i.test(field.type))
      throw new Error('Time grain requires a date or timestamp column')
    const expression = groupBy.timeGrain
      ? `date_trunc('${groupBy.timeGrain}', ${quote(field.name)})`
      : quote(field.name)
    groups.push(expression)
    select.push(`${expression} AS "group"`)
  }
  if (series) {
    column(series)
    groups.push(quote(series))
    select.push(`${quote(series)} AS "series"`)
  }
  select.push(
    `${measure.aggregation.toUpperCase()}(${measure.column ? quote(measure.column) : '*'}) AS "value"`,
  )
  const dateOrTimestamp = /^(DATE|TIMESTAMP)/i
  const parameters: QueryRequest['parameters'] = []
  const whereParts: string[] = []
  // NULL semantics are the same, intentional SQL behavior for every filter
  // shape here: `=`, `>=`/`<=` and `IN` all evaluate to NULL (not TRUE) when
  // compared against a NULL column value, so a NULL row is excluded by a
  // range or multi-value filter exactly as it already was by an eq filter —
  // there is no separate "include NULLs" path.
  for (const filter of definition.filters) {
    const field = column(filter.column)
    // Narrow on `filter.op` itself (not a copy) so TypeScript can discriminate
    // the union by each branch's own literal type.
    if (filter.op === 'range') {
      if (!numeric.test(field.type) && !dateOrTimestamp.test(field.type))
        throw new Error('Range filters require a numeric or date/timestamp column')
      if (filter.min !== undefined) {
        whereParts.push(`${quote(filter.column)} >= ?`)
        parameters.push({ logicalType: field.type, value: filter.min })
      }
      if (filter.max !== undefined) {
        // A bare date (no time part) as the upper bound of a TIMESTAMP
        // column must be inclusive of the whole final day, not just its
        // midnight instant, so it compiles to `< next day` instead of
        // `<= max`. A DATE column has no time component, so `<=` is already
        // inclusive of the whole day and needs no adjustment.
        const dateOnly = typeof filter.max === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(filter.max)
        if (dateOnly && /^TIMESTAMP/i.test(field.type)) {
          const next = new Date(`${filter.max}T00:00:00.000Z`)
          next.setUTCDate(next.getUTCDate() + 1)
          whereParts.push(`${quote(filter.column)} < ?`)
          parameters.push({ logicalType: field.type, value: next.toISOString().slice(0, 10) })
        } else {
          whereParts.push(`${quote(filter.column)} <= ?`)
          parameters.push({ logicalType: field.type, value: filter.max })
        }
      }
      continue
    }
    if (filter.op === 'in') {
      whereParts.push(`${quote(filter.column)} IN (${filter.values.map(() => '?').join(', ')})`)
      for (const value of filter.values) parameters.push({ logicalType: field.type, value })
      continue
    }
    // eq (op omitted or explicitly 'eq')
    whereParts.push(`${quote(filter.column)} = ?`)
    parameters.push({ logicalType: field.type, value: filter.value })
  }
  const where = whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : ''
  const sql = `SELECT ${select.join(', ')} FROM ${quote(table.id)}${where}${groups.length ? ` GROUP BY ${groups.join(', ')} ORDER BY ${groups.map((_, index) => index + 1).join(', ')}` : ''}`
  return {
    query: {
      datasetVersionId: schema.datasetVersionId,
      semanticRevisionId: schema.semanticRevisionId,
      sql,
      parameters,
    },
    chart: {
      mark: definition.mark,
      format: definition.format,
      title,
      ...(groupBy ? { x: 'group', xLabel: groupBy.column } : {}),
      y: 'value',
      ...(series ? { series: 'series' } : {}),
      yLabel: `${measure.aggregation} ${measure.column ?? 'rows'}`,
    },
  }
}
