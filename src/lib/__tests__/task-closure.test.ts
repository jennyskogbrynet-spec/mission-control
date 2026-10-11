// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyClosure,
  applyPrNumberBackfill,
  findClosureCandidates,
  inferDefaultRepos,
  planPrNumberBackfill,
  readPrStateSnapshot,
  sanitizePrStates,
  type PrStateMap,
} from '@/lib/task-closure'
import { createHygieneDb, seedTask } from './fixtures/hygiene-db'

const NOW_MS = Date.parse('2026-10-12T00:00:00Z')
const NOW_SEC = NOW_MS / 1000
const HOUR = 3600
const REPO = 'o/babysential'
const url = (n: number) => `https://github.com/${REPO}/pull/${n}`
const merged = (sha = 'a'.repeat(40), base = 'main') => ({ status: 'merged' as const, merged_at: '2026-10-01T10:00:00Z', merge_commit_sha: sha, base_ref: base })
const states = (spec: Record<number, PrStateMap[string]>): PrStateMap =>
  Object.fromEntries(Object.entries(spec).map(([n, s]) => [`${REPO}#${n}`, s]))

let db: Database.Database
beforeEach(() => {
  db = createHygieneDb()
})
afterEach(() => db.close())

const find = (prStates: PrStateMap, extra: Partial<Parameters<typeof findClosureCandidates>[1]> = {}) =>
  findClosureCandidates(db, { workspaceId: 1, projectSlug: 'babysential', prStates, nowMs: NOW_MS, ...extra })

