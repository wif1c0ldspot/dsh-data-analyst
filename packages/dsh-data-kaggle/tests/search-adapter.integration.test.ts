import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { InvalidKaggleSearchQueryError, searchKaggleSources } from '../src/search-adapter.js'

let directory: string
let stubPath: string
let markerPath: string

/** Stand-in `kaggle` CLI that records its argv and writes a fixed CSV to stdout. */
async function writeStub(csv: string, behavior = 'process.exit(0)'): Promise<void> {
  const script = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write(${JSON.stringify(csv)})
${behavior}
`
  await writeFile(stubPath, script, 'utf8')
  await chmod(stubPath, 0o755)
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-kaggle-search-'))
  stubPath = join(directory, 'kaggle-stub.mjs')
  markerPath = join(directory, 'argv.json')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('invokes a fixed argv array and parses the CSV into bounded results', async () => {
  await writeStub(
    'ref,title,size,lastUpdated,downloadCount,license\n' +
      '"owner/widgets","Widgets, Inc.",10MB,2024-01-01,1234,CC0\n' +
      'owner/other,Other,1MB,2023-05-05,9,other-open\n',
  )

  const results = await searchKaggleSources('widgets', { kaggleExecutable: stubPath })

  expect(results).toEqual([
    {
      ref: 'owner/widgets',
      title: 'Widgets, Inc.',
      size: '10MB',
      lastUpdated: '2024-01-01',
      downloadCount: 1234,
      license: 'CC0',
    },
    {
      ref: 'owner/other',
      title: 'Other',
      size: '1MB',
      lastUpdated: '2023-05-05',
      downloadCount: 9,
      license: 'other-open',
    },
  ])
  const receivedArgv = JSON.parse(await readFile(markerPath, 'utf8')) as string[]
  expect(receivedArgv).toEqual(['datasets', 'list', '-s', 'widgets', '--csv'])
})

it('passes query metacharacters as a single argv element, never a shell', async () => {
  await writeStub('ref,title\nowner/a,A\n')
  const results = await searchKaggleSources('a; rm -rf / ; --help', { kaggleExecutable: stubPath })
  expect(results).toHaveLength(1)
  const receivedArgv = JSON.parse(await readFile(markerPath, 'utf8')) as string[]
  expect(receivedArgv).toEqual(['datasets', 'list', '-s', 'a; rm -rf / ; --help', '--csv'])
})

it('rejects empty or oversized queries before spawning', async () => {
  await writeStub('ref,title\nowner/a,A\n')
  await expect(searchKaggleSources('   ', { kaggleExecutable: stubPath })).rejects.toBeInstanceOf(
    InvalidKaggleSearchQueryError,
  )
  await expect(
    searchKaggleSources('x'.repeat(201), { kaggleExecutable: stubPath }),
  ).rejects.toBeInstanceOf(InvalidKaggleSearchQueryError)
})

it('caps results at the configured maximum', async () => {
  const rows = Array.from({ length: 30 }, (_, index) => `owner/d${index},D${index}`).join('\n')
  await writeStub(`ref,title\n${rows}\n`)
  const results = await searchKaggleSources('d', { kaggleExecutable: stubPath })
  expect(results).toHaveLength(20)
})

it('propagates a nonzero exit as an error', async () => {
  await writeStub('', "process.stderr.write('401 Unauthorized'); process.exit(1)")
  await expect(searchKaggleSources('widgets', { kaggleExecutable: stubPath })).rejects.toThrow(
    /401 Unauthorized/,
  )
})
