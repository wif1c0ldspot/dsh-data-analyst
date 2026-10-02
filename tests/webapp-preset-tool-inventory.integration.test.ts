/**
 * Agent-preset / web-app inventory gap (docs/dsh-compatibility.md).
 *
 * Boots the published `@deepseek-ai/dsh-web-app@0.1.5-rc.2` bundle patch over
 * `dsh-base`, with our three analyst tools inserted, then records:
 *   1. Host-plane `ctx.tools.schemas()` (no session / standing preset)
 *   2. Standing `standard` preset scope via `agentPresets.standingKeyFor`
 *   3. Opt-in webapp-product candidate: closed profile + product overlay +
 *      `default: analyst` with a 3-tool standing scope
 *
 * Production `profiles/data-analyst/cordis.patch.yml` stays closed by default;
 * the product overlay is explicit opt-in only.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { expect, it } from 'vitest'
import {
  analystSurfacePackageNames,
  hostWebSurfaceReport,
  installClosedAnalystPreset,
} from '../scripts/product-composition.mjs'
import { HOST_ANALYST_TOOLS, PRODUCT_ANALYST_TOOLS } from './analyst-tool-inventory.js'
import { ALWAYS_DISABLED_TOOL_ROWS } from './nl-session-candidate-rows.js'

/** Mirrors scripts/product-composition.mjs — keep in sync with that entrypoint. */
const PRODUCT_COMPOSITION_ENV = 'DSH_DATA_PRODUCT_COMPOSITION'
const PRODUCT_COMPOSITION_WEBAPP = 'webapp'

function isWebappProductCompositionEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return env[PRODUCT_COMPOSITION_ENV] === PRODUCT_COMPOSITION_WEBAPP
}