describe('findClosureCandidates', () => {
  it('makes a candidate of an open task whose every linked PR is merged', () => {
    const id = seedTask(db, { status: 'inbox', metadata: { prUrl: url(10), native_codex_review: { candidate: { prNumber: 11 } } } })
    const r = find(states({ 10: merged(), 11: merged() }))
    expect(r.candidates.map((c) => c.task_id)).toEqual([id])
    expect(r.candidates[0].refs.map((x) => x.number)).toEqual([10, 11])
    expect(r.totals.candidate).toBe(1)
  })

  it('holds a task when any PR is open, closed unmerged, missing, or not yet looked up', () => {
    const open = seedTask(db, { metadata: { prUrl: url(1) } })
    const closed = seedTask(db, { metadata: { prUrl: url(2) } })
    const gone = seedTask(db, { metadata: { prUrl: url(3) } })
    const unknown = seedTask(db, { metadata: { prUrl: url(4) } })
    const mixed = seedTask(db, { metadata: { prUrl: url(5), pr_number: 6 } })
    const r = find(states({ 1: { status: 'open' }, 2: { status: 'closed' }, 3: { status: 'not_found' }, 5: merged(), 6: { status: 'open' } }))
    expect(r.candidates).toEqual([])
    const reasons = Object.fromEntries(r.held.map((h) => [h.task_id, h.reasons]))
    expect(reasons[open]).toEqual([`pr_open:${REPO}#1`])
    expect(reasons[closed]).toEqual([`pr_closed_unmerged:${REPO}#2`])
    expect(reasons[gone]).toEqual([`pr_lookup_failed:${REPO}#3`])
    expect(reasons[unknown]).toEqual([`pr_state_unknown:${REPO}#4`])
    expect(reasons[mixed]).toEqual([`pr_open:${REPO}#6`])
    expect(r.needs_lookup).toEqual([`${REPO}#4`])
  })

  it('holds a PR that merged into a branch other than main/master', () => {
    seedTask(db, { metadata: { prUrl: url(1) } })
    const r = find(states({ 1: merged('b'.repeat(40), 'integration/tools') }))
    expect(r.candidates).toEqual([])
    expect(r.held[0].reasons).toEqual([`merged_into_integration/tools:${REPO}#1`])
    expect(find(states({ 1: merged('b'.repeat(40), 'integration/tools') }), { baseBranches: ['integration/tools'] }).candidates).toHaveLength(1)
  })

  it('reports tasks already waiting for a reviewer instead of moving them', () => {
    const review = seedTask(db, { status: 'review', metadata: { prUrl: url(1) } })
    const qr = seedTask(db, { status: 'quality_review', metadata: { prUrl: url(1) } })
    const failed = seedTask(db, { status: 'failed', metadata: { prUrl: url(1) } })
    const r = find(states({ 1: merged() }))
    expect(r.candidates).toEqual([])
    expect(r.awaiting_review.map((c) => c.task_id).sort()).toEqual([review, qr].sort())
    expect(r.failed_but_shipped.map((c) => c.task_id)).toEqual([failed])
  })

  it('does not move a task that waits for an owner decision: a merged PR does not answer it', () => {
    const waiting = seedTask(db, { status: 'awaiting_owner', metadata: { prUrl: url(1) } })
    const r = find(states({ 1: merged() }))
    expect(r.candidates).toEqual([])
    expect(r.held.find((h) => h.task_id === waiting)!.reasons).toEqual(['awaiting_owner_decision'])
  })

  it('skips done tasks and tasks with no PR link, and counts them', () => {
    seedTask(db, { status: 'done', metadata: { prUrl: url(1) } })
    seedTask(db, { status: 'inbox', metadata: {} })
    const r = find(states({ 1: merged() }))
    expect(r.totals).toMatchObject({ done_skipped: 1, no_pr_refs: 1, considered: 1, candidate: 0 })
  })

  it('never auto-moves multi-finding digests or fix-batch release carriers', () => {
    const digest = seedTask(db, { metadata: { prUrl: url(1), finding_ids: ['a-01', 'b-02', 'c-03'] } })
    const single = seedTask(db, { metadata: { prUrl: url(1), finding_ids: ['a-01'] } })
    const carrier = seedTask(db, { metadata: { prUrl: url(1), kind: 'fix-batch' } })
    const r = find(states({ 1: merged() }))
    expect(r.candidates.map((c) => c.task_id)).toEqual([single])
    const reasons = Object.fromEntries(r.held.map((h) => [h.task_id, h.reasons]))
    expect(reasons[digest]).toEqual(['multi_finding_digest'])
    expect(reasons[carrier]).toEqual(['release_carrier'])
  })

  it('holds a task whose claim is still alive, and releases an expired claim with the move', () => {
    const live = seedTask(db, { status: 'in_progress', claim_state: 'Claimed', claimed_by: 'agent-a', claimed_at: new Date(NOW_MS - 2 * HOUR * 1000).toISOString(), updated_at: NOW_SEC - 2 * HOUR, metadata: { prUrl: url(1) } })
    const stale = seedTask(db, { status: 'in_progress', claim_state: 'Claimed', claimed_by: 'agent-b', claimed_at: new Date(NOW_MS - 200 * HOUR * 1000).toISOString(), updated_at: NOW_SEC - 200 * HOUR, metadata: { prUrl: url(1) } })
    const r = find(states({ 1: merged() }))
    expect(r.held.find((h) => h.task_id === live)!.reasons).toEqual(['active_claim'])
    const candidate = r.candidates.find((c) => c.task_id === stale)!
    expect(candidate.stale_claim).toBe(true)

    applyClosure(db, [candidate], { nowSec: NOW_SEC })
    expect(db.prepare('SELECT status, claim_state, claimed_by FROM tasks WHERE id = ?').get(stale)).toEqual({ status: 'review', claim_state: 'Unclaimed', claimed_by: null })
    expect(db.prepare('SELECT claim_state FROM tasks WHERE id = ?').get(live)).toEqual({ claim_state: 'Claimed' })
  })

  it('is scoped to the workspace and the project', () => {
    seedTask(db, { metadata: { prUrl: url(1) } })
    seedTask(db, { project_id: 6, metadata: { prUrl: url(1) } })
    seedTask(db, { project_id: 9, workspace_id: 2, metadata: { prUrl: url(1) } })
    expect(find(states({ 1: merged() })).candidates).toHaveLength(1)
    expect(find(states({ 1: merged() }), { projectSlug: null }).candidates).toHaveLength(2)
  })

  it('resolves a bare PR number against the repo its project’s PR URLs use, and flags it when there is none', () => {
    const bare = seedTask(db, { metadata: { pr: 7 } })
    seedTask(db, { status: 'done', metadata: { prUrl: url(1) } }) // gives the project a default repo
    const withDefault = find(states({ 7: merged() }))
    expect(withDefault.candidates.map((c) => c.task_id)).toEqual([bare])
    expect(withDefault.default_repos).toEqual({ babysential: REPO })

    const lonely = createHygieneDb()
    seedTask(lonely, { metadata: { pr: 7 } })
    const r = findClosureCandidates(lonely, { workspaceId: 1, projectSlug: 'babysential', prStates: {}, nowMs: NOW_MS })
    expect(r.held[0].reasons).toEqual(['repo_unresolved:#7'])
    expect(r.unresolved_repo_tasks).toHaveLength(1)
    lonely.close()
  })

  it('infers the most common repo per project', () => {
    const rows = [
      { slug: 'babysential', meta: { prUrl: 'https://github.com/x/a/pull/1' } },
      { slug: 'babysential', meta: { prUrl: 'https://github.com/x/a/pull/2' } },
      { slug: 'babysential', meta: { prUrl: 'https://github.com/x/b/pull/3' } },
      { slug: 'other', meta: { prUrl: 'https://github.com/x/c/pull/4' } },
    ].map((r, i) => ({ id: i, workspace_id: 1, project_id: 1, project_slug: r.slug, title: '', status: 'inbox', claim_state: 'Unclaimed', claimed_by: null, claimed_at: null, updated_at: 0, github_pr_number: null, github_repo: null, github_pr_state: null, metadata: JSON.stringify(r.meta) }))
    const inferred = inferDefaultRepos(rows)
    expect(inferred.byProject.get('babysential')).toBe('x/a')
    expect(inferred.byProject.get('other')).toBe('x/c')
    expect(inferred.global).toBe('x/a')
  })
})

