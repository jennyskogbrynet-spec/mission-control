// @vitest-environment node
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  db: null as any,
  user: { username: 'martin', workspace_id: 1, role: 'operator' } as Record<string, unknown>,
  broadcast: vi.fn(),
  roots: { journalRoot: '', receiptRoots: [] as string[], nativeReviewRoot: '' },
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
        nativeReviewRoot: mock.roots.nativeReviewRoot,
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
let nativeRoot = ''

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

/**
 * Structurally actual native Codex review identifiers, taken from the sanitized
 * MC1304 request/result pair. Account identity is a synthetic hash.
 */
const NATIVE = {
  runId: '6807bc77-4193-4490-b16a-370b81e5cc67',
  pr: 436,
  threadId: '01a08637-2625-7303-a89d-d8ca60674696',
  turnId: '01a08637-26fb-7af1-9c22-a373a06a96a4',
  baseSha: '1a430a885d49a86b0d01362f82d41a2bd856737f',
  headSha: 'd733d3420ab0301161c4b32058cf42c5c2f28ad5',
  treeSha: '355dcf660d9a022904cb30ffb28e274b13a7cc8c',
  policySha256: 'd9efa3ed9662a6d72c591b8e634beb38636d30d8de8bcb750c5795a22d3b44b6',
  packetSha256: '67462074e17d39319c205ef7831f152a0d333f418d1b5030d8643cf046bdcd79',
  emailHash: 'a'.repeat(64),
  model: 'gpt-6-astra',
  session: 'codex:01a08637-2625-7303-a89d-d8ca60674696',
}

function nativeRequestBody(pr: number, runId: string) {
  return {
    schemaVersion: 1,
    runId,
    candidate: {
      repo: 'jennyskogbrynet-spec/babysential',
      prNumber: pr,
      baseSha: NATIVE.baseSha,
      headSha: NATIVE.headSha,
      treeSha: NATIVE.treeSha,
      policyCommit: NATIVE.baseSha,
      policySha256: NATIVE.policySha256,
    },
    taskRef: `MC:${TASK_ID}`,
    authorSessionIds: ['claude-code:02b932a0-6f6e-4455-81a6-26937cd59f86'],
    accountId: 'fixture-account',
    expectedEmailHash: NATIVE.emailHash,
    model: NATIVE.model,
    packetSha256: NATIVE.packetSha256,
    createdAt: '2026-09-09T12:49:15.535Z',
  }
}

/** A completed native turn whose review decision is HOLD and whose child exited 0. */
function nativeBody() {
  return {
    mechanism: 'turn/start+outputSchema',
    status: 'completed',
    decision: 'hold',
    review: { decision: 'hold', summary: 'Acceptance artifacts are missing.', findings: [] },
    requestedModel: NATIVE.model,
    observedModel: NATIVE.model,
    accountBefore: { type: 'chatgpt', emailHash: NATIVE.emailHash, planType: 'pro' },
    accountAfter: { type: 'chatgpt', emailHash: NATIVE.emailHash, planType: 'pro' },
    sourceThreadId: NATIVE.threadId,
    reviewThreadId: NATIVE.threadId,
    turnId: NATIVE.turnId,
    terminal: {
      method: 'turn/completed',
      threadId: NATIVE.threadId,
      turn: { id: NATIVE.turnId, status: 'completed', startedAt: 1788958156, completedAt: 1788958342 },
    },
    exitedReviewMode: null,
    childExit: { observed: true, code: 0, signal: null },
    errorCode: null,
    operationalEvents: [],
    droppedEventCount: 0,
    outputBytes: 454555,
  }
}

interface NativeRunOptions {
  pr?: number
  runId?: string
  dir?: string
  request?: Record<string, unknown>
  result?: Record<string, unknown>
  native?: Record<string, unknown>
  /** Written verbatim instead of the digest of the actual request bytes. */
  requestSha256?: string
}

