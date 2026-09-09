// @vitest-environment node
import Database from 'better-sqlite3'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  db: null as any,
  user: { username: 'martin', workspace_id: 1, role: 'operator' } as Record<string, unknown>,
  broadcast: vi.fn(),
  roots: { journalRoot: '', receiptRoots: [] as string[] },
}))

vi.mock('@/lib/db', () => ({ getDatabase: () => mock.db }))
vi.mock('@/lib/auth', () => ({ requireRole: () => ({ user: mock.user }) }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: mock.broadcast } }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

// The real reconciler runs; only its roots are injected. Production callers get
// the fixed canonical paths and can never supply a root.
vi.mock('@/lib/task-review-resume', async () => {
  const actual = await vi.importActual<typeof import('../task-review-resume')>(
    '../task-review-resume',
  )
  return {
    ...actual,
    reconcileNativeTerminalEvidence: (request: Parameters<typeof actual.reconcileNativeTerminalEvidence>[0]) =>
      actual.reconcileNativeTerminalEvidence(request, {
        journalRoot: mock.roots.journalRoot,
        receiptRoots: mock.roots.receiptRoots,
      }),
  }
})

const TASK_ID = 1301
const PROJECT_ID = 2
const PRIOR_METADATA = {
  pr: 'PR435-f3a62d31',
  receipts: ['opus-implementation', 'fable-review'],
  history: [{ at: '2026-09-08T17:23:15Z', event: 'review_released' }],
}

let root = ''

function receipt(name: string, body: Record<string, unknown>): string {
  const file = path.join(root, 'receipts', `${name}.json`)
  writeFileSync(file, JSON.stringify(body))
  return file
}

/** Mirrors fixtures/native-terminal.json. */
function terminalReceipt(name: string, session: string, status = 'completed', exitCode = 0) {
  return receipt(name, {
    status,
    exitCode,
    sessionId: session,
    sessionRef: `claude-code:${session}`,
    startedAt: '2026-09-08T17:17:36.539562+00:00',
    completedAt: '2026-09-08T17:23:15.983993+00:00',
    permissionDenials: [],
  })
}

/** Mirrors fixtures/controller-run.json. */
function worker(
  workerId: string,
  phase: string,
  status: string,
  session: string,
  receiptRef: string | null,
) {
  return {
    workerId,
    taskId: TASK_ID,
    dispatch: { type: 'dispatch', workerId, taskId: TASK_ID, phase, agent: 'main' },
    route: { bindingId: 'claude-martin', runtimeId: 'claude-code' },
    status,
    // A deadline in the past proves nothing and must never be read as terminal.
    deadlineAt: 1788889056.340105,
    sessionRef: `claude-code:${session}`,
    receiptRef,
  }
}

function journal(name: string, body: Record<string, unknown>) {
  writeFileSync(path.join(root, 'runs', `${name}.json`), JSON.stringify(body))
}

/** Four prior workers: three completed, one genuinely failed with a nonzero exit. */
function writeTerminalJournal(overrides: Record<string, unknown> = {}) {
  journal('001-run', {
    id: '2fb27d2d-6d6c-41eb-9e8d-7308b6057867',
    status: 'completed',
    projectId: PROJECT_ID,
    workspaceId: null,
    workers: [
      worker('w-impl-1', 'implementation', 'completed', 'sess-impl-1', terminalReceipt('impl-1', 'sess-impl-1')),
      worker('w-review-1', 'review', 'completed', 'sess-review-1', terminalReceipt('review-1', 'sess-review-1')),
      worker('w-impl-2', 'implementation', 'completed', 'sess-impl-2', terminalReceipt('impl-2', 'sess-impl-2')),
      worker(
        'w-review-2',
        'review',
        'failed',
        'sess-review-2',
        terminalReceipt('review-2', 'sess-review-2', 'failed', 1),
      ),
    ],
    ...overrides,
  })
}

