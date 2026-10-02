import { join, resolve, sep } from 'node:path'
import { ARTIFACT_ID_RE } from './chart-artifact-id.js'

const NAMED_CHART_ARTIFACT = /\.(svg|json|png)$/i

/** Resolve a chart artifact basename under artifactsRoot; reject traversal. */
export function resolveSafeChartArtifact(
  artifactsRoot: string,
  idOrFile: string,
  extension: 'svg' | 'json' | 'png' = 'svg',
): string | null {
  const base = NAMED_CHART_ARTIFACT.test(idOrFile) ? idOrFile : `${idOrFile}.${extension}`
  const id = base.replace(NAMED_CHART_ARTIFACT, '')
  if (!ARTIFACT_ID_RE.test(id)) return null
  if (base.includes('..') || base.includes('/') || base.includes('\\') || base.includes('\0')) {
    return null
  }
  const root = resolve(artifactsRoot)
  const candidate = resolve(join(root, base))
  if (candidate !== root && !candidate.startsWith(root + sep)) return null
  return candidate
}
