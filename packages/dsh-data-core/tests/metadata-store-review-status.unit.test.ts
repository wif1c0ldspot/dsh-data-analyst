import { describe, expect, it } from 'vitest'
import { analysisRevisionDigest } from '../src/metadata-store.js'

/**
 * The sidebar polls `getAnalystReviewStatus` and refreshes saved views when the
 * signature changes. Count + latest-create-time missed a delete followed by a create
 * inside the same second, which is why the signature is a digest of identities.
 */
describe('analysisRevisionDigest', () => {
  const rows = [
    { analysisId: 'ana_a', revision: 1, createdAt: '2026-09-20T06:00:00.000Z' },
    { analysisId: 'ana_b', revision: 1, createdAt: '2026-09-20T06:00:01.000Z' },
  ]

  it('is stable for the same revision set', () => {
    expect(analysisRevisionDigest([...rows])).toBe(analysisRevisionDigest([...rows]))
  })

  it('changes when a delete and a create share a second and a count', () => {
    // Same number of revisions, same latest timestamp — the old count+max signature was
    // identical here, so the poll saw no change at all.
    const afterSwap = [
      { analysisId: 'ana_a', revision: 1, createdAt: '2026-09-20T06:00:00.000Z' },
      { analysisId: 'ana_c', revision: 1, createdAt: '2026-09-20T06:00:01.000Z' },
    ]
    expect(afterSwap.length).toBe(rows.length)
    expect(afterSwap.at(-1)!.createdAt).toBe(rows.at(-1)!.createdAt)
    expect(analysisRevisionDigest(afterSwap)).not.toBe(analysisRevisionDigest(rows))
  })

  it('changes when a revision is added or removed', () => {
    const added = [
      ...rows,
      { analysisId: 'ana_a', revision: 2, createdAt: '2026-09-20T06:00:01.000Z' },
    ]
    expect(analysisRevisionDigest(added)).not.toBe(analysisRevisionDigest(rows))
    expect(analysisRevisionDigest([rows[0]!])).not.toBe(analysisRevisionDigest(rows))
  })
})
