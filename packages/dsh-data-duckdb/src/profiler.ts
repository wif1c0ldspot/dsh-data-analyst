/**
 * Deterministic ingest-time structure profiling (P1, continuing the adaptive
 * ingest design). Proposes PRIMARY-KEY and JOIN-MULTIPLICITY candidates from
 * the typed projection tables — never model-authored ETL, and never persisted
 * as reviewed definitions until an analyst approves the resulting candidate.
 * The evidence (uniqueness / null share / fan-out) rides the candidate row so
 * the analyst can judge the inference instead of trusting it.
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import { quoteIdentifier } from './staging-loader.js'

export interface ColumnProfile {
  name: string
  type: string
  rowCount: number
  nullCount: number
  distinctCount: number
}

export interface KeyCandidate {
  columns: string[]
  /** distinct / rows. */
  uniqueness: number
  /** null / rows. */
  nullRatio: number
  reason: string
}

export interface RelationshipProfile {
  fromTable: string
  toTable: string
  fromColumn: string
  toColumn: string
  fromDistinct: number
  toDistinct: number
  matchedFrom: number
  matchedTo: number
  maxFromTo: number
  maxToFrom: number
  cardinality: '1:1' | '1:n' | 'n:1' | 'n:n'
  reason: string
}

export interface ProfiledTable {
  tableId: string
  columns: readonly { name: string; type: string }[]
}

/** Single-column primary keys: full uniqueness and zero NULLs. */
export function proposeKeyCandidates(columns: readonly ColumnProfile[]): KeyCandidate[] {
  return columns
    .filter(
      (column) =>
        column.rowCount > 0 && column.nullCount === 0 && column.distinctCount === column.rowCount,
    )
    .map((column) => ({
      columns: [column.name],
      uniqueness: 1,
      nullRatio: 0,
      reason: `unique over ${column.rowCount} rows with no NULLs`,
    }))
}

/** Map join fan-out to a reviewed cardinality (`from` → `to`). */
export function inferCardinality(
  maxFromTo: number,
  maxToFrom: number,
): '1:1' | '1:n' | 'n:1' | 'n:n' {
  const fromToMany = maxFromTo > 1
  const toFromMany = maxToFrom > 1
  if (fromToMany && toFromMany) return 'n:n'
  if (fromToMany) return '1:n' // each from row → many to rows
  if (toFromMany) return 'n:1' // many from rows → each to row
  return '1:1'
}

/** One scan: row count, non-null count, and distinct count per column. */
export async function profileColumnStats(
  connection: DuckDBConnection,
  tableId: string,
  columns: readonly { name: string; type: string }[],
): Promise<ColumnProfile[]> {
  const tableRef = quoteIdentifier(tableId)
  const rowCountReader = await connection.runAndReadAll(`SELECT COUNT(*) FROM ${tableRef}`)
  const rowCount = Number(rowCountReader.getRowsJson()[0]?.[0] ?? 0)
  if (rowCount === 0) {
    return columns.map((column) => ({
      name: column.name,
      type: column.type,
      rowCount: 0,
      nullCount: 0,
      distinctCount: 0,
    }))
  }
  const selectParts = columns
    .map((column, index) => {
      const ref = quoteIdentifier(column.name)
      return `COUNT(${ref}) AS n${index}, COUNT(DISTINCT ${ref}) AS d${index}`
    })
    .join(', ')
  const reader = await connection.runAndReadAll(`SELECT ${selectParts} FROM ${tableRef}`)
  const row = reader.getRowsJson()[0] ?? []
  return columns.map((column, index) => {
    const nonNull = Number(row[index * 2] ?? 0)
    const distinct = Number(row[index * 2 + 1] ?? 0)
    return {
      name: column.name,
      type: column.type,
      rowCount,
      nullCount: rowCount - nonNull,
      distinctCount: distinct,
    }
  })
}

async function profileJoin(
  connection: DuckDBConnection,
  fromTable: string,
  toTable: string,
  column: string,
): Promise<RelationshipProfile> {
  const a = quoteIdentifier(fromTable)
  const b = quoteIdentifier(toTable)
  const col = quoteIdentifier(column)

  const statsReader = await connection.runAndReadAll(`
    SELECT
      (SELECT COUNT(DISTINCT ${col}) FROM ${a}) AS from_distinct,
      (SELECT COUNT(DISTINCT ${col}) FROM ${b}) AS to_distinct,
      (SELECT COUNT(DISTINCT x.${col}) FROM ${a} x JOIN ${b} y ON x.${col} = y.${col}) AS matched_from,
      (SELECT COUNT(DISTINCT y.${col}) FROM ${a} x JOIN ${b} y ON x.${col} = y.${col}) AS matched_to
  `)
  const stats = statsReader.getRowObjectsJson()[0] ?? {}
  const fromDistinct = Number(stats.from_distinct ?? 0)
  const toDistinct = Number(stats.to_distinct ?? 0)
  const matchedFrom = Number(stats.matched_from ?? 0)
  const matchedTo = Number(stats.matched_to ?? 0)

  // Per-row fan-out: max number of DISTINCT to-rows matched by one from-row.
  const fromToReader = await connection.runAndReadAll(`
    SELECT MAX(cnt) FROM (
      SELECT COUNT(DISTINCT y.rowid) AS cnt
      FROM ${a} x LEFT JOIN ${b} y ON x.${col} = y.${col}
      GROUP BY x.rowid
    )
  `)
  const maxFromTo = Number(fromToReader.getRowsJson()[0]?.[0] ?? 0)

  // Per-row fan-out: max number of DISTINCT from-rows matched by one to-row.
  const toFromReader = await connection.runAndReadAll(`
    SELECT MAX(cnt) FROM (
      SELECT COUNT(DISTINCT x.rowid) AS cnt
      FROM ${b} y LEFT JOIN ${a} x ON y.${col} = x.${col}
      GROUP BY y.rowid
    )
  `)
  const maxToFrom = Number(toFromReader.getRowsJson()[0]?.[0] ?? 0)

  const cardinality = inferCardinality(maxFromTo, maxToFrom)
  return {
    fromTable,
    toTable,
    fromColumn: column,
    toColumn: column,
    fromDistinct,
    toDistinct,
    matchedFrom,
    matchedTo,
    maxFromTo,
    maxToFrom,
    cardinality,
    reason: `${fromTable}.${column} → ${toTable}.${column}: ${cardinality}`,
  }
}

/**
 * Propose relationship candidates for same-named columns across table pairs.
 * Only pairs with any join overlap (`matchedFrom > 0`) are proposed; fan-out
 * evidence always rides along for analyst review.
 */
export async function profileRelationships(
  connection: DuckDBConnection,
  tables: readonly ProfiledTable[],
): Promise<RelationshipProfile[]> {
  const results: RelationshipProfile[] = []
  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const a = tables[i]!
      const b = tables[j]!
      const common = a.columns.filter((column) =>
        b.columns.some((other) => other.name === column.name),
      )
      for (const column of common) {
        const profile = await profileJoin(connection, a.tableId, b.tableId, column.name)
        if (profile.matchedFrom > 0) results.push(profile)
      }
    }
  }
  return results
}
