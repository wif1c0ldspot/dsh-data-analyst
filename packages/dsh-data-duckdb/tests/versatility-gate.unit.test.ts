/**
 * Cheap structural guard for the versatility gate: the case list still covers
 * every required messy-data condition, the CLI wiring exists, and the runtime
 * fixture builders behave (RFC4180 quoting, encodings, BOMs) — without running
 * the pipeline. The pipeline-driving cases live in
 * `scripts/run-versatility-gate.mjs` (`pnpm eval:versatility`), deliberately
 * outside `pnpm check`, because they spawn native workers and generate
 * fixtures up to a few hundred thousand rows.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  readFixtureFile,
  csvBytes,
  csvField,
  utf16beWithBomBytes,
  utf16leWithBomBytes,
  windows1252Bytes,
  writeFixtureFile,
} from '../src/versatility-fixtures.js'
import { VERSATILITY_CASES, VERSATILITY_REQUIREMENTS } from '../src/versatility-gate.js'

it('every required messy-data condition maps to at least one gate case', () => {
  const known = new Set(VERSATILITY_REQUIREMENTS.map((requirement) => requirement.key))
  for (const entry of VERSATILITY_CASES) {
    for (const requirement of entry.requirements) {
      expect(known.has(requirement), `${entry.id} cites unknown requirement ${requirement}`).toBe(
        true,
      )
    }
  }
  for (const requirement of VERSATILITY_REQUIREMENTS) {
    const covering = VERSATILITY_CASES.filter((entry) =>
      entry.requirements.includes(requirement.key),
    ).map((entry) => entry.id)
    expect(covering.length, `no case covers ${requirement.key}`).toBeGreaterThan(0)
  }
})

it('case ids are unique and every case declares its documented contract', () => {
  const ids = VERSATILITY_CASES.map((entry) => entry.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const entry of VERSATILITY_CASES) {
    expect(entry.documentedContract.length, entry.id).toBeGreaterThan(40)
    expect(entry.entryPoints.length, entry.id).toBeGreaterThan(0)
  }
})

it('the versatility gate is wired as a pnpm script that runs the CLI', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> }
  expect(manifest.scripts['eval:versatility']).toContain('run-versatility-gate.mjs')
})

it('RFC4180 quoting, latin1 bytes and UTF-16 BOMs are produced exactly', async () => {
  expect(csvField('plain')).toBe('plain')
  expect(csvField('a,b')).toBe('"a,b"')
  expect(csvField('say "hi"')).toBe('"say ""hi"""')
  expect(csvField('two\nlines')).toBe('"two\nlines"')
  expect(csvField(null)).toBe('')
  expect(csvBytes([['a', 'b']]).toString('utf8')).toBe('a,b\n')
  expect(csvBytes([['a,b', 'c']]).toString('utf8')).toBe('"a,b",c\n')

  const latin1 = windows1252Bytes('Café')
  expect([...latin1]).toEqual([0x43, 0x61, 0x66, 0xe9])
  expect(() => windows1252Bytes('→')).toThrow(/latin1-range/)

  const utf16le = utf16leWithBomBytes('A')
  expect([...utf16le]).toEqual([0xff, 0xfe, 0x41, 0x00])
  const utf16be = utf16beWithBomBytes('A')
  expect([...utf16be]).toEqual([0xfe, 0xff, 0x00, 0x41])
})

it('fixture files are written to and read back from a caller-owned temp directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-versatility-fixture-'))
  try {
    const path = await writeFixtureFile(directory, 'sample.csv', csvBytes([['id'], [1]]))
    expect(path.startsWith(directory)).toBe(true)
    expect((await readFixtureFile(path)).toString('utf8')).toBe('id\n1\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
