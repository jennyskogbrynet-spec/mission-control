// @vitest-environment node
import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampLeaseHours,
  evaluateClaimLeases,
  readActiveNativeWorkerTaskIds,
  readClaimLeaseHours,
  releaseExpiredClaim,
  sweepExpiredClaims,
} from '@/lib/claim-lease'
import { createHygieneDb, seedTask } from './fixtures/hygiene-db'

const NOW_MS = Date.parse('2026-10-12T00:00:00Z')
const NOW_SEC = NOW_MS / 1000
const HOUR = 3600
const iso = (secondsAgo: number) => new Date((NOW_SEC - secondsAgo) * 1000).toISOString()

let db: Database.Database
beforeEach(() => {
  db = createHygieneDb()
})
afterEach(() => db.close())

/** A claimed task whose last touch (updated_at) and claim are `idleHours` old. */
function claimed(idleHours: number, extra: Parameters<typeof seedTask>[1] = {}): number {
  return seedTask(db, {
    status: 'review',
    claim_state: 'Claimed',
    claimed_by: 'agent-a',
    claimed_at: iso(idleHours * HOUR),
    updated_at: NOW_SEC - idleHours * HOUR,
    ...extra,
  })
}

const evaluate = (leaseHours = 72, extra: Partial<Parameters<typeof evaluateClaimLeases>[1]> = {}) =>
  evaluateClaimLeases(db, { leaseHours, nowMs: NOW_MS, ...extra })

describe('lease length', () => {
  it('clamps and falls back', () => {
    expect(clampLeaseHours('48')).toBe(48)
    expect(clampLeaseHours(0)).toBe(72)
    expect(clampLeaseHours('abc')).toBe(72)
    expect(clampLeaseHours(0.2)).toBe(1)
    expect(clampLeaseHours(1e9)).toBe(2160)
  })

  it('reads the setting first, then the env, then 72', () => {
    expect(readClaimLeaseHours(db, {})).toBe(72)
    expect(readClaimLeaseHours(db, { MC_CLAIM_LEASE_HOURS: '24' })).toBe(24)
    db.prepare("INSERT INTO settings (key, value) VALUES ('general.claim_lease_hours', '96')").run()
    expect(readClaimLeaseHours(db, { MC_CLAIM_LEASE_HOURS: '24' })).toBe(96)
  })
})