function seedTask(fields: Record<string, unknown> = {}) {
  const row = {
    id: TASK_ID,
    workspace_id: 1,
    title: 'MC1301 review',
    status: 'review',
    priority: 'high',
    project_id: PROJECT_ID,
    project_ticket_no: 1301,
    tags: '[]',
    metadata: JSON.stringify(PRIOR_METADATA),
    claim_state: 'Released',
    claimed_by: null,
    claimed_at: null,
    retry_count: 0,
    created_at: 1000,
    updated_at: 2000,
    ...fields,
  }
  mock.db
    .prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, priority, project_id, project_ticket_no,
        tags, metadata, claim_state, claimed_by, claimed_at, retry_count, created_at, updated_at)
       VALUES (@id, @workspace_id, @title, @status, @priority, @project_id, @project_ticket_no,
        @tags, @metadata, @claim_state, @claimed_by, @claimed_at, @retry_count, @created_at, @updated_at)`,
    )
    .run(row)
  return row
}

function taskRow(id = TASK_ID, workspaceId = 1) {
  return mock.db
    .prepare(`SELECT * FROM tasks WHERE id = ? AND workspace_id = ?`)
    .get(id, workspaceId) as any
}

async function resume(body: unknown, id: number = TASK_ID) {
  const { POST } = await import('@/app/api/tasks/[id]/resume-review/route')
  const request = new NextRequest(`http://localhost/api/tasks/${id}/resume-review`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  const response = await POST(request, { params: Promise.resolve({ id: String(id) }) })
  return { status: response.status, body: (await response.json()) as any }
}

async function claim(agent: string, id: number = TASK_ID) {
  const { POST } = await import('@/app/api/tasks/[id]/claim/route')
  const request = new NextRequest(`http://localhost/api/tasks/${id}/claim`, {
    method: 'POST',
    body: JSON.stringify({ agent }),
    headers: { 'content-type': 'application/json' },
  })
  const response = await POST(request, { params: Promise.resolve({ id: String(id) }) })
  return { status: response.status, body: (await response.json()) as any }
}

