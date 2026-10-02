/**
 * Deterministic clarify|refuse gate for the analyst ask path (Core v1 DoD).
 * Runs before SQL generation so ambiguous/unsupported asks fail explicitly
 * without spending a model call or opening DuckDB.
 */
import type { SemanticRevision } from 'dsh-data-core/semantics'

export type AnalystQuestionIntent = 'answer' | 'clarify' | 'refuse'

const EXPLICIT_FIELD_VALUE_COMPARISON = /\b(?:labels?|field\s+values?)\b/i

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function containsSemanticTerm(text: string, term: string): boolean {
  const needle = normalizeForMatch(term)
  return needle.length > 0 && ` ${normalizeForMatch(text)} `.includes(` ${needle} `)
}

function namedDatasetsIn(text: string, knownDatasetIds: readonly string[]): Set<string> {
  const normalizedText = ` ${normalizeForMatch(text)} `
  const candidates: Array<{ datasetId: string; start: number; end: number }> = []

  for (const datasetId of knownDatasetIds) {
    const normalizedId = normalizeForMatch(datasetId)
    if (!normalizedId) continue
    const needle = ` ${normalizedId} `
    let offset = 0
    while (offset < normalizedText.length) {
      const index = normalizedText.indexOf(needle, offset)
      if (index === -1) break
      candidates.push({
        datasetId,
        start: index + 1,
        end: index + 1 + normalizedId.length,
      })
      offset = index + 1
    }
  }

  candidates.sort(
    (left, right) => right.end - right.start - (left.end - left.start) || left.start - right.start,
  )
  const selected: typeof candidates = []
  for (const candidate of candidates) {
    const overlaps = selected.some(
      (mention) => candidate.start < mention.end && mention.start < candidate.end,
    )
    if (!overlaps) selected.push(candidate)
  }
  return new Set(selected.map((mention) => mention.datasetId))
}

/**
 * Classify an analyst question before SQL generation.
 * `datasetId` is the active published dataset when the ask is scoped.
 */
export function classifyAnalystQuestion(
  question: string,
  opts: {
    datasetId?: string
    knownDatasetIds?: readonly string[]
    semantics?: Pick<SemanticRevision, 'aliases' | 'metricTermsRequiringApproval'>
  } = {},
): AnalystQuestionIntent {
  const q = question.trim()
  const lower = q.toLowerCase()
  if (!lower) return 'clarify'

  // Destructive / write / escape intents — refuse first.
  if (
    /\b(drop|truncate)\b/i.test(q) ||
    /\bwipe\s+(?:the\s+)?(?:table|data|rows?)\b/i.test(q) ||
    /\bdelete\s+from\b/i.test(q) ||
    /\bupdate\s+(\w+\s+set|all)\b/i.test(q) ||
    /\battach\s+database\b/i.test(q) ||
    /\bcopy\s+\w+\s+to\b/i.test(q) ||
    /\bexport\s+(every|all)\s+rows?\b/i.test(q)
  ) {
    return 'refuse'
  }

  const named = namedDatasetsIn(q, opts.knownDatasetIds ?? [])
  if (/\bjoin\b/i.test(q) && named.size >= 2) return 'refuse'
  if (/\bcompare\b/i.test(q) && named.size >= 2 && !EXPLICIT_FIELD_VALUE_COMPARISON.test(q)) {
    return 'clarify'
  }

  // Ambiguous relative time / period without a fixed clock.
  if (
    /\blast\s+(week|month|quarter|year)\b/i.test(q) ||
    /\brecent\b/i.test(q) ||
    /\byear[\s-]?over[\s-]?year\b/i.test(q) ||
    /\byoy\b/i.test(q) ||
    /\bthis\s+(week|month|quarter|year)\b/i.test(q)
  ) {
    return 'clarify'
  }

  const semantics = opts.semantics
  for (const term of semantics?.metricTermsRequiringApproval ?? []) {
    const approved = semantics?.aliases.some(
      (alias) => alias.term.trim().toLowerCase() === term.trim().toLowerCase(),
    )
    if (!approved && containsSemanticTerm(q, term)) return 'clarify'
  }

  return 'answer'
}

export function clarifyRefuseMessage(intent: 'clarify' | 'refuse', question: string): string {
  if (intent === 'refuse') {
    return (
      `Refused: "${question.trim()}" is unsupported for the read-only analyst ` +
      '(destructive, cross-dataset join, or unauthorized export/attach).'
    )
  }
  return (
    `Clarification needed: "${question.trim()}" is ambiguous ` +
    '(relative time, missing metric definition, or multi-dataset scope). ' +
    'Specify an absolute period, approved metric/alias, or a single dataset.'
  )
}