describe('applyClosure', () => {
  it('moves a candidate to review (never done) with an evidence comment, an activity row and metadata', () => {
    const id = seedTask(db, { status: 'inbox', updated_at: 5_000, metadata: { prUrl: url(10), keep: 'me' } })
    const broadcast = vi.fn()
    const r = find(states({ 10: merged('c'.repeat(40)) }))
    const result = applyClosure(db, r.candidates, { actor: 'closure-sweep', nowSec: NOW_SEC, broadcast })
    expect(result).toEqual({ moved: [id], skipped: [] })

    const row = db.prepare('SELECT status, updated_at, completed_at, metadata FROM tasks WHERE id = ?').get(id) as { status: string; updated_at: number; completed_at: number | null; metadata: string }
    expect(row.status).toBe('review')
    expect(row.completed_at).toBeNull()
    expect(row.updated_at).toBe(NOW_SEC)
    const meta = JSON.parse(row.metadata)
    expect(meta.keep).toBe('me')
    expect(meta.pr_closure).toMatchObject({ by: 'closure-sweep', previous_status: 'inbox', prs: [{ repo: REPO, number: 10, merge_commit_sha: 'c'.repeat(40) }] })

    const comment = db.prepare('SELECT author, content FROM comments WHERE task_id = ?').get(id) as { author: string; content: string }
    expect(comment.author).toBe('closure-sweep')
    expect(comment.content).toContain('PR #10')
    expect(comment.content).toContain('cccccccc')
    expect(comment.content).toContain('from inbox to review')
    expect(comment.content).toContain('not a close')
    expect(db.prepare("SELECT COUNT(*) AS n FROM activities WHERE entity_id = ? AND type = 'task_updated'").get(id)).toEqual({ n: 1 })
    expect(broadcast).toHaveBeenCalledWith('task.status_changed', expect.objectContaining({ id, status: 'review', previous_status: 'inbox' }))
  })

  it('skips a task that changed after the report (compare-and-set) and anything that is not a candidate', () => {
    const touched = seedTask(db, { status: 'inbox', updated_at: 5_000, metadata: { prUrl: url(10) } })
    const moved = seedTask(db, { status: 'backlog', updated_at: 5_000, metadata: { prUrl: url(10) } })
    const r = find(states({ 10: merged() }))
    db.prepare('UPDATE tasks SET updated_at = 6000 WHERE id = ?').run(touched)
    const result = applyClosure(db, [...r.candidates, ...find(states({ 10: { status: 'open' } })).held], { nowSec: NOW_SEC })
    expect(result.moved).toEqual([moved])
    expect(result.skipped).toEqual(expect.arrayContaining([{ task_id: touched, reason: 'changed_since_evaluation' }]))
    expect(result.skipped.some((s) => s.reason.startsWith('not_a_candidate'))).toBe(true)
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(touched)).toEqual({ status: 'inbox' })
  })

  it('is idempotent: a second pass finds nothing left to move', () => {
    seedTask(db, { status: 'inbox', metadata: { prUrl: url(10) } })
    const first = find(states({ 10: merged() }))
    applyClosure(db, first.candidates, { nowSec: NOW_SEC })
    const second = find(states({ 10: merged() }))
    expect(second.candidates).toEqual([])
    expect(second.awaiting_review).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 1 })
  })

  it('caps the PR list in the comment', () => {
    const meta: Record<string, unknown> = {}
    const spec: Record<number, PrStateMap[string]> = {}
    const list: string[] = []
    for (let i = 1; i <= 30; i++) {
      list.push(url(i))
      spec[i] = merged()
    }
    meta.prs = list
    const id = seedTask(db, { metadata: meta })
    applyClosure(db, find(states(spec)).candidates, { nowSec: NOW_SEC })
    const comment = db.prepare('SELECT content FROM comments WHERE task_id = ?').get(id) as { content: string }
    expect(comment.content).toContain('+5 more')
  })
})