/** Writes `<perPR>/<pr>/<runId>/{request,result}.json` and returns the result path. */
function nativeRun(options: NativeRunOptions = {}): string {
  const pr = options.pr ?? NATIVE.pr
  const runId = options.runId ?? NATIVE.runId
  const dir = options.dir ?? path.join(nativeRoot, String(pr), runId)
  mkdirSync(dir, { recursive: true })

  const request = { ...nativeRequestBody(pr, runId), ...(options.request ?? {}) }
  const rawRequest = JSON.stringify(request)
  writeFileSync(path.join(dir, 'request.json'), rawRequest)

  const result = {
    schemaVersion: 1,
    runId,
    requestSha256:
      options.requestSha256 ?? createHash('sha256').update(rawRequest, 'utf8').digest('hex'),
    completedAt: '2026-09-09T12:52:22.638Z',
    native: { ...nativeBody(), ...(options.native ?? {}) },
    gitBefore: { headSha: NATIVE.headSha, treeSha: NATIVE.treeSha, dirty: false },
    gitAfter: { headSha: NATIVE.headSha, treeSha: NATIVE.treeSha, dirty: false },
    ...(options.result ?? {}),
  }
  const resultPath = path.join(dir, 'result.json')
  writeFileSync(resultPath, JSON.stringify(result))
  return resultPath
}

/** Mirrors the derived host_observation_of_native_release_review summary under ~/tmp. */
function hostObservation(name: string, overrides: Record<string, unknown> = {}, resultRef?: string) {
  return receipt(name, {
    schemaVersion: 1,
    kind: 'host_observation_of_native_release_review',
    note: 'Integrator host observation; the wrapper result is the authoritative native receipt.',
    status: 'completed',
    // The wrapper CLI exits non-zero on HOLD. This is a decision exit.
    exitCode: 1,
    exitCodeMeaning: 'wrapper exits non-zero on HOLD; the native turn completed',
    sessionRef: NATIVE.session,
    decision: 'hold',
    runId: NATIVE.runId,
    nativeResultRef:
      resultRef ?? path.join(nativeRoot, String(NATIVE.pr), NATIVE.runId, 'result.json'),
    pr: NATIVE.pr,
    task: TASK_ID,
    headSha: NATIVE.headSha,
    observedAt: '2026-09-09T13:43:34.664Z',
    ...overrides,
  })
}

/** A native reviewer registered on a codex session rather than a Claude session. */
function codexWorker(receiptRef: string, status = 'completed', sessionRef = NATIVE.session) {
  return {
    workerId: 'w-native-review',
    taskId: TASK_ID,
    dispatch: { type: 'dispatch', workerId: 'w-native-review', taskId: TASK_ID, phase: 'review' },
    route: { bindingId: 'codex-native', runtimeId: 'codex', model: NATIVE.model },
    status,
    deadlineAt: 1788889056.340105,
    sessionRef,
    receiptRef,
  }
}

