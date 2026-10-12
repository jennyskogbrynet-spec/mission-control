// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addAgent, addTask, approve, createDispatchDb, setSetting } from './fixtures/dispatch-db'

const mock = vi.hoisted(() => ({ db: null as any, runOpenClaw: vi.fn(), broadcast: vi.fn() }))
vi.mock('@/lib/db', () => ({
  getDatabase: () => mock.db,
  db_helpers: {
    // The real helper inserts a row; keep that, so held lines can be counted.
    logActivity: (type: string, entityType: string, entityId: number, actor: string, description: string, data?: unknown, workspaceId = 1) => {
      mock.db.prepare('INSERT INTO activities (type, entity_type, entity_id, actor, description, data, created_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(type, entityType, entityId, actor, description, data ? JSON.stringify(data) : null, Math.floor(Date.now() / 1000), workspaceId)
    },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/github-sync-engine', () => ({ syncTaskOutbound: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: mock.broadcast } }))
vi.mock('@/lib/command', () => ({ runOpenClaw: mock.runOpenClaw }))
vi.mock('@/lib/config', () => ({ config: { openclawHome: '/test/openclaw' } }))

import {
  parseApprovedList,
  parseTaskIdStrict,
  resolveDispatchScope,
} from '../dispatch-scope'
import { autoRouteInboxTasks, dispatchAssignedTasks, planDispatch, requeueStaleTasks } from '../task-dispatch'

const NOW = 1_791_900_000 // 2026-10-13 ~10:40 Oslo
const OK_RESPONSE = { stdout: JSON.stringify({ payloads: [{ text: 'Completed in test' }] }), stderr: '' }

function heldLines(): number {
  return (mock.db.prepare("SELECT COUNT(*) AS n FROM activities WHERE type = 'task_dispatch_held'").get() as { n: number }).n
}
function statusOf(id: number): { status: string; assigned_to: string | null } {
  return mock.db.prepare('SELECT status, assigned_to FROM tasks WHERE id = ?').get(id)
}
function invokedTaskIds(): number[] {
  return (mock.db.prepare('SELECT task_id FROM agent_invocations ORDER BY task_id').all() as Array<{ task_id: number }>).map(r => r.task_id)
}

/**
 * The A4 board: two approved outcomes (10 owned by reidar, 11 owned by stella), their
 * children (12 by number, 13 by string id), and decoys that outrank them on priority.
 */
function seedA4Board() {
  addAgent(mock.db, 'reidar', 'coder')
  addAgent(mock.db, 'stella', 'researcher')
  addAgent(mock.db, 'vera', 'reviewer')
  addTask(mock.db, { id: 10, title: 'Research competitor pricing', status: 'inbox', priority: 'low', claimed_by: 'reidar' })
  addTask(mock.db, { id: 11, title: 'Survey sources', status: 'assigned', assigned_to: 'stella' })
  addTask(mock.db, { id: 12, title: 'Implement the fix', status: 'inbox', metadata: { outcome_task_id: 10 } })
  addTask(mock.db, { id: 13, title: 'Review the fix', status: 'assigned', assigned_to: 'vera', metadata: { outcome_task_id: '11' } })
  // Decoys: higher priority, not approved.
  addTask(mock.db, { id: 20, title: 'Implement critical thing', status: 'inbox', priority: 'critical' })
  addTask(mock.db, { id: 21, title: 'Implement other thing', status: 'assigned', priority: 'critical', assigned_to: 'reidar' })
  addTask(mock.db, { id: 22, title: 'Bad child', status: 'inbox', priority: 'high', metadata: { outcome_task_id: '10abc' } })
  addTask(mock.db, { id: 23, title: 'Child of unapproved', status: 'inbox', priority: 'high', metadata: { outcome_task_id: 999 } })
  addTask(mock.db, { id: 24, title: 'Other workspace child', status: 'inbox', priority: 'high', workspace_id: 2, metadata: { outcome_task_id: 10 } })
  approve(mock.db, [{ task_id: 10, owner: 'reidar' }, { task_id: 11, owner: 'stella' }], NOW - 3600)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1000)
  vi.clearAllMocks()
  mock.runOpenClaw.mockResolvedValue(OK_RESPONSE)
  mock.db = createDispatchDb()
})
afterEach(() => {
  vi.useRealTimers()
  mock.db.close()
})

describe('settings and defaults', () => {
  it('absent settings: kill switch OFF, scope approved_only, list missing', () => {
    const ctx = resolveDispatchScope(mock.db, NOW)
    expect(ctx.enabled).toBe(false)
    expect(ctx.scope).toBe('approved_only')
    expect(ctx.held_reason).toBe('approved_list_missing')
    expect(ctx.eligible_ids?.size).toBe(0)
  })

  it('only the exact string "all" restores the whole queue; a typo stays approved_only', () => {
    setSetting(mock.db, 'general.task_dispatch_scope', 'al')
    expect(resolveDispatchScope(mock.db, NOW).scope).toBe('approved_only')
    setSetting(mock.db, 'general.task_dispatch_scope', 'all')
    expect(resolveDispatchScope(mock.db, NOW).scope).toBe('all')
    expect(resolveDispatchScope(mock.db, NOW).eligible_ids).toBeNull()
  })

  it('the kill switch needs exactly "true"', () => {
    for (const v of ['1', 'TRUE', 'yes', '']) {
      setSetting(mock.db, 'general.task_dispatch', v)
      expect(resolveDispatchScope(mock.db, NOW).enabled).toBe(false)
    }
    setSetting(mock.db, 'general.task_dispatch', 'true')
    expect(resolveDispatchScope(mock.db, NOW).enabled).toBe(true)
  })

  it('no settings table at all: fails closed', () => {
    mock.db.exec('DROP TABLE settings')
    const ctx = resolveDispatchScope(mock.db, NOW)
    expect(ctx.enabled).toBe(false)
    expect(ctx.scope).toBe('approved_only')
    expect(ctx.held_reason).toBe('approved_list_invalid')
  })
})

describe('approved list parsing and freshness', () => {
  const valid = { date: '2026-10-13', approved_at: NOW, source: 'morning-meeting', outcomes: [{ task_id: 1, owner: 'reidar', outcome: 'x' }] }

  it('task ids are strict', () => {
    expect(parseTaskIdStrict(7)).toBe(7)
    expect(parseTaskIdStrict('7')).toBe(7)
    for (const bad of ['7a', '07', 7.5, 0, -1, true, null, '', ' ']) expect(parseTaskIdStrict(bad)).toBeNull()
  })

  it.each([
    ['not JSON', '{'],
    ['4 outcomes', JSON.stringify({ ...valid, outcomes: [1, 2, 3, 4].map(i => ({ task_id: i, owner: 'a' })) })],
    ['0 outcomes', JSON.stringify({ ...valid, outcomes: [] })],
    ['duplicate id', JSON.stringify({ ...valid, outcomes: [{ task_id: 1, owner: 'a' }, { task_id: '1', owner: 'a' }] })],
    ['no owner', JSON.stringify({ ...valid, outcomes: [{ task_id: 1 }] })],
    ['bad date', JSON.stringify({ ...valid, date: '13.10.2026' })],
    ['approved_at as string', JSON.stringify({ ...valid, approved_at: String(NOW) })],
    ['a bare approved-outcomes.json list', JSON.stringify(valid.outcomes)],
  ])('rejects %s', (_label, raw) => {
    expect(parseApprovedList(raw).ok).toBe(false)
  })

  it('36 h is the edge: at 36 h fresh, one second later stale; future beyond skew is invalid', () => {
    addTask(mock.db, { id: 1, status: 'assigned', assigned_to: 'reidar' })
    approve(mock.db, [{ task_id: 1, owner: 'reidar' }], NOW - 36 * 3600)
    expect(resolveDispatchScope(mock.db, NOW).approved.state).toBe('fresh')
    approve(mock.db, [{ task_id: 1, owner: 'reidar' }], NOW - 36 * 3600 - 1)
    const stale = resolveDispatchScope(mock.db, NOW)
    expect(stale.held_reason).toBe('approved_list_stale')
    expect(stale.eligible_ids?.size).toBe(0)
    approve(mock.db, [{ task_id: 1, owner: 'reidar' }], NOW + 3600)
    expect(resolveDispatchScope(mock.db, NOW).held_reason).toBe('approved_list_invalid')
  })

  it('children: numeric or digit-string outcome_task_id, same workspace, one level', () => {
    seedA4Board()
    addTask(mock.db, { id: 30, title: 'Grandchild', status: 'inbox', metadata: { outcome_task_id: 12 } })
    const ctx = resolveDispatchScope(mock.db, NOW)
    expect([...ctx.eligible_ids!].sort((a, b) => a - b)).toEqual([10, 11, 12, 13])
    expect(Object.fromEntries(ctx.children)).toEqual({ 12: 10, 13: 11 })
  })
})

describe('A4: plan selects only what the morning meeting approved', () => {
  it('exactly the 2 approved tasks and their children, none of the higher-priority decoys', () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch', 'true')
    const plan = planDispatch(mock.db)

    expect(plan.scope).toBe('approved_only')
    expect(plan.held_reason).toBeNull()
    expect(plan.route).toEqual([
      { id: 12, title: 'Implement the fix', priority: 'medium', to: 'reidar', via: 'score' },
      { id: 10, title: 'Research competitor pricing', priority: 'low', to: 'reidar', via: 'owner' },
    ])
    expect(plan.dispatch.map(d => d.id)).toEqual([11, 12, 13])
    expect(plan.wip).toEqual({ in_progress: 0, in_progress_total: 0, max: 3, free: 3 })
    expect(plan.not_selected).toContainEqual({ id: 10, reason: 'batch_limit' })

    const touched = new Set([...plan.route.map(r => r.id), ...plan.dispatch.map(d => d.id)])
    expect([...touched].sort((a, b) => a - b)).toEqual([10, 11, 12, 13])
    for (const decoy of [20, 21, 22, 23, 24]) expect(touched.has(decoy)).toBe(false)
    expect(plan.next_tick).toEqual({ runs: true, would_route: 2, would_dispatch: 3 })
  })

  it('a listed task goes to its approved owner, never to a better-scoring agent', () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch', 'true')
    // "Research ..." scores stella (researcher) highest; the owner is reidar.
    expect(planDispatch(mock.db).route.find(r => r.id === 10)).toMatchObject({ to: 'reidar', via: 'owner' })
  })

  it('a listed task assigned to someone other than its owner is not dispatched', () => {
    seedA4Board()
    mock.db.prepare("UPDATE tasks SET assigned_to = 'vera' WHERE id = 11").run()
    const plan = planDispatch(mock.db)
    expect(plan.dispatch.map(d => d.id)).not.toContain(11)
    expect(plan.not_selected).toContainEqual(expect.objectContaining({ id: 11, reason: 'owner_mismatch' }))
  })

  it('WIP: at most 3 of the approved tasks in_progress; other lanes cannot hold the cap', () => {
    seedA4Board()
    // Three unapproved rows in progress (another lane, or zombies): they do not count.
    for (const id of [40, 41, 42]) addTask(mock.db, { id, status: 'in_progress', assigned_to: 'someone' })
    expect(planDispatch(mock.db).dispatch.map(d => d.id)).toEqual([11, 12, 13])
    // Two approved children already running leave one slot.
    addTask(mock.db, { id: 43, status: 'in_progress', assigned_to: 'reidar', metadata: { outcome_task_id: 10 } })
    addTask(mock.db, { id: 44, status: 'in_progress', assigned_to: 'reidar', metadata: { outcome_task_id: 10 } })
    expect(planDispatch(mock.db).dispatch.map(d => d.id)).toEqual([11])
    addTask(mock.db, { id: 45, status: 'in_progress', assigned_to: 'reidar', metadata: { outcome_task_id: 10 } })
    const full = planDispatch(mock.db)
    expect(full.dispatch).toEqual([])
    expect(full.wip).toEqual({ in_progress: 3, in_progress_total: 6, max: 3, free: 0 })
    expect(full.not_selected).toContainEqual({ id: 11, reason: 'wip_cap' })
  })

  it('at most 5 children per approved outcome, lowest ids first', () => {
    seedA4Board()
    for (const id of [60, 61, 62, 63, 64]) addTask(mock.db, { id, status: 'backlog', metadata: { outcome_task_id: 10 } })
    const ctx = resolveDispatchScope(mock.db, NOW)
    expect([...ctx.children.keys()].filter(id => ctx.children.get(id) === 10).sort((a, b) => a - b)).toEqual([12, 60, 61, 62, 63])
    expect(ctx.capped_children).toEqual([64])
    expect(ctx.eligible_ids!.has(64)).toBe(false)
  })

  it('unroutable children cannot starve a listed task out of the per-tick route limit', () => {
    seedA4Board()
    // Outcome 10 (workspace 1) has five critical children nobody can take: every agent in
    // workspace 1 is offline. Outcome 80 lives in workspace 2 with an available owner.
    mock.db.prepare("UPDATE agents SET status = 'offline' WHERE workspace_id = 1").run()
    for (const id of [70, 71, 72, 73, 74]) addTask(mock.db, { id, status: 'inbox', priority: 'critical', metadata: { outcome_task_id: 10 } })
    addAgent(mock.db, 'w2-owner', 'coder', 'idle', 2)
    addTask(mock.db, { id: 80, title: 'Implement in workspace 2', status: 'inbox', priority: 'low', workspace_id: 2, claimed_by: 'w2-owner' })
    approve(mock.db, [{ task_id: 10, owner: 'reidar' }, { task_id: 80, owner: 'w2-owner' }], NOW - 60)
    const plan = planDispatch(mock.db)
    expect(plan.route).toEqual([expect.objectContaining({ id: 80, to: 'w2-owner', via: 'owner' })])
    expect(plan.not_selected).toContainEqual(expect.objectContaining({ id: 70, reason: 'no_suitable_agent' }))
  })

  it('the plan shows the invocation budget and a spent budget dispatches nothing', () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch', 'true')
    setSetting(mock.db, 'general.agent_invocation_daily_cap', '2')
    mock.db.prepare('INSERT INTO agent_invocations (ts, source, task_id) VALUES (?, ?, 1), (?, ?, 2)').run(NOW - 60, 'task_dispatch', NOW - 60, 'task_dispatch')
    const plan = planDispatch(mock.db)
    expect(plan.budget).toEqual({ used: 2, cap: 2, exceeded: true })
    expect(plan.next_tick.would_dispatch).toBe(0)
  })

  it('missing, stale or invalid list: empty plan, and the held line it would write', () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch', 'true')
    for (const [setup, reason] of [
      [() => mock.db.prepare("DELETE FROM settings WHERE key = 'general.task_dispatch_approved'").run(), 'approved_list_missing'],
      [() => approve(mock.db, [{ task_id: 10, owner: 'reidar' }], NOW - 37 * 3600), 'approved_list_stale'],
      [() => setSetting(mock.db, 'general.task_dispatch_approved', '{"date":"x"}'), 'approved_list_invalid'],
    ] as const) {
      setup()
      const plan = planDispatch(mock.db)
      expect(plan.held_reason).toBe(reason)
      expect(plan.route).toEqual([])
      expect(plan.dispatch).toEqual([])
      expect(plan.next_tick).toEqual({ runs: false, would_route: 0, would_dispatch: 0 })
      expect(plan.held_activity).toMatchObject({ type: 'task_dispatch_held', due: true })
    }
  })

  it('scope setting absent behaves as approved_only (decoys stay put)', () => {
    seedA4Board()
    const plan = planDispatch(mock.db)
    expect(plan.scope_setting).toBeNull()
    expect(plan.scope).toBe('approved_only')
    expect(plan.dispatch.map(d => d.id)).not.toContain(21)
  })

  it('scope all: the legacy whole-queue selection (decoys first by priority)', () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch_scope', 'all')
    const plan = planDispatch(mock.db)
    expect(plan.route[0]).toMatchObject({ id: 20 })
    expect(plan.dispatch[0]).toMatchObject({ id: 20 })
    expect(plan.wip.max).toBeNull()
  })

  it('the plan writes nothing: no row, no setting, no activity', () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch', 'true')
    const before = mock.db.prepare('SELECT total_changes() AS n').get().n
    planDispatch(mock.db)
    mock.db.prepare("DELETE FROM settings WHERE key = 'general.task_dispatch_approved'").run()
    const afterDelete = mock.db.prepare('SELECT total_changes() AS n').get().n
    planDispatch(mock.db)
    expect(mock.db.prepare('SELECT total_changes() AS n').get().n).toBe(afterDelete)
    expect(afterDelete - before).toBe(1) // only the DELETE above
    expect(heldLines()).toBe(0)
  })
})

