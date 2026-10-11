import Database from 'better-sqlite3'

/** In-memory subset of the live schema: only the tables and columns the factory-hygiene code touches. */
export function createHygieneDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL, slug TEXT NOT NULL,
      ticket_prefix TEXT NOT NULL, ticket_counter INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      github_repo TEXT, github_sync_enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, metadata TEXT
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'inbox',
      priority TEXT NOT NULL DEFAULT 'medium', assigned_to TEXT, created_by TEXT NOT NULL DEFAULT 'system',
      created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, due_date INTEGER, estimated_hours INTEGER,
      actual_hours INTEGER, tags TEXT, metadata TEXT, workspace_id INTEGER NOT NULL DEFAULT 1, project_id INTEGER,
      project_ticket_no INTEGER, outcome TEXT, error_message TEXT, resolution TEXT, feedback_rating INTEGER, feedback_notes TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0, completed_at INTEGER, github_issue_number INTEGER, github_repo TEXT,
      github_synced_at INTEGER, github_branch TEXT, github_pr_number INTEGER, github_pr_state TEXT,
      dispatch_attempts INTEGER NOT NULL DEFAULT 0, claim_state TEXT NOT NULL DEFAULT 'Unclaimed', claimed_by TEXT,
      claimed_at INTEGER, last_failure_context TEXT
    );
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, author TEXT NOT NULL, content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0, parent_id INTEGER, mentions TEXT, workspace_id INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
      actor TEXT NOT NULL, description TEXT NOT NULL, data TEXT, created_at INTEGER NOT NULL DEFAULT 0,
      workspace_id INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE quality_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, reviewer TEXT NOT NULL, status TEXT NOT NULL,
      notes TEXT, created_at INTEGER NOT NULL DEFAULT 0, workspace_id INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT NOT NULL, ended_at TEXT, workspace_id INTEGER DEFAULT 1
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT, category TEXT NOT NULL DEFAULT 'general',
      updated_by TEXT, updated_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO projects (id, workspace_id, name, slug, ticket_prefix) VALUES
      (1, 1, 'General', 'general', 'TASK'),
      (2, 1, 'Babysential', 'babysential', 'BABYS'),
      (6, 1, 'QA-signal', 'qa-signal', 'QASIG'),
      (9, 2, 'Other workspace', 'other', 'OTH');
  `)
  return db
}

export interface SeedTask {
  id?: number
  title?: string
  status?: string
  project_id?: number
  workspace_id?: number
  claim_state?: string
  claimed_by?: string | null
  claimed_at?: string | null
  updated_at?: number
  created_at?: number
  github_pr_number?: number | null
  metadata?: Record<string, unknown> | string | null
  retry_count?: number
}

export function seedTask(db: Database.Database, t: SeedTask = {}): number {
  const info = db
    .prepare(
      `INSERT INTO tasks (id, title, status, project_id, workspace_id, claim_state, claimed_by, claimed_at, updated_at, created_at,
                          github_pr_number, metadata, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.id ?? null,
      t.title ?? 'Task',
      t.status ?? 'inbox',
      t.project_id ?? 2,
      t.workspace_id ?? 1,
      t.claim_state ?? 'Unclaimed',
      t.claimed_by ?? null,
      t.claimed_at ?? null,
      t.updated_at ?? 1_000,
      t.created_at ?? t.updated_at ?? 1_000,
      t.github_pr_number ?? null,
      typeof t.metadata === 'string' ? t.metadata : JSON.stringify(t.metadata ?? {}),
      t.retry_count ?? 0,
    )
  return Number(info.lastInsertRowid)
}
