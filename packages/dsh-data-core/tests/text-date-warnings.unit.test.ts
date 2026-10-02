import { describe, expect, it } from 'vitest'
import { textDateWarningsForStatement } from '../src/currency-warnings.js'

/**
 * Node shapes exactly as `json_serialize_sql` emits them (verified against DuckDB
 * directly). The point of these pins is the *shape*: two reads that silently answer
 * lexicographically on a text-held date were missed because their node class does not
 * look like the shape the collector scanned for.
 */
const textDateColumns = [{ tableId: 'superstore', column: 'order_date', approvedType: 'DATE' }]
const selectNode = (where: unknown, selectList: unknown[] = []) => ({
  type: 'SELECT_NODE',
  select_list: selectList,
  from_table: { type: 'BASE_TABLE', table_name: 'superstore' },
  where_clause: where,
  modifiers: [],
})
const columnRef = (name: string) => ({
  class: 'COLUMN_REF',
  type: 'COLUMN_REF',
  column_names: [name],
})

describe('textDateWarningsForStatement', () => {
  it('warns for a plain range comparison', () => {
    const node = selectNode({
      class: 'COMPARISON',
      type: 'COMPARE_LESSTHAN',
      left: columnRef('order_date'),
      right: columnRef('shipped_at'),
    })
    expect(textDateWarningsForStatement(node, textDateColumns)).toHaveLength(1)
  })

  it('warns for BETWEEN, whose node carries input/lower/upper rather than left/right', () => {
    // Measured on a published text date: `order_date BETWEEN …` answered 3,773 rows
    // with no warning while COMPARE_BETWEEN sat in the ordering-comparison set, because
    // the operand scan only ever looked at `left`/`right`.
    const node = selectNode({
      class: 'BETWEEN',
      type: 'COMPARE_BETWEEN',
      input: columnRef('order_date'),
      lower: { class: 'CAST', type: 'OPERATOR_CAST', child: { class: 'CONSTANT' } },
      upper: { class: 'CAST', type: 'OPERATOR_CAST', child: { class: 'CONSTANT' } },
    })
    expect(textDateWarningsForStatement(node, textDateColumns)).toHaveLength(1)
  })

  it('warns when a BETWEEN bound is itself the text column, or wrapped in a cast', () => {
    const asBound = selectNode({
      class: 'BETWEEN',
      type: 'COMPARE_BETWEEN',
      input: columnRef('shipped_at'),
      lower: columnRef('order_date'),
      upper: { class: 'CONSTANT' },
    })
    expect(textDateWarningsForStatement(asBound, textDateColumns)).toHaveLength(1)

    const castInput = selectNode({
      class: 'BETWEEN',
      type: 'COMPARE_BETWEEN',
      input: { class: 'CAST', type: 'OPERATOR_CAST', child: columnRef('order_date') },
      lower: { class: 'CONSTANT' },
      upper: { class: 'CONSTANT' },
    })
    expect(textDateWarningsForStatement(castInput, textDateColumns)).toHaveLength(1)
  })

  it('warns for MIN/MAX as an aggregate and as a window function', () => {
    const aggregate = selectNode(null, [
      {
        class: 'FUNCTION',
        type: 'FUNCTION',
        function_name: 'max',
        children: [columnRef('order_date')],
      },
    ])
    expect(textDateWarningsForStatement(aggregate, textDateColumns)).toHaveLength(1)

    // `max(x) OVER ()` serializes as class WINDOW / type WINDOW_AGGREGATE, which the
    // FUNCTION-only branch never saw.
    const window = selectNode(null, [
      {
        class: 'WINDOW',
        type: 'WINDOW_AGGREGATE',
        function_name: 'max',
        children: [columnRef('order_date')],
      },
    ])
    expect(textDateWarningsForStatement(window, textDateColumns)).toHaveLength(1)
  })

  it('leaves an ORDER BY alias or position unwarned — a documented limit, not a claim of safety', () => {
    // Resolving these back to the column needs the select list, which the ORDER_MODIFIER
    // does not carry. The sql-safety skill states this limit for the model.
    for (const expression of [
      columnRef('d'),
      { class: 'CONSTANT', type: 'VALUE_CONSTANT', value: { type: { id: 'INTEGER' }, value: 1 } },
    ]) {
      const node = {
        ...selectNode(null),
        modifiers: [{ type: 'ORDER_MODIFIER', orders: [{ type: 'ORDER_DEFAULT', expression }] }],
      }
      expect(textDateWarningsForStatement(node, textDateColumns)).toEqual([])
    }
  })
})
