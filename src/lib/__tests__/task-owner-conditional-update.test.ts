import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { NextRequest } from 'next/server'

const helpers = { createNotification: vi.fn(), ensureTaskSubscription: vi.fn(), logActivity: vi.fn() }
const runMock = vi.fn()
const preparedUpdates: string[] = []
const currentTask = {
  id: 7, workspace_id: 3, title: 'Task', description: '', status: 'assigned',
  priority: 'medium', project_id: null, assigned_to: 'Aegis', tags: '[]',
  metadata: '{}', claimed_by: 'main', claimed_at: '2026-09-12T16:24:00.223Z', updated_at: 1000,
}

vi.mock('@/lib/auth', () => ({ requireRole: vi.fn(() => ({ user: { username: 'tester', workspace_id: 3 } })) }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: vi.fn(() => null) }))
vi.mock('@/lib/task-status', () => ({ normalizeTaskUpdateStatus: vi.fn(() => undefined) }))
vi.mock('@/lib/mentions', () => ({ resolveMentionRecipients: vi.fn(() => ({ recipients: [], unresolved: [] })) }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: vi.fn() } }))
vi.mock('@/lib/github-sync-engine', () => ({ syncTaskOutbound: vi.fn() }))
vi.mock('@/lib/gnap-sync', () => ({ removeTaskFromGnap: vi.fn() }))
vi.mock('@/lib/config', () => ({ config: { gnap: { enabled: false } } }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/mc-agentic-os', () => ({ normalizeTaskMetadata: vi.fn((value) => value) }))
vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare: vi.fn((sql: string) => {
    if (sql.includes('SELECT * FROM tasks')) return { get: vi.fn(() => currentTask) }
    if (sql.includes('UPDATE tasks')) { preparedUpdates.push(sql); return { run: runMock } }
    if (sql.includes('SELECT t.*')) return { get: vi.fn(() => ({ ...currentTask, metadata: '{"proof":true}' })) }
    throw new Error(`Unexpected SQL: ${sql}`)
  }) })), db_helpers: helpers,
}))

describe('conditional task owner metadata update', () => {
  beforeEach(() => { vi.clearAllMocks(); preparedUpdates.length = 0 })

  it('returns 409 with no side effects when the atomic owner/claim condition loses', async () => {
    runMock.mockReturnValue({ changes: 0 })
    const { PUT } = await import('@/app/api/tasks/[id]/route')
    const request = new NextRequest('http://localhost/api/tasks/7', { method: 'PUT',
      body: JSON.stringify({ metadata: { proof: true }, mutation_guard: {
        capability: 'task-owner-claim-v1', claimed_by: 'main', claimed_at: '2026-09-12T16:24:00.223Z',
      } }), headers: { 'content-type': 'application/json' } })
    const response = await PUT(request, { params: Promise.resolve({ id: '7' }) })
    expect(response.status).toBe(409)
    expect(runMock.mock.calls[0].slice(-4)).toEqual([7, 3, 'main', '2026-09-12T16:24:00.223Z'])
    expect(helpers.logActivity).not.toHaveBeenCalled()
    expect(helpers.createNotification).not.toHaveBeenCalled()
  })

  it('accepts the exact guarded owner and claim incarnation', async () => {
    runMock.mockReturnValue({ changes: 1 })
    const { PUT } = await import('@/app/api/tasks/[id]/route')
    const request = new NextRequest('http://localhost/api/tasks/7', { method: 'PUT',
      body: JSON.stringify({ metadata: { proof: true }, mutation_guard: {
        capability: 'task-owner-claim-v1', claimed_by: 'main', claimed_at: '2026-09-12T16:24:00.223Z',
      } }), headers: { 'content-type': 'application/json' } })
    const response = await PUT(request, { params: Promise.resolve({ id: '7' }) })
    expect(response.status).toBe(200)
    expect((await response.json()).task.metadata).toEqual({ proof: true })
  })
})


describe('real SQLite owner/claim predicate', () => {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  it.each([
    ['replacement-owner', 3, 'other', '2026-09-12T16:24:00.223Z', 409],
    ['same-owner-new-claim', 3, 'main', '2026-09-12T17:25:00.456Z', 409],
    ['foreign-workspace', 4, 'main', '2026-09-12T16:24:00.223Z', 409],
    ['exact-claim', 3, 'main', '2026-09-12T16:24:00.223Z', 200],
  ])('%s cannot bypass the SQL condition', async (_name, workspace, owner, claim, expected) => {
    vi.clearAllMocks(); preparedUpdates.length = 0
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE tasks(id INTEGER, workspace_id INTEGER, metadata TEXT, updated_at INTEGER, claimed_by TEXT, claimed_at TEXT)')
      db.prepare('INSERT INTO tasks VALUES(7, ?, ?, 1000, ?, ?)').run(workspace, '{}', owner, claim)
      runMock.mockImplementation((...args) => db.prepare(preparedUpdates.at(-1)).run(...args))
      const { PUT } = await import('@/app/api/tasks/[id]/route')
      const response = await PUT(new NextRequest('http://localhost/api/tasks/7', { method: 'PUT',
        body: JSON.stringify({ metadata: { proof: true }, mutation_guard: {
          capability: 'task-owner-claim-v1', claimed_by: 'main', claimed_at: '2026-09-12T16:24:00.223Z',
        } }), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id: '7' }) })
      expect(response.status).toBe(expected)
      const saved = db.prepare('SELECT metadata FROM tasks WHERE id=7').get()
      expect(JSON.parse(saved.metadata)).toEqual(expected === 200 ? { proof: true } : {})
      if (expected !== 200) {
        expect(helpers.logActivity).not.toHaveBeenCalled()
        expect(helpers.createNotification).not.toHaveBeenCalled()
      }
    } finally { db.close() }
  })
  it.each([
    { project_id: 99, metadata: { proof: true } },
    { title: 'Mixed update', metadata: { proof: true } },
    {},
  ])('rejects guarded non-metadata mutations before side effects', async (fields) => {
    vi.clearAllMocks(); preparedUpdates.length = 0
    const { PUT } = await import('@/app/api/tasks/[id]/route')
    const response = await PUT(new NextRequest('http://localhost/api/tasks/7', { method: 'PUT',
      body: JSON.stringify({ ...fields, mutation_guard: { capability: 'task-owner-claim-v1',
        claimed_by: 'main', claimed_at: '2026-09-12T16:24:00.223Z' } }),
      headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id: '7' }) })
    expect(response.status).toBe(400)
    expect(runMock).not.toHaveBeenCalled()
    expect(helpers.logActivity).not.toHaveBeenCalled()
  })
})
