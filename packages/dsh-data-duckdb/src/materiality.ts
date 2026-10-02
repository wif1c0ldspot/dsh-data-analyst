/**
 * Materiality thresholds for adaptive (raw_then_typed) ingest confirm.
 * Tunable constants match packages/dsh-data-duckdb/tests/materiality.unit.test.ts.
 *
 * Signals:
 * - Cast-induced nulls (share / absolute / column count)
 * - Type-widen pressure: approved numeric/date columns that fail casts enough to
 *   imply a VARCHAR widen (projection still keeps pin types; confirm discloses)
 */
import type { DatasetManifest } from 'dsh-data-core/contracts'

/** Per-column cast-null share that triggers confirm. */
export const MATERIAL_CAST_NULL_COLUMN_PCT = 1
/** Absolute cast-null cells (any columns) that trigger confirm. */
export const MATERIAL_CAST_NULL_CELLS_TOTAL = 1_000
/** Columns with any cast-null that together trigger confirm. */
export const MATERIAL_CAST_NULL_COLUMN_COUNT = 3
/** Semantic (numeric/date) columns with material cast failure → type-widen signal. */
export const MATERIAL_TYPE_WIDEN_SEMANTIC_COLUMNS = 1
/** Any typed columns with cast failure that together trigger type-widen signal. */
export const MATERIAL_TYPE_WIDEN_COLUMN_COUNT = 3

const SEMANTIC_TYPES = /^(BIGINT|INTEGER|HUGEINT|DOUBLE|FLOAT|DECIMAL|DATE|TIMESTAMP|TIMESTAMP_NS)/i

export interface PinColumnType {
  tableId: string
  name: string
  type: string
}

/** Bounded number of named re-proposals carried with a decision. */
export const MAX_TYPE_REPROPOSALS = 12

/**
 * A column whose approved type does not fit the values actually loaded: the typed
 * projection had to cast at least one of them to NULL. Carries the column and the
 * type that would have accepted the values, so the analyst and the model do not
 * have to reconstruct that from a cast-null count. VARCHAR is the no-data-loss
 * target; keeping the type, accepting NULLs or fixing the source remain the
 * analyst's calls.
 */
export interface ColumnTypeReproposal {
  tableId: string
  column: string
  /** The type the analyst approved, when the pin recorded one. */
  approvedType?: string
  /** Type that would have accepted every sampled value. */
  proposedType: string
  castNullCells: number
  /** Share of the row basis that failed the cast, 0-1. */
  castNullShare: number
  /** True when this column met the materiality threshold on its own. */
  material: boolean
}

export interface MaterialityDecision {
  material: boolean
  reasons: string[]
  totalCastNullCells: number
  columnsWithCastNulls: number
  typeWidenColumns: number
  /** Named, ranked re-proposals — always present, empty when nothing was cast to NULL. */
  reproposals: ColumnTypeReproposal[]
}

function isSemanticType(type: string): boolean {
  return SEMANTIC_TYPES.test(type.trim())
}

function isWidenableApprovedType(type: string): boolean {
  const t = type.trim().toUpperCase()
  return t !== 'VARCHAR' && t !== 'TEXT' && t !== 'STRING' && t.length > 0
}

export function evaluateMateriality(
  tables: DatasetManifest['tables'],
  pinColumns: readonly PinColumnType[] = [],
): MaterialityDecision {
  let totalCastNullCells = 0
  let columnsWithCastNulls = 0
  let typeWidenColumns = 0
  let typeWidenSemantic = 0
  const reasons: string[] = []
  const reproposals: ColumnTypeReproposal[] = []
  const pinByTableCol = new Map(
    pinColumns.map((column) => [`${column.tableId}\0${column.name}`.toLowerCase(), column]),
  )

  for (const table of tables) {
    const counts = table.castNullCounts ?? {}
    const rowBasis = table.rawRowCount ?? table.projectionRowCount ?? table.rows
    for (const [column, count] of Object.entries(counts)) {
      if (!Number.isFinite(count) || count <= 0) continue
      columnsWithCastNulls += 1
      totalCastNullCells += count
      const pct = rowBasis > 0 ? (count / rowBasis) * 100 : 0
      if (pct >= MATERIAL_CAST_NULL_COLUMN_PCT || count >= MATERIAL_CAST_NULL_CELLS_TOTAL) {
        reasons.push(
          `${table.id}.${column}: ${count} cast-null cell(s) (${pct.toFixed(2)}% of ${rowBasis} rows)`,
        )
      }

      const materialColumn =
        pct >= MATERIAL_CAST_NULL_COLUMN_PCT || count >= MATERIAL_CAST_NULL_CELLS_TOTAL
      const pin = pinByTableCol.get(`${table.id}\0${column}`.toLowerCase())
      reproposals.push({
        tableId: table.id,
        column,
        ...(pin ? { approvedType: pin.type } : {}),
        proposedType: 'VARCHAR',
        castNullCells: count,
        castNullShare: rowBasis > 0 ? Number((count / rowBasis).toFixed(6)) : 0,
        material: materialColumn,
      })
      if (pin && isWidenableApprovedType(pin.type)) {
        typeWidenColumns += 1
        const materialWiden =
          pct >= MATERIAL_CAST_NULL_COLUMN_PCT || count >= MATERIAL_CAST_NULL_CELLS_TOTAL
        if (materialWiden && isSemanticType(pin.type)) {
          typeWidenSemantic += 1
          reasons.push(
            `type-widen ${table.id}.${column}: approved ${pin.type} → VARCHAR (cast failures)`,
          )
        } else if (materialWiden) {
          reasons.push(
            `type-widen ${table.id}.${column}: approved ${pin.type} → VARCHAR (cast failures)`,
          )
        }
      }
    }
  }

  if (totalCastNullCells >= MATERIAL_CAST_NULL_CELLS_TOTAL) {
    reasons.push(`overall cast-null cells: ${totalCastNullCells}`)
  }
  if (columnsWithCastNulls >= MATERIAL_CAST_NULL_COLUMN_COUNT) {
    reasons.push(`${columnsWithCastNulls} columns have cast-null cells`)
  }
  if (typeWidenSemantic >= MATERIAL_TYPE_WIDEN_SEMANTIC_COLUMNS) {
    reasons.push(`${typeWidenSemantic} semantic column(s) pressure type-widen to VARCHAR`)
  }
  if (typeWidenColumns >= MATERIAL_TYPE_WIDEN_COLUMN_COUNT) {
    reasons.push(`${typeWidenColumns} columns pressure type-widen to VARCHAR`)
  }

  const uniqueReasons = [...new Set(reasons)]
  // Worst first: the column most likely to hold a real data-quality problem leads.
  const ranked = [...reproposals].sort(
    (left, right) =>
      right.castNullShare - left.castNullShare || left.column.localeCompare(right.column),
  )
  return {
    material: uniqueReasons.length > 0,
    reasons: uniqueReasons,
    totalCastNullCells,
    columnsWithCastNulls,
    typeWidenColumns,
    reproposals: ranked.slice(0, MAX_TYPE_REPROPOSALS),
  }
}
