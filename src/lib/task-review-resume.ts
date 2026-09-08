import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'

/**
 * Server-side reconciliation of native worker evidence for the review-resume
 * transition. The caller never asserts that its workers stopped: this module
 * reads the canonical local controller journal and the native terminal receipts
 * the journal points at, and fails closed on anything it cannot prove.
 *
 * Roots are injectable for tests only. At runtime the fixed canonical paths are
 * used; a request can never choose a root.
 */

/** Only the primary workspace owns the local controller journal. */
export const PRIMARY_WORKSPACE_ID = 1

const MAX_JOURNAL_FILES = 400
const MAX_FILE_BYTES = 512_000

const TERMINAL_WORKER_STATUSES = ['completed', 'failed', 'cancelled'] as const
type TerminalStatus = (typeof TERMINAL_WORKER_STATUSES)[number]

const isTerminal = (status: string): status is TerminalStatus =>
  (TERMINAL_WORKER_STATUSES as readonly string[]).includes(status)

const workerSchema = z
  .object({
    workerId: z.string().min(1).max(200),
    taskId: z.number().int().positive(),
    dispatch: z
      .object({ phase: z.string().min(1).max(64).optional() })
      .passthrough()
      .optional(),
    status: z.string().min(1).max(64),
    sessionRef: z.string().min(1).max(500).nullish(),
    receiptRef: z.string().min(1).max(1000).nullish(),
  })
  .passthrough()

const journalSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    projectId: z.number().int().nullish(),
    workspaceId: z.number().int().nullish(),
    workers: z.array(workerSchema).max(500).optional(),
  })
  .passthrough()

const receiptSchema = z
  .object({
    status: z.string().min(1).max(64),
    exitCode: z.number().int().nullish(),
    sessionId: z.string().min(1).max(300).optional(),
    sessionRef: z.string().min(1).max(400).optional(),
  })
  .passthrough()

export type ResumeEvidenceCode =
  | 'workspace_not_supported'
  | 'evidence_unavailable'
  | 'evidence_unreadable'
  | 'scope_mismatch'
  | 'worker_not_terminal'
  | 'receipt_mismatch'

/** Public, path-free summary of one reconciled worker. */
export interface ReconciledWorker {
  worker_id: string
  phase: string | null
  status: TerminalStatus
  session_ref: string
  receipt_status: string
  receipt_exit_code: number
  receipt_digest: string
  run_id: string | null
}

export interface ResumeEvidenceDeps {
  /** Directory holding the controller run journals (`*.json`). */
  journalRoot: string
  /** Receipts must resolve inside one of these roots. */
  receiptRoots: string[]
}

export interface ResumeEvidenceRequest {
  taskId: number
  projectId: number | null
  workspaceId: number
}

export type ResumeEvidenceResult =
  | { ok: true; workers: ReconciledWorker[]; receipt_refs: string[]; journal_count: number }
  /** `message` is safe to return to a client; `detail` is for server logs only. */
  | { ok: false; code: ResumeEvidenceCode; message: string; detail: string }

/** Canonical runtime roots. Never derived from request input. */
export function defaultResumeEvidenceDeps(): ResumeEvidenceDeps {
  const home = homedir()
  return {
    journalRoot: path.join(
      home,
      '.openclaw',
      'workspace',
      'skills',
      'babysential-backlog-orchestrator',
      '.state',
      'runs',
    ),
    receiptRoots: [path.join(home, 'tmp')],
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function fail(code: ResumeEvidenceCode, message: string, detail: string): ResumeEvidenceResult {
  return { ok: false, code, message, detail }
}

function containedIn(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    let resolvedRoot: string
    try {
      resolvedRoot = realpathSync(root)
    } catch {
      return false
    }
    return target === resolvedRoot || target.startsWith(resolvedRoot + path.sep)
  })
}

/**
 * Read a JSON file that must be a real, owner-readable regular file inside an
 * allowed root, small enough to parse. Symlinks and traversal are rejected
 * rather than followed.
 */
function readBoundedJson(filePath: string, roots: string[]): unknown {
  if (!path.isAbsolute(filePath) || filePath.split(path.sep).includes('..')) {
    throw new Error('non-canonical path')
  }
  const stat = lstatSync(filePath)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a regular file')
  if (stat.size > MAX_FILE_BYTES) throw new Error('file too large')
  // Containment is checked on the resolved path, so a symlinked parent
  // directory cannot smuggle a file in from outside the trusted roots.
  const real = realpathSync(filePath)
  if (!containedIn(real, roots)) throw new Error('outside the trusted roots')
  return JSON.parse(readFileSync(real, 'utf8'))
}

interface JournalWorker {
  workerId: string
  phase: string | null
  status: string
  sessionRef: string | null
  receiptRef: string | null
  runId: string | null
  journalFile: string
}

/**
 * Reconcile every native worker recorded for `taskId`.
 *
 * Succeeds only when at least one worker exists for the task and every worker
 * found across every journal is terminal with a matching native terminal
 * receipt and session. A passed deadline proves nothing and is never read.
 */
