import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { DEFAULT_ALLOWED_FUNCTIONS } from '../packages/dsh-data-duckdb/src/sql-policy.js'
import { ANALYST_SKILL_MANIFEST, packageAnalystSkills } from '../scripts/package-analyst-skills.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const temporary: string[] = []

async function tempDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), label))
  temporary.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('packages only the four trusted skills and generates the exact SQL capability list', async () => {
  const directory = await tempDirectory('analyst-skills-package-')
  const sourceRoot = join(directory, 'source')
  const outputRoot = join(directory, 'output')
  await cp(join(repoRoot, 'skills'), sourceRoot, { recursive: true })
  await mkdir(join(sourceRoot, 'untrusted-extra'), { recursive: true })
  await writeFile(
    join(sourceRoot, 'untrusted-extra', 'SKILL.md'),
    '---\nname: untrusted-extra\ndescription: no\n---\n',
  )
  await packageAnalystSkills({
    repoRoot,
    sourceRoot,
    outputRoot,
    allowedFunctions: DEFAULT_ALLOWED_FUNCTIONS,
  })
  await mkdir(join(outputRoot, 'stale-skill'), { recursive: true })
  await writeFile(join(outputRoot, 'stale-skill', 'SKILL.md'), 'stale')
  await packageAnalystSkills({
    repoRoot,
    sourceRoot,
    outputRoot,
    allowedFunctions: DEFAULT_ALLOWED_FUNCTIONS,
  })

  expect((await readdir(outputRoot)).sort()).toEqual(
    ['.dsh-analyst-skills-generated', ...ANALYST_SKILL_MANIFEST.map((item) => item.name)].sort(),
  )
  const sql = await readFile(join(outputRoot, 'sql-safety', 'SKILL.md'), 'utf8')
  const line = sql.match(
    /Supported functions \(generated from the query-policy service\):\n`([^`]+)`/,
  )
  expect(line?.[1]?.split(', ')).toEqual(DEFAULT_ALLOWED_FUNCTIONS)
  expect(sql).not.toContain('{{SUPPORTED_SQL_FUNCTIONS}}')
})

it('fails closed when a manifest reference is missing', async () => {
  const directory = await tempDirectory('analyst-skills-missing-')
  const sourceRoot = join(directory, 'source')
  await cp(join(repoRoot, 'skills'), sourceRoot, { recursive: true })
  await rm(join(sourceRoot, 'semantic-layer', 'references', 'metric-contracts.md'))

  await expect(
    packageAnalystSkills({
      repoRoot,
      sourceRoot,
      outputRoot: join(directory, 'output'),
      allowedFunctions: DEFAULT_ALLOWED_FUNCTIONS,
    }),
  ).rejects.toThrow(/Missing analyst skill reference for semantic-layer/)
})

it('fails closed when packaged content exceeds the configured budget', async () => {
  const directory = await tempDirectory('analyst-skills-size-')
  await expect(
    packageAnalystSkills({
      repoRoot,
      sourceRoot: join(repoRoot, 'skills'),
      outputRoot: join(directory, 'output'),
      allowedFunctions: DEFAULT_ALLOWED_FUNCTIONS,
      maxSkillBytes: 1,
    }),
  ).rejects.toThrow(/budget is 1/)
})

it('rejects an output ancestor without removing the source skills', async () => {
  const directory = await tempDirectory('analyst-skills-ancestor-')
  const sourceRoot = join(directory, 'source', 'skills')
  await cp(join(repoRoot, 'skills'), sourceRoot, { recursive: true })

  await expect(
    packageAnalystSkills({
      repoRoot,
      sourceRoot,
      outputRoot: directory,
      allowedFunctions: DEFAULT_ALLOWED_FUNCTIONS,
    }),
  ).rejects.toThrow(/must be separate/)
  await expect(readFile(join(sourceRoot, 'sql-safety', 'SKILL.md'), 'utf8')).resolves.toContain(
    'name: sql-safety',
  )
})

it('rejects filesystem root and an unowned nonempty destination', async () => {
  const directory = await tempDirectory('analyst-skills-unowned-')
  const unowned = join(directory, 'unowned')
  await mkdir(unowned)
  await writeFile(join(unowned, 'keep.txt'), 'keep')

  for (const outputRoot of [parse(repoRoot).root, unowned]) {
    await expect(
      packageAnalystSkills({
        repoRoot,
        sourceRoot: join(repoRoot, 'skills'),
        outputRoot,
        allowedFunctions: DEFAULT_ALLOWED_FUNCTIONS,
      }),
    ).rejects.toThrow(/separate|unowned/)
  }
  await expect(readFile(join(unowned, 'keep.txt'), 'utf8')).resolves.toBe('keep')
})
