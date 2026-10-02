import { DuckDBInstance } from '@duckdb/node-api'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { profileColumnStats, profileRelationships } from '../src/profiler.js'

let instance: InstanceType<typeof DuckDBInstance>

beforeEach(async () => {
  instance = await DuckDBInstance.create(':memory:')
})

afterEach(() => {
  instance.closeSync()
})

it('profiles column stats and proposes key/relationship evidence from typed tables', async () => {
  const connection = await instance.connect()
  try {
    await connection.run(`
      CREATE TABLE orders (
        order_id BIGINT, customer_id BIGINT, status VARCHAR
      );
      INSERT INTO orders VALUES (1, 10, 'delivered'), (2, 20, 'shipped'), (3, 10, 'delivered');

      CREATE TABLE order_items (
        order_item_id BIGINT, order_id BIGINT, price DECIMAL(18,2)
      );
      INSERT INTO order_items VALUES
        (100, 1, 10.00), (101, 1, 20.00), (102, 2, 5.00), (103, 3, NULL);
    `)

    const orders = await profileColumnStats(connection, 'orders', [
      { name: 'order_id', type: 'BIGINT' },
      { name: 'customer_id', type: 'BIGINT' },
    ])
    expect(orders.find((c) => c.name === 'order_id')).toMatchObject({
      rowCount: 3,
      nullCount: 0,
      distinctCount: 3,
    })
    expect(orders.find((c) => c.name === 'customer_id')).toMatchObject({
      rowCount: 3,
      nullCount: 0,
      distinctCount: 2,
    })

    const relationships = await profileRelationships(connection, [
      {
        tableId: 'orders',
        columns: [
          { name: 'order_id', type: 'BIGINT' },
          { name: 'customer_id', type: 'BIGINT' },
        ],
      },
      {
        tableId: 'order_items',
        columns: [
          { name: 'order_item_id', type: 'BIGINT' },
          { name: 'order_id', type: 'BIGINT' },
        ],
      },
    ])

    expect(relationships).toHaveLength(1)
    expect(relationships[0]).toMatchObject({
      fromTable: 'orders',
      toTable: 'order_items',
      fromColumn: 'order_id',
      toColumn: 'order_id',
      cardinality: '1:n', // one order → many items
    })
    expect(relationships[0]?.maxFromTo).toBe(2)
    expect(relationships[0]?.maxToFrom).toBe(1)
    expect(relationships[0]?.matchedFrom).toBe(3)
  } finally {
    connection.closeSync()
  }
})
