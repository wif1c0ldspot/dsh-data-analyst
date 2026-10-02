/**
 * Reviewed table grains and relationships (P1). Data-only definitions —
 * not a join framework. Cardinalities are analyst-reviewed for metric planning.
 * Approved SQLite structure-candidate overlays (from deterministic ingest
 * profiling) extend these in-code fixtures for generic datasets.
 */
import type { GrainCandidate, RelationshipCandidate } from './contracts.js'

export interface TableGrain {
  datasetId: string
  tableId: string
  grainDescription: string
  primaryKey: string[]
}

export interface TableRelationship {
  datasetId: string
  fromTable: string
  toTable: string
  fromColumns: string[]
  toColumns: string[]
  cardinality: '1:1' | '1:n' | 'n:1' | 'n:n'
}

export const TABLE_GRAINS: readonly TableGrain[] = [
  {
    datasetId: 'retail-fixture',
    tableId: 'retail',
    grainDescription: 'One row per retail line item',
    primaryKey: ['line_id'],
  },
  {
    datasetId: 'olist-mini',
    tableId: 'orders',
    grainDescription: 'One row per order',
    primaryKey: ['order_id'],
  },
  {
    datasetId: 'olist-mini',
    tableId: 'order_items',
    grainDescription: 'One row per order line item (globally unique order_item_id in this fixture)',
    primaryKey: ['order_item_id'],
  },
  {
    datasetId: 'olist-mini',
    tableId: 'customers',
    grainDescription: 'One row per customer_id used on orders',
    primaryKey: ['customer_id'],
  },
  {
    datasetId: 'olist-mini',
    tableId: 'order_payments',
    grainDescription: 'One row per payment installment sequence on an order',
    primaryKey: ['order_id', 'payment_sequential'],
  },
  // Stubs for full source datasets (known PKs; recipes may expose more tables).
  {
    datasetId: 'olist',
    tableId: 'orders',
    grainDescription: 'One row per order (full Olist)',
    primaryKey: ['order_id'],
  },
  {
    datasetId: 'olist',
    tableId: 'order_items',
    grainDescription: 'One row per (order_id, order_item_id) line',
    primaryKey: ['order_id', 'order_item_id'],
  },
  {
    datasetId: 'olist',
    tableId: 'customers',
    grainDescription: 'One row per customer_id',
    primaryKey: ['customer_id'],
  },
  {
    datasetId: 'superstore',
    tableId: 'orders',
    grainDescription: 'One row per Superstore line (Row ID)',
    primaryKey: ['row_id'],
  },
  {
    datasetId: 'online-retail',
    tableId: 'online_retail',
    grainDescription:
      'One row per source CSV record; source_row_index preserves the source row identity',
    primaryKey: ['source_row_index'],
  },
]

export const TABLE_RELATIONSHIPS: readonly TableRelationship[] = [
  {
    datasetId: 'olist-mini',
    fromTable: 'orders',
    toTable: 'customers',
    fromColumns: ['customer_id'],
    toColumns: ['customer_id'],
    cardinality: 'n:1',
  },
  {
    datasetId: 'olist-mini',
    fromTable: 'order_items',
    toTable: 'orders',
    fromColumns: ['order_id'],
    toColumns: ['order_id'],
    cardinality: 'n:1',
  },
  {
    datasetId: 'olist-mini',
    fromTable: 'order_payments',
    toTable: 'orders',
    fromColumns: ['order_id'],
    toColumns: ['order_id'],
    cardinality: 'n:1',
  },
  {
    datasetId: 'olist',
    fromTable: 'orders',
    toTable: 'customers',
    fromColumns: ['customer_id'],
    toColumns: ['customer_id'],
    cardinality: 'n:1',
  },
  {
    datasetId: 'olist',
    fromTable: 'order_items',
    toTable: 'orders',
    fromColumns: ['order_id'],
    toColumns: ['order_id'],
    cardinality: 'n:1',
  },
  {
    datasetId: 'olist',
    fromTable: 'order_payments',
    toTable: 'orders',
    fromColumns: ['order_id'],
    toColumns: ['order_id'],
    cardinality: 'n:1',
  },
]

export function grainsForDataset(datasetId: string): readonly TableGrain[] {
  return TABLE_GRAINS.filter((grain) => grain.datasetId === datasetId)
}

export function relationshipsForDataset(datasetId: string): readonly TableRelationship[] {
  return TABLE_RELATIONSHIPS.filter((rel) => rel.datasetId === datasetId)
}

/** Catalog surface needed to overlay approved grain/relationship candidates. */
export interface StructureCatalog {
  listStructureCandidates(
    datasetId?: string,
    status?: 'candidate' | 'approved' | 'revoked',
  ): ReadonlyArray<GrainCandidate | RelationshipCandidate>
}

/** Effective grains: approved overlays (newest-first) win over in-code fixtures. */
export function getEffectiveGrains(
  datasetId: string,
  store?: StructureCatalog,
): readonly TableGrain[] {
  const base = grainsForDataset(datasetId)
  if (!store) return base
  const overlay = store
    .listStructureCandidates(datasetId, 'approved')
    .filter((candidate): candidate is GrainCandidate => 'tableId' in candidate)
    .map((candidate): TableGrain => ({
      datasetId: candidate.datasetId,
      tableId: candidate.tableId,
      grainDescription: candidate.grainDescription,
      primaryKey: [...candidate.primaryKey],
    }))

  const byTable = new Map<string, TableGrain>()
  for (const grain of overlay) if (!byTable.has(grain.tableId)) byTable.set(grain.tableId, grain)
  for (const grain of base) if (!byTable.has(grain.tableId)) byTable.set(grain.tableId, grain)
  return [...byTable.values()]
}

/** Effective relationships: approved overlays (newest-first) win over in-code fixtures. */
export function getEffectiveRelationships(
  datasetId: string,
  store?: StructureCatalog,
): readonly TableRelationship[] {
  const base = relationshipsForDataset(datasetId)
  if (!store) return base
  const overlay = store
    .listStructureCandidates(datasetId, 'approved')
    .filter((candidate): candidate is RelationshipCandidate => 'fromTable' in candidate)
    .map((candidate): TableRelationship => ({
      datasetId: candidate.datasetId,
      fromTable: candidate.fromTable,
      toTable: candidate.toTable,
      fromColumns: [...candidate.fromColumns],
      toColumns: [...candidate.toColumns],
      cardinality: candidate.cardinality,
    }))

  const byKey = new Map<string, TableRelationship>()
  for (const rel of overlay) {
    const key = `${rel.fromTable}\0${rel.toTable}`
    if (!byKey.has(key)) byKey.set(key, rel)
  }
  for (const rel of base) {
    const key = `${rel.fromTable}\0${rel.toTable}`
    if (!byKey.has(key)) byKey.set(key, rel)
  }
  return [...byKey.values()]
}