describe('the real tick under approved_only', () => {
  it('routes and dispatches exactly what the plan said, and nothing else', async () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch', 'true')
    const plan = planDispatch(mock.db)

    await autoRouteInboxTasks()
    await dispatchAssignedTasks()

    expect(invokedTaskIds()).toEqual(plan.dispatch.map(d => d.id).sort((a, b) => a - b))
    expect(statusOf(10)).toEqual({ status: 'assigned', assigned_to: 'reidar' })
    expect(statusOf(20)).toEqual({ status: 'inbox', assigned_to: null })
    expect(statusOf(21)).toEqual({ status: 'assigned', assigned_to: 'reidar' })
    for (const decoy of [22, 23, 24]) expect(statusOf(decoy).status).toBe('inbox')
  })

  it('missing list: nothing moves and exactly one activity line, rate-limited per reason', async () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch', 'true')
    mock.db.prepare("DELETE FROM settings WHERE key = 'general.task_dispatch_approved'").run()
    const snapshot = mock.db.prepare('SELECT id, status, assigned_to, updated_at FROM tasks ORDER BY id').all()

    for (let tick = 0; tick < 3; tick++) {
      await autoRouteInboxTasks()
      await dispatchAssignedTasks()
      await requeueStaleTasks()
      vi.advanceTimersByTime(60_000)
    }
    expect(mock.db.prepare('SELECT id, status, assigned_to, updated_at FROM tasks ORDER BY id').all()).toEqual(snapshot)
    expect(mock.runOpenClaw).not.toHaveBeenCalled()
    expect(heldLines()).toBe(1)

    // A different reason is a new line; the same reason again after an hour is too.
    approve(mock.db, [{ task_id: 10, owner: 'reidar' }], Math.floor(Date.now() / 1000) - 40 * 3600)
    await autoRouteInboxTasks()
    expect(heldLines()).toBe(2)
    vi.advanceTimersByTime(3601_000)
    approve(mock.db, [{ task_id: 10, owner: 'reidar' }], Math.floor(Date.now() / 1000) - 40 * 3600)
    await dispatchAssignedTasks()
    expect(heldLines()).toBe(3)
    const last = mock.db.prepare("SELECT description, data FROM activities WHERE type='task_dispatch_held' ORDER BY id DESC LIMIT 1").get()
    expect(JSON.parse(last.data)).toMatchObject({ reason: 'approved_list_stale', max_age_hours: 36 })
  })

  it('kill switch off with a fresh list: nothing is routed or claimed (manual trigger too)', async () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch', 'false')
    const route = await autoRouteInboxTasks()
    const dispatch = await dispatchAssignedTasks()
    expect(route.message).toMatch(/off/)
    expect(dispatch.message).toMatch(/off/)
    expect(statusOf(10).status).toBe('inbox')
    expect(statusOf(11).status).toBe('assigned')
    expect(mock.runOpenClaw).not.toHaveBeenCalled()
  })

  it('kill switch flipped while a dispatch is running: the next task in the batch is not claimed', async () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch', 'true')
    mock.runOpenClaw.mockImplementationOnce(async () => {
      setSetting(mock.db, 'general.task_dispatch', 'false') // Martin pulls the switch mid-tick
      return OK_RESPONSE
    })
    const result = await dispatchAssignedTasks()
    expect(invokedTaskIds()).toEqual([11])
    expect(statusOf(13).status).toBe('assigned')
    expect(result.message).toMatch(/stopped/)
  })

  it('the approved list replaced mid-batch: a task no longer approved is not claimed', async () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch', 'true')
    mock.runOpenClaw.mockImplementationOnce(async () => {
      approve(mock.db, [{ task_id: 11, owner: 'stella' }], NOW) // 10 (and its child 12) dropped
      return OK_RESPONSE
    })
    await autoRouteInboxTasks() // 10 -> reidar, 12 -> reidar
    await dispatchAssignedTasks()
    expect(invokedTaskIds()).toEqual([11, 13])
    expect(statusOf(12).status).toBe('assigned')
  })

  it('WIP is re-checked before every claim, not only at selection', async () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch', 'true')
    addTask(mock.db, { id: 40, status: 'in_progress', assigned_to: 'reidar', metadata: { outcome_task_id: 10 } })
    // Selection allows 2 (3 minus approved child 40). While 11 runs, two more approved children start.
    mock.runOpenClaw.mockImplementationOnce(async () => {
      addTask(mock.db, { id: 41, status: 'in_progress', assigned_to: 'stella', metadata: { outcome_task_id: 11 } })
      addTask(mock.db, { id: 42, status: 'in_progress', assigned_to: 'stella', metadata: { outcome_task_id: 11 } })
      return OK_RESPONSE
    })
    const result = await dispatchAssignedTasks()
    expect(invokedTaskIds()).toEqual([11])
    expect(statusOf(13).status).toBe('assigned')
    expect(result.message).toMatch(/WIP cap 3/)
  })

  it('a listed owner changed mid-batch: the old assignee is not dispatched', async () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch', 'true')
    mock.runOpenClaw.mockImplementationOnce(async () => {
      // Someone rewrites the list directly (PUT /api/settings): 13's parent 11 now belongs to vera.
      approve(mock.db, [{ task_id: 10, owner: 'reidar' }, { task_id: 11, owner: 'vera' }, { task_id: 13, owner: 'stella' }], NOW)
      return OK_RESPONSE
    })
    await dispatchAssignedTasks()
    // 11 ran first; 13 (assigned to vera) is now listed for stella and must not run.
    expect(invokedTaskIds()).toEqual([11])
    expect(statusOf(13).status).toBe('assigned')
  })

  it('held list: stale requeue touches nothing, approved or not', async () => {
    seedA4Board()
    addTask(mock.db, { id: 50, status: 'in_progress', assigned_to: 'ghost', updated_at: 1, metadata: { outcome_task_id: 10 } })
    approve(mock.db, [{ task_id: 10, owner: 'reidar' }], NOW - 40 * 3600)
    const result = await requeueStaleTasks()
    expect(result.message).toMatch(/held/)
    expect(statusOf(50).status).toBe('in_progress')
  })

  it('held line rate limit is per reason: A, B, A within the hour writes A once', async () => {
    seedA4Board()
    setSetting(mock.db, 'general.task_dispatch', 'true')
    mock.db.prepare("DELETE FROM settings WHERE key = 'general.task_dispatch_approved'").run()
    await autoRouteInboxTasks() // missing
    approve(mock.db, [{ task_id: 10, owner: 'reidar' }], NOW - 40 * 3600)
    await autoRouteInboxTasks() // stale
    mock.db.prepare("DELETE FROM settings WHERE key = 'general.task_dispatch_approved'").run()
    await autoRouteInboxTasks() // missing again, same hour
    expect(heldLines()).toBe(2)
  })

  it('stale requeue touches only approved tasks under approved_only', async () => {
    seedA4Board()
    // Both in_progress, both with an unknown (offline) agent, both long untouched.
    addTask(mock.db, { id: 50, status: 'in_progress', assigned_to: 'ghost', updated_at: 1, metadata: { outcome_task_id: 10 } })
    addTask(mock.db, { id: 51, status: 'in_progress', assigned_to: 'ghost', updated_at: 1 })
    await requeueStaleTasks()
    expect(statusOf(50).status).toBe('assigned')
    expect(statusOf(51).status).toBe('in_progress')
  })
})
