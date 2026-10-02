import { describe, expect, it } from 'vitest'
import { buildDefaultChartIntent, selectChartMark } from '../src/chart-mark.js'

describe('selectChartMark', () => {
  it('selects line when a temporal and a quantitative field are available', () => {
    expect(
      selectChartMark({
        question: 'sales over time',
        columns: [
          { name: 'revenue', logicalType: 'DECIMAL(18,2)' },
          { name: 'order_date', logicalType: 'DATE' },
        ],
        rowCount: 3,
        preview: [],
      }),
    ).toBe('line')
  })

  it.each([
    { name: 'year', logicalType: 'INTEGER' },
    { name: 'created_at', logicalType: 'TIMESTAMP WITH TIME ZONE' },
  ])('selects line for the temporal field $name', (temporalColumn) => {
    expect(
      selectChartMark({
        question: 'sales over time',
        columns: [temporalColumn, { name: 'revenue', logicalType: 'DOUBLE' }],
        rowCount: 3,
        preview: [],
      }),
    ).toBe('line')
  })

  it.each([
    'sales over time',
    'sales by month',
    'sales by year',
    'sales trend',
    'sales time series',
  ])('selects line for an aliased VARCHAR period when asked for %s', (question) => {
    expect(
      selectChartMark({
        question,
        columns: [
          { name: 'period', logicalType: 'VARCHAR' },
          { name: 'revenue', logicalType: 'DOUBLE' },
        ],
        rowCount: 3,
        preview: [
          ['2024-01', 10],
          ['2024-02', 20],
        ],
      }),
    ).toBe('line')
  })

  it.each([
    { name: 'order_month', logicalType: 'VARCHAR' },
    { name: 'fiscal_year', logicalType: 'INTEGER' },
  ])('selects line for the snake-case temporal field $name', (temporalColumn) => {
    expect(
      selectChartMark({
        question: 'sales trend',
        columns: [temporalColumn, { name: 'revenue', logicalType: 'DOUBLE' }],
        rowCount: 3,
        preview: [],
      }),
    ).toBe('line')
  })

  it('does not reinterpret a categorical field as time from the question alone', () => {
    expect(
      selectChartMark({
        question: 'sales over time',
        columns: [
          { name: 'region', logicalType: 'VARCHAR' },
          { name: 'revenue', logicalType: 'DOUBLE' },
        ],
        rowCount: 2,
        preview: [
          ['North', 10],
          ['South', 20],
        ],
      }),
    ).toBe('bar')
  })

  it('selects bar for one categorical and one quantitative field', () => {
    expect(
      selectChartMark({
        question: 'sales by region',
        columns: [
          { name: 'revenue', logicalType: 'DOUBLE' },
          { name: 'region', logicalType: 'VARCHAR' },
        ],
        rowCount: 3,
        preview: [],
      }),
    ).toBe('bar')
  })

  it('selects point for two quantitative fields', () => {
    expect(
      selectChartMark({
        question: 'compare revenue and profit',
        columns: [
          { name: 'revenue', logicalType: 'DECIMAL(18,2)' },
          { name: 'profit', logicalType: 'DOUBLE' },
        ],
        rowCount: 3,
        preview: [],
      }),
    ).toBe('point')
  })

  it('selects histogram for a one-field quantitative distribution', () => {
    expect(
      selectChartMark({
        question: 'show the distribution of amount',
        columns: [{ name: 'amount', logicalType: 'DECIMAL(18,2)' }],
        rowCount: 3,
        preview: [['10.25'], ['20.50'], ['35.00']],
      }),
    ).toBe('histogram')
  })

  it('selects boxplot for a quantitative distribution grouped by category', () => {
    expect(
      selectChartMark({
        question: 'show the amount distribution by region',
        columns: [
          { name: 'amount', logicalType: 'DECIMAL(18,2)' },
          { name: 'region', logicalType: 'VARCHAR' },
        ],
        rowCount: 3,
        preview: [],
      }),
    ).toBe('boxplot')
  })

  it('selects KPI for exactly one finite numeric scalar', () => {
    expect(
      selectChartMark({
        question: 'how many rows are there',
        columns: [{ name: 'row_count', logicalType: 'BIGINT' }],
        rowCount: 1,
        preview: [[3]],
      }),
    ).toBe('kpi')
  })

  it.each(['order_date_count', 'month_total', 'year_over_year_growth'])(
    'keeps the numeric metric %s eligible for KPI',
    (name) => {
      expect(
        selectChartMark({
          question: `show ${name}`,
          columns: [{ name, logicalType: 'BIGINT' }],
          rowCount: 1,
          preview: [[12]],
        }),
      ).toBe('kpi')
    },
  )

  it.each(['order_date_count', 'month_total', 'year_over_year_growth'])(
    'keeps the numeric metric %s quantitative in a two-measure result',
    (name) => {
      expect(
        selectChartMark({
          question: `${name} trend versus revenue`,
          columns: [
            { name, logicalType: 'BIGINT' },
            { name: 'revenue', logicalType: 'DOUBLE' },
          ],
          rowCount: 3,
          preview: [],
        }),
      ).toBe('point')
    },
  )

  it.each([
    { label: 'empty', rowCount: 0, preview: [] },
    { label: 'null', rowCount: 1, preview: [[null]] },
    { label: 'multiple rows', rowCount: 2, preview: [[1], [2]] },
  ])('selects table for a $label scalar result', ({ rowCount, preview }) => {
    expect(
      selectChartMark({
        question: 'show amount',
        columns: [{ name: 'amount', logicalType: 'DOUBLE' }],
        rowCount,
        preview,
      }),
    ).toBe('table')
  })

  it('selects table for unsupported or ambiguous result shapes', () => {
    expect(
      selectChartMark({
        question: 'show the result',
        columns: [
          { name: 'region', logicalType: 'VARCHAR' },
          { name: 'segment', logicalType: 'VARCHAR' },
        ],
        rowCount: 3,
        preview: [],
      }),
    ).toBe('table')
  })
})

