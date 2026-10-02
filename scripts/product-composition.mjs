/**
 * Opt-in product webapp composition helpers.
 *
 * Default closed boots stay on `profiles/data-analyst/cordis.patch.yml` alone.
 * Operators enable the candidate product stack only when
 * `DSH_DATA_PRODUCT_COMPOSITION=webapp`.
 *
 * ADR 001 (2026-09-14): dsh web is the Core analyst surface. These helpers boot
 * the closed analyst / webapp-product candidate for inventory and persistent
 * session serve (`serve-analyst-session.mjs`).
 */
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageAnalystSkills } from './package-analyst-skills.mjs'

const require = createRequire(import.meta.url)
const webRequire = createRequire(require.resolve('@deepseek-ai/dsh-web-app/package.json'))
export const root = fileURLToPath(new URL('..', import.meta.url))

export const PRODUCT_COMPOSITION_ENV = 'DSH_DATA_PRODUCT_COMPOSITION'
export const PRODUCT_COMPOSITION_WEBAPP = 'webapp'

export const HOST_ANALYST_TOOLS = [
  'add_to_dashboard',
  'apply_dashboard_filters',
  'bin_elapsed_intervals',
  'cancel_job',
  'check_studio_availability',
  'create_dashboard',
  'dataset_status',
  'delete_dashboard',
  'describe_column',
  'duckdb_query',
  'export_dashboard',
  'export_report',
  'find_duplicate_rows',
  'find_top_n',
  'get_analysis',
  'get_dashboard',
  'get_learning_examples',
  'get_metrics',
  'get_schema',
  'get_workflow_trail',
  'ingest_dataset',
  'investigate_metric',
  'kaggle_download',
  'list_analyses',
  'list_chart_feedback',
  'list_dashboards',
  'list_datasets',
  'list_pending_metrics',
  'list_pending_structure',
  'make_chart',
  'map_dashboard_filters',
  'preview_ingest_source',
  'propose_metric',
  'propose_sql_correction',
  'propose_structure',
  'ratio_of_sums',
  'reconcile_totals',
  'rename_dashboard',
  'report_chart_issue',
  'resolve_kaggle_source',
  'resolve_kaggle_version',
  'restore_dashboard',
  'save_analysis',
  'search_kaggle_sources',
]

export const ANALYST_TOOLS = [...HOST_ANALYST_TOOLS, 'skill'].sort()

export const FORBIDDEN_TOOL_NAMES = [
  'bash',
  'pwsh',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'subagent',
  'subagent_fork',
  'send_message',
  'list_agents',
  'run_code',
  'exit_plan_mode',
  'ask_user_question',
  'todo_write',
  'workflow',
  'ralph',
]

export function isWebappProductCompositionEnabled(env = process.env) {
  return env[PRODUCT_COMPOSITION_ENV] === PRODUCT_COMPOSITION_WEBAPP
}

export function basePatchPath() {
  return require
    .resolve('@deepseek-ai/dsh-base/package.json')
    .replace(/package\.json$/, 'cordis.patch.yml')
}

export function webPatchPath() {
  return require
    .resolve('@deepseek-ai/dsh-web-app/package.json')
    .replace(/package\.json$/, 'cordis.patch.yml')
}

export function profilePatchPath() {
  return join(root, 'profiles/data-analyst/cordis.patch.yml')
}

export function webappProductCandidatePatchPath() {
  return join(root, 'tests/fixtures/cordis-overlays/cordis.webapp-product.candidate.patch.yml')
}

export function analystPresetSourceDir() {
  return join(root, 'profiles/data-analyst/presets/analyst')
}

/** Default durable home for `npm run serve:analyst` (gitignored). */
export function defaultAnalystHomeDir() {
  return join(root, '.dsh-home')
}

/**
 * Resolve patch files for a boot.
 * - Default / unset env: closed production profile only (after base + web-app).
 * - `DSH_DATA_PRODUCT_COMPOSITION=webapp`: append the opt-in product candidate.
 *
 * Pass `forceProduct: true` for smoke scripts that already gate via the npm
 * script env (same stack as smoke:agent:boot).
 */
export function resolveProductCompositionPatchPaths(options = {}) {
  const { env = process.env, forceProduct = false, includeWebApp = true } = options
  const paths = [basePatchPath()]
  if (includeWebApp) paths.push(webPatchPath())
  paths.push(profilePatchPath())
  if (forceProduct || isWebappProductCompositionEnabled(env)) {
    paths.push(webappProductCandidatePatchPath())
  }
  return paths
}

export function standardPresetPath() {
  return join(
    dirname(webRequire.resolve('@deepseek-ai/dsh-agent-presets/package.json')),
    'presets/standard/agent.cordis.yml',
  )
}

/** Package names the standard preset composition references (for pnpm disk-walk linking). */
export async function standardPresetPackageNames() {
  const raw = await readFile(standardPresetPath(), 'utf8')
  const names = [...raw.matchAll(/name: '(@deepseek-ai\/[^']+)'/g)].map((match) => match[1])
  return [...new Set(names.map((name) => name.split('/').slice(0, 2).join('/')))]
}

