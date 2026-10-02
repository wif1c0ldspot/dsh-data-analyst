/**
 * Versioned SQL migrations for the metadata coordinator (P1). One
 * `schema_migrations` table records applied versions; `runMigrations` is
 * idempotent (re-running against an already-migrated database is a no-op)
 * and each migration runs inside its own transaction so a failure never
 * leaves a partially-applied step recorded as done. See
 * docs/contracts.md "Identity and persistence" and ADR 002 ("SQLite
 * transactions through the established better-sqlite3 adapter... with
 * versioned SQL migrations").
 */
import type Database from 'better-sqlite3'

export interface Migration {
  version: number
  name: string
  up: string
}

/**
 * `import_jobs`: durable job lifecycle with an idempotency key derived from
 * source version + source hashes + transform recipe + importer version
 * (see "Data and approval flow" in docs/architecture.md). `dataset_versions`: immutable published
 * manifests. `dataset_pointers`: the one mutable "current ready version per
 * dataset" row, updated only after a version's manifest is already durably
 * stored — this is the atomic publish step.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'import_jobs_and_dataset_versions',
    up: `
      CREATE TABLE import_jobs (
        job_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL,
        source_version TEXT,
        status TEXT NOT NULL,
        dataset_version_id TEXT,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE dataset_versions (
        dataset_version_id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX dataset_versions_by_dataset ON dataset_versions(dataset_id);

      CREATE TABLE dataset_pointers (
        dataset_id TEXT PRIMARY KEY,
        current_dataset_version_id TEXT NOT NULL REFERENCES dataset_versions(dataset_version_id),
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'analysis_revisions',
    up: `
      CREATE TABLE analysis_revisions (
        analysis_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (analysis_id, revision)
      );
      CREATE INDEX analysis_revisions_by_created ON analysis_revisions(created_at DESC);
    `,
  },
  {
    version: 3,
    name: 'dashboards_feedback_alias_candidates',
    up: `
      CREATE TABLE dashboards (
        dashboard_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        layout_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE feedback (
        feedback_id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        analysis_revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        status TEXT NOT NULL,
        comment TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX feedback_by_analysis ON feedback(analysis_id, analysis_revision);

      CREATE TABLE semantic_alias_candidates (
        candidate_id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        term TEXT NOT NULL,
        expression TEXT NOT NULL,
        description TEXT NOT NULL,
        table_id TEXT NOT NULL,
        status TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );
    `,
  },
  {
    version: 4,
    name: 'reviewed_sql_learning_examples',
    up: `
      CREATE TABLE learning_examples (
        example_id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        analysis_revision INTEGER NOT NULL,
        dataset_id TEXT NOT NULL,
        dataset_version_id TEXT NOT NULL,
        schema_fingerprint TEXT NOT NULL,
        semantic_revision_id TEXT NOT NULL,
        question TEXT NOT NULL,
        corrected_sql TEXT NOT NULL,
        status TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );
      CREATE INDEX learning_examples_compatibility
        ON learning_examples(dataset_id, schema_fingerprint, semantic_revision_id, status, created_at DESC);
    `,
  },
  {
    version: 5,
    name: 'workspace_source_pins',
    up: `
      CREATE TABLE workspace_source_pins (
        pin_id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        source_version TEXT NOT NULL,
        recipe_json TEXT NOT NULL,
        status TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );
      CREATE INDEX workspace_source_pins_by_slug
        ON workspace_source_pins(slug, status, created_at DESC);
    `,
  },
  {
    version: 6,
    name: 'dashboard_archived_flag',
    up: `
      ALTER TABLE dashboards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 7,
    name: 'semantic_structure_candidates',
    up: `
      CREATE TABLE semantic_structure_candidates (
        candidate_id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        table_id TEXT,
        primary_key_json TEXT,
        grain_description TEXT,
        from_table TEXT,
        to_table TEXT,
        from_columns_json TEXT,
        to_columns_json TEXT,
        cardinality TEXT,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );
      CREATE INDEX semantic_structure_candidates_by_dataset
        ON semantic_structure_candidates(dataset_id, kind, status, created_at DESC);
    `,
  },
  {
    version: 8,
    name: 'semantic_alias_structured_fields',
    up: `
      ALTER TABLE semantic_alias_candidates ADD COLUMN aggregation TEXT;
      ALTER TABLE semantic_alias_candidates ADD COLUMN units TEXT;
      ALTER TABLE semantic_alias_candidates ADD COLUMN date_column TEXT;
      ALTER TABLE semantic_alias_candidates ADD COLUMN inclusion TEXT;
    `,
  },
  {
    version: 9,
    name: 'dashboard_active_filter',
    up: `
      ALTER TABLE dashboards ADD COLUMN active_filter_json TEXT;
    `,
  },
  {
    version: 10,
    name: 'report_exports',
    up: `
      CREATE TABLE report_exports (
        report_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_json TEXT NOT NULL,
        files_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX report_exports_by_created ON report_exports(created_at DESC);
    `,
  },
  {
    version: 11,
    name: 'source_pin_revision',
    up: 'ALTER TABLE workspace_source_pins ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;',
  },
  {
    version: 12,
    name: 'workflow_trail',
    up: `
      CREATE TABLE workflow_trail (
        entry_id TEXT PRIMARY KEY,
        milestone TEXT NOT NULL,
        actor TEXT NOT NULL,
        dataset_version_id TEXT,
        analysis_id TEXT,
        receipt_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX workflow_trail_by_dataset ON workflow_trail(dataset_version_id, recorded_at);
      CREATE INDEX workflow_trail_by_analysis ON workflow_trail(analysis_id, recorded_at);
    `,
  },
  {
    version: 13,
    name: 'chart_feedback',
    up: `
      CREATE TABLE chart_feedback (
        feedback_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        analysis_id TEXT NOT NULL,
        analysis_revision INTEGER NOT NULL,
        issue_type TEXT NOT NULL,
        notes TEXT,
        status TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );
      CREATE INDEX chart_feedback_by_analysis
        ON chart_feedback(analysis_id, analysis_revision, created_at DESC);
      CREATE INDEX chart_feedback_by_artifact ON chart_feedback(artifact_id, created_at DESC);
      CREATE INDEX chart_feedback_by_status ON chart_feedback(status, created_at DESC);
    `,
  },
]

const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  queued: ['downloading', 'failed', 'cancelled'],
  downloading: ['validating', 'needs-input', 'failed', 'cancelled'],
  validating: ['loading', 'needs-input', 'failed', 'cancelled'],
  loading: ['profiling', 'failed', 'cancelled'],
  profiling: ['ready', 'needs-input', 'failed', 'cancelled'],
  'needs-input': ['downloading', 'validating', 'loading', 'ready', 'failed', 'cancelled'],
  ready: [],
  failed: [],
  cancelled: [],
}

export function isValidJobTransition(from: string, to: string): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to)
}

export function runMigrations(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version),
  )
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    const apply = db.transaction(() => {
      db.exec(migration.up)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      )
    })
    apply()
  }
}
