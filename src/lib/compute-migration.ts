import type Database from 'better-sqlite3'

export function migrateComputeLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS compute_accounts (
      workspace_id INTEGER NOT NULL, id TEXT NOT NULL, definition TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id,id)
    );
    CREATE TABLE IF NOT EXISTS compute_pools (
      workspace_id INTEGER NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL, definition TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id,id),
      FOREIGN KEY (workspace_id,account_id) REFERENCES compute_accounts(workspace_id,id)
    );
    CREATE TABLE IF NOT EXISTS compute_bindings (
      workspace_id INTEGER NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL, definition TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id,id),
      FOREIGN KEY (workspace_id,account_id) REFERENCES compute_accounts(workspace_id,id)
    );
    CREATE TABLE IF NOT EXISTS compute_observations (
      workspace_id INTEGER NOT NULL, external_id TEXT NOT NULL, account_id TEXT,
      kind TEXT NOT NULL, subject_id TEXT NOT NULL, observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      body_hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (workspace_id,external_id),
      FOREIGN KEY (workspace_id,account_id) REFERENCES compute_accounts(workspace_id,id)
    );
    CREATE INDEX IF NOT EXISTS idx_compute_observation_subject ON compute_observations(workspace_id,kind,subject_id,observed_at DESC,created_at DESC);
    CREATE TRIGGER IF NOT EXISTS compute_observations_no_update BEFORE UPDATE ON compute_observations
      BEGIN SELECT RAISE(ABORT,'Compute observations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS compute_observations_no_delete BEFORE DELETE ON compute_observations
      BEGIN SELECT RAISE(ABORT,'Compute observations are append-only'); END;
  `)
}
