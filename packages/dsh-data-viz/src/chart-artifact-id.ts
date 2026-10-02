/** Artifact identity and the authenticated dsh fetch path for chart bytes. */

export const ARTIFACT_ID_RE = /^art_[a-z0-9]+$/i

/** Exact Connection fetch route (below `/api`) for chart SVG/PNG/JSON. */
export const CHART_ARTIFACT_FETCH_PATH = '/api/analyst/artifacts'

/** Parse `make_chart` model-facing JSON (or a bare id) into a safe artifact id. */
export function parseMakeChartArtifactId(text: string): string | null {
  const trimmed = text.trim()
  if (ARTIFACT_ID_RE.test(trimmed)) return trimmed
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && 'artifactId' in parsed) {
      const id = (parsed as { artifactId: unknown }).artifactId
      if (typeof id === 'string' && ARTIFACT_ID_RE.test(id)) return id
    }
  } catch {
    return null
  }
  return null
}
