// @vitest-environment node
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ db: null as any, warn: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDatabase: () => mock.db, db_helpers: {} }))
vi.mock('@/lib/logger', () => ({ logger: { warn: mock.warn, info: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/github-sync-engine', () => ({ syncTaskOutbound: vi.fn() }))
import { recordDirectDispatchUsage } from '@/lib/task-dispatch'
beforeEach(() => {
  mock.db = new Database(':memory:')
  // Columns from migrations 018_token_usage + workspace scope + 039_session_costs.
  mock.db.exec(`CREATE TABLE token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, session_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, workspace_id INTEGER NOT NULL DEFAULT 1,
    cost_usd REAL, agent_name TEXT, task_id INTEGER
  )`)
  mock.warn.mockClear()
})
afterEach(() => mock.db.close())
describe('direct dispatch usage receipts', () => {
  it('persists token counts and explicit task/agent/workspace attribution without inventing cost', () => {
    recordDirectDispatchUsage({ id: 42, agent_name: 'Research', workspace_id: 7 }, 'claude-sonnet-4-6', { input_tokens: 123, output_tokens: 45 })
    expect(mock.db.prepare('SELECT model,session_id,input_tokens,output_tokens,cost_usd,workspace_id,agent_name,task_id FROM token_usage').get()).toEqual({
      model: 'claude-sonnet-4-6', session_id: 'task-42', input_tokens: 123, output_tokens: 45,
      cost_usd: null, workspace_id: 7, agent_name: 'Research', task_id: 42,
    })
    expect(mock.warn).not.toHaveBeenCalled()
  })
  it('records separate billable responses and logs storage failure without propagating it into retries', () => {
    const task = { id: 42, agent_name: 'Research', workspace_id: 7 }
    recordDirectDispatchUsage(task, 'claude-sonnet-4-6', { input_tokens: 10, output_tokens: 2 })
    recordDirectDispatchUsage(task, 'claude-sonnet-4-6', { input_tokens: 20, output_tokens: 3 })
    expect(mock.db.prepare('SELECT count(*) AS n, sum(input_tokens) AS tokens FROM token_usage').get()).toEqual({ n: 2, tokens: 30 })
    mock.db.exec('DROP TABLE token_usage')
    expect(() => recordDirectDispatchUsage(task, 'claude-sonnet-4-6', { input_tokens: 5 })).not.toThrow()
    expect(mock.warn).toHaveBeenCalledOnce()
  })
})