describe('evaluateClaimLeases', () => {
  it('expires a claim that has been idle past the lease and keeps a fresher one', () => {
    const old = claimed(100)
    const fresh = claimed(10)
    const byId = Object.fromEntries(evaluate().map((e) => [e.task_id, e]))
    expect(byId[old].verdict).toBe('expired')
    expect(byId[old].idle_hours).toBe(100)
    expect(byId[fresh].verdict).toBe('within_lease')
  })

  it('ignores unclaimed and released tasks', () => {
    seedTask(db, { claim_state: 'Unclaimed', updated_at: 1 })
    seedTask(db, { claim_state: 'Released', updated_at: 1 })
    expect(evaluate()).toEqual([])
  })

  it('treats a recent comment as activity even when the task row is old', () => {
    const id = claimed(200)
    db.prepare('INSERT INTO comments (task_id, author, content, created_at) VALUES (?, ?, ?, ?)').run(id, 'agent-a', 'working', NOW_SEC - 5 * HOUR)
    const ev = evaluate().find((e) => e.task_id === id)!
    expect(ev.verdict).toBe('within_lease')
    expect(ev.last_activity_source).toBe('comment')
  })

  it.each([
    ['activity-log row', (id: number) => db.prepare("INSERT INTO activities (type, entity_type, entity_id, actor, description, created_at) VALUES ('x','task',?, 'a', 'd', ?)").run(id, NOW_SEC - 3 * HOUR), 'activity_log'],
    ['quality review', (id: number) => db.prepare("INSERT INTO quality_reviews (task_id, reviewer, status, created_at) VALUES (?, 'aegis', 'rejected', ?)").run(id, NOW_SEC - 3 * HOUR), 'quality_review'],
    ['finished run', (id: number) => db.prepare("INSERT INTO runs (id, agent_id, task_id, status, started_at, ended_at) VALUES ('r1','a',?, 'completed', ?, ?)").run(String(id), iso(4 * HOUR), iso(3 * HOUR)), 'run'],
  ])('treats a %s as activity', (_name, insert, source) => {
    const id = claimed(200)
    insert(id)
    const ev = evaluate().find((e) => e.task_id === id)!
    expect(ev.verdict).toBe('within_lease')
    expect(ev.last_activity_source).toBe(source)
  })

  it('never expires a claim while a run linked to the task is active', () => {
    const id = claimed(100)
    db.prepare("INSERT INTO runs (id, agent_id, task_id, status, started_at) VALUES ('r1','a',?, 'running', ?)").run(String(id), iso(80 * HOUR))
    // 80 h old "running" row is a zombie (limit 24 h): it does not protect, but it counts as activity of 80 h ago.
    expect(evaluate().find((e) => e.task_id === id)!.verdict).toBe('expired')

    db.prepare("UPDATE runs SET started_at = ? WHERE id = 'r1'").run(iso(2 * HOUR))
    const ev = evaluate().find((e) => e.task_id === id)!
    // started 2 h ago is activity itself, so the lease has not even run out:
    expect(ev.verdict).toBe('within_lease')
  })

  it('protects an idle claim whose run is active under a long lease override', () => {
    // Active run (pending, started 20 h ago) while the lease is only 10 h: idle since the run start is 20 h >= 10 h.
    const id = claimed(100)
    db.prepare("INSERT INTO runs (id, agent_id, task_id, status, started_at) VALUES ('r1','a',?, 'pending', ?)").run(String(id), iso(20 * HOUR))
    const ev = evaluate(10).find((e) => e.task_id === id)!
    expect(ev.verdict).toBe('protected_active_run')
  })

  it('does not count an ended run as active', () => {
    const id = claimed(100)
    db.prepare("INSERT INTO runs (id, agent_id, task_id, status, started_at, ended_at) VALUES ('r1','a',?, 'running', ?, ?)").run(String(id), iso(90 * HOUR), iso(89 * HOUR))
    expect(evaluate().find((e) => e.task_id === id)!.verdict).toBe('expired')
  })

  it('protects a claim that has a live native worker', () => {
    const id = claimed(100)
    const ev = evaluate(72, { activeNativeTaskIds: new Set([id]) }).find((e) => e.task_id === id)!
    expect(ev.verdict).toBe('protected_native_worker')
  })

  it('does not match runs of other tasks and handles string task ids', () => {
    const a = claimed(100)
    const b = claimed(100)
    db.prepare("INSERT INTO runs (id, agent_id, task_id, status, started_at) VALUES ('r1','a',?, 'running', ?)").run(String(b), iso(1 * HOUR))
    const byId = Object.fromEntries(evaluate().map((e) => [e.task_id, e.verdict]))
    expect(byId[a]).toBe('expired')
    expect(byId[b]).toBe('within_lease')
  })

  it('never releases on a guess: no readable timestamp means within lease', () => {
    const id = seedTask(db, { claim_state: 'Claimed', claimed_by: 'x', claimed_at: 'not a date', updated_at: 0 })
    expect(evaluate().find((e) => e.task_id === id)!.verdict).toBe('within_lease')
  })

  it('scopes to one workspace when asked', () => {
    claimed(100, { project_id: 9, workspace_id: 2 })
    const mine = claimed(100)
    expect(evaluate(72, { workspaceId: 1 }).map((e) => e.task_id)).toEqual([mine])
    expect(evaluate(72)).toHaveLength(2)
  })

  it('accepts a numeric claimed_at (seconds or milliseconds)', () => {
    const id = seedTask(db, { claim_state: 'Claimed', claimed_by: 'x', updated_at: 1 })
    db.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(NOW_SEC - 100 * HOUR, id)
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(NOW_SEC - 100 * HOUR, id)
    expect(evaluate().find((e) => e.task_id === id)!.verdict).toBe('expired')
  })
})

