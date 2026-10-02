#!/usr/bin/env node
/**
 * Census of tool `output.schema` strictness (docs/implementation.md, "Strict
 * output schemas"). Strict = the schema's own top-level
 * `additionalProperties` is literally `false`. Everything else (absent,
 * `true`, or any other value) is loose. Walks the real TypeScript AST rather
 * than grepping, so nested `additionalProperties` inside sub-object properties
 * can't be mistaken for the tool's own top-level strictness.
 *
 * Exported for the drift canary in
 * `tests/tool-output-schema-census.unit.test.ts`; run directly to print the
 * current census as JSON.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const TOOL_FILES = [
  'packages/dsh-data-duckdb/src/plugin-tools.ts',
  'packages/dsh-data-kaggle/src/index.ts',
  'packages/dsh-data-viz/src/index.ts',
  'packages/dsh-data-workbench/src/plugin-tools.ts',
]

function findProperty(obj, name) {
  if (!ts.isObjectLiteralExpression(obj)) return undefined
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const key =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined
    if (key === name) return prop.initializer
  }
  return undefined
}

/**
 * @param repoRoot - repository root to census.
 * @returns Per-tool strictness plus sorted strict/loose tool name lists.
 */
export async function censusOutputSchemas(
  repoRoot = resolve(fileURLToPath(import.meta.url), '../..'),
) {
  const rows = []

  for (const relPath of TOOL_FILES) {
    const filePath = resolve(repoRoot, relPath)
    const text = await readFile(filePath, 'utf8')
    const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true)

    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'defineTool'
      ) {
        const arg = node.arguments[0]
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const nameNode = findProperty(arg, 'name')
          const toolName = nameNode && ts.isStringLiteral(nameNode) ? nameNode.text : '<unknown>'
          const outputNode = findProperty(arg, 'output')
          const schemaNode = outputNode ? findProperty(outputNode, 'schema') : undefined
          let strict = false
          if (schemaNode) {
            const additionalProperties = findProperty(schemaNode, 'additionalProperties')
            strict =
              additionalProperties !== undefined &&
              additionalProperties.kind === ts.SyntaxKind.FalseKeyword
          }
          rows.push({ file: relPath, tool: toolName, hasOutputSchema: Boolean(schemaNode), strict })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  const withSchema = rows.filter((r) => r.hasOutputSchema)
  const strict = withSchema.filter((r) => r.strict)
  const loose = withSchema.filter((r) => !r.strict)
  return {
    totalTools: rows.length,
    toolsWithOutputSchema: withSchema.length,
    strict: strict.length,
    loose: loose.length,
    strictTools: strict.map((r) => r.tool).sort(),
    looseTools: loose.map((r) => r.tool).sort(),
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await censusOutputSchemas(), null, 2))
}