describe('POST /api/tasks/[id]/resume-review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.user = { username: 'martin', workspace_id: 1, role: 'operator' }
    root = mkdtempSync(path.join(tmpdir(), 'mc1308-'))
    mkdirSync(path.join(root, 'runs'))
    mkdirSync(path.join(root, 'receipts'))
    mock.roots = { journalRoot: path.join(root, 'runs'), receiptRoots: [root] }

    mock.db = new Database(':memory:')
    mock.db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL DEFAULT 1, title TEXT NOT NULL,
        description TEXT, status TEXT NOT NULL, priority TEXT, project_id INTEGER,
        project_ticket_no INTEGER, assigned_to TEXT, tags TEXT, metadata TEXT,
        claim_state TEXT NOT NULL DEFAULT 'Unclaimed', claimed_by TEXT, claimed_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE projects (id INTEGER PRIMARY KEY, workspace_id INTEGER, name TEXT, ticket_prefix TEXT);
      CREATE TABLE activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL, actor TEXT NOT NULL, description TEXT NOT NULL, data TEXT,
        workspace_id INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT 0);
      INSERT INTO projects VALUES (2, 1, 'Babysential', 'MC');
    `)
  })

  afterEach(() => {
    mock.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('resumes a Released review to Unclaimed, then the ticket can actually be claimed', async () => {
    writeTerminalJournal()
    const before = seedTask()

    const resumed = await resume({
      reason: 'All four prior workers reconciled terminal; PR435-f3a62d31 unchanged',
      expected_updated_at: before.updated_at,
    })

    expect(resumed.status).toBe(200)
    expect(resumed.body.task.claim_state).toBe('Unclaimed')
    // The review is resumed, not restarted or passed.
    expect(resumed.body.task.status).toBe('review')
    expect(resumed.body.task.claimed_by).toBeNull()
    expect(resumed.body.resumed_by).toBe('martin')
    expect(resumed.body.evidence.workers).toHaveLength(4)
    expect(resumed.body.evidence.workers.map((w: any) => w.status).sort()).toEqual([
      'completed',
      'completed',
      'completed',
      'failed',
    ])
    // The public evidence summary omits paths; scoped task metadata retains the authorized audit references.
    expect(JSON.stringify(resumed.body.evidence)).not.toContain(root)

    // Metadata, receipts and history survive; the audit entry is appended.
    const after = taskRow()
    const metadata = JSON.parse(after.metadata)
    expect(metadata.pr).toBe('PR435-f3a62d31')
    expect(metadata.receipts).toEqual(PRIOR_METADATA.receipts)
    expect(metadata.history).toEqual(PRIOR_METADATA.history)
    expect(metadata.review_resumes).toHaveLength(1)
    expect(metadata.review_resumes[0].actor).toBe('martin')
    expect(metadata.review_resumes[0].reason).toContain('reconciled terminal')
    expect(metadata.review_resumes[0].evidence.workers).toHaveLength(4)
    expect(after.updated_at).toBeGreaterThan(before.updated_at)
    expect(after.retry_count).toBe(0)

    const activity = mock.db
      .prepare(`SELECT * FROM activities WHERE entity_id = ? AND type = 'task_review_resumed'`)
      .get(TASK_ID) as any
    expect(activity.actor).toBe('martin')
    expect(activity.workspace_id).toBe(1)
    expect(JSON.parse(activity.data).evidence.receipt_refs).toHaveLength(4)
    expect(mock.broadcast).toHaveBeenCalledWith('task.updated', expect.objectContaining({ claim_state: 'Unclaimed' }))

    const claimed = await claim('claude-martin-fable')
    expect(claimed.status).toBe(200)
    expect(claimed.body.task.claim_state).toBe('Claimed')
    expect(claimed.body.task.claimed_by).toBe('claude-martin-fable')
  })

  it('rejects a stale expected_updated_at without mutating', async () => {
    writeTerminalJournal()
    seedTask()

    const result = await resume({ reason: 'stale', expected_updated_at: 1999 })

    expect(result.status).toBe(409)
    expect(result.body.error).toBe('Stale revision')
    expect(taskRow().claim_state).toBe('Released')
    expect(taskRow().updated_at).toBe(2000)
  })

  it('requires a nonempty reason and an integer expected_updated_at', async () => {
    writeTerminalJournal()
    seedTask()

    expect((await resume({ reason: '   ', expected_updated_at: 2000 })).status).toBe(400)
    expect((await resume({ reason: 'ok' })).status).toBe(400)
    expect((await resume({ reason: 'ok', expected_updated_at: '2000' })).status).toBe(400)
    expect((await resume({ reason: 'ok', expected_updated_at: 2000.5 })).status).toBe(400)
    expect(taskRow().claim_state).toBe('Released')
  })

  it('fails closed when no native worker evidence exists for the task', async () => {
    seedTask()

    const result = await resume({ reason: 'no evidence', expected_updated_at: 2000 })

    expect(result.status).toBe(409)
    expect(result.body.evidence_code).toBe('evidence_unavailable')
    expect(taskRow().claim_state).toBe('Released')
  })

  it('fails closed for a non-primary workspace without exposing filesystem evidence', async () => {
    writeTerminalJournal()
    seedTask({ id: 4301, workspace_id: 2 })
    mock.user = { username: 'tenant-op', workspace_id: 2, role: 'operator' }

    const result = await resume({ reason: 'other workspace', expected_updated_at: 2000 }, 4301)

    expect(result.status).toBe(409)
    expect(result.body.evidence_code).toBe('workspace_not_supported')
    expect(JSON.stringify(result.body)).not.toContain('/')
    expect(taskRow(4301, 2).claim_state).toBe('Released')
  })

  it('fails closed when a later journal still shows a running or unknown worker', async () => {
    writeTerminalJournal()
    journal('002-later-run', {
      id: 'later-run',
      projectId: PROJECT_ID,
      workspaceId: null,
      workers: [worker('w-review-3', 'review', 'running', 'sess-review-3', null)],
    })
    seedTask()

    const running = await resume({ reason: 'later worker', expected_updated_at: 2000 })
    expect(running.status).toBe(409)
    expect(running.body.evidence_code).toBe('worker_not_terminal')
    expect(taskRow().claim_state).toBe('Released')

    journal('002-later-run', {
      id: 'later-run',
      projectId: PROJECT_ID,
      workspaceId: null,
      workers: [worker('w-review-3', 'review', 'starting', 'sess-review-3', null)],
    })
    const starting = await resume({ reason: 'later worker', expected_updated_at: 2000 })
    expect(starting.status).toBe(409)
    expect(starting.body.evidence_code).toBe('worker_not_terminal')

    journal('002-later-run', {
      id: 'later-run',
      projectId: PROJECT_ID,
      workspaceId: null,
      workers: [worker('w-review-3', 'review', 'mystery-state', 'sess-review-3', null)],
    })
    const unknown = await resume({ reason: 'later worker', expected_updated_at: 2000 })
    expect(unknown.status).toBe(409)
    expect(unknown.body.evidence_code).toBe('worker_not_terminal')
    expect(taskRow().claim_state).toBe('Released')
  })

  it('fails closed when a receipt does not prove the recorded worker finished', async () => {
    // Claims completed but exited nonzero, and the session does not match.
    journal('001-run', {
      id: 'run-1',
      projectId: PROJECT_ID,
      workspaceId: null,
      workers: [
        worker('w-impl-1', 'implementation', 'completed', 'sess-impl-1', terminalReceipt('impl-1', 'other-session', 'completed', 3)),
      ],
    })
    seedTask()

    const mismatched = await resume({ reason: 'mismatch', expected_updated_at: 2000 })
    expect(mismatched.status).toBe(409)
    expect(mismatched.body.evidence_code).toBe('receipt_mismatch')

    // A missing receipt file is equally unprovable.
    journal('001-run', {
      id: 'run-1',
      projectId: PROJECT_ID,
      workspaceId: null,
      workers: [
        worker('w-impl-1', 'implementation', 'completed', 'sess-impl-1', path.join(root, 'receipts', 'absent.json')),
      ],
    })
    const missing = await resume({ reason: 'missing receipt', expected_updated_at: 2000 })
    expect(missing.status).toBe(409)
    expect(missing.body.evidence_code).toBe('receipt_mismatch')
    expect(missing.body.error).not.toContain(root)
    expect(taskRow().claim_state).toBe('Released')
  })

  it('fails closed when the journal describes a different project scope', async () => {
    writeTerminalJournal({ projectId: 99 })
    seedTask()

    const result = await resume({ reason: 'wrong project', expected_updated_at: 2000 })

    expect(result.status).toBe(409)
    expect(result.body.evidence_code).toBe('scope_mismatch')
    expect(taskRow().claim_state).toBe('Released')
  })

  it('rejects terminal tasks and tasks that still record an owner', async () => {
    writeTerminalJournal()
    seedTask({ status: 'done' })
    expect((await resume({ reason: 'done task', expected_updated_at: 2000 })).status).toBe(409)
    mock.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(TASK_ID)

    seedTask({ status: 'failed' })
    expect((await resume({ reason: 'failed task', expected_updated_at: 2000 })).status).toBe(409)
    mock.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(TASK_ID)

    // Active claim: claim/release semantics still own this ticket.
    seedTask({ claim_state: 'Running', claimed_by: 'claude-martin', claimed_at: '2026-09-08T17:20:00.000Z' })
    const running = await resume({ reason: 'live owner', expected_updated_at: 2000 })
    expect(running.status).toBe(409)
    expect(running.body.current_claim_state).toBe('Running')
    expect(taskRow().claim_state).toBe('Running')
    mock.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(TASK_ID)

    // Released but with a residual owner record — unknown ownership, not free.
    seedTask({ claimed_by: 'claude-martin' })
    const residual = await resume({ reason: 'residual owner', expected_updated_at: 2000 })
    expect(residual.status).toBe(409)
    expect(residual.body.error).toContain('owner')
    expect(taskRow().claim_state).toBe('Released')
  })

  it('returns 404 for a task outside the authenticated workspace', async () => {
    writeTerminalJournal()
    seedTask({ id: 4302, workspace_id: 2 })

    const result = await resume({ reason: 'cross workspace', expected_updated_at: 2000 }, 4302)

    expect(result.status).toBe(404)
    expect(taskRow(4302, 2).claim_state).toBe('Released')
  })

  it('recognizes a finished process even when post-exit validation marked the worker failed', async () => {
    journal('001-run', { projectId: PROJECT_ID, workers: [
      worker('w-failed-validation', 'review', 'failed', 'sess-validation', terminalReceipt('validation', 'sess-validation', 'failed', 0)),
    ] })
    seedTask()
    expect((await resume({ reason: 'Actual child exited; validation failed, review still needed', expected_updated_at: 2000 })).status).toBe(200)
  })

  it('rejects contradictory sessionRef and sessionId instead of accepting either identity', async () => {
    const ref = receipt('contradictory', { status: 'completed', exitCode: 0, sessionRef: 'claude-code:other', sessionId: 'sess-intended' })
    journal('001-run', { projectId: PROJECT_ID, workers: [worker('w-one', 'review', 'completed', 'sess-intended', ref)] })
    seedTask()
    expect((await resume({ reason: 'contradictory identity', expected_updated_at: 2000 })).status).toBe(409)
    expect(taskRow().claim_state).toBe('Released')
  })

  it('does not overwrite an existing malformed resume history', async () => {
    writeTerminalJournal()
    seedTask({ metadata: JSON.stringify({ ...PRIOR_METADATA, review_resumes: { legacy: 'retain this' } }) })
    const before = taskRow().metadata
    expect((await resume({ reason: 'preserve history', expected_updated_at: 2000 })).status).toBe(409)
    expect(taskRow().metadata).toBe(before)
    expect(taskRow().claim_state).toBe('Released')
  })

  it('rejects an ID with a numeric prefix without resuming the real numeric task', async () => {
    writeTerminalJournal()
    seedTask()
    const { POST } = await import('@/app/api/tasks/[id]/resume-review/route')
    const response = await POST(new NextRequest('http://localhost/api/tasks/1301oops/resume-review', {
      method: 'POST', body: JSON.stringify({ reason: 'bad id', expected_updated_at: 2000 }),
      headers: { 'content-type': 'application/json' },
    }), { params: Promise.resolve({ id: '1301oops' }) })
    expect(response.status).toBe(400)
    expect(taskRow().claim_state).toBe('Released')
  })

  it('rejects out-of-root and symlinked receipt paths without changing the task', async () => {
    mock.roots.receiptRoots = [path.join(root, 'receipts')]
    const outside = path.join(root, 'outside.json')
    writeFileSync(outside, JSON.stringify({ status: 'completed', exitCode: 0, sessionId: 'sess-one' }))
    const linked = path.join(root, 'receipts', 'link.json')
    symlinkSync(outside, linked)
    seedTask()
    for (const ref of [outside, linked, path.join(root, 'receipts') + '/../outside.json']) {
      journal('001-run', { projectId: PROJECT_ID, workers: [worker('w-one', 'review', 'completed', 'sess-one', ref)] })
      expect((await resume({ reason: 'untrusted receipt path', expected_updated_at: 2000 })).status).toBe(409)
      expect(taskRow().claim_state).toBe('Released')
      expect(taskRow().updated_at).toBe(2000)
    }
  })

  it('rejects a symlinked parent that escapes the receipt root', async () => {
    mock.roots.receiptRoots = [path.join(root, 'receipts')]
    const outsideDir = path.join(root, 'outside-dir')
    mkdirSync(outsideDir)
    writeFileSync(path.join(outsideDir, 'receipt.json'), JSON.stringify({ status: 'completed', exitCode: 0, sessionId: 'sess-one' }))
    symlinkSync(outsideDir, path.join(root, 'receipts', 'parent'))
    journal('001-run', { projectId: PROJECT_ID, workers: [worker('w-one', 'review', 'completed', 'sess-one', path.join(root, 'receipts', 'parent', 'receipt.json'))] })
    seedTask()
    expect((await resume({ reason: 'parent escape', expected_updated_at: 2000 })).body.evidence_code).toBe('receipt_mismatch')
    expect(taskRow().claim_state).toBe('Released')
  })

  it('fails closed on oversized receipts, malformed journals and the journal count limit', async () => {
    writeTerminalJournal()
    seedTask()
    writeFileSync(path.join(root, 'receipts', 'impl-1.json'), ' '.repeat(512001))
    expect((await resume({ reason: 'oversize', expected_updated_at: 2000 })).body.evidence_code).toBe('receipt_mismatch')
    writeTerminalJournal()
    writeFileSync(path.join(root, 'runs', '002-broken.json'), '{broken')
    expect((await resume({ reason: 'malformed', expected_updated_at: 2000 })).body.evidence_code).toBe('evidence_unreadable')
    rmSync(path.join(root, 'runs', '002-broken.json'))
    for (let i = 0; i < 400; i++) journal(`extra-${i}`, { workers: [] })
    expect((await resume({ reason: 'journal count bound', expected_updated_at: 2000 })).body.evidence_code).toBe('evidence_unreadable')
    expect(taskRow().claim_state).toBe('Released')
    expect(mock.db.prepare('SELECT count(*) n FROM activities').get()).toEqual({ n: 0 })
  })

  it('resumes quality_review with a cancelled worker only when its exit receipt matches', async () => {
    journal('001-run', { projectId: PROJECT_ID, workers: [worker('w-one', 'review', 'cancelled', 'sess-one', terminalReceipt('cancelled', 'sess-one', 'cancelled', -15))] })
    seedTask({ status: 'quality_review' })
    const result = await resume({ reason: 'cancelled process reconciled', expected_updated_at: 2000 })
    expect(result.status).toBe(200)
    expect(result.body.task.status).toBe('quality_review')
    expect(result.body.task.claim_state).toBe('Unclaimed')
  })

  it('yields exactly one transition for concurrent duplicate calls', async () => {
    writeTerminalJournal()
    seedTask()

    const results = await Promise.all([
      resume({ reason: 'first', expected_updated_at: 2000 }),
      resume({ reason: 'duplicate', expected_updated_at: 2000 }),
    ])

    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409)).toHaveLength(1)

    const metadata = JSON.parse(taskRow().metadata)
    expect(metadata.review_resumes).toHaveLength(1)
    expect(metadata.receipts).toEqual(PRIOR_METADATA.receipts)
    const audits = mock.db
      .prepare(`SELECT COUNT(*) AS n FROM activities WHERE entity_id = ?`)
      .get(TASK_ID) as { n: number }
    expect(audits.n).toBe(1)
  })
})

/**
 * Evidence lives in a directory called `tmp`, which every disk sweep is entitled
 * to treat as disposable. `MC_EVIDENCE_ROOT` names a durable second root so the
 * receipts can be moved out and stay reachable through a `~/tmp` symlink.
 *
 * The configured root is additive and containment is still checked on the
 * resolved path, so this widens where evidence may live without widening what
 * counts as proof: a receipt outside every root is still refused.
 */
describe('defaultResumeEvidenceDeps + MC_EVIDENCE_ROOT', () => {
  let actual: typeof import('../task-review-resume')
  let scratch = ''
  const savedEnv = process.env.MC_EVIDENCE_ROOT
  const tmpRoot = path.join(homedir(), 'tmp')
  const request = { taskId: 999, projectId: 2, workspaceId: 1 }

  function journalRootWith(receiptRef: string) {
    const runs = mkdtempSync(path.join(tmpdir(), 'mc-evidence-runs-'))
    writeFileSync(
      path.join(runs, 'run.json'),
      JSON.stringify({
        id: 'run-1',
        projectId: 2,
        workspaceId: null,
        workers: [
          {
            workerId: 'w-one',
            taskId: 999,
            dispatch: { phase: 'review' },
            status: 'completed',
            sessionRef: 'claude-code:sess-one',
            receiptRef,
          },
        ],
      }),
    )
    return runs
  }

  beforeEach(async () => {
    actual = await vi.importActual<typeof import('../task-review-resume')>('../task-review-resume')
    // Under $HOME on purpose: a trusted root is only accepted there, so a
    // scratch dir in the system temp root could no longer stand in for one.
    scratch = mkdtempSync(path.join(homedir(), '.mc-evidence-root-test-'))
    delete process.env.MC_EVIDENCE_ROOT
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
    if (savedEnv === undefined) delete process.env.MC_EVIDENCE_ROOT
    else process.env.MC_EVIDENCE_ROOT = savedEnv
  })

  it('leaves the ~/tmp receipt root untouched when the variable is unset', () => {
    const deps = actual.defaultResumeEvidenceDeps()
    expect(deps.receiptRoots).toEqual([tmpRoot])
    expect(deps.journalRoot).toContain('babysential-backlog-orchestrator')
  })

  it('adds a configured evidence root without dropping ~/tmp', () => {
    process.env.MC_EVIDENCE_ROOT = scratch
    expect(actual.defaultResumeEvidenceDeps().receiptRoots).toEqual([tmpRoot, scratch])
  })

  it('accepts a receipt reached through a symlink into the configured root', () => {
    // Exactly the shape an evidence migration leaves behind: the receipt file
    // now lives in the durable root, and the recorded receiptRef still points at
    // the old tmp-style path, which has become a symlink.
    const evidence = path.join(scratch, 'evidence')
    const tmpLike = path.join(scratch, 'tmp-like')
    mkdirSync(path.join(evidence, 'run-42'), { recursive: true })
    mkdirSync(tmpLike)
    writeFileSync(
      path.join(evidence, 'run-42', 'native-terminal.json'),
      JSON.stringify({ status: 'completed', exitCode: 0, sessionId: 'sess-one' }),
    )
    symlinkSync(path.join(evidence, 'run-42'), path.join(tmpLike, 'run-42'))

    const runs = journalRootWith(path.join(tmpLike, 'run-42', 'native-terminal.json'))

    // Without the evidence root the symlink resolves outside every trusted root.
    const before = actual.reconcileNativeTerminalEvidence(request, {
      journalRoot: runs,
      receiptRoots: [tmpLike],
    })
    expect(before.ok).toBe(false)
    if (!before.ok) expect(before.code).toBe('receipt_mismatch')

    const after = actual.reconcileNativeTerminalEvidence(request, {
      journalRoot: runs,
      receiptRoots: [tmpLike, evidence],
    })
    expect(after.ok).toBe(true)
    if (after.ok) expect(after.workers[0].receipt_status).toBe('completed')

    rmSync(runs, { recursive: true, force: true })
  })

  it('still refuses a receipt outside every root once a root is configured', () => {
    const evidence = path.join(scratch, 'evidence')
    mkdirSync(evidence, { recursive: true })
    process.env.MC_EVIDENCE_ROOT = evidence
    const stray = path.join(scratch, 'stray.json')
    writeFileSync(stray, JSON.stringify({ status: 'completed', exitCode: 0, sessionId: 'sess-one' }))
    const runs = journalRootWith(stray)

    const result = actual.reconcileNativeTerminalEvidence(request, {
      journalRoot: runs,
      receiptRoots: actual.defaultResumeEvidenceDeps().receiptRoots,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('receipt_mismatch')
    rmSync(runs, { recursive: true, force: true })
  })

  it('ignores an unusable or over-broad evidence root instead of trusting it', () => {
    const realHome = realpathSync(homedir())
    // Real directories, because a root that does not exist is refused for the
    // wrong reason and would prove nothing about the breadth rule.
    const madeHere: string[] = []
    const madeIfPossible = (parent: string, prefix: string): string | null => {
      try {
        const dir = mkdtempSync(path.join(realpathSync(parent), prefix))
        madeHere.push(dir)
        return dir
      } catch {
        return null
      }
    }
    // An ancestor of $HOME (`/Users` here): not the filesystem root, not equal
    // to $HOME, and strictly wider than $HOME — the gap this test closes.
    const homeAncestor = path.dirname(realHome)
    // Inside the disposable root this variable exists to escape.
    const underHomeTmp = madeIfPossible(tmpRoot, 'mc-evidence-under-home-tmp-')
    // The system temp root (`/private/tmp` on macOS): outside $HOME, and a
    // directory any disk sweep is entitled to clear.
    const underSystemTmp = madeIfPossible('/tmp', 'mc-evidence-under-system-tmp-')

    const values = [
      '',
      '   ',
      'relative/path',
      path.join(scratch, 'does-not-exist'),
      `${scratch}/../traversal`,
      '/',
      homedir(),
      realHome,
      homeAncestor,
      tmpRoot,
      underHomeTmp,
      underSystemTmp,
    ].filter((value): value is string => value !== null)

    try {
      for (const value of values) {
        process.env.MC_EVIDENCE_ROOT = value
        // Soft, so one run names every value that leaks through rather than
        // stopping at the first and hiding the rest.
        expect.soft(actual.defaultResumeEvidenceDeps().receiptRoots, value).toEqual([tmpRoot])
      }
    } finally {
      for (const dir of madeHere) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('trusts a durable root that lies strictly under $HOME', () => {
    // The same shape as the production value,
    // $HOME/.openclaw/mission-control/evidence, built inside a scratch home so
    // the test owns every byte it touches.
    const canonical = path.join(scratch, '.openclaw', 'mission-control', 'evidence')
    mkdirSync(canonical, { recursive: true })
    process.env.MC_EVIDENCE_ROOT = canonical
    expect(actual.defaultResumeEvidenceDeps().receiptRoots).toEqual([tmpRoot, canonical])

    // And the literal production path, on a machine that already has one.
    const production = path.join(homedir(), '.openclaw', 'mission-control', 'evidence')
    if (existsSync(production)) {
      process.env.MC_EVIDENCE_ROOT = production
      expect(actual.defaultResumeEvidenceDeps().receiptRoots).toEqual([tmpRoot, production])
    }
  })
})
