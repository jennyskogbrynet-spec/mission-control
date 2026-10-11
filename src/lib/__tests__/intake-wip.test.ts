// @vitest-environment node
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WIP_RULES,
  applyDeferredPromotion,
  countOpenForSource,
  decideIntake,
  deferredMetadata,
  intakeReport,
  intakeSourceOf,
  parseWipOverrides,
  planDeferredPromotion,
  resolveWipRules,
  stripWipOwnedKeys,
} from '@/lib/intake-wip'
import { createHygieneDb, seedTask } from './fixtures/hygiene-db'

let db: Database.Database
beforeEach(() => {
  db = createHygieneDb()
})
afterEach(() => db.close())

const fa = (n: number, extra: Parameters<typeof seedTask>[1] = {}) => {
  for (let i = 0; i < n; i++) seedTask(db, { project_id: 6, metadata: { source: 'feature-audit' }, ...extra })
}
const decide = (status = 'inbox', metadata: Record<string, unknown> = { source: 'feature-audit' }, projectId = 6) =>
  decideIntake(db, { workspaceId: 1, projectId, status, metadata })

describe('rules', () => {
  it('ships the requested defaults', () => {
    expect(DEFAULT_WIP_RULES['feature-audit']).toEqual({ cap: 15, on_cap: 'defer' })
    expect(DEFAULT_WIP_RULES['feature-audit-ambition']).toEqual({ cap: 10, on_cap: 'reject' })
    expect(DEFAULT_WIP_RULES['seo-radar']).toEqual({ cap: 5, on_cap: 'defer' })
    expect(resolveWipRules(db, {})['deep-verify']).toBeUndefined()
  })

  it('layers env then setting over the defaults; 0 or null removes a cap; garbage is ignored', () => {
    expect(resolveWipRules(db, { MC_INTAKE_WIP_CAPS: '{"feature-audit":20,"deep-verify":{"cap":3,"on_cap":"reject"}}' })).toMatchObject({
      'feature-audit': { cap: 20, on_cap: 'defer' },
      'deep-verify': { cap: 3, on_cap: 'reject' },
      'seo-radar': { cap: 5 },
    })
    db.prepare("INSERT INTO settings (key, value) VALUES ('intake.wip_caps', ?)").run('{"feature-audit":0,"SEO-Radar":null,"x":-4}')
    const rules = resolveWipRules(db, { MC_INTAKE_WIP_CAPS: '{"feature-audit":20}' })
    expect(rules['feature-audit']).toBeUndefined()
    expect(rules['seo-radar']).toBeUndefined()
    expect(rules['x']).toBeUndefined()
    expect(rules['feature-audit-ambition']).toBeDefined()
    expect(resolveWipRules(db, { MC_INTAKE_WIP_CAPS: '{broken' })['feature-audit']).toBeUndefined() // setting above removed it
    db.prepare("DELETE FROM settings WHERE key = 'intake.wip_caps'").run()
    expect(resolveWipRules(db, { MC_INTAKE_WIP_CAPS: '{broken' })['feature-audit']).toEqual({ cap: 15, on_cap: 'defer' })
  })

  it('parseWipOverrides rejects non-objects', () => {
    expect(parseWipOverrides('[1]')).toBeNull()
    expect(parseWipOverrides('7')).toBeNull()
    expect(parseWipOverrides('')).toEqual({})
    expect(parseWipOverrides({ a: 5 })).toEqual({ a: { cap: 5, on_cap: 'defer' } })
  })

  it('reads the source case-insensitively and only from a string', () => {
    expect(intakeSourceOf({ source: ' Feature-Audit ' })).toBe('feature-audit')
    expect(intakeSourceOf({ source: { a: 1 } })).toBeNull()
    expect(intakeSourceOf(null)).toBeNull()
    expect(intakeSourceOf({ source: '  ' })).toBeNull()
  })
})

