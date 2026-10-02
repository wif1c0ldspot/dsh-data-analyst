import { readFile, readdir, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, dirname, relative, extname } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { isRosettaNode } from './doctor-checks.mjs'

const ROSETTA_GAP_MESSAGE =
  'Node is running under Rosetta 2 (x64 translation) on Apple Silicon. Native bindings ' +
  'this project depends on (DuckDB, rolldown) will fail to load with cryptic errors under ' +
  'translation. Install and use a native arm64 build of Node (e.g. via nvm/fnm, making sure ' +
  'the installed version is arm64) and re-run this doctor script. A common cause is running ' +
  'a Terminal app itself under Rosetta; check with `arch` or by inspecting `file $(which node)` ' +
  '(it should say "arm64", not "x86_64").'

function detectRosettaGap() {
  if (process.platform !== 'darwin') return false
  const hardware = spawnSync('sysctl', ['-n', 'hw.optional.arm64'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  const hardwareArm64 =
    !hardware.error && hardware.status === 0 && (hardware.stdout ?? '').trim() === '1'
  return isRosettaNode({ platform: process.platform, arch: process.arch, hardwareArm64 })
}

// Dependency-free scaffold diagnostics. This does not execute product tests.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const failures = []
const files = []
const excluded = new Set([
  'deepseek-harness',
  'node_modules',
  '.git',
  '.codex',
  '.agents',
  'datasets',
  'dist',
  'lib',
  'coverage',
  '.pnpm-store',
  '.tmp',
  // Internal records (measured evidence, publishing and development notes) are
  // deliberately outside the published distribution; their relative links
  // resolve only in the docs/ location they were written for.
  '.internal',
])

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (['.json', '.md'].includes(extname(path))) files.push(path)
  }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

await walk(root)
let jsonCount = 0
let linkCount = 0
for (const path of files) {
  const source = await readFile(path, 'utf8')
  if (extname(path) === '.json') {
    try {
      JSON.parse(source)
      jsonCount++
    } catch (error) {
      failures.push(`${relative(root, path)}: ${error.message}`)
    }
  } else {
    // Check local inline Markdown link targets; anchors and web links are outside
    // this small diagnostic's scope. Ignore code examples/fences.
    const prose = source.replace(/```[\s\S]*?```/g, '')
    for (const match of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0]
      if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue
      linkCount++
      if (!(await exists(resolve(dirname(path), target)))) {
        failures.push(`${relative(root, path)}: missing link ${target}`)
      }
    }
  }
}
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const pin = JSON.parse(
  await readFile(resolve(root, 'profiles/data-analyst/upstream-lock.json'), 'utf8'),
)
if (pkg.type !== 'module') failures.push('Root package must be ESM')
if (pkg.packageManager !== pin.packageManager)
  failures.push('Root package manager differs from reviewed upstream pin')

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(
  `Scaffold integrity passed: ${jsonCount} JSON files, ${linkCount} local documentation links. This is not a runtime or schema-validation test.`,
)
const rosettaGap = detectRosettaGap()
if (process.argv.includes('--check')) {
  if (rosettaGap) {
    console.error(`Development environment NOT READY:\n- ${ROSETTA_GAP_MESSAGE}`)
    process.exit(1)
  }
  process.exit(0)
}

const gaps = []
const upstreamPath = resolve(root, 'deepseek-harness')
if (await exists(upstreamPath)) {
  const upstream = spawnSync('git', ['-C', upstreamPath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  if (upstream.status !== 0 || upstream.stdout.trim() !== pin.commit)
    gaps.push('Upstream revision differs from the reviewed source pin')
  else console.log(`Optional source checkout matches ${pin.commit}.`)
} else
  console.log(
    'Optional upstream source checkout is absent; published dependencies support builds/tests.',
  )
const [major, minor] = process.versions.node.split('.').map(Number)
if (!(major >= 24 || (major === 22 && minor >= 19)))
  gaps.push('Node version is outside the reviewed engine range')
if (rosettaGap) gaps.push(ROSETTA_GAP_MESSAGE)
if (!(await exists(resolve(root, 'pnpm-lock.yaml')))) gaps.push('No frozen root pnpm lockfile')
// First-run prerequisites for live Kaggle preview/download, not build/test
// (which need neither). Reports presence/absence and the exact fix only —
// never token material, even a fragment or length.
const kaggleCliPresent = await exists(resolve(root, 'tools/kaggle-cli/.venv/bin/kaggle'))
console.log(
  kaggleCliPresent
    ? 'Kaggle CLI: present at tools/kaggle-cli/.venv/bin/kaggle.'
    : 'Kaggle CLI: absent. Fix: cd tools/kaggle-cli && uv sync',
)
const kaggleTokenFile = resolve(homedir(), '.kaggle', 'access_token')
const kaggleLegacyConfig = resolve(homedir(), '.kaggle', 'kaggle.json')
const kaggleTokenPresent =
  Boolean(process.env.KAGGLE_API_TOKEN?.trim()) ||
  (await exists(kaggleTokenFile)) ||
  (await exists(kaggleLegacyConfig))
console.log(
  kaggleTokenPresent
    ? 'Kaggle token: present.'
    : 'Kaggle token: absent. Fix: generate an API token at ' +
        'https://www.kaggle.com/settings/api, save it to ~/.kaggle/access_token, ' +
        'then chmod 600 ~/.kaggle/access_token (or set KAGGLE_API_TOKEN).',
)
for (const [from, dependencies] of [
  [
    'package.json',
    ['typescript', 'vitest', 'eslint', 'prettier', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'],
  ],
  ['packages/dsh-data-core/package.json', ['zod']],
  ['packages/dsh-data-duckdb/package.json', ['@duckdb/node-api']],
  ['packages/dsh-data-viz/package.json', ['vega', 'vega-lite']],
]) {
  const require = createRequire(resolve(root, from))
  for (const dependency of dependencies) {
    try {
      require.resolve(dependency)
    } catch {
      gaps.push(`Missing dependency ${dependency}`)
    }
  }
}
console.log(`Runtime: Node ${process.versions.node}, ${process.platform}/${process.arch}`)
if (gaps.length) {
  console.error(`Development environment NOT READY:\n${gaps.map((gap) => `- ${gap}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log('Development prerequisites ready. Run npm run check for build/type/test evidence.')
  console.log(
    'Current status: approved tabular ingest and Analysis Studio are implemented. ' +
      'Narrative reliability, bounded UI scope and Learning v1.1 are documented — ' +
      'see docs/implementation.md.',
  )
}