describe('sweepExpiredClaims', () => {
  it('is a dry run unless apply is true', () => {
    const id = claimed(100)
    const result = sweepExpiredClaims(db, { apply: false, leaseHours: 72, nowMs: NOW_MS })
    expect(result.expired.map((e) => e.task_id)).toEqual([id])
    expect(result.released).toEqual([])
    expect(db.prepare('SELECT claim_state, claimed_by FROM tasks WHERE id = ?').get(id)).toEqual({ claim_state: 'Claimed', claimed_by: 'agent-a' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 0 })
  })

  it('releases to Unclaimed with a comment, an activity row and an event; retry_count and status stay', () => {
    const id = claimed(100, { retry_count: 2 })
    const broadcast = vi.fn()
    const result = sweepExpiredClaims(db, { apply: true, leaseHours: 72, nowMs: NOW_MS, nowSec: NOW_SEC, broadcast })
    expect(result.released).toEqual([id])
    const row = db.prepare('SELECT status, claim_state, claimed_by, claimed_at, retry_count, updated_at FROM tasks WHERE id = ?').get(id)
    expect(row).toEqual({ status: 'review', claim_state: 'Unclaimed', claimed_by: null, claimed_at: null, retry_count: 2, updated_at: NOW_SEC })
    const comment = db.prepare('SELECT author, content FROM comments WHERE task_id = ?').get(id) as { author: string; content: string }
    expect(comment.author).toBe('claim-lease')
    expect(comment.content).toContain('agent-a')
    expect(comment.content).toContain('100 h')
    expect(comment.content).toContain(`POST /api/tasks/${id}/claim`)
    expect(db.prepare("SELECT COUNT(*) AS n FROM activities WHERE entity_id = ? AND actor = 'claim-lease'").get(id)).toEqual({ n: 1 })
    expect(broadcast).toHaveBeenCalledWith('task.updated', expect.objectContaining({ id, claim_state: 'Unclaimed', prev_claimed_by: 'agent-a' }))
  })

  it('leaves protected and fresh claims alone', () => {
    const fresh = claimed(10)
    const protectedId = claimed(100)
    const result = sweepExpiredClaims(db, { apply: true, leaseHours: 72, nowMs: NOW_MS, activeNativeTaskIds: new Set([protectedId]) })
    expect(result.released).toEqual([])
    expect(result.protected.map((e) => e.task_id)).toEqual([protectedId])
    expect(result.within_lease).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE claim_state = 'Claimed'").get()).toEqual({ n: 2 })
    void fresh
  })

  it('skips a claim that changed between evaluation and release (compare-and-set)', () => {
    const id = claimed(100)
    const [ev] = evaluate()
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(NOW_SEC - 1, id) // touched meanwhile
    expect(releaseExpiredClaim(db, ev, { nowSec: NOW_SEC })).toBe(false)
    db.prepare("UPDATE tasks SET updated_at = ?, claimed_by = 'agent-b' WHERE id = ?").run(ev.updated_at, id) // handed over
    expect(releaseExpiredClaim(db, ev, { nowSec: NOW_SEC })).toBe(false)
    expect(db.prepare('SELECT claimed_by FROM tasks WHERE id = ?').get(id)).toEqual({ claimed_by: 'agent-b' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 0 })
  })

  it('a second sweep right after the first finds nothing to do', () => {
    claimed(100)
    sweepExpiredClaims(db, { apply: true, leaseHours: 72, nowMs: NOW_MS, nowSec: NOW_SEC })
    const again = sweepExpiredClaims(db, { apply: true, leaseHours: 72, nowMs: NOW_MS, nowSec: NOW_SEC })
    expect(again.evaluated).toBe(0)
    expect(again.released).toEqual([])
  })

  it('honours a shorter lease', () => {
    claimed(30)
    expect(sweepExpiredClaims(db, { apply: false, leaseHours: 24, nowMs: NOW_MS }).expired).toHaveLength(1)
    expect(sweepExpiredClaims(db, { apply: false, leaseHours: 72, nowMs: NOW_MS }).expired).toHaveLength(0)
  })
})

describe('readActiveNativeWorkerTaskIds', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lease-journal-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const journal = (name: string, workers: unknown[], ageHours = 1) => {
    const file = join(dir, name)
    writeFileSync(file, JSON.stringify({ id: name, workers }))
    const when = (NOW_MS - ageHours * 3_600_000) / 1000
    utimesSync(file, when, when)
  }

  it('returns tasks with a non-terminal worker and ignores terminal ones', () => {
    journal('a.json', [
      { taskId: 11, status: 'running' },
      { taskId: 12, status: 'completed' },
      { taskId: 13, status: 'failed' },
      { taskId: 14, status: 'cancelled' },
      { taskId: 15, status: 'dispatched' },
    ])
    const scan = readActiveNativeWorkerTaskIds({ dir, nowMs: NOW_MS })
    expect(scan.ok).toBe(true)
    expect([...scan.ids].sort()).toEqual([11, 15])
    expect(scan.scanned).toBe(1)
  })

  it('ignores journals older than the window (a crashed controller is not a live worker)', () => {
    journal('old.json', [{ taskId: 21, status: 'running' }], 48)
    expect([...readActiveNativeWorkerTaskIds({ dir, nowMs: NOW_MS }).ids]).toEqual([])
  })

  it('treats a missing directory as "no controller here"', () => {
    const scan = readActiveNativeWorkerTaskIds({ dir: join(dir, 'nope'), nowMs: NOW_MS })
    expect(scan).toMatchObject({ ok: true, scanned: 0 })
    expect(scan.ids.size).toBe(0)
  })

  it('fails closed on an unreadable recent journal and on a symlinked root', () => {
    writeFileSync(join(dir, 'bad.json'), '{not json')
    expect(readActiveNativeWorkerTaskIds({ dir, nowMs: Date.now() }).ok).toBe(false)

    const link = join(tmpdir(), `lease-link-${process.pid}`)
    symlinkSync(dir, link)
    try {
      expect(readActiveNativeWorkerTaskIds({ dir: link, nowMs: NOW_MS }).ok).toBe(false)
    } finally {
      rmSync(link, { force: true })
    }
  })

  it('skips non-json files and symlinked journals', () => {
    writeFileSync(join(dir, 'notes.txt'), 'x')
    const target = join(tmpdir(), `lease-target-${process.pid}.json`)
    writeFileSync(target, JSON.stringify({ workers: [{ taskId: 99, status: 'running' }] }))
    symlinkSync(target, join(dir, 'link.json'))
    try {
      expect(readActiveNativeWorkerTaskIds({ dir, nowMs: Date.now() }).ids.size).toBe(0)
    } finally {
      rmSync(target, { force: true })
    }
  })
})
