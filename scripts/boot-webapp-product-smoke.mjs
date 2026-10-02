#!/usr/bin/env node
/**
 * One-shot smoke: boot dsh-base + dsh-web-app + closed profile + opt-in
 * webapp-product candidate with the closed `analyst` preset, print JSON
 * { ok, tools, defaultPreset }, dispose, exit.
 *
 * Host:  npm run smoke:agent:boot
 * This is a local composition smoke; no container runtime is required.
 * Prefer: npm run smoke:product:composition (env-gated product entrypoint)
 *
 * Does not enable bash/fs/web tools. Loopback cmdline only (--host 127.0.0.1).
 * Does not claim Core exit — inventory/boot proof only.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PRODUCT_COMPOSITION_ENV, PRODUCT_COMPOSITION_WEBAPP } from './product-composition.mjs'

const script = fileURLToPath(new URL('./run-product-composition.mjs', import.meta.url))
const result = spawnSync(process.execPath, [script], {
  env: {
    ...process.env,
    [PRODUCT_COMPOSITION_ENV]: PRODUCT_COMPOSITION_WEBAPP,
  },
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
