/**
 * `investigate_metric` must require `datasetId`
 * and treat bound `parameters` as optional — not copy `duckdb_query`'s shape.
 *
 * Cheap-minor follow-up: assert the actual registered schema object
 * (`investigateMetricParameters`, exported from `plugin-tools.ts` and used
 * verbatim in the tool's `defineTool({ parameters: ... })` call) instead of
 * grepping/parsing this file's source text with a loose regex.
 */
import { expect, it } from 'vitest'
import { investigateMetricParameters } from '../src/plugin-tools.js'

it('registers investigate_metric with datasetId/sqlCurrent/sqlBaseline required and optional parameters', () => {
  expect(investigateMetricParameters.datasetId.type).toBe('string')
  expect(investigateMetricParameters.datasetId.required).toBe(true)
  expect(investigateMetricParameters.sqlCurrent.type).toBe('string')
  expect(investigateMetricParameters.sqlCurrent.required).toBe(true)
  expect(investigateMetricParameters.sqlBaseline.type).toBe('string')
  expect(investigateMetricParameters.sqlBaseline.required).toBe(true)

  expect(investigateMetricParameters.parameters.type).toBe('array')
  expect(investigateMetricParameters.parameters).not.toHaveProperty('required')

  const items = investigateMetricParameters.parameters.items
  expect(items.type).toBe('object')
  expect(items.additionalProperties).toBe(false)
  expect(items.properties.logicalType).toEqual({ type: 'string', required: true })
  expect(items.properties.value).toEqual({ type: 'json', required: true })
})
