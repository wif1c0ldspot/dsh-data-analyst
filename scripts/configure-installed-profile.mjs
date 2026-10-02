#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageAnalystSkills } from './package-analyst-skills.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
function option(name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : fallback
}
function flag(name) {
  return argv.includes(name)
}

// Daily driver: install the isolated analyst preset onto the standard web
// profile. Closed host deny-list is opt-in for the legacy data-analyst profile.
const profile = option('--profile', 'web')
const home = resolve(option('--home', process.env.DSH_HOME ?? join(homedir(), '.dsh')))
const closedHost = flag('--closed-host') || profile === 'data-analyst'
if (!/^[a-zA-Z0-9._-]+$/.test(profile)) throw new Error(`Invalid profile name: ${profile}`)
const profileDir = join(home, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (!manifest.dsh?.profile?.bundles?.includes('dsh-data-analyst')) {
  throw new Error(
    `Profile ${profile} does not contain dsh-data-analyst; run dsh plugin --profile ${profile} add ${root} first`,
  )
}

let profilePatch
if (closedHost) {
  const closed = await readFile(join(root, 'profiles/data-analyst/cordis.patch.yml'), 'utf8')
  const product = await readFile(
    join(root, 'tests/fixtures/cordis-overlays/cordis.webapp-product.candidate.patch.yml'),
    'utf8',
  )
  // Split on the marker comment that starts the tool-plugin insert block, so
  // the closed-host profile gets only the deny-list half of the file. A
  // plain string split silently returns the whole file (no host policy
  // stripped) if the marker is ever renamed without updating this literal —
  // fail loudly instead of writing a wrong, unfiltered profile.
  const marker = '# The four analyst tool plugins'
  const markerIndex = closed.indexOf(marker)
  if (markerIndex < 0) {
    throw new Error(
      `profiles/data-analyst/cordis.patch.yml no longer contains the marker comment ${JSON.stringify(marker)} that this script splits on; update this script's marker to match before continuing, or the closed-host profile would silently receive the wrong patch`,
    )
  }
  const hostPolicy = closed.slice(0, markerIndex)
  profilePatch = join(profileDir, 'cordis.patch.yml')
  await writeFile(profilePatch, `${hostPolicy.trimEnd()}\n\n${product}`, 'utf8')
}

const presetSource = join(root, 'profiles/data-analyst/presets/analyst')
const presetDestination = join(home, '.agent-presets', 'analyst')
await mkdir(dirname(presetDestination), { recursive: true })
await cp(presetSource, presetDestination, { recursive: true, force: true })
const agentPath = join(presetDestination, 'agent.cordis.yml')
const agent = await readFile(agentPath, 'utf8')
const skillRoot = join(presetDestination, 'skills')
await packageAnalystSkills({ sourceRoot: join(root, 'skills'), outputRoot: skillRoot })
await writeFile(agentPath, agent.replaceAll('__DSH_ANALYST_SKILL_ROOT__', skillRoot), 'utf8')

console.log(
  JSON.stringify({
    ok: true,
    profile,
    home,
    closedHost,
    profilePatch: profilePatch ?? null,
    preset: agentPath,
  }),
)