describe('github_pr_number backfill', () => {
  it('plans one PR per task, leaves ambiguous ones alone, and counts what is already set', () => {
    const one = seedTask(db, { status: 'done', metadata: { prUrl: url(10), native_codex_review: { candidate: { prNumber: 10 } } } })
    const two = seedTask(db, { metadata: { prUrl: url(10), pr_url: url(11) } })
    seedTask(db, { github_pr_number: 5, metadata: { prUrl: url(10) } })
    seedTask(db, { metadata: {} })
    const plan = planPrNumberBackfill(db, { workspaceId: 1, projectSlug: 'babysential', prStates: states({ 10: merged() }) })
    expect(plan.items.map((i) => [i.task_id, i.github_pr_number, i.github_pr_state])).toEqual([[one, 10, 'merged']])
    expect(plan.ambiguous).toEqual([{ task_id: two, numbers: [10, 11] }])
    expect(plan.already_set).toBe(1)
    expect(plan.no_refs).toBe(1)
  })

  it('writes the column only: updated_at, status and github_repo are untouched, existing values are not overwritten', () => {
    const id = seedTask(db, { status: 'review', updated_at: 5_000, metadata: { prUrl: url(10) } })
    const taken = seedTask(db, { github_pr_number: 99, metadata: { prUrl: url(10) } })
    const plan = planPrNumberBackfill(db, { workspaceId: 1, projectSlug: 'babysential', prStates: states({ 10: merged() }) })
    const forced = [...plan.items, { task_id: taken, workspace_id: 1, project_slug: 'babysential', status: 'inbox', github_pr_number: 10, repo: REPO, github_pr_state: null }]
    const result = applyPrNumberBackfill(db, forced)
    expect(result).toEqual({ updated: [id], skipped: [taken] })
    expect(db.prepare('SELECT github_pr_number, github_pr_state, updated_at, status, github_repo FROM tasks WHERE id = ?').get(id)).toEqual({
      github_pr_number: 10,
      github_pr_state: 'merged',
      updated_at: 5_000,
      status: 'review',
      github_repo: null,
    })
    expect(db.prepare('SELECT github_pr_number FROM tasks WHERE id = ?').get(taken)).toEqual({ github_pr_number: 99 })
  })

  it('leaves the state NULL when the PR state is unknown', () => {
    const id = seedTask(db, { metadata: { prUrl: url(10) } })
    applyPrNumberBackfill(db, planPrNumberBackfill(db, { workspaceId: 1, projectSlug: 'babysential' }).items)
    expect(db.prepare('SELECT github_pr_number, github_pr_state FROM tasks WHERE id = ?').get(id)).toEqual({ github_pr_number: 10, github_pr_state: null })
  })
})

describe('PR state input', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'closure-snapshot-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads a snapshot file, lower-casing keys and dropping malformed entries', () => {
    const file = join(dir, 'snap.json')
    writeFileSync(file, JSON.stringify({ generated_at: '2026-10-12T00:00:00Z', prs: { 'O/R#1': { status: 'merged', merge_commit_sha: 'abc', base_ref: 'main' }, 'o/r#2': { status: 'weird' }, 'o/r#3': 'x' } }))
    const snap = readPrStateSnapshot(file)!
    expect(snap.generated_at).toBe('2026-10-12T00:00:00Z')
    expect(Object.keys(snap.states)).toEqual(['o/r#1'])
    expect(snap.states['o/r#1']).toMatchObject({ status: 'merged', merge_commit_sha: 'abc', base_ref: 'main' })
  })

  it('returns null for a missing or malformed snapshot', () => {
    expect(readPrStateSnapshot(join(dir, 'missing.json'))).toBeNull()
    writeFileSync(join(dir, 'bad.json'), '{')
    expect(readPrStateSnapshot(join(dir, 'bad.json'))).toBeNull()
    writeFileSync(join(dir, 'noprs.json'), '{"a":1}')
    expect(readPrStateSnapshot(join(dir, 'noprs.json'))).toBeNull()
  })

  it('sanitises client-supplied states', () => {
    const out = sanitizePrStates({ 'o/r#1': { status: 'merged', merged_at: 5 }, 'bad key': { status: 'merged' }, 'o/r#2': { status: 'nope' }, 'o/r#3': null })
    expect(Object.keys(out)).toEqual(['o/r#1'])
    expect(out['o/r#1'].merged_at).toBeNull()
    expect(sanitizePrStates('x')).toEqual({})
    expect(sanitizePrStates([1])).toEqual({})
  })
})