export function reconcileNativeTerminalEvidence(
  request: ResumeEvidenceRequest,
  deps: ResumeEvidenceDeps = defaultResumeEvidenceDeps(),
): ResumeEvidenceResult {
  if (request.workspaceId !== PRIMARY_WORKSPACE_ID) {
    // Fail closed without touching the filesystem or hinting at what exists.
    return fail(
      'workspace_not_supported',
      'Review resume evidence is available in the primary workspace only',
      `workspace ${request.workspaceId} is not the primary workspace`,
    )
  }

  const { journalRoot } = deps
  if (!existsSync(journalRoot)) {
    return fail(
      'evidence_unavailable',
      'No controller journal is available to reconcile the previous workers',
      'journal root is missing',
    )
  }

  let files: string[]
  try {
    const rootStat = lstatSync(journalRoot)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('not a directory')
    files = readdirSync(journalRoot)
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch (error) {
    return fail(
      'evidence_unreadable',
      'The controller journal could not be read; reconcile it locally before resuming',
      `journal root unreadable: ${(error as Error).message}`,
    )
  }

  if (files.length > MAX_JOURNAL_FILES) {
    return fail(
      'evidence_unreadable',
      'The controller journal is too large to reconcile automatically',
      `${files.length} journal files exceeds the bound`,
    )
  }

  const workers: JournalWorker[] = []
  let journalCount = 0

  for (const name of files) {
    const filePath = path.join(journalRoot, name)
    let parsed: z.infer<typeof journalSchema>
    try {
      parsed = journalSchema.parse(readBoundedJson(filePath, [journalRoot]))
    } catch (error) {
      return fail(
        'evidence_unreadable',
        'A controller journal entry is unreadable; reconcile it locally before resuming',
        `journal ${name}: ${(error as Error).message}`,
      )
    }
    journalCount += 1

    const matching = (parsed.workers ?? []).filter((worker) => worker.taskId === request.taskId)
    if (matching.length === 0) continue

    // The journal must describe the same scope as the task being resumed.
    const journalWorkspace = parsed.workspaceId ?? PRIMARY_WORKSPACE_ID
    if (journalWorkspace !== PRIMARY_WORKSPACE_ID || parsed.projectId !== request.projectId) {
      return fail(
        'scope_mismatch',
        'Recorded worker evidence belongs to a different project or workspace',
        `journal ${name}: project ${String(parsed.projectId)} workspace ${String(parsed.workspaceId)}`,
      )
    }

    for (const worker of matching) {
      workers.push({
        workerId: worker.workerId,
        phase: worker.dispatch?.phase ?? null,
        status: worker.status,
        sessionRef: worker.sessionRef ?? null,
        receiptRef: worker.receiptRef ?? null,
        runId: parsed.id ?? null,
        journalFile: name,
      })
    }
  }

  if (workers.length === 0) {
    return fail(
      'evidence_unavailable',
      'No native worker is recorded for this task, so there is nothing to reconcile',
      `no journal worker for task ${request.taskId}`,
    )
  }

  const reconciled: ReconciledWorker[] = []
  const receiptRefs: string[] = []

  for (const worker of workers) {
    if (!isTerminal(worker.status)) {
      return fail(
        'worker_not_terminal',
        'A recorded native worker is not finished, so the review cannot be resumed',
        `worker ${worker.workerId} in ${worker.journalFile} has status ${worker.status}`,
      )
    }
    if (!worker.receiptRef || !worker.sessionRef) {
      return fail(
        'receipt_mismatch',
        'A recorded native worker has no terminal receipt or session to verify',
        `worker ${worker.workerId} in ${worker.journalFile} is missing a receipt or session ref`,
      )
    }

    let receipt: z.infer<typeof receiptSchema>
    try {
      receipt = receiptSchema.parse(readBoundedJson(worker.receiptRef, deps.receiptRoots))
    } catch (error) {
      return fail(
        'receipt_mismatch',
        'A native terminal receipt is missing or unreadable, so the workers cannot be proven finished',
        `worker ${worker.workerId} receipt: ${(error as Error).message}`,
      )
    }

    // The receipt itself must prove a terminal native process: matching status,
    // an actual exit code and the same session the journal registered.
    const exitCode = receipt.exitCode
    const exitProvesTerminal =
      typeof exitCode === 'number' &&
      (receipt.status !== 'completed' || exitCode === 0)
    // Either field may be absent, but every supplied identity must agree.
    const sessionMatches =
      (receipt.sessionRef !== undefined || receipt.sessionId !== undefined) &&
      (receipt.sessionRef === undefined || receipt.sessionRef === worker.sessionRef) &&
      (receipt.sessionId === undefined || worker.sessionRef.endsWith(`:${receipt.sessionId}`))

    if (
      !isTerminal(receipt.status) ||
      receipt.status !== worker.status ||
      !exitProvesTerminal ||
      !sessionMatches
    ) {
      return fail(
        'receipt_mismatch',
        'A native terminal receipt does not prove the recorded worker finished',
        `worker ${worker.workerId}: receipt status ${receipt.status} exit ${String(exitCode)} session ${String(receipt.sessionRef ?? receipt.sessionId)}`,
      )
    }

    reconciled.push({
      worker_id: worker.workerId,
      phase: worker.phase,
      status: worker.status,
      session_ref: worker.sessionRef,
      receipt_status: receipt.status,
      receipt_exit_code: exitCode as number,
      receipt_digest: digest(JSON.stringify(receipt)),
      run_id: worker.runId,
    })
    receiptRefs.push(worker.receiptRef)
  }

  return { ok: true, workers: reconciled, receipt_refs: receiptRefs, journal_count: journalCount }
}
