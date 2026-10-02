import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { joinWarningsForSql } from 'dsh-data-core/join-warnings'
import {
  buildAnalyticalRecipe,
  buildReconcileGrainsRecipe,
  type AnalyticalRecipeInput,
  type ReconcileGrainsScope,
} from '../src/analytical-recipes.js'
import { QueryCancelledError } from '../src/cancellable-query.js'
import { QueryBudgetViolation } from '../src/fixed-query.js'
import { executeAuthorizedQuery } from '../src/query-service.js'
import { QueryPolicyViolation } from '../src/sql-policy.js'

let directory: string
let datasetPath: string

const scopes = {
  measurements: {
    table: 'measurements',
    columns: ['elapsed_seconds', 'value', 'comparison_group'],
    columnTypes: { elapsed_seconds: 'BIGINT', value: 'DOUBLE', comparison_group: 'VARCHAR' },
    grainStatus: 'approved' as const,
  },
  wideIntervals: {
    table: 'wide_intervals',
    columns: ['elapsed_seconds'],
    columnTypes: { elapsed_seconds: 'BIGINT' },
    grainStatus: 'approved' as const,
  },
  empty: {
    table: 'empty_values',
    columns: ['value'],
    columnTypes: { value: 'DOUBLE' },
    grainStatus: 'approved' as const,
  },
  allNull: {
    table: 'all_null_values',
    columns: ['value'],
    columnTypes: { value: 'DOUBLE' },
    grainStatus: 'approved' as const,
  },
  duplicates: {
    table: 'duplicate_rows',
    columns: ['key', 'value'],
    columnTypes: { key: 'VARCHAR', value: 'BIGINT' },
    grainStatus: 'approved' as const,
  },
  singleColumnDuplicates: {
    table: 'single_duplicate_rows',
    columns: ['value'],
    columnTypes: { value: 'BIGINT' },
    grainStatus: 'unknown' as const,
  },
  ratios: {
    table: 'ratio_rows',
    columns: ['numerator', 'denominator'],
    columnTypes: { numerator: 'DECIMAL(38,2)', denominator: 'DECIMAL(38,2)' },
    grainStatus: 'approved' as const,
  },
  incompleteRatios: {
    table: 'incomplete_ratio_rows',
    columns: ['numerator', 'denominator'],
    columnTypes: { numerator: 'DECIMAL(38,2)', denominator: 'DECIMAL(38,2)' },
    grainStatus: 'approved' as const,
  },
  zeroRatios: {
    table: 'zero_ratio_rows',
    columns: ['numerator', 'denominator'],
    columnTypes: { numerator: 'DECIMAL(38,2)', denominator: 'DECIMAL(38,2)' },
    grainStatus: 'approved' as const,
  },
  exactValues: {
    table: 'exact_values',
    columns: ['value'],
    columnTypes: { value: 'BIGINT' },
    grainStatus: 'approved' as const,
  },
  preciseDecimals: {
    table: 'precise_decimals',
    columns: ['value'],
    columnTypes: { value: 'DECIMAL(38,20)' },
    grainStatus: 'approved' as const,
  },
  rateComparison: {
    table: 'rate_comparison',
    columns: ['old_fraction', 'new_fraction', 'old_percent', 'new_percent'],
    columnTypes: {
      old_fraction: 'DECIMAL(10,2)',
      new_fraction: 'DECIMAL(10,2)',
      old_percent: 'DECIMAL(10,2)',
      new_percent: 'DECIMAL(10,2)',
    },
    grainStatus: 'approved' as const,
  },
  orderTotals: {
    table: 'order_totals',
    columns: ['order_id', 'total_amount'],
    columnTypes: { order_id: 'VARCHAR', total_amount: 'DECIMAL(18,2)' },
    grainStatus: 'approved' as const,
  },
  salesRows: {
    table: 'sales_rows',
    columns: ['customer', 'region', 'revenue'],
    columnTypes: { customer: 'VARCHAR', region: 'VARCHAR', revenue: 'DECIMAL(18,2)' },
    grainStatus: 'approved' as const,
  },
  orderLineItems: {
    table: 'order_line_items',
    columns: ['order_id', 'line_amount'],
    columnTypes: { order_id: 'VARCHAR', line_amount: 'DECIMAL(18,2)' },
    grainStatus: 'approved' as const,
  },
  emptyTotals: {
    table: 'empty_totals',
    columns: ['order_id', 'total_amount'],
    columnTypes: { order_id: 'VARCHAR', total_amount: 'DECIMAL(18,2)' },
    grainStatus: 'approved' as const,
  },
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-analytical-recipes-'))
  datasetPath = join(directory, 'dataset.duckdb')
  const database = await DuckDBInstance.create(datasetPath)
  const connection = await database.connect()
  try {
    await connection.run(`
      CREATE TABLE measurements (
        elapsed_seconds BIGINT,
        value DOUBLE,
        comparison_group VARCHAR
      );
      INSERT INTO measurements VALUES
        (-3601, NULL, 'z'),
        (-3600, 1, 'a'),
        (-1, 2, 'a'),
        (0, 2, 'b'),
        (3599, 100, 'b'),
        (3600, 1000, 'c');
      CREATE TABLE wide_intervals (elapsed_seconds BIGINT);
      INSERT INTO wide_intervals VALUES
        (-9223372036854775808), (-9007199254740993),
        (9007199254740992), (9007199254740993);
      CREATE TABLE empty_values (value DOUBLE);
      CREATE TABLE all_null_values (value DOUBLE);
      INSERT INTO all_null_values VALUES (NULL), (NULL);
      CREATE TABLE duplicate_rows (key VARCHAR, value BIGINT);
      INSERT INTO duplicate_rows VALUES ('a', 1), ('a', 1), ('b', NULL), ('b', NULL);
      CREATE TABLE single_duplicate_rows (value BIGINT);
      INSERT INTO single_duplicate_rows VALUES (NULL), (NULL), (1);
      CREATE TABLE ratio_rows (numerator DECIMAL(38,2), denominator DECIMAL(38,2));
      INSERT INTO ratio_rows VALUES (1, 2), (9, 98);
      CREATE TABLE incomplete_ratio_rows (numerator DECIMAL(38,2), denominator DECIMAL(38,2));
      INSERT INTO incomplete_ratio_rows VALUES (1, 2), (9, NULL), (NULL, 98);
      CREATE TABLE zero_ratio_rows (numerator DECIMAL(38,2), denominator DECIMAL(38,2));
      INSERT INTO zero_ratio_rows VALUES (1, 0), (9, 0);
      CREATE TABLE rate_comparison (
        old_fraction DECIMAL(10,2), new_fraction DECIMAL(10,2),
        old_percent DECIMAL(10,2), new_percent DECIMAL(10,2)
      );
      INSERT INTO rate_comparison VALUES (0.10, 0.12, 10, 12);
      CREATE TABLE exact_values (value BIGINT);
      INSERT INTO exact_values VALUES (9007199254740993), (9007199254740995);
      CREATE TABLE precise_decimals (value DECIMAL(38,20));
      INSERT INTO precise_decimals VALUES
        (0.12345678901234567890), (0.12345678901234567892);
      CREATE TABLE order_items (order_id VARCHAR, amount DECIMAL(18,2));
      INSERT INTO order_items VALUES ('o1', 10), ('o1', 20);
      CREATE TABLE order_payments (order_id VARCHAR, amount DECIMAL(18,2));
      INSERT INTO order_payments VALUES ('o1', 15), ('o1', 15);
      CREATE TABLE order_totals (order_id VARCHAR, total_amount DECIMAL(18,2));
      INSERT INTO order_totals VALUES ('o1', 25), ('o2', 40);
      CREATE TABLE order_line_items (order_id VARCHAR, line_amount DECIMAL(18,2));
      INSERT INTO order_line_items VALUES ('o1', 10), ('o1', 20), ('o2', 40);
      CREATE TABLE empty_totals (order_id VARCHAR, total_amount DECIMAL(18,2));
      CREATE TABLE sales_rows (customer VARCHAR, region VARCHAR, revenue DECIMAL(18,2));
      INSERT INTO sales_rows VALUES
        ('c1', 'east', 100),
        ('c2', 'east', 90),
        ('c3', 'west', 90),
        ('c4', 'west', 50),
        ('c5', 'north', 50),
        ('c6', 'south', 10),
        ('c8', 'south', NULL);
      CHECKPOINT;
    `)
  } finally {
    connection.closeSync()
    database.closeSync()
  }
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function execute(scope: (typeof scopes)[keyof typeof scopes], input: AnalyticalRecipeInput) {
  const recipe = buildAnalyticalRecipe(scope, input)
  return executeAuthorizedQuery({
    datasetPath,
    datasetVersionId: 'fixture-v1',
    semanticRevisionId: 'fixture-sem-v1',
    sql: recipe.sql,
    parameters: recipe.parameters,
    allowedTables: [scope.table],
  })
}

async function executeReconcile(
  scope: ReconcileGrainsScope,
  input: Extract<AnalyticalRecipeInput, { kind: 'reconcile-grains' }>,
) {
  const recipe = buildReconcileGrainsRecipe(scope, input)
  return executeAuthorizedQuery({
    datasetPath,
    datasetVersionId: 'fixture-v1',
    semanticRevisionId: 'fixture-sem-v1',
    sql: recipe.sql,
    parameters: recipe.parameters,
    allowedTables: [scope.primary.table, scope.secondary.table],
  })
}

it('computes boundary-safe elapsed bins and excludes NULL elapsed values', async () => {
  const result = await execute(scopes.measurements, {
    kind: 'elapsed-intervals',
    elapsedColumn: 'elapsed_seconds',
    originSeconds: 0,
    widthSeconds: 3600,
  })
  expect(result.preview).toEqual([
    ['-2', '1'],
    ['-1', '2'],
    ['0', '2'],
    ['1', '1'],
  ])
})

it('keeps wide and extreme BIGINT interval bins exact without subtraction overflow', async () => {
  const zeroOrigin = await execute(scopes.wideIntervals, {
    kind: 'elapsed-intervals',
    elapsedColumn: 'elapsed_seconds',
    originSeconds: 0,
    widthSeconds: 1,
  })
  expect(zeroOrigin.preview).toEqual([
    ['-9223372036854775808', '1'],
    ['-9007199254740993', '1'],
    ['9007199254740992', '1'],
    ['9007199254740993', '1'],
  ])

  const shifted = await execute(scopes.wideIntervals, {
    kind: 'elapsed-intervals',
    elapsedColumn: 'elapsed_seconds',
    originSeconds: 1,
    widthSeconds: 1,
  })
  expect(shifted.preview[0]).toEqual(['-9223372036854775809', '1'])
})

it('reports counts, NULL share, skewed statistics, groups, empty input, and all-NULL input', async () => {
  const summary = await execute(scopes.measurements, {
    kind: 'descriptive-statistics',
    valueColumn: 'value',
  })
  expect(summary.preview).toEqual([
    ['6', '5', '1', 1 / 6, 1, 1000, 221, 2, 2, 100, 'DERIVED_DOUBLE'],
  ])
  const [, , , , min, , , median, q1, q3] = summary.preview[0]!
  expect(Number(min) <= Number(q1)).toBe(true)
  expect(Number(q1) <= Number(median)).toBe(true)
  expect(Number(median) <= Number(q3)).toBe(true)

  const grouped = await execute(scopes.measurements, {
    kind: 'descriptive-statistics',
    valueColumn: 'value',
    groupColumn: 'comparison_group',
  })
  expect(grouped.preview).toEqual([
    ['a', '2', '2', '0', 0, 1, 2, 1.5, 1.5, 1.25, 1.75, 'DERIVED_DOUBLE'],
    ['b', '2', '2', '0', 0, 2, 100, 51, 51, 26.5, 75.5, 'DERIVED_DOUBLE'],
    ['c', '1', '1', '0', 0, 1000, 1000, 1000, 1000, 1000, 1000, 'DERIVED_DOUBLE'],
    ['z', '1', '0', '1', 1, null, null, null, null, null, null, 'NO_NON_NULL_VALUES'],
  ])

  const empty = await execute(scopes.empty, {
    kind: 'descriptive-statistics',
    valueColumn: 'value',
  })
  expect(empty.preview).toEqual([
    ['0', '0', '0', null, null, null, null, null, null, null, 'NO_NON_NULL_VALUES'],
  ])

  const allNull = await execute(scopes.allNull, {
    kind: 'descriptive-statistics',
    valueColumn: 'value',
  })
  expect(allNull.preview).toEqual([
    ['2', '0', '2', 1, null, null, null, null, null, null, 'NO_NON_NULL_VALUES'],
  ])
})

it('counts full-row duplicate excess including rows containing NULL', async () => {
  const result = await execute(scopes.duplicates, {
    kind: 'full-row-duplicate-excess',
    rowColumns: scopes.duplicates.columns,
  })
  expect(result.preview).toEqual([['4', '2', '2']])

  const singleColumn = await execute(scopes.singleColumnDuplicates, {
    kind: 'full-row-duplicate-excess',
    rowColumns: scopes.singleColumnDuplicates.columns,
  })
  expect(singleColumn.preview).toEqual([['3', '2', '1']])
})

it('uses a ratio of aggregate sums and applies explicit incomplete/zero rules', async () => {
  const ratio = await execute(scopes.ratios, {
    kind: 'ratio-of-sums',
    numeratorColumn: 'numerator',
    denominatorColumn: 'denominator',
    nullRule: 'withhold-on-incomplete-pairs',
  })
  expect(ratio.preview).toEqual([['2', '0', '10.00', '100.00', 0.1, null]])
  expect((0.5 + 9 / 98) / 2).not.toBe(0.1)

  const withheld = await execute(scopes.incompleteRatios, {
    kind: 'ratio-of-sums',
    numeratorColumn: 'numerator',
    denominatorColumn: 'denominator',
    nullRule: 'withhold-on-incomplete-pairs',
  })
  expect(withheld.preview).toEqual([['3', '2', '1.00', '2.00', null, 'INCOMPLETE_PAIRS']])

  const excluded = await execute(scopes.incompleteRatios, {
    kind: 'ratio-of-sums',
    numeratorColumn: 'numerator',
    denominatorColumn: 'denominator',
    nullRule: 'exclude-incomplete-pairs',
  })
  expect(excluded.preview).toEqual([['3', '2', '1.00', '2.00', 0.5, null]])

  const zero = await execute(scopes.zeroRatios, {
    kind: 'ratio-of-sums',
    numeratorColumn: 'numerator',
    denominatorColumn: 'denominator',
    nullRule: 'exclude-incomplete-pairs',
  })
  expect(zero.preview).toEqual([['2', '0', '10.00', '0.00', null, 'ZERO_DENOMINATOR']])
})

it('reconciles two independent population totals and reports the delta share', async () => {
  const result = await executeReconcile(
    { primary: scopes.orderTotals, secondary: scopes.orderLineItems, relationshipApproved: true },
    { kind: 'reconcile-grains', primaryColumn: 'total_amount', secondaryColumn: 'line_amount' },
  )
  // order_totals sums to 65.00 (25 + 40); order_line_items sums to 70.00 (10+20+40).
  expect(result.preview).toEqual([
    ['65.00', '2', '70.00', '3', '-5.00', -0.07692307692307693, null],
  ])
})

it('refuses reconcile-grains without an approved relationship between the two tables, naming a real next step', () => {
  expect(() =>
    buildReconcileGrainsRecipe(
      {
        primary: scopes.orderTotals,
        secondary: scopes.orderLineItems,
        relationshipApproved: false,
      },
      { kind: 'reconcile-grains', primaryColumn: 'total_amount', secondaryColumn: 'line_amount' },
    ),
  ).toThrow(/approved relationship/)
  // The error must be actionable, not just a fail-closed dead end: it should
  // name the two tables involved, point at the real tool that surfaces a
  // relationship candidate for analyst review (propose_structure /
  // list_pending_structure — verified against plugin-tools.ts), and warn the
  // model off hand-writing a join around the gate.
  expect(() =>
    buildReconcileGrainsRecipe(
      {
        primary: scopes.orderTotals,
        secondary: scopes.orderLineItems,
        relationshipApproved: false,
      },
      { kind: 'reconcile-grains', primaryColumn: 'total_amount', secondaryColumn: 'line_amount' },
    ),
  ).toThrow(
    /"order_totals" and "order_line_items".*propose_structure.*list_pending_structure.*ask the analyst.*Do not hand-write a join/s,
  )
})

it('flags an all-NULL side of a reconciliation instead of a misleading zero delta', async () => {
  const result = await executeReconcile(
    { primary: scopes.emptyTotals, secondary: scopes.orderLineItems, relationshipApproved: true },
    { kind: 'reconcile-grains', primaryColumn: 'total_amount', secondaryColumn: 'line_amount' },
  )
  expect(result.preview).toEqual([
    [null, '0', '70.00', '3', null, null, 'NO_NON_NULL_VALUES_ON_ONE_SIDE'],
  ])
})

it('rejects a non-numeric column for reconcile-grains', () => {
  expect(() =>
    buildReconcileGrainsRecipe(
      { primary: scopes.orderTotals, secondary: scopes.orderLineItems, relationshipApproved: true },
      { kind: 'reconcile-grains', primaryColumn: 'order_id', secondaryColumn: 'line_amount' },
    ),
  ).toThrow(/numeric column types/)
})

it('routes reconcile-grains input away from the single-table recipe builder', () => {
  expect(() =>
    buildAnalyticalRecipe(scopes.orderTotals, {
      kind: 'reconcile-grains',
      primaryColumn: 'total_amount',
      secondaryColumn: 'line_amount',
    }),
  ).toThrow(/buildReconcileGrainsRecipe/)
})

it('distinguishes fractional and already-percent percentage-point scales', async () => {
  const result = await executeAuthorizedQuery({
    datasetPath,
    datasetVersionId: 'fixture-v1',
    semanticRevisionId: 'sem-v1',
    sql: `SELECT
      old_fraction AS exact_old_fraction,
      new_fraction AS exact_new_fraction,
      (new_fraction - old_fraction) * 100 AS fractional_percentage_points,
      new_percent - old_percent AS stored_percentage_points,
      (new_fraction - old_fraction) / old_fraction AS relative_change
      FROM rate_comparison`,
    parameters: [],
    allowedTables: [scopes.rateComparison.table],
    resultStoreDir: join(directory, 'results'),
  })
  expect(result.preview[0]?.slice(0, 4)).toEqual(['0.10', '0.12', '2.00', '2.00'])
  expect(result.preview[0]?.[4]).toBeCloseTo(0.2)
  expect(result.preview[0]?.[4]).not.toBe(0.2)
})

it('preserves unsafe BIGINT extrema as strings while derived statistics remain engine numbers', async () => {
  const result = await execute(scopes.exactValues, {
    kind: 'descriptive-statistics',
    valueColumn: 'value',
  })
  expect(result.preview).toEqual([
    [
      '2',
      '2',
      '0',
      0,
      '9007199254740993',
      '9007199254740995',
      null,
      null,
      null,
      null,
      'WITHHELD_UNSAFE_DOUBLE_PRECISION',
    ],
  ])
})

it('withholds misleading derived statistics for high-precision DECIMAL values', async () => {
  const result = await execute(scopes.preciseDecimals, {
    kind: 'descriptive-statistics',
    valueColumn: 'value',
  })
  expect(result.preview).toEqual([
    [
      '2',
      '2',
      '0',
      0,
      '0.12345678901234567890',
      '0.12345678901234567892',
      null,
      null,
      null,
      null,
      'WITHHELD_HIGH_PRECISION_DECIMAL',
    ],
  ])
})

it('detects a many-to-many fanout and demonstrates the inflated independent oracle', async () => {
  const sql =
    'SELECT sum(i.amount) AS item_total FROM order_items i JOIN order_payments p ON p.order_id = i.order_id'
  const result = await executeAuthorizedQuery({
    datasetPath,
    datasetVersionId: 'fixture-v1',
    semanticRevisionId: 'fixture-sem-v1',
    sql,
    parameters: [],
    allowedTables: ['order_items', 'order_payments'],
  })
  expect(result.preview).toEqual([['60.00']])
  expect(result.preview[0]?.[0]).not.toBe('30.00')
  expect(
    joinWarningsForSql('fixture', sql, [
      {
        datasetId: 'fixture',
        fromTable: 'order_items',
        toTable: 'order_payments',
        fromColumns: ['order_id'],
        toColumns: ['order_id'],
        cardinality: 'n:n',
      },
    ]),
  ).toEqual(['fanout-risk: order_items x order_payments'])
})

it('ranks ungrouped rows for top-N and bottom-N with a deterministic tiebreak on ties', async () => {
  // Independently computed: 100(c1), 90(c2 east)/90(c3 west) tied, 50(c4
  // west)/50(c5 north) tied, 10(c6); c8's NULL revenue is excluded by the
  // recipe's WHERE clause. Ties break on customer ascending (the only other
  // approved column ordered before region alphabetically).
  const top = await execute(scopes.salesRows, {
    kind: 'top-n-extrema',
    measureColumn: 'revenue',
    direction: 'top',
    limit: 3,
  })
  expect(top.preview).toEqual([
    ['c1', 'east', '100.00'],
    ['c2', 'east', '90.00'],
    ['c3', 'west', '90.00'],
  ])

  const bottom = await execute(scopes.salesRows, {
    kind: 'top-n-extrema',
    measureColumn: 'revenue',
    direction: 'bottom',
    limit: 3,
  })
  expect(bottom.preview).toEqual([
    ['c6', 'south', '10.00'],
    ['c4', 'west', '50.00'],
    ['c5', 'north', '50.00'],
  ])
})

it('returns every available row instead of erroring when N exceeds the row count', async () => {
  const result = await execute(scopes.salesRows, {
    kind: 'top-n-extrema',
    measureColumn: 'revenue',
    direction: 'top',
    limit: 50,
  })
  // 7 rows total, 1 with NULL revenue excluded -> 6 non-null rows returned.
  expect(result.rowCount).toBe(6)
})

it('aggregates a grouped top-N/bottom-N ranking by summed measure per group', async () => {
  // Independently computed: east = 100+90 = 190, west = 90+50 = 140,
  // north = 50, south = 10 (c8's NULL revenue excluded from the sum).
  const top = await execute(scopes.salesRows, {
    kind: 'top-n-extrema',
    measureColumn: 'revenue',
    groupColumn: 'region',
    direction: 'top',
    limit: 2,
  })
  expect(top.preview).toEqual([
    ['east', '190.00', '2'],
    ['west', '140.00', '2'],
  ])

  const bottom = await execute(scopes.salesRows, {
    kind: 'top-n-extrema',
    measureColumn: 'revenue',
    groupColumn: 'region',
    direction: 'bottom',
    limit: 2,
  })
  expect(bottom.preview).toEqual([
    ['south', '10.00', '1'],
    ['north', '50.00', '1'],
  ])
})

it('rejects an unbounded or non-integer top-n-extrema limit before executing', () => {
  expect(() =>
    buildAnalyticalRecipe(scopes.salesRows, {
      kind: 'top-n-extrema',
      measureColumn: 'revenue',
      direction: 'top',
      limit: 500,
    }),
  ).toThrow(/integer between 1 and 50/)
})

it('retains policy denial, result budgets, and cancellation on the recipe execution path', async () => {
  const bins = buildAnalyticalRecipe(scopes.measurements, {
    kind: 'elapsed-intervals',
    elapsedColumn: 'elapsed_seconds',
    originSeconds: 0,
    widthSeconds: 3600,
  })
  const base = {
    datasetPath,
    datasetVersionId: 'fixture-v1',
    semanticRevisionId: 'fixture-sem-v1',
    sql: bins.sql,
    parameters: bins.parameters,
  }
  await expect(executeAuthorizedQuery({ ...base, allowedTables: [] })).rejects.toBeInstanceOf(
    QueryPolicyViolation,
  )
  await expect(
    executeAuthorizedQuery({ ...base, allowedTables: ['measurements'], maxResultRows: 2 }),
  ).rejects.toBeInstanceOf(QueryBudgetViolation)
  await expect(
    executeAuthorizedQuery({ ...base, allowedTables: ['measurements'], maxResultBytes: 1 }),
  ).rejects.toMatchObject({ name: 'QueryBudgetViolation', kind: 'bytes' })

  const controller = new AbortController()
  controller.abort()
  await expect(
    executeAuthorizedQuery({
      ...base,
      allowedTables: ['measurements'],
      signal: controller.signal,
    }),
  ).rejects.toBeInstanceOf(QueryCancelledError)
})
