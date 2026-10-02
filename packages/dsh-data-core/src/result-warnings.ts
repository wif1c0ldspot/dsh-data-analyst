/**
 * Result-warning classification.
 *
 * `duckdb_query` prints at most `maxPreviewRows` rows in the payload it hands the
 * model and says so ("Preview capped at N of M rows; the full result remains
 * authorized and complete"). That notice is a fact about the *transport* — how
 * much of the result the model was shown — not a caveat about the data.
 *
 * Treating it as a data caveat had two visible consequences in one live run: every
 * chart drawn from that result wore it as a subtitle, and it shipped inside the
 * exported report, telling the reader that a chart which draws the complete result
 * was a 20-row preview (measured on a 2,454-row histogram, a 117-point line chart
 * and a 34-bin bar chart). It belongs in the tool payload, so this module is used
 * to keep it out of everything that is stored, charted or exported.
 */
export const PAYLOAD_PREVIEW_WARNING_PREFIX = 'Preview capped at '

export function isPayloadPreviewWarning(warning: string): boolean {
  return warning.startsWith(PAYLOAD_PREVIEW_WARNING_PREFIX)
}

/**
 * Split a query result's warnings into the payload-transport notices (returned to
 * the model only) and the data caveats (stored, charted, exported).
 */
export function splitResultWarnings(warnings: readonly string[]): {
  payloadNotes: string[]
  dataWarnings: string[]
} {
  const payloadNotes: string[] = []
  const dataWarnings: string[] = []
  for (const warning of warnings) {
    if (isPayloadPreviewWarning(warning)) payloadNotes.push(warning)
    else dataWarnings.push(warning)
  }
  return { payloadNotes, dataWarnings }
}
