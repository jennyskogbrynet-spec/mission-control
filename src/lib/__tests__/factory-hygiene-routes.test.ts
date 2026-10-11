// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHygieneDb, seedTask } from './fixtures/hygiene-db'

const mocks = vi.hoisted(() => ({
  database: vi.fn(),
  role: vi.fn(),
  broadcast: vi.fn(),
  native: vi.fn(),
  dataDir: { value: '' },
}))
vi.mock('@/lib/db', () => ({ getDatabase: mocks.database }))
vi.mock('@/lib/auth', () => ({ requireRole: mocks.role }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: mocks.broadcast } }))
vi.mock('@/lib/config', () => ({
  config: {
    get dataDir() {
      return mocks.dataDir.value
    },
  },
}))
// The real journal lives under the operator's home; tests must never read it.
vi.mock('@/lib/claim-lease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/claim-lease')>()),
  readActiveNativeWorkerTaskIds: mocks.native,
}))

import { GET as closureGet, POST as closurePost } from '@/app/api/tasks/closure-candidates/route'
import { GET as leaseGet, POST as leasePost } from '@/app/api/tasks/claim-leases/route'
import { GET as intakeGet, POST as intakePost } from '@/app/api/tasks/intake-wip/route'
import { runClosure, runIntake, runLeases } from '../../../scripts/mc-factory-hygiene.mjs'

const HOUR = 3600
const REPO = 'o/babysential'
const url = (n: number) => `https://github.com/${REPO}/pull/${n}`
const mergedState = { status: 'merged', merged_at: '2026-10-01T10:00:00Z', merge_commit_sha: 'a'.repeat(40), base_ref: 'main' }