export async function webClientPackageNames() {
  const pkgPath = webRequire.resolve('@deepseek-ai/dsh-web-app/package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  return Object.keys(pkg.dependencies ?? {}).filter((name) =>
    name.startsWith('@deepseek-ai/dsh-client'),
  )
}

const ANALYST_SURFACE_EXTRA_PACKAGES = [
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
]

function scopedPackageName(specifier) {
  return specifier.split('/').slice(0, 2).join('/')
}

async function packageNamesFromCordisPatch(patchFile) {
  const raw = await readFile(patchFile, 'utf8')
  return [...raw.matchAll(/name: ['"](@deepseek-ai\/[^'"]+)['"]/g)].map((match) =>
    scopedPackageName(match[1]),
  )
}

/**
 * Packages the pnpm layout must expose under the Cordis config dir. Client-modules
 * resolves `dsh.client` manifests from that tree; linking only `dsh-client*` leaves
 * api-remotes / typert / gateway out of the browser graph.
 */
export async function analystSurfacePackageNames() {
  const names = new Set(await standardPresetPackageNames())
  for (const pkg of ANALYST_SURFACE_EXTRA_PACKAGES) names.add(pkg)
  for (const pkg of await webClientPackageNames()) names.add(pkg)
  for (const patch of [basePatchPath(), webPatchPath()]) {
    for (const pkg of await packageNamesFromCordisPatch(patch)) names.add(pkg)
  }
  return [...names]
}

/** Symlink preset packages under configDir/node_modules for Cordis mount. */
export async function linkPackagesForPresetMount(configDir, packages) {
  const scopeDir = join(configDir, 'node_modules', '@deepseek-ai')
  await mkdir(scopeDir, { recursive: true })
  for (const pkg of packages) {
    const shortName = pkg.replace('@deepseek-ai/', '')
    const dest = join(scopeDir, shortName)
    try {
      await readFile(join(dest, 'package.json'))
      continue
    } catch {
      // link below
    }
    let target
    try {
      target = dirname(webRequire.resolve(`${pkg}/package.json`))
    } catch {
      try {
        target = dirname(require.resolve(`${pkg}/package.json`))
      } catch {
        continue
      }
    }
    try {
      await symlink(target, dest)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
}

export async function installClosedAnalystPreset(dshHome, options = {}) {
  const sourceSkillRoot = options.skillRoot ?? join(root, 'skills')
  const dest = join(dshHome, '.agent-presets', 'analyst')
  await mkdir(dirname(dest), { recursive: true })
  await cp(analystPresetSourceDir(), dest, { recursive: true })
  const skillRoot = join(dest, 'skills')
  await packageAnalystSkills({ sourceRoot: sourceSkillRoot, outputRoot: skillRoot })
  const agentPath = join(dest, 'agent.cordis.yml')
  const raw = await readFile(agentPath, 'utf8')
  await writeFile(agentPath, raw.replaceAll('__DSH_ANALYST_SKILL_ROOT__', skillRoot), 'utf8')
}

const FIBER_PENDING = 0
const FIBER_LOADING = 1
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3
const FIBER_STATES = {
  [FIBER_PENDING]: 'pending',
  [FIBER_LOADING]: 'loading',
  [FIBER_ACTIVE]: 'active',
  [FIBER_FAILED]: 'failed',
}

/** Host Loader rows plus the composed browser module graph (R1 UI diagnosis). */
export function hostWebSurfaceReport(ctx) {
  const loaderRows = []
  for (const entry of ctx.loader?.entries?.() ?? []) {
    const fiber = entry.fiber
    const state = fiber?.state
    let missing = []
    if (fiber && state === FIBER_PENDING && fiber.inject) {
      missing = Object.keys(fiber.inject).filter((service) => fiber.ctx.get(service) === undefined)
    }
    loaderRows.push({
      id: entry.options?.id ?? null,
      name: entry.options?.name ?? null,
      disabled: Boolean(entry.disabled),
      state: FIBER_STATES[state] ?? (state === undefined ? 'none' : String(state)),
      missing,
    })
  }
  const clientModules = ctx.get('clientModules')
  const graphIds = clientModules?.graph?.()?.entries?.map((row) => row.id) ?? []
  return { loaderRows, graphIds }
}

/** Standing-scope tool names for the closed analyst preset. */
export async function closedAnalystToolNames(ctx) {
  const agentPresets = ctx.get('agentPresets')
  const defaultPreset = agentPresets?.defaultId ?? null
  const standingKey = await agentPresets.standingKeyFor('analyst')
  const tools =
    ctx.tools
      ?.schemas(standingKey)
      .map((tool) => tool.name)
      .sort() ?? []
  const missing = ANALYST_TOOLS.filter((name) => !tools.includes(name))
  const forbidden = FORBIDDEN_TOOL_NAMES.filter((name) => tools.includes(name))
  return { tools, defaultPreset, standingKey, missing, forbidden }
}
