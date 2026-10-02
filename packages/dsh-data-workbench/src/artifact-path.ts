import { join, resolve, sep } from 'node:path'

const NAMED_ARTIFACT = /\.(svg|json|html|csv|png|zip)$/i

/** Resolve a basename artifact under artifactsRoot; reject traversal. */
export function resolveSafeArtifact(artifactsRoot: string, idOrFile: string): string | null {
  const base = NAMED_ARTIFACT.test(idOrFile) ? idOrFile : `${idOrFile}.svg`
  if (base.includes('..') || base.includes('/') || base.includes('\\') || base.includes('\0')) {
    return null
  }
  const candidate = resolve(join(artifactsRoot, base))
  if (candidate !== artifactsRoot && !candidate.startsWith(artifactsRoot + sep)) return null
  return candidate
}
