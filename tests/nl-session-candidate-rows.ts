/** Rows that may be re-enabled for a dsh agent chat (still disabled in the live profile). */
export const NL_SESSION_CANDIDATE_ROWS = [
  'llm',
  'llm-pi-ai',
  'llm-retry',
  'llm-deepseek',
  'deepseek-llm-api-extensions',
  'agent-default-model',
  'agent',
  'agent-loop',
  'session',
  'session-log-deepseek',
  'session-persistence-jsonl',
  'session-query-sqlite',
  'session-projection',
  'session-projection-cache',
  'storage',
  'storage-json',
  'storage-domain',
  'credentials',
  'settings',
  'user-questions',
] as const

/** Must stay disabled even after NL session composition. */
export const ALWAYS_DISABLED_TOOL_ROWS = [
  'tool-bash',
  'tool-pwsh',
  'bash-sandbox',
  'pwsh-sandbox',
  'subprocess',
  'sandbox',
  'sandbox-policy',
  'web',
  'web-search-deepseek',
  'web-fetch-http',
  'tool-web',
  'subagent',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-fs',
  'tool-workflow',
  'tool-ralph',
] as const

/** Skill registry + tool may be enabled on the opt-in product composition (R2). */
export const PRODUCT_SKILL_ROWS = ['skill', 'tool-skill'] as const

/** Must stay disabled on the live closed profile (includes skill until promoted). */
export const LIVE_DISABLED_EXTRA_ROWS = ['skill', 'tool-skill'] as const
