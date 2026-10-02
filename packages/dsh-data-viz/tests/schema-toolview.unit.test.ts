import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const packageDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

/**
 * A canned `get_schema` observation shaped exactly like
 * `renderObserve('schema', ...)` in `dsh-data-core/src/tool-observe.ts`:
 * `<<observe kind=schema>>\n{...}\n<</observe>>`. Covers every field the
 * review asked `SchemaToolRow` to surface: grain + primary key, column
 * name + type, relationship from/to tables + join columns, an approved
 * alias, and a reviewed metric rule.
 */
const SCHEMA_PAYLOAD = {
  datasetId: 'superstore',
  datasetVersionId: 'superstore-v1',
  semanticRevisionId: 'sem-superstore-v1',
  tables: [
    {
      id: 'orders',
      rows: 9994,
      rejectedRows: 0,
      columns: [
        { name: 'row_id', type: 'BIGINT' },
        { name: 'sales', type: 'DECIMAL(18,4)' },
      ],
      grain: {
        grainDescription: 'One row per Superstore line (Row ID)',
        primaryKey: ['row_id'],
      },
    },
  ],
  relationships: [
    {
      fromTable: 'order_items',
      toTable: 'orders',
      fromColumns: ['order_id'],
      toColumns: ['order_id'],
      cardinality: 'n:1',
    },
  ],
  aliases: [
    { term: 'revenue', expression: 'SUM(sales)', description: 'Gross sales', tableId: 'orders' },
  ],
  rules: [
    {
      datasetId: 'superstore',
      tableId: 'orders',
      column: 'sales',
      kind: 'currency',
      note: 'DECIMAL(18,4) gross sales amount per line (Sales column)',
    },
  ],
}

const OBSERVE_TEXT = `<<observe kind=schema>>\n${JSON.stringify(SCHEMA_PAYLOAD)}\n<</observe>>`

/**
 * Minimal fake `createElement` — returns a plain `{ type, props, children }`
 * tree instead of a real React element, so `SchemaToolRow` (which has no
 * hooks in its read path) can run unmodified in Node without a `react`
 * dependency. This loads and executes the *actual* `client.js` factory —
 * the same `parseObservePayload` and render code the browser runs — rather
 * than duplicating its parse/render logic in the test.
 */
function fakeCreateElement(type: unknown, props: unknown, ...children: unknown[]) {
  return { type, props: props ?? {}, children }
}

interface ElementNode {
  children?: unknown[]
}

function elementText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(elementText).join(' | ')
  if (typeof node === 'object' && 'children' in (node as ElementNode)) {
    return elementText((node as ElementNode).children)
  }
  return ''
}

type ToolviewComponent = (props: { block: unknown }) => unknown

/** Loads `client.js` for real and returns its registered toolview components. */
function loadToolviewRegistry(clientSource: string): Record<string, ToolviewComponent> {
  const fakeReact = {
    createElement: fakeCreateElement,
    useEffect: () => {},
    useState: (initial: unknown) => [initial, () => {}],
  }
  const fakeRequire = (id: string) => {
    if (id === 'react') return fakeReact
    throw new Error(`Unexpected require("${id}") while loading dsh-data-viz client.js`)
  }
  const loaded: Record<string, { apply: (ctx: unknown) => void }> = {}
  const fakeWindow = {
    __ModuleLoader__: {
      load(mod: {
        id: string
        factory: (require: (id: string) => unknown) => { apply: (ctx: unknown) => void }
      }) {
        loaded[mod.id] = mod.factory(fakeRequire)
      },
    },
  }

  const loadClientModule = new Function('window', clientSource)
  loadClientModule(fakeWindow)

  const registry: Record<string, ToolviewComponent> = {}
  const ctx = {
    get: () => undefined,
    slots: {
      inject: (_name: string, register: () => void) => register(),
      register: (descriptor: { key: string }, Component: ToolviewComponent) => {
        registry[descriptor.key] = Component
      },
    },
  }
  loaded['dsh-data-analyst']?.apply(ctx)
  return registry
}

it('parses a canned get_schema observe payload the same way the client does and renders every reviewed field', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const registry = loadToolviewRegistry(clientSource)
  const SchemaToolRow = registry.get_schema
  expect(SchemaToolRow).toBeTypeOf('function')

  const block = { kind: 'result', isError: false, content: [{ type: 'text', text: OBSERVE_TEXT }] }
  const tree = SchemaToolRow!({ block })
  const text = elementText(tree)

  // Table id and column names AND types.
  expect(text).toContain('orders')
  expect(text).toContain('row_id: BIGINT')
  expect(text).toContain('sales: DECIMAL(18,4)')
  // Grain description AND primary key.
  expect(text).toContain('One row per Superstore line (Row ID)')
  expect(text).toContain('PK: row_id')
  // Relationship from/to tables AND join columns.
  expect(text).toContain('order_items(order_id)')
  expect(text).toContain('orders(order_id)')
  // Approved alias.
  expect(text).toContain('revenue: SUM(sales)')
  // Metric rule.
  expect(text).toContain('orders.sales (currency)')
  expect(text).toContain('DECIMAL(18,4) gross sales amount per line (Sales column)')
})

it('never treats candidate aliases as approved and adds no edit-in-place controls', async () => {
  const clientSource = await readFile(join(packageDir, 'client.js'), 'utf8')
  const rowSource = clientSource.slice(
    clientSource.indexOf('function SchemaToolRow'),
    clientSource.indexOf('function MarkSwitcher'),
  )
  // `aliases` only ever carries analyst-approved terms (getEffectiveSemantics);
  // SchemaToolRow must not branch on a `status` field to decide what's approved.
  expect(rowSource).not.toContain("'candidate'")
  expect(rowSource).not.toContain('.status')
  // Read-only: no inputs/buttons/onClick — SQL expression edits stay in the
  // existing alias-review toolview (propose_metric / AliasProposalToolRow).
  expect(rowSource).not.toContain('onClick')
  expect(rowSource).not.toContain("'input'")
  expect(rowSource).not.toContain("'button'")
})

it('registers SchemaToolRow on the get_schema key without an extra fetch', async () => {
  const client = await readFile(join(packageDir, 'client.js'), 'utf8')
  expect(client).toContain('function SchemaToolRow')
  expect(client).toContain("key: 'get_schema'")
  expect(client).not.toMatch(/get_schema[\s\S]{0,200}fetch\(/)
})
