#!/usr/bin/env node
/**
 * Persistent dsh analyst session launcher.
 *
 * Boots dsh-base + dsh-web-app + closed profile + webapp-product candidate with
 * the closed `analyst` preset under a durable DSH_HOME. Stays running until
 * SIGINT/SIGTERM. Opt-in only:
 *
 *   DSH_DATA_PRODUCT_COMPOSITION=webapp npm run serve:analyst
 *
 * Env:
 *   DSH_HOME              durable home (default: <repo>/.dsh-home)
 *   DSH_ANALYST_HOST      bind host (default: 127.0.0.1; 0.0.0.0 refused by dsh)
 *   DSH_ANALYST_PORT      listen port (default: 3080)
 *   DSH_ANALYST_OPEN      set to 1 to open the default browser
 *   DEEPSEEK_API_KEY      required for model chat (boot works without it)
 *
 * Does not promote the live default profile. Skills load from explicit project
 * roots (`includeDefaultRoots: false`); see the four packages under skills/.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  PRODUCT_COMPOSITION_ENV,
  PRODUCT_COMPOSITION_WEBAPP,
  analystSurfacePackageNames,
  closedAnalystToolNames,
  defaultAnalystHomeDir,
  hostWebSurfaceReport,
  installClosedAnalystPreset,
  isWebappProductCompositionEnabled,
  linkPackagesForPresetMount,
  resolveProductCompositionPatchPaths,
  root,
} from './product-composition.mjs'

function fail(message, extra = {}) {
  console.error(
    JSON.stringify({
      ok: false,
      error: message,
      composition: PRODUCT_COMPOSITION_WEBAPP,
      ...extra,
    }),
  )
  process.exitCode = 1
}

if (!isWebappProductCompositionEnabled()) {
  fail(
    `refusing default closed boot: set ${PRODUCT_COMPOSITION_ENV}=${PRODUCT_COMPOSITION_WEBAPP}`,
    {
      note: 'Live default profile stays closed; use the opt-in composition for R1 serve.',
    },
  )
  process.exit(1)
}

const host = process.env.DSH_ANALYST_HOST ?? '127.0.0.1'
const port = process.env.DSH_ANALYST_PORT ?? '3080'
const openBrowser = process.env.DSH_ANALYST_OPEN === '1'
const home = process.env.DSH_HOME ?? defaultAnalystHomeDir()
const configDir = join(home, 'boot')
const configPath = join(configDir, 'cordis.yml')
const label = 'serve-analyst-session'

await mkdir(home, { recursive: true })
await mkdir(configDir, { recursive: true })
await writeFile(configPath, '[]\n', 'utf8')

process.env.DSH_HOME = home

const args = ['--host', host, '--port', String(port)]
if (!openBrowser) args.push('--no-open')

let ctx
try {
  await installClosedAnalystPreset(home)
  await linkPackagesForPresetMount(configDir, await analystSurfacePackageNames())

  const patchPaths = resolveProductCompositionPatchPaths({ forceProduct: true })
  const patches = patchPaths.flatMap((path) => loadOverlayPatches(label, path))

  ctx = await boot(label, configPath, patches, (hostCtx) => {
    provideCmdline(hostCtx, {
      args,
      exit: (code) => {
        process.exitCode = code ?? 0
      },
    })
  })

  const surface = await closedAnalystToolNames(ctx)
  if (surface.defaultPreset !== 'analyst' || surface.missing.length || surface.forbidden.length) {
    fail('closed analyst surface assertion failed', {
      tools: surface.tools,
      defaultPreset: surface.defaultPreset,
      missing: surface.missing,
      forbidden: surface.forbidden,
      patchPaths,
      dshHome: home,
    })
    await ctx.fiber.dispose()
    process.exit(1)
  }

  const webSurface = hostWebSurfaceReport(ctx)
  const requiredGraph = [
    '@deepseek-ai/dsh-typert-registry',
    '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-ui-chat',
    'dsh-data-analyst',
  ]
  const missingGraph = requiredGraph.filter((id) => !webSurface.graphIds.includes(id))
  if (missingGraph.length) {
    fail('browser module graph missing remotes/chat packages', {
      missingGraph,
      graphCount: webSurface.graphIds.length,
      dshHome: home,
    })
    await ctx.fiber.dispose()
    process.exit(1)
  }

  const workspaceRoot = process.env.DSH_DATA_WORKSPACE
  let attachedWorkspace = null
  if (workspaceRoot) {
    const registry = ctx.get('workspaceRegistry')
    if (typeof registry?.create !== 'function') {
      fail('workspaceRegistry.create unavailable', { dshHome: home, workspaceRoot })
      await ctx.fiber.dispose()
      process.exit(1)
    }
    try {
      const created = await registry.create(workspaceRoot, 'Analyst data')
      attachedWorkspace = { id: created.id, title: created.title, path: created.path }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), { dshHome: home, workspaceRoot })
      await ctx.fiber.dispose()
      process.exit(1)
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      serving: true,
      tools: surface.tools,
      defaultPreset: surface.defaultPreset,
      composition: PRODUCT_COMPOSITION_WEBAPP,
      dshHome: home,
      host,
      port: Number(port),
      workspaceHint: workspaceRoot ?? join(root, 'datasets/dev'),
      attachedWorkspace,
      hasDeepseekKey: Boolean(process.env.DEEPSEEK_API_KEY ?? process.env.DSH_NL_API_KEY),
      note: 'Persistent opt-in dsh web session. Watch for "dsh web:" URL line. SIGINT to stop. Skills load from the four packages under skills/.',
    }),
  )

  try {
    const skills = ctx.get('skills')
    const listed = await skills?.list?.({ scope: surface.standingKey })
    const skillNames = (listed ?? []).map((s) => s.name).sort()
    console.log(JSON.stringify({ ok: true, skillNames }))
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        skillListError: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  await new Promise((resolve) => {
    const stop = async (signal) => {
      console.error(JSON.stringify({ ok: true, stopping: true, signal }))
      try {
        await ctx.fiber.dispose()
      } catch (error) {
        console.error(
          JSON.stringify({
            ok: false,
            disposeError: error instanceof Error ? error.message : String(error),
          }),
        )
      }
      resolve()
    }
    process.once('SIGINT', () => void stop('SIGINT'))
    process.once('SIGTERM', () => void stop('SIGTERM'))
  })
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), { dshHome: home })
  if (ctx) {
    try {
      await ctx.fiber.dispose()
    } catch {
      // ignore dispose after boot failure
    }
  }
  process.exit(1)
}