function resolveProductCompositionPatchPaths(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string[] {
  const paths = [basePatchPath(), webPatchPath(), profilePatchPath()]
  if (isWebappProductCompositionEnabled(env)) {
    paths.push(webappProductCandidatePatchPath())
  }
  return paths
}

const require = createRequire(import.meta.url)
const webRequire = createRequire(require.resolve('@deepseek-ai/dsh-web-app/package.json'))

/**
 * Effective tools under the shipped `standard` agent preset standing scope
 * (darwin/linux: bash enabled, pwsh disabled) plus our analyst inserts.
 * Captured 2026-09-13 against `@deepseek-ai/dsh-web-app@0.1.5-rc.2` and updated
 * when host analyst tools were added for R2.
 *
 * This list is the product-policy decision surface: promoting web-app without a
 * closed analyst preset would expose every name below to the model.
 */
const STANDARD_PRESET_PLUS_ANALYST_TOOLS = [
  'add_to_dashboard',
  'apply_dashboard_filters',
  'ask_user_question',
  'bash',
  'bin_elapsed_intervals',
  'cancel_job',
  'check_studio_availability',
  'create_dashboard',
  'create_goal',
  'dataset_status',
  'delete_dashboard',
  'describe_column',
  'duckdb_query',
  'edit',
  'exit_plan_mode',
  'export_dashboard',
  'export_report',
  'find_duplicate_rows',
  'find_top_n',
  'get_analysis',
  'get_dashboard',
  'get_goal',
  'get_learning_examples',
  'get_metrics',
  'get_schema',
  'get_workflow_trail',
  'glob',
  'grep',
  'ingest_dataset',
  'interrupt_agent',
  'investigate_metric',
  'job_kill',
  'job_list',
  'job_output',
  'kaggle_download',
  'list_agents',
  'list_analyses',
  'list_chart_feedback',
  'list_dashboards',
  'list_datasets',
  'list_pending_metrics',
  'list_pending_structure',
  'make_chart',
  'map_dashboard_filters',
  'present',
  'preview_ingest_source',
  'propose_metric',
  'propose_sql_correction',
  'propose_structure',
  'ralph',
  'ratio_of_sums',
  'read',
  'read_image',
  'reconcile_totals',
  'rename_dashboard',
  'report_chart_issue',
  'resolve_kaggle_source',
  'resolve_kaggle_version',
  'restore_dashboard',
  'save_analysis',
  'search_kaggle_sources',
  'send_message',
  'skill',
  'subagent_fork',
  'todo_write',
  'update_goal',
  'web_fetch',
  'web_search',
  'workflow',
  'write',
] as const

/** Model-facing names our closed profile must never leave reachable. */
const FORBIDDEN_TOOL_NAMES = [
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
] as const

function basePatchPath(): string {
  return require
    .resolve('@deepseek-ai/dsh-base/package.json')
    .replace(/package\.json$/, 'cordis.patch.yml')
}

function webPatchPath(): string {
  return require
    .resolve('@deepseek-ai/dsh-web-app/package.json')
    .replace(/package\.json$/, 'cordis.patch.yml')
}

function profilePatchPath(): string {
  return fileURLToPath(new URL('../profiles/data-analyst/cordis.patch.yml', import.meta.url))
}

function candidatePatchPath(): string {
  return fileURLToPath(
    new URL(
      '../tests/fixtures/cordis-overlays/cordis.nl-session.candidate.patch.yml',
      import.meta.url,
    ),
  )
}

function webappProductCandidatePatchPath(): string {
  return fileURLToPath(
    new URL(
      '../tests/fixtures/cordis-overlays/cordis.webapp-product.candidate.patch.yml',
      import.meta.url,
    ),
  )
}

function standardPresetPath(): string {
  return join(
    dirname(webRequire.resolve('@deepseek-ai/dsh-agent-presets/package.json')),
    'presets/standard/agent.cordis.yml',
  )
}

/** Package names the standard preset composition references (for pnpm disk-walk linking). */
async function standardPresetPackageNames(): Promise<string[]> {
  const raw = await readFile(standardPresetPath(), 'utf8')
  const names = [...raw.matchAll(/name: '(@deepseek-ai\/[^']+)'/g)].map((match) => match[1]!)
  return [...new Set(names.map((name) => name.split('/').slice(0, 2).join('/')))]
}

/**
 * agent-presets health/mount resolve packages with a simple
 * `node_modules/<pkg>/package.json` walk from the config directory. pnpm does
 * not hoist those peers to a temp config dir, so link them explicitly.
 */
async function linkPackagesForPresetMount(configDir: string, packages: string[]): Promise<void> {
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
    let target: string
    try {
      target = dirname(webRequire.resolve(`${pkg}/package.json`))
    } catch {
      target = dirname(require.resolve(`${pkg}/package.json`))
    }
    try {
      await symlink(target, dest)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

function analystInsertPatches(label: string) {
  return loadOverlayPatches(label, profilePatchPath()).filter((patch) =>
    Array.isArray(patch.insert),
  )
}

async function withWebAppBoot<T>(
  label: string,
  patchPaths: string[],
  run: (ctx: Awaited<ReturnType<typeof boot>>) => Promise<T>,
  options?: {
    linkStandardPackages?: boolean
    installClosedAnalystPreset?: boolean
    extraPatches?: ReturnType<typeof loadOverlayPatches>
  },
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-p0-4-webapp-'))
  const home = join(directory, 'home')
  await mkdir(home, { recursive: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, '[]\n', 'utf8')

  if (options?.installClosedAnalystPreset) {
    await installClosedAnalystPreset(home)
  }

  if (options?.installClosedAnalystPreset) {
    await linkPackagesForPresetMount(directory, await analystSurfacePackageNames())
  } else if (options?.linkStandardPackages) {
    const packages: string[] = await standardPresetPackageNames()
    await linkPackagesForPresetMount(directory, packages)
  }

  const patches = [
    ...patchPaths.flatMap((path) => loadOverlayPatches(label, path)),
    ...(options?.extraPatches ?? []),
  ]

  try {
    const ctx = await boot(label, configPath, patches, (hostCtx) => {
      provideCmdline(hostCtx, {
        args: ['--no-open', '--port', '0', '--host', '127.0.0.1'],
        exit: () => {},
      })
    })
    try {
      return await run(ctx)
    } finally {
      await ctx.fiber.dispose()
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}

it('web-app cordis.patch.yml is resolvable at the upstream-locked version', () => {
  const pkg = require('@deepseek-ai/dsh-web-app/package.json') as { version: string }
  expect(pkg.version).toBe('0.1.5-rc.2')
  expect(() => webPatchPath()).not.toThrow()
  expect(() => webRequire.resolve('@deepseek-ai/dsh-agent-presets/package.json')).not.toThrow()
})

it('boots dsh-base + dsh-web-app with only our three host-plane tools', async () => {
  await withWebAppBoot(
    'p0-4-webapp-host',
    [basePatchPath(), webPatchPath()],
    async (ctx) => {
      const names =
        ctx.tools
          ?.schemas()
          .map((tool) => tool.name)
          .sort() ?? []
      expect(names).toEqual([...HOST_ANALYST_TOOLS])
      for (const name of FORBIDDEN_TOOL_NAMES) expect(names).not.toContain(name)
    },
    { extraPatches: analystInsertPatches('p0-4-webapp-host') },
  )
}, 120_000)

it('standard agent preset standing scope lists the documented (dangerous) tool inventory', async () => {
  await withWebAppBoot(
    'p0-4-webapp-standard',
    [basePatchPath(), webPatchPath()],
    async (ctx) => {
      const hostNames =
        ctx.tools
          ?.schemas()
          .map((tool) => tool.name)
          .sort() ?? []
      expect(hostNames).toEqual([...HOST_ANALYST_TOOLS])

      const agentPresets = ctx.get('agentPresets') as
        { standingKeyFor: (id?: string) => Promise<object> } | undefined
      expect(agentPresets?.standingKeyFor).toEqual(expect.any(Function))

      const standingKey = await agentPresets!.standingKeyFor('standard')
      const scopedNames =
        ctx.tools
          ?.schemas(standingKey as never)
          .map((tool) => tool.name)
          .sort() ?? []

      // Explicit inventory (option b): green only while this matches the
      // recorded standard+analyst surface. A future upstream preset change
      // fails here so product policy re-reviews before claiming a closed UI.
      expect(scopedNames).toEqual([...STANDARD_PRESET_PLUS_ANALYST_TOOLS])

      // Dangerous defaults remain present under `standard` — prefer the closed
      // `analyst` preset (profiles/data-analyst/presets/analyst) for product UI.
      for (const name of [
        'write',
        'edit',
        'read',
        'web_search',
        'web_fetch',
        'subagent_fork',
        'workflow',
        'ralph',
      ] as const) {
        expect(
          scopedNames,
          `standard still exposes ${name}; product must use closed analyst preset`,
        ).toContain(name)
      }
    },
    {
      linkStandardPackages: true,
      extraPatches: analystInsertPatches('p0-4-webapp-standard'),
    },
  )
}, 120_000)

it('closed analyst preset standing scope exposes host tools plus skill', async () => {
  await withWebAppBoot(
    'p0-4-webapp-analyst',
    [basePatchPath(), webPatchPath()],
    async (ctx) => {
      const agentPresets = ctx.get('agentPresets') as
        | { standingKeyFor: (id?: string) => Promise<object>; list?: () => Promise<unknown[]> }
        | undefined
      expect(agentPresets?.standingKeyFor).toEqual(expect.any(Function))

      const standingKey = await agentPresets!.standingKeyFor('analyst')
      const scopedNames =
        ctx.tools
          ?.schemas(standingKey as never)
          .map((tool) => tool.name)
          .sort() ?? []

      expect(scopedNames).toEqual([...PRODUCT_ANALYST_TOOLS])
      for (const name of FORBIDDEN_TOOL_NAMES) {
        expect(scopedNames, `closed analyst preset must not expose ${name}`).not.toContain(name)
      }

      const skills = ctx.get('skills') as
        | {
            list: (options: { scope: object }) => Promise<Array<{ name: string }>>
          }
        | undefined
      expect(skills).toBeDefined()
      const skillNames = (await skills!.list({ scope: standingKey })).map((skill) => skill.name)
      expect(skillNames).toEqual([
        'ingest-kaggle',
        'semantic-layer',
        'sql-safety',
        'viz-conventions',
      ])
      const scopedAgent = standingKey as { session?: { header: { cwd: string } } }
      scopedAgent.session = { header: { cwd: fileURLToPath(new URL('..', import.meta.url)) } }
      const skillTool = ctx.tools.get('skill', standingKey as never)
      expect(skillTool).toBeDefined()
      for (const name of skillNames) {
        const value = await skillTool!.execute({ name }, {
          agent: scopedAgent,
          arguments: { name },
          name: 'skill',
          callId: 'load-skill' as never,
          rootCallId: 'load-skill' as never,
          token: Symbol('load-skill') as never,
          signal: AbortSignal.timeout(5_000),
          deferContext: () => {},
          concludeTurn: () => {},
        } as never)
        const loaded = value as { content: string }
        expect(loaded.content).toContain('## Packaged reference:')
        const rendered = skillTool!.output.render({ name }, value as never)
        expect(rendered[0]?.type).toBe('text')
        if (name === 'sql-safety') {
          expect(loaded.content).toContain('### Descriptive statistics')
          expect(loaded.content).toContain('floor, median, quantile_cont')
          expect(rendered[0]?.type === 'text' ? rendered[0].text : '').toContain(
            '### Ratio of sums',
          )
        }
        /* The standing profile scope has no live session, so invoking the
         * registered definition directly is the credential-free equivalent of
         * the runtime dispatch body. ToolRuntime/session plumbing is covered by
         * upstream; this assertion covers our real scoped loader and renderer. */
        expect(rendered).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: 'text' })]),
        )
      }
    },
    {
      installClosedAnalystPreset: true,
      extraPatches: analystInsertPatches('p0-4-webapp-analyst'),
    },
  )
}, 120_000)

it('closed production profile cannot boot the full dsh-web-app composition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-p0-4-webapp-closed-'))
  const home = join(directory, 'home')
  await mkdir(home, { recursive: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, '[]\n', 'utf8')

  const patches = [
    ...loadOverlayPatches('p0-4-webapp-closed', basePatchPath()),
    ...loadOverlayPatches('p0-4-webapp-closed', webPatchPath()),
    ...loadOverlayPatches('p0-4-webapp-closed', profilePatchPath()),
  ]

  try {
    await expect(
      boot('p0-4-webapp-closed', configPath, patches, (hostCtx) => {
        provideCmdline(hostCtx, {
          args: ['--no-open', '--port', '0', '--host', '127.0.0.1'],
          exit: () => {},
        })
      }),
    ).rejects.toThrow(/did not activate/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)

it('closed profile + NL candidate overlay still cannot boot full dsh-web-app', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-p0-4-webapp-candidate-'))
  const home = join(directory, 'home')
  await mkdir(home, { recursive: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, '[]\n', 'utf8')

  const patches = [
    ...loadOverlayPatches('p0-4-webapp-candidate', basePatchPath()),
    ...loadOverlayPatches('p0-4-webapp-candidate', webPatchPath()),
    ...loadOverlayPatches('p0-4-webapp-candidate', profilePatchPath()),
    ...loadOverlayPatches('p0-4-webapp-candidate', candidatePatchPath()),
  ]

  try {
    await expect(
      boot('p0-4-webapp-candidate', configPath, patches, (hostCtx) => {
        provideCmdline(hostCtx, {
          args: ['--no-open', '--port', '0', '--host', '127.0.0.1'],
          exit: () => {},
        })
      }),
    ).rejects.toThrow(/did not activate/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)

it('webapp-product candidate overlay never re-enables ALWAYS_DISABLED_TOOL_ROWS', () => {
  const patches = loadOverlayPatches('p0-4-webapp-product-rows', webappProductCandidatePatchPath())
  const reenabled = new Set(
    patches
      .filter((patch) => patch.id !== undefined && patch.disabled === false)
      .map((patch) => patch.id as string),
  )
  for (const id of ALWAYS_DISABLED_TOOL_ROWS) {
    expect(reenabled.has(id), `${id} must stay out of the product overlay`).toBe(false)
  }
  for (const id of [
    'open-in-app',
    'ui-open-in-app',
    'workspace-files',
    'ui-deliverables',
  ] as const) {
    const row = patches.find((patch) => patch.id === id)
    expect(row?.disabled, `${id} must be disabled in the product overlay`).toBe(true)
  }
  const presets = patches.find((patch) => patch.id === 'agent-presets')
  expect(presets?.config).toEqual({ default: 'analyst' })
})

it('product composition env stays off by default and enables only when webapp', () => {
  expect(isWebappProductCompositionEnabled({})).toBe(false)
  expect(isWebappProductCompositionEnabled({ [PRODUCT_COMPOSITION_ENV]: 'closed' })).toBe(false)
  expect(
    isWebappProductCompositionEnabled({ [PRODUCT_COMPOSITION_ENV]: PRODUCT_COMPOSITION_WEBAPP }),
  ).toBe(true)

  const closed = resolveProductCompositionPatchPaths({})
  expect(closed).toEqual([basePatchPath(), webPatchPath(), profilePatchPath()])
  expect(closed).not.toContain(webappProductCandidatePatchPath())

  const optedIn = resolveProductCompositionPatchPaths({
    [PRODUCT_COMPOSITION_ENV]: PRODUCT_COMPOSITION_WEBAPP,
  })
  expect(optedIn).toEqual([
    basePatchPath(),
    webPatchPath(),
    profilePatchPath(),
    webappProductCandidatePatchPath(),
  ])
})

it('boots closed profile + webapp-product candidate with analyst default and skill tool', async () => {
  await withWebAppBoot(
    'p0-4-webapp-product',
    [basePatchPath(), webPatchPath(), profilePatchPath(), webappProductCandidatePatchPath()],
    async (ctx) => {
      const hostNames =
        ctx.tools
          ?.schemas()
          .map((tool) => tool.name)
          .sort() ?? []
      expect(hostNames).toEqual([...HOST_ANALYST_TOOLS])
      for (const name of FORBIDDEN_TOOL_NAMES) expect(hostNames).not.toContain(name)

      const agentPresets = ctx.get('agentPresets') as
        | {
            defaultId: string
            standingKeyFor: (id?: string) => Promise<object>
          }
        | undefined
      expect(agentPresets?.standingKeyFor).toEqual(expect.any(Function))
      expect(agentPresets?.defaultId).toBe('analyst')
      expect(ctx.get('sessionProjections')).toBeDefined()
      expect(ctx.get('tokenMeter')).toBeDefined()

      const analystKey = await agentPresets!.standingKeyFor('analyst')
      const analystNames =
        ctx.tools
          ?.schemas(analystKey as never)
          .map((tool) => tool.name)
          .sort() ?? []
      expect(analystNames).toEqual([...PRODUCT_ANALYST_TOOLS])
      for (const name of FORBIDDEN_TOOL_NAMES) {
        expect(analystNames, `closed analyst preset must not expose ${name}`).not.toContain(name)
      }

      const graphIds = hostWebSurfaceReport(ctx).graphIds
      for (const id of [
        '@deepseek-ai/dsh-typert-registry',
        '@deepseek-ai/dsh-api-gateway',
        '@deepseek-ai/dsh-api-remotes',
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-client-ui-chat',
      ] as const) {
        expect(graphIds, `browser module graph must include ${id}`).toContain(id)
      }

      // Shipped `standard` may still resolve; if it mounts, it remains dangerous.
      // Under the closed product overlay it often fails to mount (tool rows wait
      // on ALWAYS_DISABLED services). Product policy relies on defaultId === analyst.
      try {
        const standardKey = await agentPresets!.standingKeyFor('standard')
        const standardNames =
          ctx.tools
            ?.schemas(standardKey as never)
            .map((tool) => tool.name)
            .sort() ?? []
        for (const name of ['bash', 'write', 'web_search', 'subagent_fork'] as const) {
          expect(standardNames, `standard still exposes ${name}; keep defaultId=analyst`).toContain(
            name,
          )
        }
      } catch (error) {
        expect(String(error)).toMatch(
          /unknown|not found|unavailable|no configured root|failed to mount|did not activate/i,
        )
      }
    },
    {
      linkStandardPackages: true,
      installClosedAnalystPreset: true,
    },
  )
}, 120_000)

it('DSH_DATA_PRODUCT_COMPOSITION=webapp boots with skill tool and defaultId analyst', async () => {
  const previous = process.env[PRODUCT_COMPOSITION_ENV]
  process.env[PRODUCT_COMPOSITION_ENV] = PRODUCT_COMPOSITION_WEBAPP
  try {
    const patchPaths = resolveProductCompositionPatchPaths()
    expect(patchPaths.at(-1)).toBe(webappProductCandidatePatchPath())
    await withWebAppBoot(
      'p0-4-webapp-product-env',
      patchPaths,
      async (ctx) => {
        const agentPresets = ctx.get('agentPresets') as
          | {
              defaultId: string
              standingKeyFor: (id?: string) => Promise<object>
            }
          | undefined
        expect(agentPresets?.defaultId).toBe('analyst')
        const analystKey = await agentPresets!.standingKeyFor('analyst')
        const tools =
          ctx.tools
            ?.schemas(analystKey as never)
            .map((tool) => tool.name)
            .sort() ?? []
        expect(tools).toEqual([...PRODUCT_ANALYST_TOOLS])
        for (const name of FORBIDDEN_TOOL_NAMES) expect(tools).not.toContain(name)
      },
      {
        linkStandardPackages: true,
        installClosedAnalystPreset: true,
      },
    )
  } finally {
    if (previous === undefined) delete process.env[PRODUCT_COMPOSITION_ENV]
    else process.env[PRODUCT_COMPOSITION_ENV] = previous
  }
}, 120_000)
