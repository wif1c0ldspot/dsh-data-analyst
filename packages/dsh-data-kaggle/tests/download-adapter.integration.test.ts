import { mkdtemp, rm, writeFile, chmod, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  InvalidKaggleSlugError,
  KaggleDownloadTimeoutError,
  MissingKaggleExecutableError,
  runKaggleDownload,
  validateKaggleSlug,
} from '../src/download-adapter.js'

let directory: string
let stubPath: string
let destinationDir: string
let markerPath: string

/**
 * Write an executable Node stub standing in for the real `kaggle` CLI, so
 * these tests need no network access or credentials. It writes its own
 * received argv to `markerPath` as JSON, so tests can assert the fixed
 * argument array actually sent, then behaves according to `behavior`.
 */
async function writeStub(behavior: string): Promise<void> {
  const script = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)))
${behavior}
`
  await writeFile(stubPath, script, 'utf8')
  await chmod(stubPath, 0o755)
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-kaggle-test-'))
  stubPath = join(directory, 'kaggle-stub.mjs')
  destinationDir = join(directory, 'job-dest')
  markerPath = join(directory, 'argv.json')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('fails closed with a recovery hint when the kaggle executable is missing', async () => {
  const missing = join(directory, 'no-such-kaggle')
  await expect(
    runKaggleDownload(
      { slug: 'owner/dataset', sourceVersion: '1', destinationDir },
      { kaggleExecutable: missing },
    ),
  ).rejects.toSatisfy((error: unknown) => {
    expect(error).toBeInstanceOf(MissingKaggleExecutableError)
    expect((error as Error).message).toMatch(/uv sync/)
    expect((error as Error).message).toMatch(/DSH_KAGGLE_EXECUTABLE/)
    return true
  })
})

it('validates the slug shape before ever spawning a process', async () => {
  await writeStub('process.exit(0)')
  for (const badSlug of ['not-a-slug', '../escape/attempt', 'owner/', '/dataset', 'a b/c d', '']) {
    expect(() => validateKaggleSlug(badSlug)).toThrow(InvalidKaggleSlugError)
    await expect(
      runKaggleDownload(
        { slug: badSlug, sourceVersion: '1', destinationDir },
        { kaggleExecutable: stubPath },
      ),
    ).rejects.toBeInstanceOf(InvalidKaggleSlugError)
  }
  await expect(access(markerPath)).rejects.toThrow() // the stub never ran.
})

it('accepts a well-formed slug and invokes a fixed, version-pinned argument array', async () => {
  await writeStub('process.exit(0)')
  const result = await runKaggleDownload(
    { slug: 'owner/superstore', sourceVersion: '1', destinationDir },
    { kaggleExecutable: stubPath },
  )
  expect(result.exitCode).toBe(0)
  expect(result.datasetRef).toBe('owner/superstore/1')
  expect(result.sourceVersion).toBe('1')
  const receivedArgv = JSON.parse(await readFile(markerPath, 'utf8')) as string[]
  expect(receivedArgv).toEqual([
    'datasets',
    'download',
    '-d',
    'owner/superstore/1',
    '-p',
    destinationDir,
    '-q',
  ])
})

it('refuses unpinned source versions such as latest', async () => {
  await writeStub('process.exit(0)')
  await expect(
    runKaggleDownload(
      { slug: 'owner/dataset', sourceVersion: 'latest', destinationDir },
      { kaggleExecutable: stubPath },
    ),
  ).rejects.toThrow(/pinned|version/i)
  await expect(access(markerPath)).rejects.toThrow()
})

it('propagates a nonzero exit and captured stderr instead of throwing on a normal failure', async () => {
  await writeStub(
    "process.stderr.write('403 - dataset requires accepting competition terms'); process.exit(1)",
  )
  const result = await runKaggleDownload(
    { slug: 'owner/dataset', sourceVersion: '1', destinationDir },
    { kaggleExecutable: stubPath },
  )
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('403 - dataset requires accepting competition terms')
})

it('caps buffered output instead of growing unbounded on a runaway process', async () => {
  await writeStub("process.stdout.write('x'.repeat(1000)); process.exit(0)")
  const result = await runKaggleDownload(
    { slug: 'owner/dataset', sourceVersion: '1', destinationDir },
    { kaggleExecutable: stubPath, maxOutputBytes: 100 },
  )
  expect(result.outputTruncated).toBe(true)
  expect(result.stdout.length).toBeLessThanOrEqual(100)
})

it('kills the underlying process on timeout rather than only abandoning the promise', async () => {
  const doneMarker = join(directory, 'completed-normally')
  await writeStub(`
await new Promise((resolve) => setTimeout(resolve, 5000))
writeFileSync(${JSON.stringify(doneMarker)}, 'done')
process.exit(0)
`)
  const started = performance.now()
  await expect(
    runKaggleDownload(
      { slug: 'owner/dataset', sourceVersion: '1', destinationDir },
      { kaggleExecutable: stubPath, timeoutMs: 200 },
    ),
  ).rejects.toBeInstanceOf(KaggleDownloadTimeoutError)
  const elapsedMs = performance.now() - started
  expect(elapsedMs).toBeLessThan(3_000) // well under the 5s the stub would otherwise sleep.
  await expect(access(doneMarker)).rejects.toThrow() // the process never reached its post-sleep write.
})

it('kills the underlying process on AbortSignal the same way as a timeout', async () => {
  const doneMarker = join(directory, 'completed-normally-abort')
  await writeStub(`
await new Promise((resolve) => setTimeout(resolve, 5000))
writeFileSync(${JSON.stringify(doneMarker)}, 'done')
process.exit(0)
`)
  const controller = new AbortController()
  const runPromise = runKaggleDownload(
    { slug: 'owner/dataset', sourceVersion: '1', destinationDir },
    { kaggleExecutable: stubPath, signal: controller.signal },
  )
  setTimeout(() => controller.abort(), 150)
  const result = await runPromise
  // Aborting resolves (not a policy-defined rejection type) but the process
  // was actually killed: it never reached its post-sleep completion marker.
  expect(result.signalName).toBe('SIGTERM')
  await expect(access(doneMarker)).rejects.toThrow()
})
