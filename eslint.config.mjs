import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['deepseek-harness/**', '**/dist/**', '**/node_modules/**', 'coverage/**'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // packages/dsh-data-viz/client.js is the Analysis Studio sidebar UI. It is
    // hand-authored `createElement` calls loaded in a browser via the
    // harness's `__ModuleLoader__` contract (see the bottom of the file) -
    // there is no Node module system and no JSX/build step (see
    // docs/implementation.md, "Client bundle build step"). It is plain
    // script, not a TS/ESM module, so it gets its own, narrower ruleset
    // rather than the `**/*.ts` block above: no TypeScript-aware rules (they
    // assume a type checker and ESM), and a browser global set instead of
    // Node's.
    files: ['packages/dsh-data-viz/client.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 2020,
      globals: {
        window: 'readonly',
        document: 'readonly',
        AbortController: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        FormData: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        history: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
