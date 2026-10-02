import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { commitStaged, discardStaged, rollbackPromoted, stagePath } from '../src/ui-staging.js'

const directories: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

it('commits staged files only when explicitly promoted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ui-staging-'))
  directories.push(root)
  const staged = await stagePath(root, 'results', 'res_test.json')
  await writeFile(staged, '{"private":true}')
  const publicPath = join(root, 'results', 'res_test.json')
  await expect(access(publicPath)).rejects.toThrow()

  await commitStaged(root)

  await expect(readFile(publicPath, 'utf8')).resolves.toBe('{"private":true}')
})

it('discards staged files after a failed publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ui-staging-'))
  directories.push(root)
  const staged = await stagePath(root, 'artifacts', 'art_test.svg')
  await writeFile(staged, '<svg/>')

  await discardStaged(root)

  await expect(access(staged)).rejects.toThrow()
})

it('returns the promoted public paths so a later failure can roll them back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ui-staging-'))
  directories.push(root)
  const staged = await stagePath(root, 'results', 'res_promoted.json')
  await writeFile(staged, '{"ok":true}')

  const promoted = await commitStaged(root)

  expect(promoted).toEqual([join(root, 'results', 'res_promoted.json')])
  await expect(readFile(promoted[0]!, 'utf8')).resolves.toBe('{"ok":true}')
})

it('removes the now-empty staging root on a successful commit to external destinations', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-ui-staging-'))
  directories.push(parent)
  const root = join(parent, '.ui-staging', 'req-1')
  const publicResults = join(parent, 'results')
  const staged = await stagePath(root, 'results', 'res_cleanup.json')
  await writeFile(staged, '{}')

  await commitStaged(root, { results: publicResults })

  await expect(readFile(join(publicResults, 'res_cleanup.json'), 'utf8')).resolves.toBe('{}')
  // Nothing — not even an empty directory — should be left behind under
  // the (now fully-consumed) per-request staging root, matching how
  // `ui-routes.ts` stages under `.ui-staging/<uuid>` next to public
  // `results`/`artifacts` directories rather than inside the staging root.
  await expect(access(root)).rejects.toThrow()
})

it('rolls back an already-promoted file when a later category fails to promote (all-or-nothing)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ui-staging-'))
  directories.push(root)
  const resultsDestination = join(root, 'public-results')
  const artifactsDestination = join(root, 'public-artifacts')

  await stagePath(root, 'results', 'res_ok.json')
  await writeFile(join(root, '.private', 'results', 'res_ok.json'), '{"ok":true}')
  await stagePath(root, 'artifacts', 'art_blocked.svg')
  await writeFile(join(root, '.private', 'artifacts', 'art_blocked.svg'), '<svg/>')

  // Block the artifacts destination so its promotion fails after the
  // results category has already been promoted (categories in
  // `Object.entries` order: results, then artifacts): a plain file sits
  // where a directory needs to be created.
  await mkdir(root, { recursive: true })
  await writeFile(artifactsDestination, 'not a directory')

  await expect(
    commitStaged(root, { results: resultsDestination, artifacts: artifactsDestination }),
  ).rejects.toThrow()

  // The already-promoted results file must have been rolled back — never
  // left in the public destination while the overall commit failed.
  await expect(access(join(resultsDestination, 'res_ok.json'))).rejects.toThrow()
  // It must be restored to private staging so `discardStaged` can still
  // clean it up.
  await expect(readFile(join(root, '.private', 'results', 'res_ok.json'), 'utf8')).resolves.toBe(
    '{"ok":true}',
  )
})

it('rollbackPromoted deletes already-public files that never got published', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ui-staging-'))
  directories.push(root)
  const staged = await stagePath(root, 'results', 'res_orphan.json')
  await writeFile(staged, '{}')
  const promoted = await commitStaged(root)
  await expect(access(promoted[0]!)).resolves.toBeUndefined()

  await rollbackPromoted(promoted)

  await expect(access(promoted[0]!)).rejects.toThrow()
})
