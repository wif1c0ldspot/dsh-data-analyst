import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { detectCurrencyDimensions, MAX_DISTINCT_TO_SCAN } from '../src/currency-detection.js'

let directory: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-currency-detection-'))
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function connect() {
  const database = await DuckDBInstance.create(':memory:')
  return database.connect()
}

it('flags a VARCHAR column mixing 2+ recognized ISO-4217 codes', async () => {
  const connection = await connect()
  try {
    await connection.run(`
      CREATE TABLE orders (order_id BIGINT, currency VARCHAR, amount DOUBLE);
      INSERT INTO orders VALUES (1, 'USD', 10), (2, 'GBP', 20), (3, 'EUR', 30), (4, 'USD', 40);
    `)
    const result = await detectCurrencyDimensions(connection, 'orders', [
      { name: 'order_id', type: 'BIGINT' },
      { name: 'currency', type: 'VARCHAR' },
      { name: 'amount', type: 'DOUBLE' },
    ])
    expect(result).toEqual([{ column: 'currency', currencies: ['EUR', 'GBP', 'USD'] }])
  } finally {
    connection.closeSync()
  }
})

it('does not flag a single-currency column', async () => {
  const connection = await connect()
  try {
    await connection.run(`
      CREATE TABLE orders (currency VARCHAR);
      INSERT INTO orders VALUES ('USD'), ('USD'), ('USD');
    `)
    const result = await detectCurrencyDimensions(connection, 'orders', [
      { name: 'currency', type: 'VARCHAR' },
    ])
    expect(result).toEqual([])
  } finally {
    connection.closeSync()
  }
})

it('does not flag a column with any non-code value, even if most values are codes', async () => {
  const connection = await connect()
  try {
    await connection.run(`
      CREATE TABLE orders (currency VARCHAR);
      INSERT INTO orders VALUES ('USD'), ('GBP'), ('Unknown');
    `)
    const result = await detectCurrencyDimensions(connection, 'orders', [
      { name: 'currency', type: 'VARCHAR' },
    ])
    expect(result).toEqual([])
  } finally {
    connection.closeSync()
  }
})

it('does not flag a non-string column even if its type name loosely resembles a string', async () => {
  const connection = await connect()
  try {
    await connection.run(`
      CREATE TABLE orders (amount DOUBLE);
      INSERT INTO orders VALUES (1), (2);
    `)
    const result = await detectCurrencyDimensions(connection, 'orders', [
      { name: 'amount', type: 'DOUBLE' },
    ])
    expect(result).toEqual([])
  } finally {
    connection.closeSync()
  }
})

it('skips a column with more distinct values than the scan cap, rather than guessing from a sample', async () => {
  const connection = await connect()
  try {
    const rows = Array.from({ length: MAX_DISTINCT_TO_SCAN + 1 }, (_, i) => `('code_${i}')`).join(
      ', ',
    )
    await connection.run(`
      CREATE TABLE wide (label VARCHAR);
      INSERT INTO wide VALUES ${rows};
    `)
    const result = await detectCurrencyDimensions(connection, 'wide', [
      { name: 'label', type: 'VARCHAR' },
    ])
    expect(result).toEqual([])
  } finally {
    connection.closeSync()
  }
})

it('ignores NULLs and is case-insensitive', async () => {
  const connection = await connect()
  try {
    await connection.run(`
      CREATE TABLE orders (currency VARCHAR);
      INSERT INTO orders VALUES ('usd'), ('gbp'), (NULL);
    `)
    const result = await detectCurrencyDimensions(connection, 'orders', [
      { name: 'currency', type: 'VARCHAR' },
    ])
    expect(result).toEqual([{ column: 'currency', currencies: ['GBP', 'USD'] }])
  } finally {
    connection.closeSync()
  }
})
