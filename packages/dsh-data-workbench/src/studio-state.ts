import Database from 'better-sqlite3'
import type { StudioDefinition } from './studio-definition.js'

/** UI state is advisory; catalog revisions remain the source of truth. */
export function withStudioState<T>(path: string, action: (db: Database.Database) => T): T {
  const db = new Database(path)
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS column_review_drafts (session_id TEXT NOT NULL, pin_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (session_id, pin_id)); CREATE TABLE IF NOT EXISTS studio_state (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS studio_definitions (analysis_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (analysis_id, revision))',
    )
    return action(db)
  } finally {
    db.close()
  }
}
export function readStudioDefinition(
  path: string,
  analysisId: string,
  revision: number,
): StudioDefinition | null {
  return withStudioState(path, (db) => {
    const row = db
      .prepare('SELECT body FROM studio_definitions WHERE analysis_id = ? AND revision = ?')
      .get(analysisId, revision) as { body: string } | undefined
    return row ? (JSON.parse(row.body) as StudioDefinition) : null
  })
}
export function saveStudioDefinition(
  path: string,
  analysisId: string,
  revision: number,
  definition: StudioDefinition,
): void {
  withStudioState(path, (db) =>
    db
      .prepare(
        'INSERT OR REPLACE INTO studio_definitions (analysis_id, revision, body) VALUES (?, ?, ?)',
      )
      .run(analysisId, revision, JSON.stringify(definition)),
  )
}
