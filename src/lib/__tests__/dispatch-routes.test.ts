// @vitest-environment node
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addAgent, addTask, createDispatchDb, setSetting } from './fixtures/dispatch-db'

const mocks = vi.hoisted(() => ({ db: null as any, role: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/db', () => ({
  getDatabase: () => mocks.db,
  logAuditEvent: mocks.audit,
  db_helpers: {
    logActivity: (type: string, entityType: string, entityId: number, actor: string, description: string, data?: unknown, workspaceId = 1) => {
      mocks.db.prepare('INSERT INTO activities (type, entity_type, entity_id, actor, description, data, created_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(type, entityType, entityId, actor, description, data ? JSON.stringify(data) : null, Math.floor(Date.now() / 1000), workspaceId)
    },
  },
}))
vi.mock('@/lib/auth', () => ({ requireRole: mocks.role }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null, agentTaskLimiter: () => null }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: vi.fn() } }))
vi.mock('@/lib/config', () => ({ config: { openclawHome: '/test/openclaw' } }))
vi.mock('@/lib/command', () => ({ runOpenClaw: vi.fn() }))
vi.mock('@/lib/github-sync-engine', () => ({ syncTaskOutbound: vi.fn().mockResolvedValue({}) }))

import { GET as planGet } from '@/app/api/tasks/dispatch-plan/route'
import { GET as approvedGet, POST as approvedPost } from '@/app/api/tasks/dispatch-approved/route'
import { GET as queueGet } from '@/app/api/tasks/queue/route'
import { runApprove, runDispatch } from '../../../scripts/mc-factory-hygiene.mjs'

const NOW = 1_791_900_000
const req = (path: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://localhost${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

/** The morning meeting's file, in the exact format `ines-commute morning --outcomes` reads. */
const outcomesFile = () => [
  { task_id: 10, owner: 'reidar', approved: true, outcome: 'Ship the fix', sources: ['MC 10'], acceptance: ['CI green'] },
  { task_id: 11, owner: 'stella', approved: true, outcome: 'Research done', sources: ['MC 11'], acceptance: ['note in vault'] },
]

/** Calls the real route handlers, the same contract the CLI's HTTP transport uses. */
async function routeTransport(path: string, method = 'GET', body?: unknown) {
  const handler = path.startsWith('/api/tasks/dispatch-plan') ? planGet
    : method === 'POST' ? approvedPost : approvedGet
  const res = await handler(req(path, method, body))
  return res.json()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1000)
  vi.clearAllMocks()
  mocks.db = createDispatchDb()
  mocks.role.mockReturnValue({ user: { id: 1, username: 'orchestrator', workspace_id: 1, role: 'admin' } })
  addAgent(mocks.db, 'reidar', 'coder')
  addAgent(mocks.db, 'stella', 'researcher')
  addTask(mocks.db, { id: 10, status: 'inbox', claimed_by: 'reidar' })
  addTask(mocks.db, { id: 11, status: 'assigned', assigned_to: 'stella' })
  addTask(mocks.db, { id: 12, status: 'done', assigned_to: 'reidar' })
  addTask(mocks.db, { id: 13, status: 'inbox', assigned_to: 'reidar', claimed_by: 'stella' })
})
afterEach(() => {
  vi.useRealTimers()
  mocks.db.close()
})

const setting = () => mocks.db.prepare("SELECT value FROM settings WHERE key = 'general.task_dispatch_approved'").get()

