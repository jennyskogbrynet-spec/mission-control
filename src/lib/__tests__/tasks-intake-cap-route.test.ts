// @vitest-environment node
import type Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHygieneDb, seedTask } from './fixtures/hygiene-db'

const mocks = vi.hoisted(() => ({
  database: vi.fn(),
  role: vi.fn(),
  broadcast: vi.fn(),
  logActivity: vi.fn(),
  notify: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  getDatabase: mocks.database,
  db_helpers: { logActivity: mocks.logActivity, ensureTaskSubscription: vi.fn(), createNotification: mocks.notify },
}))
vi.mock('@/lib/auth', () => ({ requireRole: mocks.role }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: mocks.broadcast } }))
vi.mock('@/lib/mentions', () => ({ resolveMentionRecipients: () => ({ recipients: [], unresolved: [] }) }))
vi.mock('@/lib/github-sync-engine', () => ({ pushTaskToGitHub: vi.fn(), syncTaskOutbound: vi.fn() }))
vi.mock('@/lib/gnap-sync', () => ({ pushTaskToGnap: vi.fn(), removeTaskFromGnap: vi.fn() }))
vi.mock('@/lib/config', () => ({ config: { gnap: { enabled: false, autoSync: false, repoPath: '' } } }))

import { POST } from '@/app/api/tasks/route'

let db: Database.Database
const post = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))

const create = (source: string | undefined, extra: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) =>
  post({ title: 'Finding', project_id: 6, ...extra, metadata: { ...(source ? { source } : {}), ...metadata } })

const fill = (source: string, n: number, status = 'inbox') => {
  for (let i = 0; i < n; i++) seedTask(db, { project_id: 6, status, metadata: { source } })
}
const count = () => (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n

beforeEach(() => {
  vi.clearAllMocks()
  db = createHygieneDb()
  mocks.database.mockReturnValue(db)
  mocks.role.mockReturnValue({ user: { id: 1, username: 'poster', workspace_id: 1, role: 'operator' } })
})
afterEach(() => db.close())

describe('POST /api/tasks intake cap', () => {
  it('creates normally below the cap and does not add a wip block', async () => {
    fill('feature-audit', 14)
    const res = await create('feature-audit')
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.wip).toBeUndefined()
    expect(body.task.status).toBe('inbox')
    expect(res.headers.get('X-MC-Intake')).toBeNull()
  })

  it('at the cap it still answers 201 with an id, but parks the task in backlog flagged wip_deferred', async () => {
    fill('feature-audit', 15)
    const before = count()
    const res = await create('feature-audit', { priority: 'high' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.task.id).toBeGreaterThan(0)
    expect(body.task.status).toBe('backlog')
    expect(body.task.priority).toBe('high')
    expect(body.task.metadata).toMatchObject({ source: 'feature-audit', wip_deferred: true, wip_requested_status: 'inbox' })
    expect(body.wip).toMatchObject({ deferred: true, source: 'feature-audit', open: 15, cap: 15, requested_status: 'inbox', status: 'backlog' })
    expect(res.headers.get('X-MC-Intake')).toBe('deferred')
    expect(count()).toBe(before + 1)
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(body.task.id)).toEqual({ status: 'backlog' })
    expect(mocks.broadcast).toHaveBeenCalledWith('task.created', expect.objectContaining({ id: body.task.id, status: 'backlog' }))
  })

  it('a deferred task is not counted, so the board does not tip further over the cap', async () => {
    fill('feature-audit', 15)
    await create('feature-audit')
    await create('feature-audit')
    const rows = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE json_extract(metadata, '$.wip_deferred') = 1").get()
    expect(rows).toEqual({ n: 2 })
  })

  it('does not notify the assignee of a task it parked', async () => {
    fill('feature-audit', 15)
    await create('feature-audit', { assigned_to: 'Aegis' })
    expect(mocks.notify).not.toHaveBeenCalled()
    mocks.notify.mockClear()
    await create('deep-verify', { assigned_to: 'Aegis' })
    expect(mocks.notify).toHaveBeenCalledTimes(1)
  })

  it('a caller cannot pre-flag itself as deferred to dodge the count', async () => {
    fill('feature-audit', 15)
    const res = await create('feature-audit', {}, { wip_deferred: false, wip_requested_status: 'in_progress' })
    const body = await res.json()
    expect(body.task.status).toBe('backlog')
    expect(body.task.metadata.wip_requested_status).toBe('inbox')
  })

  it('answers 409 intake_wip_cap for a reject rule and creates nothing', async () => {
    fill('feature-audit-ambition', 10, 'backlog')
    const before = count()
    const res = await create('feature-audit-ambition', { status: 'backlog', priority: 'low' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'intake_wip_cap', source: 'feature-audit-ambition', open: 10, cap: 10, project_id: 6 })
    expect(body.error).toContain('Intake cap reached')
    expect(count()).toBe(before)
    expect(db.prepare('SELECT ticket_counter FROM projects WHERE id = 6').get()).toEqual({ ticket_counter: 0 })
  })

  it('lets a fix-batch carrier through at the cap (the native release gate needs its claim)', async () => {
    fill('feature-audit', 20)
    const res = await create('feature-audit', {}, { kind: 'fix-batch' })
    expect(res.status).toBe(201)
    expect((await res.json()).task.status).toBe('inbox')
  })

  it('does not touch tasks without a source, with an unruled source, or created already closed', async () => {
    fill('feature-audit', 30)
    for (const [source, extra] of [[undefined, {}], ['deep-verify', {}], ['feature-audit', { status: 'done', outcome: 'success' }]] as const) {
      const res = await create(source, { ...extra })
      expect(res.status).toBe(201)
    }
  })

  it('applies the cap per project', async () => {
    fill('feature-audit', 15)
    const res = await post({ title: 'Elsewhere', project_id: 2, metadata: { source: 'feature-audit' } })
    expect((await res.json()).task.status).toBe('inbox')
  })

  it('honours an override from the settings table', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('intake.wip_caps', '{\"feature-audit\":2}')").run()
    fill('feature-audit', 2)
    expect((await (await create('feature-audit')).json()).task.status).toBe('backlog')
    db.prepare("UPDATE settings SET value = '{\"feature-audit\":0}' WHERE key = 'intake.wip_caps'").run()
    expect((await (await create('feature-audit')).json()).task.status).toBe('inbox')
  })
})
