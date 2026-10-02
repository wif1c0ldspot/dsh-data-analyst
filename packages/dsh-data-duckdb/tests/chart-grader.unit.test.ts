import { describe, expect, it } from 'vitest'
import { gradeChartIntent } from '../src/chart-grader.js'

describe('gradeChartIntent', () => {
  const acceptable = [
    { mark: 'bar' as const, x: 'region', y: 'revenue' },
    { mark: 'line' as const, x: 'order_date', y: 'revenue' },
  ]

  it('passes when mark and specified axes match (case-insensitive)', () => {
    expect(gradeChartIntent({ mark: 'bar', x: 'Region', y: 'REVENUE' }, acceptable)).toBe(true)
  })

  it('fails when mark does not match any acceptable entry', () => {
    expect(gradeChartIntent({ mark: 'point', x: 'region', y: 'revenue' }, acceptable)).toBe(false)
  })

  it('fails when a specified axis column mismatches', () => {
    expect(gradeChartIntent({ mark: 'bar', x: 'category', y: 'revenue' }, acceptable)).toBe(false)
    expect(gradeChartIntent({ mark: 'bar', x: 'region', y: 'profit' }, acceptable)).toBe(false)
  })

  it('allows missing axes on intent when acceptable omits them', () => {
    expect(gradeChartIntent({ mark: 'bar' }, [{ mark: 'bar' }])).toBe(true)
  })

  it('requires specified axes on acceptable to be present and matching on intent', () => {
    expect(gradeChartIntent({ mark: 'bar' }, [{ mark: 'bar', x: 'region' }])).toBe(false)
  })

  it('strips @table suffixes and accepts revenue/sales aliases', () => {
    expect(gradeChartIntent({ mark: 'bar', x: 'region', y: 'revenue@orders' }, acceptable)).toBe(
      true,
    )
    expect(gradeChartIntent({ mark: 'bar', x: 'region', y: 'sales' }, acceptable)).toBe(true)
    expect(
      gradeChartIntent({ mark: 'bar', x: 'ship_mode', y: 'quantity' }, [
        { mark: 'bar', x: 'ship_mode', y: 'n' },
      ]),
    ).toBe(false)
  })

  it('collapses aggregate expressions into measure roles', () => {
    expect(
      gradeChartIntent({ mark: 'bar', x: 'country', y: 'COUNT(DISTINCT invoice)' }, [
        { mark: 'bar', x: 'country', y: 'invoices' },
      ]),
    ).toBe(true)
    expect(
      gradeChartIntent({ mark: 'bar', x: 'country', y: 'SUM(quantity)' }, [
        { mark: 'bar', x: 'country', y: 'qty' },
      ]),
    ).toBe(true)
  })

  it('accepts quantity aliases with qty and explicit row-count aliases with n', () => {
    expect(
      gradeChartIntent({ mark: 'bar', x: 'region', y: 'profit on orders' }, [
        { mark: 'bar', x: 'region', y: 'profit' },
      ]),
    ).toBe(true)
    expect(
      gradeChartIntent({ mark: 'bar', x: 'country', y: 'total_quantity' }, [
        { mark: 'bar', x: 'country', y: 'qty' },
      ]),
    ).toBe(true)
    expect(
      gradeChartIntent({ mark: 'bar', x: 'payment_type', y: 'payment_row_count' }, [
        { mark: 'bar', x: 'payment_type', y: 'n' },
      ]),
    ).toBe(true)
    expect(
      gradeChartIntent({ mark: 'bar', x: 'product_category_name_english', y: 'order_item_id' }, [
        { mark: 'bar', x: 'category', y: 'n' },
      ]),
    ).toBe(false)
  })

  it('accepts common model-authored result aliases observed in live dsh traces', () => {
    expect(
      gradeChartIntent({ mark: 'bar', x: 'sub_category', y: 'sales_revenue' }, [
        { mark: 'bar', x: 'sub_category', y: 'revenue' },
      ]),
    ).toBe(true)
    expect(
      gradeChartIntent({ mark: 'bar', x: 'country', y: 'total_unit_price' }, [
        { mark: 'bar', x: 'country', y: 'total_price' },
      ]),
    ).toBe(true)
    expect(
      gradeChartIntent({ mark: 'bar', x: 'country', y: 'distinct_invoices' }, [
        { mark: 'bar', x: 'country', y: 'invoices' },
      ]),
    ).toBe(true)
    expect(
      gradeChartIntent({ mark: 'bar', x: 'country', y: 'net_quantity' }, [
        { mark: 'bar', x: 'country', y: 'qty' },
      ]),
    ).toBe(true)
    expect(
      gradeChartIntent({ mark: 'bar', x: 'payment_type', y: 'payment_rows' }, [
        { mark: 'bar', x: 'payment_type', y: 'n' },
      ]),
    ).toBe(true)
    expect(
      gradeChartIntent({ mark: 'bar', x: 'category_en', y: 'review_count' }, [
        { mark: 'bar', x: 'category', y: 'n' },
      ]),
    ).toBe(true)
  })

  it('accepts a case-specific xAliases/yAliases entry without any global MEASURE_ALIASES support', () => {
    // 'yr'/'profit_margin_pct' are not in any MEASURE_ALIASES group and never
    // will be by themselves — the per-case alias list on AcceptableChart is
    // what makes this pass, proving that mechanism works standalone.
    expect(
      gradeChartIntent({ mark: 'line', x: 'year', y: 'profit_margin_pct' }, [
        {
          mark: 'line',
          x: 'yr',
          xAliases: ['year'],
          y: 'margin_pct',
          yAliases: ['profit_margin_pct'],
        },
      ]),
    ).toBe(true)
    // The alias list is scoped to that one entry: a different acceptable
    // entry without a matching alias still rejects it.
    expect(
      gradeChartIntent({ mark: 'line', x: 'year', y: 'profit_margin_pct' }, [
        { mark: 'line', x: 'yr', y: 'margin_pct' },
      ]),
    ).toBe(false)
    // Aliases are alias-tolerant themselves (case-insensitive / trailing @table).
    expect(
      gradeChartIntent({ mark: 'bar', x: 'Year@orders', y: 'n' }, [
        { mark: 'bar', x: 'yr', xAliases: ['year'], y: 'n' },
      ]),
    ).toBe(true)
  })

  describe("role-based matching against the answer call's real result columns", () => {
    it('accepts a chart whose fields are the accepted answer result columns under a novel alias', () => {
      expect(
        gradeChartIntent(
          { mark: 'bar', x: 'dimension_value', y: 'aggregate_value' },
          [{ mark: 'bar', x: 'sub_category', y: 'revenue' }],
          { resultColumns: ['dimension_value', 'aggregate_value', 'row_count'] },
        ),
      ).toBe(true)
    })

    it('accepts profit_margin_pct and order_year style variants without a per-case alias list', () => {
      expect(
        gradeChartIntent(
          { mark: 'bar', x: 'segment', y: 'profit_margin_pct' },
          [{ mark: 'bar', x: 'segment', y: 'margin_pct', yAliases: ['profit_margin', 'margin'] }],
          { resultColumns: ['segment', 'total_sales', 'total_profit', 'profit_margin_pct'] },
        ),
      ).toBe(true)
      // Two-column result: no name/alias/suffix path resolves `order_year`
      // (`xAliases` only holds `year`), so this now depends on value
      // confirmation — the column's own values must match the case's
      // expected dimension/measure values, not merely sit in slot 1/2.
      expect(
        gradeChartIntent(
          { mark: 'bar', x: 'order_year', y: 'total_sales' },
          [{ mark: 'bar', x: 'yr', xAliases: ['year'], y: 'revenue' }],
          {
            resultColumns: ['order_year', 'total_sales'],
            columnValues: {
              order_year: [2014, 2015, 2016, 2017],
              total_sales: [484247.5, 470532.51, 609205.6, 733215.26],
            },
            roleValues: {
              dimension: [2014, 2015, 2016, 2017],
              measure: [484247.5, 470532.51, 609205.6, 733215.26],
            },
          },
        ),
      ).toBe(true)
    })

    it('still rejects a wrong measure even when the field name matches an alias', () => {
      expect(
        gradeChartIntent(
          { mark: 'bar', x: 'segment', y: 'total_cost' },
          [{ mark: 'bar', x: 'segment', y: 'margin_pct', yAliases: ['profit_margin', 'margin'] }],
          { resultColumns: ['segment', 'profit_margin_pct', 'total_cost'] },
        ),
      ).toBe(false)
    })

    it('still rejects a mark that is not in the accepted set (no loosening of genuine misses)', () => {
      expect(
        gradeChartIntent({ mark: 'kpi', x: 'region', y: 'revenue' }, [{ mark: 'bar' }], {
          resultColumns: ['region', 'revenue'],
        }),
      ).toBe(false)
      expect(
        gradeChartIntent({ mark: 'table', x: 'region', y: 'revenue' }, [{ mark: 'bar' }], {
          resultColumns: ['region', 'revenue'],
        }),
      ).toBe(false)
    })

    it('does not use role matching when no result-columns context is supplied (older traces)', () => {
      // Same novel-alias case as above, but without context: the fallback
      // alias path alone cannot resolve `dimension_value`/`aggregate_value`,
      // so it must still fail — proving the fallback path is unchanged.
      expect(
        gradeChartIntent({ mark: 'bar', x: 'dimension_value', y: 'aggregate_value' }, [
          { mark: 'bar', x: 'sub_category', y: 'revenue' },
        ]),
      ).toBe(false)
    })

    it('does not accept an unrelated numeric column as the measure when the result has extra columns and no role signal resolves it', () => {
      // Same shape as the wrong-measure case, but the model's y is itself
      // absent from the result entirely -- must still fail, not merely
      // "still fails when it names the wrong real column".
      expect(
        gradeChartIntent(
          { mark: 'bar', x: 'segment', y: 'made_up_column' },
          [{ mark: 'bar', x: 'segment', y: 'margin_pct', yAliases: ['profit_margin', 'margin'] }],
          { resultColumns: ['segment', 'profit_margin_pct', 'total_cost'] },
        ),
      ).toBe(false)
    })
  })

  describe('value confirms identity (Task 6): rule 3 no longer infers a role from column position alone', () => {
    it('rejects a wrong measure in a two-column result (rule 3 must not imply identity)', () => {
      // Reproduces the Task 6 spec's own probe: no roleValues/columnValues
      // are supplied, so there is nothing to confirm `total_cost` as the
      // accepted `margin_pct` measure by value, and the old "column 2 of a
      // two-column result is the measure" rule must no longer paper over
      // that absence.
      expect(
        gradeChartIntent(
          { mark: 'bar', x: 'segment', y: 'total_cost' },
          [{ mark: 'bar', x: 'segment', y: 'margin_pct' }],
          { resultColumns: ['segment', 'total_cost'] },
        ),
      ).toBe(false)
    })

    it('accepts a correct chart whose measure name is novel once a third column appears', () => {
      // heldout-superstore-sales-trend-by-year: the model adds a third
      // measure (`orders`) alongside the correct `order_year`/`total_sales`.
      // `order_year` is unreachable by name (`xAliases` only holds `year`)
      // and rule 2's suffix strip does not reach it, so this can only pass
      // via the actual result values matching the case's expected
      // dimension/measure values.
      expect(
        gradeChartIntent(
          { mark: 'bar', x: 'order_year', y: 'total_sales' },
          [
            { mark: 'line', x: 'yr', xAliases: ['year'], y: 'revenue' },
            { mark: 'bar', x: 'yr', xAliases: ['year'], y: 'revenue' },
          ],
          {
            resultColumns: ['order_year', 'total_sales', 'orders'],
            columnValues: {
              order_year: [2014, 2015, 2016, 2017],
              total_sales: [484247.5, 470532.51, 609205.6, 733215.26],
              orders: [482, 466, 602, 731],
            },
            roleValues: {
              dimension: [2014, 2015, 2016, 2017],
              measure: [484247.5, 470532.51, 609205.6, 733215.26],
            },
          },
        ),
      ).toBe(true)
    })

    it('still accepts find_top_n generic output columns', () => {
      expect(
        gradeChartIntent(
          { mark: 'bar', x: 'dimension_value', y: 'aggregate_value' },
          [{ mark: 'bar', x: 'sub_category', y: 'revenue' }],
          { resultColumns: ['dimension_value', 'aggregate_value'] },
        ),
      ).toBe(true)
    })

    it('still rejects a mark outside the accepted set', () => {
      expect(
        gradeChartIntent({ mark: 'kpi', x: 'segment', y: 'margin_pct' }, [{ mark: 'bar' }], {
          resultColumns: ['segment', 'margin_pct'],
          roleValues: { dimension: ['Consumer'], measure: [10] },
        }),
      ).toBe(false)
    })

    it('falls back to name matching when no result columns are supplied (older traces)', () => {
      // Unchanged behaviour: with no context at all, only the direct
      // name/alias path can accept or reject an axis.
      expect(
        gradeChartIntent({ mark: 'bar', x: 'segment', y: 'margin_pct' }, [
          { mark: 'bar', x: 'segment', y: 'margin_pct' },
        ]),
      ).toBe(true)
      expect(
        gradeChartIntent({ mark: 'bar', x: 'segment', y: 'total_cost' }, [
          { mark: 'bar', x: 'segment', y: 'margin_pct' },
        ]),
      ).toBe(false)
    })

    it('does not confirm a role when the column values do not actually match the expected role values', () => {
      // The column occupies the "right" slot by name, but its real values
      // are unrelated to the expected measure — value confirmation must
      // reject it, proving this is a genuine value check and not merely
      // "roleValues present => true".
      expect(
        gradeChartIntent(
          { mark: 'bar', x: 'segment', y: 'total_cost' },
          [{ mark: 'bar', x: 'segment', y: 'margin_pct' }],
          {
            resultColumns: ['segment', 'total_cost'],
            columnValues: { segment: ['Consumer'], total_cost: [999, 888] },
            roleValues: { dimension: ['Consumer'], measure: [10, 12] },
          },
        ),
      ).toBe(false)
    })
  })
})