describe('POST /api/tasks/dispatch-approved', () => {
  it('is a dry run unless apply is exactly true', async () => {
    const res = await approvedPost(req('/api/tasks/dispatch-approved', 'POST', { outcomes: outcomesFile(), apply: 'true' }))
    expect(res.status).toBe(200)
    expect((await res.json()).dry_run).toBe(true)
    expect(setting()).toBeUndefined()
  })

  it('apply writes the list with a server-stamped approved_at and never touches the kill switch', async () => {
    setSetting(mocks.db, 'general.task_dispatch', 'false')
    const res = await approvedPost(req('/api/tasks/dispatch-approved', 'POST', { outcomes: outcomesFile(), apply: true, approved_at: 1, date: '2026-10-13' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.applied).toBe(true)
    const stored = JSON.parse(setting().value)
    expect(stored).toEqual({
      date: '2026-10-13',
      approved_at: NOW,
      source: 'morning-meeting',
      outcomes: [
        { task_id: 10, owner: 'reidar', outcome: 'Ship the fix' },
        { task_id: 11, owner: 'stella', outcome: 'Research done' },
      ],
    })
    expect(mocks.db.prepare("SELECT value FROM settings WHERE key = 'general.task_dispatch'").get()).toEqual({ value: 'false' })
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'settings_update', actor: 'orchestrator' }))
    expect(body.plan.approved.state).toBe('fresh')
    expect(body.plan.next_tick.runs).toBe(false) // the switch is still off
  })

  it.each([
    ['approved not true', (o: any[]) => { o[0].approved = 'yes' }, /approved must be true/],
    ['owner is not the task owner', (o: any[]) => { o[0].owner = 'stella' }, /single observed owner/],
    ['two observed owners', (o: any[]) => { o[1] = { ...o[1], task_id: 13, owner: 'reidar' } }, /single observed owner/],
    ['done task', (o: any[]) => { o[1] = { ...o[1], task_id: 12, owner: 'reidar' } }, /is done/],
    ['unknown task', (o: any[]) => { o[1].task_id = 999 }, /not found/],
    ['no sources', (o: any[]) => { o[0].sources = [] }, /sources/],
    ['no acceptance', (o: any[]) => { delete o[0].acceptance }, /acceptance/],
    ['four outcomes', (o: any[]) => { o.push(o[0], o[0]) }, /1-3/],
  ])('422 and nothing written: %s', async (_label, mutate, message) => {
    const outcomes = outcomesFile()
    mutate(outcomes)
    const res = await approvedPost(req('/api/tasks/dispatch-approved', 'POST', { outcomes, apply: true }))
    expect(res.status).toBe(422)
    expect((await res.json()).errors.join('\n')).toMatch(message)
    expect(setting()).toBeUndefined()
  })

  it('needs admin, like PUT /api/settings', async () => {
    mocks.role.mockReturnValue({ error: 'Forbidden', status: 403 })
    const res = await approvedPost(req('/api/tasks/dispatch-approved', 'POST', { outcomes: outcomesFile(), apply: true }))
    expect(res.status).toBe(403)
    expect(mocks.role).toHaveBeenCalledWith(expect.anything(), 'admin')
    expect(setting()).toBeUndefined()
  })

  it('GET reports the state and age', async () => {
    await approvedPost(req('/api/tasks/dispatch-approved', 'POST', { outcomes: outcomesFile(), apply: true }))
    vi.setSystemTime((NOW + 37 * 3600) * 1000)
    const body = await (await approvedGet(req('/api/tasks/dispatch-approved'))).json()
    expect(body).toMatchObject({ setting: 'general.task_dispatch_approved', state: 'stale', age_hours: 37 })
  })
})

describe('re-applying an approval does not restart the 36 h clock', () => {
  it('same outcomes again: unchanged, approved_at kept; reapprove: a new clock', async () => {
    await approvedPost(req('/api/tasks/dispatch-approved', 'POST', { outcomes: outcomesFile(), apply: true }))
    const first = JSON.parse(setting().value).approved_at
    vi.setSystemTime((NOW + 30 * 3600) * 1000)
    const again = await (await approvedPost(req('/api/tasks/dispatch-approved', 'POST', { outcomes: outcomesFile(), apply: true }))).json()
    expect(again).toMatchObject({ applied: false, unchanged: true })
    expect(JSON.parse(setting().value).approved_at).toBe(first)
    vi.setSystemTime((NOW + 37 * 3600) * 1000)
    expect((await (await approvedGet(req('/api/tasks/dispatch-approved'))).json()).state).toBe('stale')
    const re = await (await approvedPost(req('/api/tasks/dispatch-approved', 'POST', { outcomes: outcomesFile(), apply: true, reapprove: true }))).json()
    expect(re.applied).toBe(true)
    expect(JSON.parse(setting().value).approved_at).toBe(NOW + 37 * 3600)
    const line = mocks.db.prepare("SELECT description FROM activities WHERE type = 'task_dispatch_approved' ORDER BY id DESC LIMIT 1").get()
    expect(line.description).toMatch(/re-approved/)
  })

  it('a different set of outcomes is a new approval with a new clock', async () => {
    await approvedPost(req('/api/tasks/dispatch-approved', 'POST', { outcomes: outcomesFile(), apply: true }))
    vi.setSystemTime((NOW + 3600) * 1000)
    const res = await (await approvedPost(req('/api/tasks/dispatch-approved', 'POST', { outcomes: outcomesFile().slice(0, 1), apply: true }))).json()
    expect(res.applied).toBe(true)
    expect(JSON.parse(setting().value).approved_at).toBe(NOW + 3600)
  })

  it('a date that is not today or yesterday in Oslo is refused', async () => {
    const res = await approvedPost(req('/api/tasks/dispatch-approved', 'POST', { outcomes: outcomesFile(), apply: true, date: '2026-10-01' }))
    expect(res.status).toBe(422)
    expect((await res.json()).errors.join(' ')).toMatch(/not today or yesterday/)
    expect(setting()).toBeUndefined()
  })
})

