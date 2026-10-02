import { describe, expect, it } from 'vitest'
import { isRosettaNode } from '../scripts/doctor-checks.mjs'

describe('isRosettaNode', () => {
  it('treats a native arm64 node on arm64 hardware as healthy (the former false positive)', () => {
    expect(isRosettaNode({ platform: 'darwin', arch: 'arm64', hardwareArm64: true })).toBe(false)
  })

  it('flags an x64 node running on arm64 (Apple Silicon) hardware as Rosetta translation', () => {
    expect(isRosettaNode({ platform: 'darwin', arch: 'x64', hardwareArm64: true })).toBe(true)
  })

  it('treats an x64 node on x64 hardware (Intel Mac) as native, not a gap', () => {
    expect(isRosettaNode({ platform: 'darwin', arch: 'x64', hardwareArm64: false })).toBe(false)
  })

  it('treats a non-darwin platform as not applicable regardless of arch/hardware', () => {
    expect(isRosettaNode({ platform: 'linux', arch: 'x64', hardwareArm64: true })).toBe(false)
  })

  it('treats a missing/failed sysctl read (hardwareArm64 false) as "not Apple Silicon", never a gap', () => {
    // doctor.mjs maps a missing or failed `sysctl -n hw.optional.arm64` call to
    // hardwareArm64: false before calling this predicate; verify that mapping
    // can never produce a gap even for an x64 binary.
    expect(isRosettaNode({ platform: 'darwin', arch: 'x64', hardwareArm64: false })).toBe(false)
  })
})
