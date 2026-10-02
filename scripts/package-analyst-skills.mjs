#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MAX_PACKAGED_SKILL_BYTES = 48 * 1024
export const SUPPORTED_SQL_FUNCTIONS_TOKEN = '{{SUPPORTED_SQL_FUNCTIONS}}'
const GENERATED_ROOT_MARKER = '.dsh-analyst-skills-generated'

export const ANALYST_SKILL_MANIFEST = [
  { name: 'ingest-kaggle', reference: 'references/profiling.md' },
  { name: 'semantic-layer', reference: 'references/metric-contracts.md' },
  { name: 'sql-safety', reference: 'references/analytical-recipes.md' },
  { name: 'viz-conventions', reference: 'references/chart-and-delivery.md' },
]

async function readRequired(path, label) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Missing analyst skill ${label}: ${path}`)
    throw error
  }
}

async function serviceAllowedFunctions(repoRoot) {
  const modulePath = join(repoRoot, 'packages/dsh-data-duckdb/dist/sql-policy.js')
  try {
    const module = await import(`${pathToFileURL(modulePath).href}?pack=${Date.now()}`)
    return module.DEFAULT_ALLOWED_FUNCTIONS
  } catch (error) {
    throw new Error(
      `Cannot load the built SQL capability list at ${modulePath}; run the TypeScript build first`,
      { cause: error },
    )
  }
}

function containsPath(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export async function packageAnalystSkills(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? fileURLToPath(new URL('..', import.meta.url)))
  const sourceRoot = resolve(options.sourceRoot ?? join(repoRoot, 'skills'))
  const outputRoot = resolve(options.outputRoot ?? join(repoRoot, 'dist/analyst-skills'))
  const maxSkillBytes = options.maxSkillBytes ?? MAX_PACKAGED_SKILL_BYTES
  const allowedFunctions = options.allowedFunctions ?? (await serviceAllowedFunctions(repoRoot))

  if (!Array.isArray(allowedFunctions) || allowedFunctions.length === 0) {
    throw new Error('The SQL capability list must contain at least one function')
  }
  if (
    outputRoot === parse(outputRoot).root ||
    containsPath(sourceRoot, outputRoot) ||
    containsPath(outputRoot, sourceRoot) ||
    containsPath(outputRoot, repoRoot)
  ) {
    throw new Error('The generated analyst skill root must be separate from the source skill root')
  }

  const packaged = []
  for (const item of ANALYST_SKILL_MANIFEST) {
    const skillPath = join(sourceRoot, item.name, 'SKILL.md')
    const referencePath = join(sourceRoot, item.name, item.reference)
    const entrypoint = await readRequired(skillPath, `entrypoint for ${item.name}`)
    let reference = await readRequired(referencePath, `reference for ${item.name}`)

    const tokenCount = reference.split(SUPPORTED_SQL_FUNCTIONS_TOKEN).length - 1
    if (item.name === 'sql-safety') {
      if (tokenCount !== 1) {
        throw new Error(
          `${referencePath} must contain ${SUPPORTED_SQL_FUNCTIONS_TOKEN} exactly once`,
        )
      }
      reference = reference.replace(SUPPORTED_SQL_FUNCTIONS_TOKEN, allowedFunctions.join(', '))
    } else if (tokenCount !== 0) {
      throw new Error(`${referencePath} contains an unexpected SQL capability token`)
    }

    const content = `${entrypoint.trimEnd()}\n\n---\n\n${reference.trim()}\n`
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > maxSkillBytes) {
      throw new Error(
        `Packaged analyst skill ${item.name} is ${bytes} bytes; budget is ${maxSkillBytes}`,
      )
    }

    packaged.push({ name: item.name, content })
  }

  let existing = []
  try {
    existing = await readdir(outputRoot)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (existing.length > 0 && !existing.includes(GENERATED_ROOT_MARKER)) {
    throw new Error(`Refusing to replace unowned analyst skill directory: ${outputRoot}`)
  }

  // The marker establishes outputRoot as a dedicated generated directory.
  // Replacing it prevents an old or manually added skill surviving a reinstall.
  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })
  await writeFile(join(outputRoot, GENERATED_ROOT_MARKER), 'generated\n', 'utf8')
  for (const item of packaged) {
    const destination = join(outputRoot, item.name, 'SKILL.md')
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, item.content, 'utf8')
  }

  return { outputRoot, skills: ANALYST_SKILL_MANIFEST.map((item) => item.name) }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf('--output')
  const outputRoot = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined
  const result = await packageAnalystSkills({ ...(outputRoot ? { outputRoot } : {}) })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
