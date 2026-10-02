#!/usr/bin/env node
/**
 * Opt-in product composition one-shot / hold:
 *   dsh-base + dsh-web-app + closed profile + webapp-product candidate
 *   + closed `analyst` preset installed under $DSH_HOME
 *
 * Requires DSH_DATA_PRODUCT_COMPOSITION=webapp (does not change default closed
 * boots). Prints JSON { ok, tools, defaultPreset, composition, note } and exits.
 *
 * Host: npm run smoke:product:composition
 * Same stack as smoke:agent:boot / boot-webapp-product-smoke.mjs.
 *
 * For a long-running UI session use: npm run serve:analyst
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  ANALYST_TOOLS,
  FORBIDDEN_TOOL_NAMES,
  PRODUCT_COMPOSITION_ENV,
  PRODUCT_COMPOSITION_WEBAPP,
  closedAnalystToolNames,
  hostWebSurfaceReport,
  installClosedAnalystPreset,
  isWebappProductCompositionEnabled,
  linkPackagesForPresetMount,
  resolveProductCompositionPatchPaths,
  analystSurfacePackageNames,
} from './product-composition.mjs'

function fail(error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error)
  console.log(
    JSON.stringify({
      ok: false,
      tools: [],
      defaultPreset: null,
      composition: PRODUCT_COMPOSITION_WEBAPP,
      error: message,
      ...extra,
    }),
  )
  process.exitCode = 1
}

if (!isWebappProductCompositionEnabled()) {
  fail(
    new Error(
      `refusing default closed boot: set ${PRODUCT_COMPOSITION_ENV}=${PRODUCT_COMPOSITION_WEBAPP} to opt in`,
    ),
    {
      note: 'Production profile alone stays closed; use serve:analyst for persistent dsh UI.',
    },
  )
  process.exit(process.exitCode ?? 1)
}

const label = 'run-product-composition'
const directory = await mkdtemp(join(tmpdir(), 'dsh-product-composition-'))
const home = join(directory, 'home')
await mkdir(home, { recursive: true })
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const configPath = join(directory, 'cordis.yml')
await writeFile(configPath, '[]\n', 'utf8')

try {
  await installClosedAnalystPreset(home)
  await linkPackagesForPresetMount(directory, await analystSurfacePackageNames())

  const patchPaths = resolveProductCompositionPatchPaths({ forceProduct: true })
  const patches = patchPaths.flatMap((path) => loadOverlayPatches(label, path))

  const ctx = await boot(label, configPath, patches, (hostCtx) => {
    provideCmdline(hostCtx, {
      args: ['--no-open', '--port', '0', '--host', '127.0.0.1'],
      exit: () => {},
    })
  })

  try {
    const surface = await closedAnalystToolNames(ctx)
    const { tools, defaultPreset, standingKey, missing, forbidden } = surface
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

    if (defaultPreset !== 'analyst' || missing.length || forbidden.length || missingGraph.length) {
      fail(new Error('closed analyst surface assertion failed'), {
        tools,
        defaultPreset,
        missing,
        forbidden,
        missingGraph,
        graphCount: webSurface.graphIds.length,
        patchPaths,
      })
    } else {
      const holdMsRaw = Number(process.env.DSH_PRODUCT_HOLD_MS ?? '0')
      const holdMs = Number.isFinite(holdMsRaw) && holdMsRaw > 0 ? Math.floor(holdMsRaw) : 0
      let holdPolls = 0
      if (holdMs > 0) {
        const deadline = Date.now() + holdMs
        while (Date.now() < deadline) {
          const still =
            ctx.tools
              ?.schemas(standingKey)
              .map((tool) => tool.name)
              .sort() ?? []
          const stillMissing = ANALYST_TOOLS.filter((name) => !still.includes(name))
          const stillForbidden = FORBIDDEN_TOOL_NAMES.filter((name) => still.includes(name))
          if (stillMissing.length || stillForbidden.length) {
            throw new Error(
              `tool surface drifted during hold (missing=${stillMissing}; forbidden=${stillForbidden})`,
            )
          }
          holdPolls += 1
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
      console.log(
        JSON.stringify({
          ok: true,
          tools,
          defaultPreset,
          composition: PRODUCT_COMPOSITION_WEBAPP,
          patchPaths,
          holdMs,
          holdPolls,
          graphCount: webSurface.graphIds.length,
          note:
            holdMs > 0
              ? 'Opt-in product composition held open; tools re-checked. Use serve:analyst for durable UI.'
              : 'Opt-in one-shot inventory proof. Use serve:analyst for persistent dsh web session (R1).',
        }),
      )
    }
  } finally {
    await ctx.fiber.dispose()
  }
} catch (error) {
  fail(error)
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(directory, { recursive: true, force: true })
}
