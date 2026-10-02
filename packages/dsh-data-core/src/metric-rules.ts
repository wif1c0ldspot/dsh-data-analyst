/**
 * Reviewed date/currency notes for metric planning (P1). Data only —
 * not a rules engine. Consumers read these alongside grains/semantics.
 */

export type MetricRuleKind = 'currency' | 'date' | 'signed_quantity'

export interface MetricRuleNote {
  datasetId: string
  tableId: string
  column: string
  kind: MetricRuleKind
  note: string
}

export const METRIC_RULE_NOTES: readonly MetricRuleNote[] = [
  {
    datasetId: 'retail-fixture',
    tableId: 'retail',
    column: 'amount',
    kind: 'currency',
    note: 'DECIMAL currency amount per line; may be negative for adjustments',
  },
  {
    datasetId: 'retail-fixture',
    tableId: 'retail',
    column: 'order_date',
    kind: 'date',
    note: 'DATE grain for order timing (ISO calendar day)',
  },
  {
    datasetId: 'online-retail',
    tableId: 'online_retail',
    column: 'quantity',
    kind: 'signed_quantity',
    note: 'quantity * price can be negative when quantity is negative (returns)',
  },
  {
    datasetId: 'online-retail',
    tableId: 'online_retail',
    column: 'price',
    kind: 'currency',
    note: 'Unit price; line revenue is quantity * price including returns',
  },
  {
    datasetId: 'olist-mini',
    tableId: 'order_items',
    column: 'price',
    kind: 'currency',
    note: 'DECIMAL item price (excludes freight_value)',
  },
  {
    datasetId: 'olist-mini',
    tableId: 'orders',
    column: 'order_purchase_timestamp',
    kind: 'date',
    note: 'TIMESTAMP purchase time; delivery dates may be NULL',
  },
  {
    datasetId: 'superstore',
    tableId: 'orders',
    column: 'sales',
    kind: 'currency',
    note: 'DECIMAL(18,4) gross sales amount per line (Sales column)',
  },
  {
    datasetId: 'superstore',
    tableId: 'orders',
    column: 'order_date',
    kind: 'date',
    note: 'DATE order timing (Order Date); ship_date may trail by several days',
  },
]

export function metricRulesForDataset(datasetId: string): readonly MetricRuleNote[] {
  return METRIC_RULE_NOTES.filter((rule) => rule.datasetId === datasetId)
}
