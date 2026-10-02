// Pure helper functions for doctor.mjs, split out so they can be unit tested
// without actually shelling out to sysctl or touching the filesystem.

/**
 * Decide whether the currently-running Node binary is x64 code being
 * emulated by Rosetta 2 on Apple Silicon hardware.
 *
 * This intentionally does NOT use `sysctl.proc_translated`: that key
 * describes whether the *calling process tree* (e.g. the terminal/shell)
 * is translated, not whether the actual Node binary in this process is
 * native arm64 or emulated x64. A native arm64 Node launched from inside a
 * translated terminal would be misdiagnosed as broken by that key, while it
 * still could not distinguish that false positive from a genuinely broken
 * x64 Node. The only combination that is actually broken is: the hardware
 * is Apple Silicon (`hw.optional.arm64` = 1) and the running binary itself
 * is x64 (`process.arch` = 'x64'). A native arm64 binary is healthy
 * regardless of what shell/terminal launched it.
 *
 * @param {{ platform: string, arch: string, hardwareArm64: boolean }} params
 * @returns {boolean}
 */
export function isRosettaNode({ platform, arch, hardwareArm64 }) {
  return platform === 'darwin' && arch === 'x64' && hardwareArm64 === true
}