describe('countOpenForSource / decideIntake', () => {
  it('counts only open, non-deferred, non-exempt tasks of that source in that project and workspace', () => {
    fa(2)
    fa(1, { status: 'done' })
    fa(1, { status: 'failed' })
    fa(1, { metadata: { source: 'feature-audit', wip_deferred: true } })
    fa(1, { metadata: { source: 'feature-audit', kind: 'fix-batch' } })
    fa(1, { metadata: { source: 'feature-audit', wip_exempt: true } })
    fa(1, { project_id: 2 })
    fa(1, { project_id: 9, workspace_id: 2 })
    seedTask(db, { project_id: 6, metadata: { source: 'deep-verify' } })
    seedTask(db, { project_id: 6, metadata: 'not json at all' })
    seedTask(db, { project_id: 6, metadata: null })
    expect(countOpenForSource(db, 1, 6, 'feature-audit')).toBe(2)
  })

  it('counts every open status, including backlog and review', () => {
    for (const status of ['backlog', 'inbox', 'assigned', 'awaiting_owner', 'in_progress', 'review', 'quality_review']) fa(1, { status })
    expect(countOpenForSource(db, 1, 6, 'feature-audit')).toBe(7)
  })

  it('allows below the cap and defers at or above it (to backlog, whatever status was asked for)', () => {
    fa(14)
    expect(decide()).toMatchObject({ action: 'allow', reason: 'below_cap', open: 14, final_status: 'inbox' })
    fa(1)
    expect(decide('inbox')).toMatchObject({ action: 'defer', open: 15, final_status: 'backlog', requested_status: 'inbox' })
    expect(decide('assigned')).toMatchObject({ action: 'defer', requested_status: 'assigned' })
    fa(5)
    expect(decide()).toMatchObject({ action: 'defer', open: 20 })
  })

  it('is per project: another project is not blocked', () => {
    fa(15)
    expect(decide('inbox', { source: 'feature-audit' }, 2).action).toBe('allow')
  })

  it('rejects for a reject rule, and lets exempt, terminal, source-less and unruled tasks through', () => {
    for (let i = 0; i < 10; i++) seedTask(db, { project_id: 6, status: 'backlog', metadata: { source: 'feature-audit-ambition' } })
    expect(decide('backlog', { source: 'feature-audit-ambition' })).toMatchObject({ action: 'reject', open: 10 })
    fa(15)
    expect(decide('inbox', { source: 'feature-audit', kind: 'fix-batch' })).toMatchObject({ action: 'allow', reason: 'exempt' })
    expect(decide('inbox', { source: 'feature-audit', wip_exempt: true }).reason).toBe('exempt')
    expect(decide('done', { source: 'feature-audit' }).reason).toBe('exempt')
    expect(decide('inbox', {}).reason).toBe('no_source')
    expect(decide('inbox', { source: 'deep-verify' }).reason).toBe('no_rule')
  })

  it('uses supplied rules instead of resolving them', () => {
    fa(1)
    const d = decideIntake(db, { workspaceId: 1, projectId: 6, status: 'inbox', metadata: { source: 'feature-audit' }, rules: { 'feature-audit': { cap: 1, on_cap: 'reject' } } })
    expect(d.action).toBe('reject')
  })

  it('does not let a caller pre-flag itself as deferred or exempt-by-flag keys it does not own', () => {
    const cleaned = stripWipOwnedKeys({ source: 'feature-audit', wip_deferred: true, wip_requested_status: 'x', keep: 1 })
    expect(cleaned).toEqual({ source: 'feature-audit', keep: 1 })
    expect(deferredMetadata(decide(), '2026-10-12T00:00:00Z')).toMatchObject({ wip_deferred: true, wip_requested_status: 'inbox' })
  })
})

describe('intakeReport', () => {
  it('shows open and deferred counts per project and source with the rule that applies', () => {
    fa(16)
    fa(3, { metadata: { source: 'feature-audit', wip_deferred: true }, status: 'backlog' })
    fa(1, { status: 'review' })
    seedTask(db, { project_id: 2, metadata: { source: 'deep-verify' }, status: 'inbox' })
    const rows = intakeReport(db, 1)
    const row = rows.find((r) => r.source === 'feature-audit' && r.project_id === 6)!
    expect(row).toMatchObject({ open: 17, deferred: 3, cap: 15, on_cap: 'defer', at_or_over_cap: true, project_slug: 'qa-signal' })
    expect(row.by_status).toEqual({ inbox: 16, review: 1 })
    const dv = rows.find((r) => r.source === 'deep-verify')!
    expect(dv).toMatchObject({ open: 1, cap: null, on_cap: null, at_or_over_cap: false })
  })
})

describe('deferred promotion', () => {
  const deferred = (n: number, createdAt = 100) => {
    const ids: number[] = []
    for (let i = 0; i < n; i++) {
      ids.push(seedTask(db, { project_id: 6, status: 'backlog', created_at: createdAt + i, metadata: { source: 'feature-audit', wip_deferred: true, wip_requested_status: 'inbox' } }))
    }
    return ids
  }

  it('promotes the oldest deferred tasks that fit under the cap, nothing more', () => {
    fa(13) // 13 open, cap 15 -> room for 2
    const ids = deferred(5)
    const plan = planDeferredPromotion(db, { workspaceId: 1 })
    expect(plan.items.map((i) => i.task_id)).toEqual(ids.slice(0, 2))
    expect(plan.items.every((i) => i.to_status === 'inbox')).toBe(true)
    expect(plan.headroom).toEqual([{ project_id: 6, source: 'feature-audit', open: 13, cap: 15, promoted: 2 }])
  })

  it('plans nothing when the source is at its cap', () => {
    fa(15)
    deferred(2)
    expect(planDeferredPromotion(db, { workspaceId: 1 }).items).toEqual([])
  })

  it('apply restores the requested status, clears the flag, comments, and is safe to repeat', () => {
    const [first] = deferred(1)
    const plan = planDeferredPromotion(db, { workspaceId: 1 })
    const broadcast = vi.fn()
    const result = applyDeferredPromotion(db, 1, plan.items, { nowSec: 5_000, broadcast })
    expect(result).toEqual({ promoted: [first], skipped: [] })
    const row = db.prepare('SELECT status, metadata, updated_at FROM tasks WHERE id = ?').get(first) as { status: string; metadata: string; updated_at: number }
    expect(row.status).toBe('inbox')
    expect(row.updated_at).toBe(5_000)
    expect(JSON.parse(row.metadata)).toMatchObject({ wip_deferred: false })
    expect(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE task_id = ?').get(first)).toEqual({ n: 1 })
    expect(broadcast).toHaveBeenCalledWith('task.status_changed', expect.objectContaining({ id: first, status: 'inbox', previous_status: 'backlog' }))
    expect(applyDeferredPromotion(db, 1, plan.items, { nowSec: 6_000 })).toEqual({ promoted: [], skipped: [first] })
    expect(countOpenForSource(db, 1, 6, 'feature-audit')).toBe(1)
  })

  it('ignores deferred tasks of sources without a rule and respects the limit', () => {
    seedTask(db, { project_id: 6, status: 'backlog', metadata: { source: 'mystery', wip_deferred: true } })
    deferred(4)
    expect(planDeferredPromotion(db, { workspaceId: 1, limit: 3 }).items).toHaveLength(3)
  })
})