describe('buildDefaultChartIntent', () => {
  it('assigns typed line roles without value sorting', () => {
    expect(
      buildDefaultChartIntent({
        title: 'Revenue over time',
        question: 'revenue over time',
        columns: [
          { name: 'revenue', logicalType: 'DOUBLE' },
          { name: 'year', logicalType: 'INTEGER' },
        ],
        rowCount: 3,
        preview: [],
      }),
    ).toEqual({ mark: 'line', title: 'Revenue over time', x: 'year', y: 'revenue' })
  })

  it('sorts only categorical bars by their numeric value', () => {
    expect(
      buildDefaultChartIntent({
        title: 'Revenue by region',
        question: 'revenue by region',
        columns: [
          { name: 'revenue', logicalType: 'DOUBLE' },
          { name: 'region', logicalType: 'VARCHAR' },
        ],
        rowCount: 3,
        preview: [],
      }),
    ).toEqual({
      mark: 'bar',
      title: 'Revenue by region',
      x: 'region',
      y: 'revenue',
      sort: { field: 'revenue', direction: 'descending' },
    })
  })

  it('assigns an aliased period to the line x role', () => {
    expect(
      buildDefaultChartIntent({
        title: 'Revenue over time',
        question: 'revenue over time',
        columns: [
          { name: 'revenue', logicalType: 'DOUBLE' },
          { name: 'period', logicalType: 'VARCHAR' },
        ],
        rowCount: 2,
        preview: [
          [10, '2024-01'],
          [20, '2024-02'],
        ],
      }),
    ).toEqual({ mark: 'line', title: 'Revenue over time', x: 'period', y: 'revenue' })
  })

  it('assigns the two quantitative fields to point x/y without sorting', () => {
    expect(
      buildDefaultChartIntent({
        title: 'Revenue and profit',
        question: 'compare revenue and profit',
        columns: [
          { name: 'revenue', logicalType: 'DECIMAL(18,2)' },
          { name: 'profit', logicalType: 'DOUBLE' },
        ],
        rowCount: 3,
        preview: [],
      }),
    ).toEqual({ mark: 'point', title: 'Revenue and profit', x: 'revenue', y: 'profit' })
  })

  it('keeps a date-named count in the point quantitative role', () => {
    expect(
      buildDefaultChartIntent({
        title: 'Date count and revenue',
        question: 'order date count trend versus revenue',
        columns: [
          { name: 'order_date_count', logicalType: 'BIGINT' },
          { name: 'revenue', logicalType: 'DOUBLE' },
        ],
        rowCount: 3,
        preview: [],
      }),
    ).toEqual({
      mark: 'point',
      title: 'Date count and revenue',
      x: 'order_date_count',
      y: 'revenue',
    })
  })

  it('assigns category x and quantitative y to a boxplot without sorting', () => {
    expect(
      buildDefaultChartIntent({
        title: 'Amount distribution by region',
        question: 'amount distribution by region',
        columns: [
          { name: 'amount', logicalType: 'DOUBLE' },
          { name: 'region', logicalType: 'VARCHAR' },
        ],
        rowCount: 3,
        preview: [],
      }),
    ).toEqual({
      mark: 'boxplot',
      title: 'Amount distribution by region',
      x: 'region',
      y: 'amount',
    })
  })

  it('assigns only the numeric x role to a histogram', () => {
    expect(
      buildDefaultChartIntent({
        title: 'Amount distribution',
        question: 'amount distribution',
        columns: [{ name: 'amount', logicalType: 'DECIMAL(18,2)' }],
        rowCount: 3,
        preview: [['10.25']],
      }),
    ).toEqual({ mark: 'histogram', title: 'Amount distribution', x: 'amount' })
  })

  it('assigns only the numeric y role to a KPI', () => {
    expect(
      buildDefaultChartIntent({
        title: 'Row count',
        question: 'row count',
        columns: [{ name: 'row_count', logicalType: 'BIGINT' }],
        rowCount: 1,
        preview: [[3]],
      }),
    ).toEqual({ mark: 'kpi', title: 'Row count', y: 'row_count' })
  })

  it('does not assign axes to a table', () => {
    expect(
      buildDefaultChartIntent({
        title: 'Null total',
        question: 'show total',
        columns: [{ name: 'total', logicalType: 'DOUBLE' }],
        rowCount: 1,
        preview: [[null]],
      }),
    ).toEqual({ mark: 'table', title: 'Null total' })
  })
})
