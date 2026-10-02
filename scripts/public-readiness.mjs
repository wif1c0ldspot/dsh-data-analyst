#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
// These files are required for the supported public Git-checkout distribution.
const required = [
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/README.md',
  'docs/architecture.md',
  'docs/analyst-setup.md',
  'docs/implementation.md',
  'profiles/data-analyst/cordis.bundle.patch.yml',
  'profiles/data-analyst/presets/analyst/agent.cordis.yml',
  'profiles/data-analyst/presets/analyst/preset.yml',
  'skills/ingest-kaggle/SKILL.md',
  'skills/semantic-layer/SKILL.md',
  'skills/sql-safety/SKILL.md',
  'skills/viz-conventions/SKILL.md',
  'packages/dsh-data-core/package.json',
  'packages/dsh-data-duckdb/package.json',
  'packages/dsh-data-kaggle/package.json',
  'packages/dsh-data-viz/package.json',
  'packages/dsh-data-workbench/package.json',
  'packages/dsh-data-core/src/analysis-store.ts',
  'packages/dsh-data-duckdb/src/ingest-pipeline.ts',
  'packages/dsh-data-viz/src/chart-service.ts',
  'packages/dsh-data-workbench/src/export-pack.ts',
  'scripts/configure-installed-profile.mjs',
]

for (const relative of required) await access(resolve(root, relative))

// A passing check in a developer's dirty workspace must not be mistaken for a
// reproducible public release. Every required distribution file must already be
// part of the Git tree (staged is sufficient while preparing a commit).
for (const relative of required) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relative], {
      cwd: root,
      stdio: 'ignore',
    })
  } catch {
    throw new Error(`Required public distribution file is not tracked by Git: ${relative}`)
  }
}

const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (manifest.name !== 'dsh-data-analyst') throw new Error('Unexpected root package name')
if (manifest.private !== true) {
  throw new Error(
    'Root workspace bundle must stay private until its internal packages are published',
  )
}
if (manifest.license !== 'MIT') throw new Error('Root package must declare the repository license')
if (manifest.dsh?.bundle?.patch !== './profiles/data-analyst/cordis.bundle.patch.yml') {
  throw new Error('Root package must expose the installable dsh bundle patch')
}
if (manifest.dsh?.client?.platform !== 'web' || !manifest.exports?.['./client']) {
  throw new Error('Root package must expose its dsh web client')
}

const packageDirs = await readdir(resolve(root, 'packages'), { withFileTypes: true })
for (const entry of packageDirs) {
  if (!entry.isDirectory()) continue
  const child = JSON.parse(
    await readFile(resolve(root, 'packages', entry.name, 'package.json'), 'utf8'),
  )
  if (child.license !== 'MIT') throw new Error(`${child.name} must declare the repository license`)
}

const deploymentFiles = await readdir(resolve(root, 'deployment'))
const obsolete = deploymentFiles.filter(
  (name) => /^Dockerfile(?:\.|$)/.test(name) || /^compose(?:\.|$)/.test(name),
)
if (obsolete.length) throw new Error(`Obsolete container artifacts remain: ${obsolete.join(', ')}`)

const gitignore = await readFile(resolve(root, '.gitignore'), 'utf8')
for (const pattern of [
  'node_modules/',
  '.env',
  'datasets/*',
  'deepseek-harness/',
  '*.duckdb',
  '.dsh-home-smoke/',
  '.dsh-r3-accept/',
  'tools/kaggle-cli/.venv/',
]) {
  if (!gitignore.split(/\r?\n/).includes(pattern)) {
    throw new Error(`.gitignore must exclude ${pattern}`)
  }
}

const publicFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean)
for (const relative of publicFiles) {
  if (/(^|\/)(?:\.DS_Store|\.env)$|\.duckdb(?:\.wal)?$/i.test(relative)) {
    throw new Error(`Sensitive or generated file would be shared: ${relative}`)
  }
  const path = resolve(root, relative)
  const details = await stat(path).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (!details) continue
  if (details.size > 10 * 1024 * 1024) {
    throw new Error(`Public source file exceeds 10 MiB: ${relative}`)
  }
  if (!/\.(?:c?js|mjs|json|md|ts|tsx|ya?ml)$/i.test(relative)) continue
  const source = await readFile(path, 'utf8')
  for (const match of source.matchAll(
    /(?:DEEPSEEK_API_KEY|DSH_NL_API_KEY|KAGGLE_API_TOKEN)\s*=\s*["']?([^\s"'#]+)/g,
  )) {
    const value = (match[1] ?? '').replace(/[`),.;]+$/, '')
    if (
      value &&
      !['...', 'dummy', 'ollama', 'test', 'unused'].includes(value.toLowerCase()) &&
      !value.startsWith('$') &&
      !value.startsWith('<')
    ) {
      throw new Error(`Possible credential value would be shared: ${relative}`)
    }
  }
}

console.log(
  JSON.stringify({
    ok: true,
    distribution: 'public-git-checkout',
    package: manifest.name,
    capabilities: ['duckdb', 'kaggle', 'viz', 'workbench'],
    customAgent: 'analyst',
    skills: 4,
  }),
)
