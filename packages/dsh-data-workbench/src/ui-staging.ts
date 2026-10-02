import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const PRIVATE_DIR = '.private'

export async function stagePath(
  stagingRoot: string,
  category: string,
  filename: string,
): Promise<string> {
  const path = join(stagingRoot, PRIVATE_DIR, category, filename)
  await mkdir(dirname(path), { recursive: true })
  return path
}

/**
 * Promote every privately staged file into its public destination
 * directory. All-or-nothing: if any individual rename fails partway through,
 * every file already promoted in this call is moved back into private
 * staging (or deleted if the move-back itself fails) before the error is
 * re-thrown, so a partial promotion never leaves orphaned public files while
 * still keeping `discardStaged` able to clean up whatever remains staged.
 *
 * On full success, the private staging tree *and* the now-empty staging
 * root are removed, and the list of newly public file paths is returned so
 * a caller can roll them back if a later step (e.g. the metadata commit)
 * fails — those files exist publicly but are still "not referenced" until
 * that later step succeeds (see docs/contracts.md, "Identity and persistence").
 */
export async function commitStaged(
  stagingRoot: string,
  destinations?: Record<string, string>,
): Promise<string[]> {
  const privateRoot = join(stagingRoot, PRIVATE_DIR)
  const categories = destinations ?? {
    results: join(stagingRoot, 'results'),
    artifacts: join(stagingRoot, 'artifacts'),
  }

  const moves: Array<{ source: string; destination: string }> = []
  for (const [category, destination] of Object.entries(categories)) {
    const source = join(privateRoot, category)
    let filenames: string[]
    try {
      filenames = await readdir(source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const filename of filenames) {
      moves.push({ source: join(source, filename), destination: join(destination, filename) })
    }
  }

  const promoted: string[] = []
  try {
    for (const move of moves) {
      await mkdir(dirname(move.destination), { recursive: true })
      await rename(move.source, move.destination)
      promoted.push(move.destination)
    }
  } catch (error) {
    // Roll back every file already promoted during this call so a failed
    // promotion never leaves public files that no metadata will ever
    // reference.
    for (const destination of promoted) {
      const move = moves.find((candidate) => candidate.destination === destination)
      if (!move) continue
      try {
        await mkdir(dirname(move.source), { recursive: true })
        await rename(move.destination, move.source)
      } catch {
        await rm(move.destination, { force: true })
      }
    }
    throw error
  }

  await rm(privateRoot, { recursive: true, force: true })
  // Remove the staging root only if it is now empty. Callers that pass
  // explicit public destinations outside the staging tree (the production
  // path) leave nothing behind here and this deletes the leftover empty
  // directory scaffolding; callers that use the default destinations
  // (`<root>/results`, `<root>/artifacts`, nested *inside* the staging
  // root — used by tests) still have real promoted content under the root,
  // so it must be left alone.
  try {
    const remaining = await readdir(stagingRoot)
    if (remaining.length === 0) await rm(stagingRoot, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return promoted
}

export async function discardStaged(stagingRoot: string): Promise<void> {
  await rm(stagingRoot, { recursive: true, force: true })
}

/**
 * Delete public files that were promoted by {@link commitStaged} but whose
 * owning metadata transaction subsequently failed, was cancelled, or lost a
 * concurrency race. These files are not referenced by any metadata (nothing
 * points at their IDs yet), so removing them cannot orphan a published
 * pointer — it only prevents an unpublished, unreferenced file from lingering
 * on disk.
 */
export async function rollbackPromoted(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })))
}