let db: Database.Database
let dir: string
const req = (path: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://localhost${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  dir = mkdtempSync(join(tmpdir(), 'hygiene-routes-'))
  mocks.dataDir.value = dir
  db = createHygieneDb()
  mocks.database.mockReturnValue(db)
  mocks.role.mockReturnValue({ user: { id: 1, username: 'operator', workspace_id: 1, role: 'operator' } })
  mocks.native.mockReturnValue({ ok: true, ids: new Set<number>(), scanned: 0 })
  delete process.env.MC_PR_STATE_SNAPSHOT
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('/api/tasks/closure-candidates', () => {
  it('GET is read-only and says what to look up when no snapshot exists', async () => {
    const id = seedTask(db, { status: 'inbox', metadata: { prUrl: url(10) } })
    const res = await closureGet(req('/api/tasks/closure-candidates?project=babysential'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.snapshot).toBeNull()
    expect(body.report.candidates).toEqual([])
    expect(body.report.needs_lookup).toEqual([`${REPO}#10`])
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)).toEqual({ status: 'inbox' })
  })

  it('GET judges against the snapshot file and reports its age', async () => {
    seedTask(db, { status: 'inbox', metadata: { prUrl: url(10) } })
    const file = join(dir, 'pr-state-snapshot.json')
    writeFileSync(file, JSON.stringify({ generated_at: new Date(Date.now() - 2 * HOUR * 1000).toISOString(), prs: { [`${REPO}#10`]: mergedState } }))
    const body = await (await closureGet(req('/api/tasks/closure-candidates?project=babysential'))).json()
    expect(body.report.candidates).toHaveLength(1)
    expect(body.snapshot).toMatchObject({ pr_count: 1 })
    expect(body.snapshot.age_hours).toBeGreaterThanOrEqual(1.9)
    expect(JSON.stringify(body)).not.toContain(dir) // no filesystem path leaks
  })

  it('POST is a dry run unless apply is exactly true', async () => {
    const id = seedTask(db, { status: 'inbox', metadata: { prUrl: url(10) } })
    for (const apply of [undefined, false, 'true', 1]) {
      const res = await closurePost(req('/api/tasks/closure-candidates', 'POST', { project: 'babysential', pr_states: { [`${REPO}#10`]: mergedState }, apply }))
      const body = await res.json()
      expect(body.dry_run).toBe(true)
      expect(body.report.candidates).toHaveLength(1)
      expect(body.applied).toBeNull()
    }
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)).toEqual({ status: 'inbox' })
  })

  it('POST apply moves candidates to review (not done), recomputing from the supplied PR states', async () => {
    const ok = seedTask(db, { status: 'inbox', metadata: { prUrl: url(10) } })
    const open = seedTask(db, { status: 'inbox', metadata: { prUrl: url(11) } })
    const res = await closurePost(
      req('/api/tasks/closure-candidates', 'POST', {
        project: 'babysential',
        pr_states: { [`${REPO}#10`]: mergedState, [`${REPO}#11`]: { status: 'open' } },
        apply: true,
        task_ids: [ok, open, 99999],
      }),
    )
    const body = await res.json()
    expect(body.dry_run).toBe(false)
    expect(body.applied.moved).toEqual([ok])
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(ok)).toEqual({ status: 'review' })
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(open)).toEqual({ status: 'inbox' })
    expect(db.prepare("SELECT status FROM tasks WHERE status = 'done'").all()).toEqual([])
    expect(mocks.broadcast).toHaveBeenCalledWith('task.status_changed', expect.objectContaining({ id: ok, status: 'review' }))
    const comment = db.prepare('SELECT author FROM comments WHERE task_id = ?').get(ok) as { author: string }
    expect(comment.author).toBe('operator')
  })

  it('POST task_ids can only narrow the set', async () => {
    const a = seedTask(db, { status: 'inbox', metadata: { prUrl: url(10) } })
    const b = seedTask(db, { status: 'inbox', metadata: { prUrl: url(10) } })
    const body = await (await closurePost(req('/api/tasks/closure-candidates', 'POST', { project: 'babysential', pr_states: { [`${REPO}#10`]: mergedState }, apply: true, task_ids: [a] }))).json()
    expect(body.applied.moved).toEqual([a])
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(b)).toEqual({ status: 'inbox' })
  })

  it('POST refuses to apply when the controller journal cannot be read, but still previews', async () => {
    seedTask(db, { status: 'inbox', metadata: { prUrl: url(10) } })
    mocks.native.mockReturnValue({ ok: false, ids: new Set<number>(), scanned: 0, reason: 'journal root unreadable' })
    const body = { project: 'babysential', pr_states: { [`${REPO}#10`]: mergedState } }
    expect((await closurePost(req('/api/tasks/closure-candidates', 'POST', { ...body, apply: true }))).status).toBe(409)
    expect((await closurePost(req('/api/tasks/closure-candidates', 'POST', body))).status).toBe(200)
  })

  it('POST backfill is planned on a dry run and written only on apply', async () => {
    const id = seedTask(db, { status: 'done', metadata: { prUrl: url(10) } })
    const body = { project: 'babysential', pr_states: { [`${REPO}#10`]: mergedState }, backfill_pr_numbers: true }
    const dry = await (await closurePost(req('/api/tasks/closure-candidates', 'POST', body))).json()
    expect(dry.backfill).toMatchObject({ planned: 1, written: null })
    expect(db.prepare('SELECT github_pr_number FROM tasks WHERE id = ?').get(id)).toEqual({ github_pr_number: null })
    const applied = await (await closurePost(req('/api/tasks/closure-candidates', 'POST', { ...body, apply: true }))).json()
    expect(applied.backfill.written.updated).toEqual([id])
    expect(db.prepare('SELECT github_pr_number, github_pr_state FROM tasks WHERE id = ?').get(id)).toEqual({ github_pr_number: 10, github_pr_state: 'merged' })
  })

  it('requires auth, and an operator for POST', async () => {
    mocks.role.mockReturnValueOnce({ error: 'Authentication required', status: 401 })
    expect((await closureGet(req('/api/tasks/closure-candidates'))).status).toBe(401)
    mocks.role.mockReturnValueOnce({ error: 'Requires operator role or higher', status: 403 })
    expect((await closurePost(req('/api/tasks/closure-candidates', 'POST', { apply: true }))).status).toBe(403)
    expect(mocks.role).toHaveBeenLastCalledWith(expect.anything(), 'operator')
  })

  it('does not see another workspace', async () => {
    mocks.role.mockReturnValue({ user: { id: 2, username: 'other', workspace_id: 2, role: 'operator' } })
    seedTask(db, { status: 'inbox', metadata: { prUrl: url(10) } })
    const body = await (await closurePost(req('/api/tasks/closure-candidates', 'POST', { pr_states: { [`${REPO}#10`]: mergedState }, apply: true }))).json()
    expect(body.report.totals.considered).toBe(0)
    expect(body.applied.moved).toEqual([])
  })
})

