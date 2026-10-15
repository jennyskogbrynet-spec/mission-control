// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addAgent, addTask, approve, createDispatchDb, setSetting } from './fixtures/dispatch-db'

/**
 * A5: the kill switch, proven through the real scheduler loop (initScheduler + its 60 s
 * tick) with the real dispatch code. Everything the other scheduled jobs touch is mocked;
 * the database is an in-memory copy of the dispatch schema.
 */
const mock = vi.hoisted(() => ({ db: null as any, runOpenClaw: vi.fn(), broadcast: vi.fn() }))
vi.mock('@/lib/db', () => ({
  getDatabase: () => mock.db,
  logAuditEvent: vi.fn(),
  db_helpers: {
    logActivity: (type: string, entityType: string, entityId: number, actor: string, description: string, data?: unknown, workspaceId = 1) => {
      mock.db.prepare('INSERT INTO activities (type, entity_type, entity_id, actor, description, data, created_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(type, entityType, entityId, actor, description, data ? JSON.stringify(data) : null, Math.floor(Date.now() / 1000), workspaceId)
    },
  },
}))
vi.mock('@/lib/config', () => ({ config: { dbPath: '/nonexistent/mc/mission-control.db', openclawHome: '/test/openclaw' }, ensureDirExists: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-sync', () => ({ syncAgentsFromConfig: vi.fn().mockResolvedValue({ created: 0, updated: 0, synced: 0 }) }))
vi.mock('@/lib/webhooks', () => ({ processWebhookRetries: vi.fn().mockResolvedValue({ ok: true, message: '' }) }))
vi.mock('@/lib/claude-sessions', () => ({ syncClaudeSessions: vi.fn().mockResolvedValue({ ok: true, message: '' }) }))
vi.mock('@/lib/sessions', () => ({ pruneGatewaySessionsOlderThan: vi.fn(), getAgentLiveStatuses: () => new Map() }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: mock.broadcast } }))
vi.mock('@/lib/skill-sync', () => ({ syncSkillsFromDisk: vi.fn().mockResolvedValue({ ok: true, message: '' }) }))
vi.mock('@/lib/local-agent-sync', () => ({ syncLocalAgents: vi.fn().mockResolvedValue({ ok: true, message: '' }) }))
vi.mock('@/lib/recurring-tasks', () => ({ spawnRecurringTasks: vi.fn().mockResolvedValue({ ok: true, message: '' }) }))
vi.mock('@/lib/github-sync-engine', () => ({ syncTaskOutbound: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/command', () => ({ runOpenClaw: mock.runOpenClaw }))

import { getSchedulerStatus, initScheduler, stopScheduler, triggerTask } from '../scheduler'

const NOW_MS = Date.UTC(2026, 9, 13, 8, 0, 0) // 10:00 Oslo, far from the 03:00/04:00 UTC daily jobs
const OK_RESPONSE = { stdout: JSON.stringify({ payloads: [{ text: 'Completed in test' }] }), stderr: '' }

function claimsAndMoves() {
  return {
    invocations: (mock.db.prepare('SELECT COUNT(*) AS n FROM agent_invocations').get() as { n: number }).n,
    dispatched: (mock.db.prepare("SELECT COUNT(*) AS n FROM activities WHERE type IN ('task_dispatched','task_auto_routed')").get() as { n: number }).n,
    tasks: mock.db.prepare('SELECT id, status, assigned_to, updated_at FROM tasks ORDER BY id').all(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.clearAllMocks()
  mock.runOpenClaw.mockResolvedValue(OK_RESPONSE)
  mock.db = createDispatchDb()
  // The scheduler now makes a missing/old backup due at startup (MC 1728), and this fixture has no
  // backup directory. Without this line the "control" test below failed in the full suite (twice,
  // identically) while passing alone: the backup is the first task of the tick and does real file
  // I/O that the fake-timer loop does not wait for. The brake is what is under test here.
  setSetting(mock.db, 'general.auto_backup', 'false')
  addAgent(mock.db, 'reidar', 'coder')
  addAgent(mock.db, 'stella', 'researcher')
  mock.db.prepare('UPDATE agents SET last_seen = ?').run(Math.floor(NOW_MS / 1000))
  addTask(mock.db, { id: 10, title: 'Implement approved thing', status: 'inbox', claimed_by: 'reidar' })
  addTask(mock.db, { id: 11, title: 'Survey approved sources', status: 'assigned', assigned_to: 'stella' })
  addTask(mock.db, { id: 20, title: 'Implement unapproved critical', status: 'assigned', priority: 'critical', assigned_to: 'reidar' })
  approve(mock.db, [{ task_id: 10, owner: 'reidar' }, { task_id: 11, owner: 'stella' }], Math.floor(NOW_MS / 1000) - 600)
})
afterEach(() => {
  stopScheduler()
  vi.useRealTimers()
  mock.db.close()
})

describe('A5: general.task_dispatch=false stops the factory', () => {
  it('switch false with a fresh approved list: three ticks claim nothing (stale requeue left on)', async () => {
    setSetting(mock.db, 'general.task_dispatch', 'false')
    const before = claimsAndMoves()
    initScheduler()
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(claimsAndMoves()).toEqual(before)
    expect(mock.runOpenClaw).not.toHaveBeenCalled()
    expect(getSchedulerStatus().find(t => t.id === 'task_dispatch')).toMatchObject({ enabled: false })
  })

  it('switch row absent: the factory is off (F2 default), the scheduler status says so', async () => {
    const before = claimsAndMoves()
    initScheduler()
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(claimsAndMoves()).toEqual(before)
    expect(getSchedulerStatus().find(t => t.id === 'task_dispatch')).toMatchObject({ enabled: false })
  })

  it('control: switch true, the same tick dispatches the approved task and never the critical decoy', async () => {
    setSetting(mock.db, 'general.task_dispatch', 'true')
    initScheduler()
    await vi.advanceTimersByTimeAsync(61_000) // the loop ticks every 60 s; task_dispatch is due from +10 s
    const invoked = (mock.db.prepare('SELECT task_id FROM agent_invocations ORDER BY task_id').all() as Array<{ task_id: number }>).map(r => r.task_id)
    expect(invoked).toEqual([10, 11])
    expect(mock.db.prepare('SELECT status FROM tasks WHERE id = 20').get()).toEqual({ status: 'assigned' })
  })

  it('switch flipped to false while a tick is pending: that tick and the next claim nothing', async () => {
    setSetting(mock.db, 'general.task_dispatch', 'true')
    initScheduler()
    await vi.advanceTimersByTimeAsync(61_000)
    const afterFirstRun = claimsAndMoves()
    // A new approved-eligible task arrives, then Martin pulls the switch before the next tick.
    addTask(mock.db, { id: 12, title: 'Child', status: 'assigned', assigned_to: 'stella', metadata: { outcome_task_id: 11 } })
    setSetting(mock.db, 'general.task_dispatch', 'false')
    const pending = claimsAndMoves()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(claimsAndMoves()).toEqual(pending)
    expect(pending.invocations).toBe(afterFirstRun.invocations)
    expect(mock.db.prepare('SELECT status FROM tasks WHERE id = 12').get()).toEqual({ status: 'assigned' })
  })

  it('a manual trigger (POST /api/scheduler) obeys the switch too', async () => {
    setSetting(mock.db, 'general.task_dispatch', 'false')
    const before = claimsAndMoves()
    const result = await triggerTask('task_dispatch')
    expect(result.message).toMatch(/off/)
    expect(claimsAndMoves()).toEqual(before)
  })
})

describe('scheduler wiring for task_dispatch (source-level, like claim_lease_sweep)', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8')
  it('task_dispatch is no longer on by default: absent from both defaultEnabled lists', () => {
    const lists = source.match(/const defaultEnabled = [^\n]+/g) ?? []
    expect(lists).toHaveLength(2)
    for (const list of lists) expect(list).not.toContain("'task_dispatch'")
  })
  it('still maps to general.task_dispatch in both lookups and runs route then dispatch', () => {
    expect(source.match(/id === 'task_dispatch' \? 'general\.task_dispatch'/g)).toHaveLength(2)
    expect(source).toContain("id === 'task_dispatch' ? await autoRouteInboxTasks()")
  })
})
