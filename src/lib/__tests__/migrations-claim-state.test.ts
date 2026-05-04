import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '../migrations'

interface ColumnInfo {
  name: string
  type: string
  notnull: 0 | 1
  dflt_value: string | null
}

describe('051_task_claim_state migration', () => {
  it('adds claim_state, claimed_by, claimed_at, retry_count to tasks', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as ColumnInfo[]
    const byName = Object.fromEntries(columns.map((c) => [c.name, c])) as Record<
      string,
      ColumnInfo
    >

    expect(byName.claim_state).toBeDefined()
    expect(byName.claim_state.notnull).toBe(1)
    expect(byName.claim_state.dflt_value).toBe(`'Unclaimed'`)

    expect(byName.claimed_by).toBeDefined()
    expect(byName.claimed_by.notnull).toBe(0)

    expect(byName.claimed_at).toBeDefined()
    expect(byName.claimed_at.type).toBe('INTEGER')
    expect(byName.claimed_at.notnull).toBe(0)

    // retry_count already exists from migration 026, but Phase 1 reuses it.
    expect(byName.retry_count).toBeDefined()
    expect(byName.retry_count.dflt_value).toBe('0')
  })

  it('creates the indices used by the stall-guard cron', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'`)
      .all() as { name: string }[]
    const names = indexes.map((i) => i.name)
    expect(names).toContain('idx_tasks_claim_state')
    expect(names).toContain('idx_tasks_claimed_active')
  })

  it('is idempotent — running migrations twice does not error', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
  })

  it('defaults new tasks to Unclaimed with retry_count 0', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    db.prepare(`INSERT INTO tasks (title, status, created_by) VALUES (?, ?, ?)`).run(
      'test-task',
      'inbox',
      'system',
    )
    const row = db.prepare(`SELECT claim_state, retry_count FROM tasks LIMIT 1`).get() as {
      claim_state: string
      retry_count: number
    }
    expect(row.claim_state).toBe('Unclaimed')
    expect(row.retry_count).toBe(0)
  })
})
