import type Database from 'better-sqlite3'
import { createHygieneDb } from './hygiene-db'

/** The factory-hygiene schema plus what dispatch touches (agents, invocation ledger). */
export function createDispatchDb(): Database.Database {
  const db = createHygieneDb()
  db.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'agent',
      status TEXT NOT NULL DEFAULT 'idle', config TEXT, workspace_id INTEGER NOT NULL DEFAULT 1,
      hidden INTEGER NOT NULL DEFAULT 0, last_seen INTEGER, session_key TEXT
    );
    CREATE TABLE agent_invocations (id INTEGER PRIMARY KEY, ts INTEGER, source TEXT, task_id INTEGER);
  `)
  return db
}

export interface DispatchTask {
  id: number
  title?: string
  status?: string
  priority?: string
  assigned_to?: string | null
  claimed_by?: string | null
  workspace_id?: number
  created_at?: number
  updated_at?: number
  metadata?: Record<string, unknown> | string | null
}

export function addTask(db: Database.Database, t: DispatchTask): number {
  db.prepare(`
    INSERT INTO tasks (id, title, status, priority, assigned_to, claimed_by, claim_state, workspace_id, project_id, created_at, updated_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?)
  `).run(
    t.id,
    t.title ?? `Task ${t.id}`,
    t.status ?? 'inbox',
    t.priority ?? 'medium',
    t.assigned_to ?? null,
    t.claimed_by ?? null,
    t.claimed_by ? 'Claimed' : 'Unclaimed',
    t.workspace_id ?? 1,
    t.created_at ?? t.id,
    t.updated_at ?? 1,
    typeof t.metadata === 'string' ? t.metadata : JSON.stringify(t.metadata ?? {}),
  )
  return t.id
}

export function addAgent(db: Database.Database, name: string, role = 'coder', status = 'idle', workspaceId = 1): void {
  db.prepare('INSERT INTO agents (name, role, status, workspace_id) VALUES (?, ?, ?, ?)').run(name, role, status, workspaceId)
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
}

/** The setting as POST /api/tasks/dispatch-approved writes it. */
export function approve(db: Database.Database, outcomes: Array<{ task_id: number; owner: string }>, approvedAt: number): void {
  setSetting(db, 'general.task_dispatch_approved', JSON.stringify({
    date: '2026-10-13',
    approved_at: approvedAt,
    source: 'morning-meeting',
    outcomes: outcomes.map(o => ({ ...o, outcome: `Outcome for ${o.task_id}` })),
  }))
}