describe('/api/tasks/claim-leases', () => {
  const claimed = (idleHours: number) =>
    seedTask(db, {
      status: 'review',
      claim_state: 'Claimed',
      claimed_by: 'agent-a',
      claimed_at: new Date(Date.now() - idleHours * HOUR * 1000).toISOString(),
      updated_at: Math.floor(Date.now() / 1000) - idleHours * HOUR,
    })

  it('GET reports expired claims without changing anything', async () => {
    const id = claimed(100)
    claimed(1)
    const body = await (await leaseGet(req('/api/tasks/claim-leases'))).json()
    expect(body).toMatchObject({ applied: false, lease_hours: 72, evaluated: 2, within_lease: 1 })
    expect(body.expired.map((e: { task_id: number }) => e.task_id)).toEqual([id])
    expect(db.prepare('SELECT claim_state FROM tasks WHERE id = ?').get(id)).toEqual({ claim_state: 'Claimed' })
  })

  it('POST releases only with apply:true; lease_hours overrides the default', async () => {
    const id = claimed(30)
    expect((await (await leasePost(req('/api/tasks/claim-leases', 'POST', { lease_hours: 24 }))).json()).released).toEqual([])
    expect(db.prepare('SELECT claim_state FROM tasks WHERE id = ?').get(id)).toEqual({ claim_state: 'Claimed' })
    const body = await (await leasePost(req('/api/tasks/claim-leases', 'POST', { apply: true, lease_hours: 24 }))).json()
    expect(body.released).toEqual([id])
    expect(db.prepare('SELECT claim_state, claimed_by FROM tasks WHERE id = ?').get(id)).toEqual({ claim_state: 'Unclaimed', claimed_by: null })
    expect(mocks.broadcast).toHaveBeenCalledWith('task.updated', expect.objectContaining({ id, claim_state: 'Unclaimed' }))
  })

  it('takes the lease length from the setting', async () => {
    claimed(30)
    db.prepare("INSERT INTO settings (key, value) VALUES ('general.claim_lease_hours', '24')").run()
    expect((await (await leaseGet(req('/api/tasks/claim-leases'))).json()).expired).toHaveLength(1)
  })

  it('protects a claim with a live native worker and refuses to apply when the journal is unreadable', async () => {
    const id = claimed(100)
    mocks.native.mockReturnValue({ ok: true, ids: new Set([id]), scanned: 1 })
    const body = await (await leasePost(req('/api/tasks/claim-leases', 'POST', { apply: true }))).json()
    expect(body.released).toEqual([])
    expect(body.protected).toHaveLength(1)

    mocks.native.mockReturnValue({ ok: false, ids: new Set<number>(), scanned: 0, reason: 'unreadable' })
    expect((await leasePost(req('/api/tasks/claim-leases', 'POST', { apply: true }))).status).toBe(409)
    expect(db.prepare('SELECT claim_state FROM tasks WHERE id = ?').get(id)).toEqual({ claim_state: 'Claimed' })
  })
})

describe('/api/tasks/intake-wip', () => {
  it('GET shows the effective rules and per-source counts', async () => {
    for (let i = 0; i < 16; i++) seedTask(db, { project_id: 6, metadata: { source: 'feature-audit' } })
    const body = await (await intakeGet(req('/api/tasks/intake-wip'))).json()
    expect(body.rules['feature-audit']).toEqual({ cap: 15, on_cap: 'defer' })
    expect(body.rows[0]).toMatchObject({ source: 'feature-audit', open: 16, cap: 15, at_or_over_cap: true })
  })

  it('POST promote is a dry run unless apply is true', async () => {
    const id = seedTask(db, { project_id: 6, status: 'backlog', metadata: { source: 'feature-audit', wip_deferred: true, wip_requested_status: 'inbox' } })
    const dry = await (await intakePost(req('/api/tasks/intake-wip', 'POST', {}))).json()
    expect(dry.dry_run).toBe(true)
    expect(dry.plan.items.map((i: { task_id: number }) => i.task_id)).toEqual([id])
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)).toEqual({ status: 'backlog' })
    const done = await (await intakePost(req('/api/tasks/intake-wip', 'POST', { apply: true }))).json()
    expect(done.result.promoted).toEqual([id])
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)).toEqual({ status: 'inbox' })
  })
})