describe('GET /api/tasks/queue (pull dispatch) obeys the brake', () => {
  const poll = async (agent: string) => (await queueGet(req(`/api/tasks/queue?agent=${agent}`))).json()
  beforeEach(() => {
    addTask(mocks.db, { id: 20, title: 'Unapproved critical', status: 'inbox', priority: 'critical' })
    addTask(mocks.db, { id: 21, title: 'Approved child', status: 'inbox', priority: 'high', metadata: { outcome_task_id: 11 } })
  })

  it('switch off: no new claim, even with a fresh list', async () => {
    await approvedPost(req('/api/tasks/dispatch-approved', 'POST', { outcomes: outcomesFile(), apply: true }))
    const body = await poll('reidar')
    expect(body).toMatchObject({ task: null, reason: 'dispatch_held' })
    expect(mocks.db.prepare('SELECT status FROM tasks WHERE id = 20').get()).toEqual({ status: 'inbox' })
  })

  it('switch on, list missing: no new claim', async () => {
    setSetting(mocks.db, 'general.task_dispatch', 'true')
    expect(await poll('reidar')).toMatchObject({ task: null, reason: 'dispatch_held', held: 'approved_list_missing' })
  })

  it('switch on, fresh list: only approved work, a listed task only for its owner', async () => {
    setSetting(mocks.db, 'general.task_dispatch', 'true')
    await approvedPost(req('/api/tasks/dispatch-approved', 'POST', { outcomes: outcomesFile(), apply: true }))
    // vera owns nothing listed: she may take the approved child, never the unapproved critical or 10/11.
    expect((await poll('vera')).task).toMatchObject({ id: 21, status: 'in_progress', assigned_to: 'vera' })
    expect((await poll('someone-else')).task).toBeNull()
    // reidar gets his listed task 10.
    expect((await poll('reidar')).task).toMatchObject({ id: 10, assigned_to: 'reidar' })
    expect(mocks.db.prepare('SELECT status FROM tasks WHERE id = 20').get()).toEqual({ status: 'inbox' })
  })

  it('a running task is still handed back (continue_current) while held', async () => {
    addTask(mocks.db, { id: 30, status: 'in_progress', assigned_to: 'reidar' })
    expect(await poll('reidar')).toMatchObject({ reason: 'continue_current', task: expect.objectContaining({ id: 30 }) })
  })

  it('scope all + switch on: the legacy queue (unapproved critical first)', async () => {
    setSetting(mocks.db, 'general.task_dispatch', 'true')
    setSetting(mocks.db, 'general.task_dispatch_scope', 'all')
    expect((await poll('vera')).task).toMatchObject({ id: 20 })
  })
})

describe('CLI against the real routes', () => {
  it('approve --outcomes (dry run, then --apply), then dispatch --plan shows exactly the approved tasks', async () => {
    const log: string[] = []
    const deps = { request: routeTransport, log: (t: string) => log.push(t), readFile: () => JSON.stringify(outcomesFile()) }

    expect((await runApprove({ outcomes: '/x/approved-outcomes.json' }, deps)).exit).toBe(0)
    expect(log.join('\n')).toContain('DRY RUN')
    expect(setting()).toBeUndefined()

    expect((await runApprove({ outcomes: '/x/approved-outcomes.json', apply: true }, deps)).exit).toBe(0)
    expect(setting()).toBeDefined()

    log.length = 0
    const { plan } = await runDispatch({ plan: true }, deps)
    expect(plan.route.map((r: any) => r.id)).toEqual([10])
    expect(plan.dispatch.map((d: any) => d.id).sort()).toEqual([10, 11])
    expect(log.join('\n')).toMatch(/dispatch=OFF/)
    expect(log.join('\n')).toMatch(/next tick: moves nothing/)
  })

  it('dispatch without --plan refuses (exit 2) and calls nothing', async () => {
    const request = vi.fn()
    expect((await runDispatch({}, { request, log: () => {} })).exit).toBe(2)
    expect(request).not.toHaveBeenCalled()
  })

  it('GET /api/tasks/dispatch-plan with no approved list: held, empty', async () => {
    const body = await (await planGet(req('/api/tasks/dispatch-plan'))).json()
    expect(body.plan).toMatchObject({ held_reason: 'approved_list_missing', route: [], dispatch: [] })
    expect(mocks.role).toHaveBeenCalledWith(expect.anything(), 'viewer')
  })
})
