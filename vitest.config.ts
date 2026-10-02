import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Native libraries run in isolated child processes; no credentials/network needed.
    pool: 'forks',
    testTimeout: 15_000,
    hookTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/tests/**/*.unit.test.ts', 'tests/**/*.unit.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/tests/**/*.integration.test.ts', 'tests/**/*.integration.test.ts'],
        },
      },
    ],
  },
})