describe('the CLI against the real route handlers (field-name contract)', () => {
  const handlers: Record<string, (r: NextRequest) => Promise<Response>> = {
    'GET /api/tasks/closure-candidates': closureGet,
    'POST /api/tasks/closure-candidates': closurePost,
    'POST /api/tasks/claim-leases': leasePost,
    'GET /api/tasks/intake-wip': intakeGet,
    'POST /api/tasks/intake-wip': intakePost,
  }
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const u = new URL(`http://localhost${path}`)
    const handler = handlers[`${method} ${u.pathname}`]
    if (!handler) throw new Error(`no handler for ${method} ${u.pathname}`)
    const res = await handler(req(`${u.pathname}${u.search}`, method, body))
    const json = await res.json()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`)
    return json
  }
  const read = async () => ({ ok: true, doc: { state: 'closed', merged: true, merged_at: '2026-10-01T10:00:00Z', merge_commit_sha: 'f'.repeat(40), base: { ref: 'main' } } })

  it('closure: dry run lists the candidate, --apply moves it to review, a second run finds nothing', async () => {
    const id = seedTask(db, { status: 'inbox', title: 'Shipped but open', metadata: { prUrl: url(10) } })
    seedTask(db, { status: 'done', metadata: { prUrl: url(10) } })
    const lines: string[] = []
    const log = (l: string) => lines.push(l)
    const dry = await runClosure({ project: 'babysential', backfill: true }, { request, read, log })
    expect(lines.join('\n')).toContain(`CANDIDATE #${id}`)
    expect(lines.join('\n')).toContain('DRY RUN')
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)).toEqual({ status: 'inbox' })
    expect(dry.preview.backfill.planned).toBe(2)

    await runClosure({ project: 'babysential', backfill: true, apply: true }, { request, read, log })
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)).toEqual({ status: 'review' })
    expect(db.prepare('SELECT github_pr_number FROM tasks WHERE id = ?').get(id)).toEqual({ github_pr_number: 10 })

    const again = await runClosure({ project: 'babysential' }, { request, read, log: () => {} })
    expect(again.preview.report.totals.candidate).toBe(0)
    expect(again.preview.report.totals.awaiting_review).toBe(1)
  })

  it('leases: dry run reports, --apply releases', async () => {
    const id = seedTask(db, {
      status: 'review',
      claim_state: 'Claimed',
      claimed_by: 'agent-a',
      claimed_at: new Date(Date.now() - 200 * HOUR * 1000).toISOString(),
      updated_at: Math.floor(Date.now() / 1000) - 200 * HOUR,
    })
    const lines: string[] = []
    await runLeases({}, { request, log: (l: string) => lines.push(l) })
    expect(lines.join('\n')).toContain(`EXPIRED #${id}`)
    expect(db.prepare('SELECT claim_state FROM tasks WHERE id = ?').get(id)).toEqual({ claim_state: 'Claimed' })
    await runLeases({ apply: true }, { request, log: () => {} })
    expect(db.prepare('SELECT claim_state FROM tasks WHERE id = ?').get(id)).toEqual({ claim_state: 'Unclaimed' })
  })

  it('intake: report and promote read the same fields the routes send', async () => {
    for (let i = 0; i < 16; i++) seedTask(db, { project_id: 6, metadata: { source: 'feature-audit' } })
    const deferred = seedTask(db, { project_id: 6, status: 'backlog', metadata: { source: 'feature-audit', wip_deferred: true, wip_requested_status: 'inbox' } })
    const lines: string[] = []
    await runIntake({}, { request, log: (l: string) => lines.push(l) })
    expect(lines.join('\n')).toContain('AT/OVER CAP')
    const promoted = await runIntake({ promote: true, apply: true }, { request, log: () => {} })
    expect(promoted.result.result.promoted).toEqual([]) // at the cap: nothing fits
    db.prepare("UPDATE tasks SET status = 'done' WHERE project_id = 6 AND status = 'inbox'").run()
    const after = await runIntake({ promote: true, apply: true }, { request, log: () => {} })
    expect(after.result.result.promoted).toEqual([deferred])
  })
})