function nativeJournal(receiptRef: string, status = 'completed', sessionRef = NATIVE.session) {
  journal('001-run', {
    id: '2fb27d2d-6d6c-41eb-9e8d-7308b6057867',
    projectId: PROJECT_ID,
    workspaceId: null,
    workers: [codexWorker(receiptRef, status, sessionRef)],
  })
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
    // Resolved up front so recorded receipt refs compare exactly on macOS,
    // where the temp dir is itself a symlink.
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mc1308-')))
    mkdirSync(path.join(root, 'runs'))
    mkdirSync(path.join(root, 'receipts'))
    // Mirrors ~/.openclaw/state/babysential-codex-review/perPR; test-injected only.
    nativeRoot = path.join(root, 'codex-review', 'perPR')
    mkdirSync(nativeRoot, { recursive: true })
    mock.roots = {
      journalRoot: path.join(root, 'runs'),
      receiptRoots: [path.join(root, 'receipts')],
      nativeReviewRoot: nativeRoot,
    }

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

  // MC1320: the native Codex reviewer writes an immutable nested receipt, and the
  // integrator writes a derived summary that points at it. Neither may be
  // rewritten into the older flat shape to make a resume pass.
  describe('native Codex review receipts', () => {
    it('accepts the raw native result: HOLD is preserved and the child exit proves completion', async () => {
      nativeJournal(nativeRun())
      seedTask()

      const result = await resume({
        reason: 'MC1304 native reviewer child exited 0; review decision is HOLD',
        expected_updated_at: 2000,
      })

      expect(result.status).toBe(200)
      const [reconciled] = result.body.evidence.workers
      expect(reconciled.status).toBe('completed')
      expect(reconciled.receipt_status).toBe('completed')
      // The proven process exit is the observed native child exit.
      expect(reconciled.receipt_exit_code).toBe(0)
      expect(reconciled.native.evidence_kind).toBe('native_result')
      expect(reconciled.native.child_exit_code).toBe(0)
      expect(reconciled.native.child_exit_signal).toBeNull()
      // A raw result has no wrapper decision exit at all.
      expect(reconciled.native.wrapper_exit_code).toBeNull()
      // The review decision is carried through untouched; resume never passes it.
      expect(reconciled.native.review_decision).toBe('hold')
      expect(reconciled.native.native_run_id).toBe(NATIVE.runId)
      expect(reconciled.native.pr_number).toBe(NATIVE.pr)
      expect(reconciled.native.head_sha).toBe(NATIVE.headSha)
      expect(reconciled.native.task_ref).toBe(`MC:${TASK_ID}`)
      expect(reconciled.native.observed_model).toBe(NATIVE.model)
      expect(reconciled.native.thread_id).toBe(NATIVE.threadId)
      expect(reconciled.native.request_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(reconciled.native.result_digest).toMatch(/^[0-9a-f]{64}$/)
      expect(reconciled.native.wrapper_digest).toBeNull()
      // The public summary still carries no filesystem path.
      expect(JSON.stringify(result.body.evidence)).not.toContain(root)

      // The HOLD survives in the durable audit, and prior metadata is preserved.
      const metadata = JSON.parse(taskRow().metadata)
      expect(metadata.receipts).toEqual(PRIOR_METADATA.receipts)
      expect(metadata.history).toEqual(PRIOR_METADATA.history)
      const stored = metadata.review_resumes[0].evidence
      expect(stored.workers[0].native.review_decision).toBe('hold')
      expect(stored.receipt_refs).toEqual([path.join(nativeRoot, '436', NATIVE.runId, 'result.json')])

      // The resumed ticket is actually claimable again.
      const claimed = await claim('claude-martin-fable')
      expect(claimed.status).toBe(200)
      expect(claimed.body.task.claim_state).toBe('Claimed')
    })

    it('accepts the host observation and keeps the wrapper exit 1 apart from the child exit 0', async () => {
      const resultRef = nativeRun()
      nativeJournal(hostObservation('mc1305'))
      seedTask()

      const result = await resume({
        reason: 'MC1305 wrapper exited 1 on HOLD; the native child exited 0',
        expected_updated_at: 2000,
      })

      expect(result.status).toBe(200)
      const [reconciled] = result.body.evidence.workers
      expect(reconciled.native.evidence_kind).toBe('host_observation_of_native_release_review')
      // The decision exit is recorded, never relabelled as the child exit.
      expect(reconciled.native.wrapper_exit_code).toBe(1)
      expect(reconciled.native.wrapper_exit_meaning).toContain('HOLD')
      expect(reconciled.native.child_exit_code).toBe(0)
      expect(reconciled.receipt_exit_code).toBe(0)
      expect(reconciled.native.review_decision).toBe('hold')
      // Both the wrapper and the authoritative source are digested.
      expect(reconciled.native.wrapper_digest).toMatch(/^[0-9a-f]{64}$/)
      expect(reconciled.native.result_digest).toMatch(/^[0-9a-f]{64}$/)
      expect(reconciled.native.wrapper_digest).not.toBe(reconciled.native.result_digest)
      expect(JSON.stringify(result.body.evidence)).not.toContain(root)

      // The audit references both the observation and the source it was checked against.
      const activity = mock.db
        .prepare(`SELECT data FROM activities WHERE entity_id = ? AND type = 'task_review_resumed'`)
        .get(TASK_ID) as any
      expect(JSON.parse(activity.data).evidence.receipt_refs).toEqual([
        path.join(root, 'receipts', 'mc1305.json'),
        resultRef,
      ])
    })

    it.each<[string, () => void]>([
      ['altered request bytes that decode to the same replacement character', () => {
        const ref = nativeRun({ request: { note: '\uFFFD' } }); const requestPath = path.join(path.dirname(ref), 'request.json');
        const bytes = readFileSync(requestPath); const at = bytes.indexOf(Buffer.from('\uFFFD')); expect(at).toBeGreaterThan(-1);
        writeFileSync(requestPath, Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + 3)])); nativeJournal(ref)
      }],

      ['native metadata over the original size limit', () => { const ref = nativeRun(); const value = JSON.parse(readFileSync(ref, 'utf8')); value.padding = 'x'.repeat(512001); writeFileSync(ref, JSON.stringify(value)); nativeJournal(ref) }],
      ['symlinked native root', () => { const ref = nativeRun(); const linked = path.join(root, 'native-link'); symlinkSync(nativeRoot, linked); mock.roots.nativeReviewRoot = linked; nativeJournal(ref) }],
      ['symlinked native run directory', () => { const ref = nativeRun(); const dir = path.dirname(ref); const actual = dir + '-original'; renameSync(dir, actual); symlinkSync(actual, dir); nativeJournal(ref) }],

      ['missing accountBefore', () => nativeJournal(nativeRun({ native: { accountBefore: undefined } }))],
      ['null accountAfter', () => nativeJournal(nativeRun({ native: { accountAfter: null } }))],
      ['wrong account type', () => nativeJournal(nativeRun({ native: { accountBefore: { type: 'apiKey', emailHash: NATIVE.emailHash } } }))],
      ['wrong native mechanism', () => nativeJournal(nativeRun({ native: { mechanism: 'review/start' } }))],
      ['nonterminal notification with completed fields', () => nativeJournal(nativeRun({ native: { terminal: { ...nativeBody().terminal, method: 'turn/started' } } }))],
      ['wrong runtime prefix', () => nativeJournal(nativeRun(), 'completed', 'claude-code:' + NATIVE.threadId)],
      ['bare native session', () => nativeJournal(nativeRun(), 'completed', NATIVE.threadId)],
      ['unsupported native decision', () => nativeJournal(nativeRun({ native: { decision: 'approve', review: { decision: 'approve' } } }))],
      ['registered account mismatch', () => { const ref = nativeRun(); const cw = codexWorker(ref); journal('native', { projectId: PROJECT_ID, workers: [{ ...cw, route: { ...cw.route, accountId: 'another-account' } }] }) }],
      ['registered modelId mismatch', () => { const ref = nativeRun(); const cw = codexWorker(ref); journal('native', { projectId: PROJECT_ID, workers: [{ ...cw, route: { ...cw.route, modelId: 'wrong-model' } }] }) }],
      ['registered dispatch model mismatch', () => { const ref = nativeRun(); const cw = codexWorker(ref); journal('native', { projectId: PROJECT_ID, workers: [{ ...cw, dispatch: { ...cw.dispatch, modelId: 'wrong-model' } }] }) }],

      [
        'completed with a nonzero child exit',
        () => nativeJournal(nativeRun({ native: { childExit: { observed: true, code: 1, signal: null } } })),
      ],
      [
        'an unobserved child exit',
        () => nativeJournal(nativeRun({ native: { childExit: { observed: false, code: null, signal: null } } })),
      ],
      [
        'a missing child exit code',
        () => nativeJournal(nativeRun({ native: { childExit: { observed: true, signal: null } } })),
      ],
      [
        'a signalled child',
        () => nativeJournal(nativeRun({ native: { childExit: { observed: true, code: 0, signal: 'SIGKILL' } } })),
      ],
      [
        'a native error code',
        () => nativeJournal(nativeRun({ native: { errorCode: 'stream_disconnected' } })),
      ],
      [
        'a turn that is not terminal',
        () =>
          nativeJournal(
            nativeRun({
              native: {
                terminal: {
                  method: 'turn/started',
                  threadId: NATIVE.threadId,
                  turn: { id: NATIVE.turnId, status: 'in_progress' },
                },
              },
            }),
          ),
      ],
      [
        'a terminal thread that is not the source thread',
        () =>
          nativeJournal(
            nativeRun({
              native: {
                terminal: {
                  method: 'turn/completed',
                  threadId: '01a08637-2625-7303-a89d-000000000000',
                  turn: { id: NATIVE.turnId, status: 'completed' },
                },
              },
            }),
          ),
      ],
      [
        'a request digest that does not cover the raw request bytes',
        () => nativeJournal(nativeRun({ requestSha256: 'b'.repeat(64) })),
      ],
      [
        'a taskRef for a different MC task',
        () => nativeJournal(nativeRun({ request: { taskRef: 'MC:9999' } })),
      ],
      [
        'a PR number that contradicts the directory',
        () =>
          nativeJournal(
            nativeRun({ request: { candidate: { ...nativeRequestBody(999, NATIVE.runId).candidate } } }),
          ),
      ],
      [
        'a runId that contradicts the directory',
        () => nativeJournal(nativeRun({ result: { runId: '11111111-2222-4333-8444-555555555555' } })),
      ],
      [
        'an observed model the request did not ask for',
        () => nativeJournal(nativeRun({ native: { observedModel: 'gpt-5-legacy' } })),
      ],
      [
        'an account identity the request did not authorize',
        () =>
          nativeJournal(
            nativeRun({ native: { accountAfter: { type: 'chatgpt', emailHash: 'c'.repeat(64), planType: 'pro' } } }),
          ),
      ],
      [
        'a session that does not bind the native source thread',
        () => nativeJournal(nativeRun(), 'completed', 'codex:11111111-2222-4333-8444-555555555555'),
      ],
      [
        'a reviewed head that is not the requested candidate',
        () =>
          nativeJournal(
            nativeRun({ result: { gitAfter: { headSha: 'f'.repeat(40), treeSha: NATIVE.treeSha, dirty: false } } }),
          ),
      ],
      [
        'a dirty worktree at review time',
        () =>
          nativeJournal(
            nativeRun({ result: { gitBefore: { headSha: NATIVE.headSha, treeSha: NATIVE.treeSha, dirty: true } } }),
          ),
      ],
      [
        'a decision that contradicts the review decision',
        () => nativeJournal(nativeRun({ native: { decision: 'pass' } })),
      ],
      [
        'a native status that contradicts the recorded worker status',
        () => nativeJournal(nativeRun({ native: { status: 'failed' } })),
      ],
      [
        'a malformed native receipt carrying legacy-looking flat fields',
        () =>
          nativeJournal(
            nativeRun({
              native: { childExit: undefined },
              result: { status: 'completed', exitCode: 0, sessionId: NATIVE.threadId },
            }),
          ),
      ],
      [
        'a native result outside the fixed native review root',
        () =>
          nativeJournal(
            nativeRun({ dir: path.join(root, 'receipts', 'stray', String(NATIVE.pr), NATIVE.runId) }),
          ),
      ],
      [
        'a native result at the wrong depth inside the native root',
        () => nativeJournal(nativeRun({ dir: path.join(nativeRoot, String(NATIVE.pr)) })),
      ],
      [
        'a native result under a non-numeric PR directory',
        () => nativeJournal(nativeRun({ dir: path.join(nativeRoot, 'main', NATIVE.runId) })),
      ],
      [
        'a native result under a run directory that is not a canonical uuid',
        () => nativeJournal(nativeRun({ dir: path.join(nativeRoot, String(NATIVE.pr), 'latest') })),
      ],
      [
        'an observation whose decision upgrades the native HOLD',
        () => {
          nativeRun()
          nativeJournal(hostObservation('upgraded', { decision: 'pass' }))
        },
      ],
      [
        'an observation whose status contradicts the native status',
        () => {
          nativeRun()
          nativeJournal(hostObservation('status-drift', { status: 'failed' }))
        },
      ],
      [
        'an observation bound to a different task',
        () => {
          nativeRun()
          nativeJournal(hostObservation('other-task', { task: 9999 }))
        },
      ],
      [
        'an observation bound to a different head',
        () => {
          nativeRun()
          nativeJournal(hostObservation('other-head', { headSha: 'e'.repeat(40) }))
        },
      ],
      [
        'an observation whose session is not the registered worker session',
        () => {
          nativeRun()
          nativeJournal(hostObservation('other-session', { sessionRef: 'codex:11111111-2222-4333-8444-555555555555' }))
        },
      ],
      [
        'an observation with no exitCodeMeaning',
        () => {
          nativeRun()
          nativeJournal(hostObservation('no-meaning', { exitCodeMeaning: '' }))
        },
      ],
      [
        'an observation pointing outside the native review root',
        () => {
          nativeRun()
          const outside = receipt('planted-result', { schemaVersion: 1, native: nativeBody() })
          nativeJournal(hostObservation('escaping', {}, outside))
        },
      ],
      [
        // Exactly one pointer is followed, and its target must be a raw result.
        'an observation chained through a second observation inside the native root',
        () => {
          nativeRun()
          const chainedRunId = '11111111-2222-4333-8444-555555555555'
          const chainedDir = path.join(nativeRoot, String(NATIVE.pr), chainedRunId)
          mkdirSync(chainedDir, { recursive: true })
          const chained = path.join(chainedDir, 'result.json')
          writeFileSync(
            chained,
            JSON.stringify({
              schemaVersion: 1,
              kind: 'host_observation_of_native_release_review',
              status: 'completed',
              exitCode: 1,
              exitCodeMeaning: 'wrapper exits non-zero on HOLD',
              sessionRef: NATIVE.session,
              decision: 'hold',
              runId: chainedRunId,
              nativeResultRef: path.join(nativeRoot, String(NATIVE.pr), NATIVE.runId, 'result.json'),
              pr: NATIVE.pr,
              task: TASK_ID,
              headSha: NATIVE.headSha,
            }),
          )
          nativeJournal(hostObservation('outer', {}, chained))
        },
      ],
      [
        'an observation using a traversal path into the native root',
        () => {
          nativeRun()
          nativeJournal(
            hostObservation(
              'traversal',
              {},
              [nativeRoot, String(NATIVE.pr), '..', String(NATIVE.pr), NATIVE.runId, 'result.json'].join(path.sep),
            ),
          )
        },
      ],
    ])('rejects %s without mutating the task', async (_label, arrange) => {
      arrange()
      seedTask()

      const result = await resume({ reason: 'native evidence check', expected_updated_at: 2000 })

      expect(result.status).toBe(409)
      expect(result.body.evidence_code).toBe('receipt_mismatch')
      expect(JSON.stringify(result.body)).not.toContain(root)
      expect(taskRow().claim_state).toBe('Released')
      expect(taskRow().updated_at).toBe(2000)
      expect(mock.db.prepare('SELECT count(*) n FROM activities').get()).toEqual({ n: 0 })
    })

    it('rejects a flat legacy receipt planted inside the native review root', async () => {
      const dir = path.join(nativeRoot, String(NATIVE.pr), NATIVE.runId)
      mkdirSync(dir, { recursive: true })
      const planted = path.join(dir, 'result.json')
      writeFileSync(
        planted,
        JSON.stringify({ status: 'completed', exitCode: 0, sessionRef: NATIVE.session }),
      )
      nativeJournal(planted)
      seedTask()

      const result = await resume({ reason: 'planted flat receipt', expected_updated_at: 2000 })

      expect(result.status).toBe(409)
      expect(result.body.evidence_code).toBe('receipt_mismatch')
      expect(taskRow().claim_state).toBe('Released')
    })

    it('rejects a symlinked native result rather than following it', async () => {
      const real = nativeRun({ pr: 999 })
      const dir = path.join(nativeRoot, String(NATIVE.pr), NATIVE.runId)
      mkdirSync(dir, { recursive: true })
      const linked = path.join(dir, 'result.json')
      symlinkSync(real, linked)
      nativeJournal(linked)
      seedTask()

      expect((await resume({ reason: 'symlinked native result', expected_updated_at: 2000 })).body.evidence_code).toBe(
        'receipt_mismatch',
      )
      expect(taskRow().claim_state).toBe('Released')
    })

    it('still blocks when a later journal shows a live worker for the same task', async () => {
      nativeJournal(nativeRun())
      journal('002-later-run', {
        id: 'later-run',
        projectId: PROJECT_ID,
        workspaceId: null,
        workers: [worker('w-review-3', 'review', 'running', 'sess-review-3', null)],
      })
      seedTask()

      const result = await resume({ reason: 'later live worker', expected_updated_at: 2000 })

      expect(result.status).toBe(409)
      expect(result.body.evidence_code).toBe('worker_not_terminal')
      expect(taskRow().claim_state).toBe('Released')
    })

    it('reconciles a native reviewer alongside older flat Claude workers in the same journal', async () => {
      journal('001-run', {
        id: '2fb27d2d-6d6c-41eb-9e8d-7308b6057867',
        projectId: PROJECT_ID,
        workspaceId: null,
        workers: [
          worker('w-impl-1', 'implementation', 'completed', 'sess-impl-1', terminalReceipt('impl-1', 'sess-impl-1')),
          codexWorker(nativeRun()),
        ],
      })
      seedTask()

      const result = await resume({ reason: 'mixed legacy and native', expected_updated_at: 2000 })

      expect(result.status).toBe(200)
      const kinds = result.body.evidence.workers.map((w: any) => w.native?.evidence_kind ?? 'legacy_flat')
      expect(kinds.sort()).toEqual(['legacy_flat', 'native_result'])
    })
  })
})
