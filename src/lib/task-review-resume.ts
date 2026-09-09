import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import {
  MAX_NATIVE_FILE_BYTES,
  classifyReceipt,
  isTerminalStatus,
  verifyNativeTerminalEvidence,
  type BoundedFile,
  type NativeTerminalEvidence,
  type TerminalStatus,
} from './native-review-terminal'

/**
 * Server-side reconciliation of native worker evidence for the review-resume
 * transition. The caller never asserts that its workers stopped: this module
 * reads the canonical local controller journal and the native terminal receipts
 * the journal points at, and fails closed on anything it cannot prove.
 *
 * Two receipt roots are trusted, both fixed at runtime: the legacy receipt root
 * and the native Codex review per-PR root. Roots are injectable for tests only;
 * a request can never choose a root.
 */

/** Only the primary workspace owns the local controller journal. */
export const PRIMARY_WORKSPACE_ID = 1

const MAX_JOURNAL_FILES = 400
const MAX_FILE_BYTES = 512_000
const MAX_RECEIPT_ROOTS = 8

const isTerminal = isTerminalStatus

const workerSchema = z
  .object({
    workerId: z.string().min(1).max(200),
    taskId: z.number().int().positive(),
    dispatch: z
      .object({ phase: z.string().min(1).max(64).optional(), modelId: z.string().min(1).max(120).nullish(), hostModelId: z.string().min(1).max(120).nullish(), accountId: z.string().min(1).max(200).nullish() })
      .passthrough()
      .optional(),
    route: z
      .object({ model: z.string().min(1).max(120).nullish(), modelId: z.string().min(1).max(120).nullish(), accountId: z.string().min(1).max(200).nullish() })
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

/** Path-free native provenance; only present for native Codex receipts. */
export type NativeProvenance = Omit<NativeTerminalEvidence, 'native_result_ref'>

/** Public, path-free summary of one reconciled worker. */
export interface ReconciledWorker {
  worker_id: string
  phase: string | null
  status: TerminalStatus
  session_ref: string
  receipt_status: string
  /**
   * The exit that proves the worker's own process ended. For native receipts
   * this is the observed native child exit, never a wrapper decision exit.
   */
  receipt_exit_code: number
  receipt_digest: string
  run_id: string | null
  native?: NativeProvenance
}

export interface ResumeEvidenceDeps {
  /** Directory holding the controller run journals (`*.json`). */
  journalRoot: string
  /** Legacy receipts must resolve inside one of these roots. */
  receiptRoots: string[]
  /** Fixed `<...>/babysential-codex-review/perPR` root for native receipts. */
  nativeReviewRoot: string
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

/** Operator-configured durable evidence root, in addition to `~/tmp`. */
export const EVIDENCE_ROOT_ENV = 'MC_EVIDENCE_ROOT'
/** Operator-configured comma list of further durable legacy receipt roots. */
export const RECEIPT_ROOTS_ENV = 'MC_RECEIPT_ROOTS'

/** True when `target` sits inside `root`, and is not `root` itself. */
function strictlyUnder(target: string, root: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return target !== root && target.startsWith(prefix)
}

/**
 * Resolve an entry from either receipt-root variable into a trusted root, or null.
 *
 * Evidence currently lives under a directory called `tmp`, which every disk
 * sweep is entitled to treat as disposable. This lets an operator point the
 * reconciler at a durable root as well, so receipts can be moved out and left
 * reachable through a `~/tmp` symlink: containment is checked on the resolved
 * path, so a symlink into a trusted root is accepted while one that escapes
 * every root is still refused.
 *
 * An unusable value is ignored rather than fatal, so a typo degrades to today's
 * behaviour instead of making every review unresumable. An over-broad or
 * disposable value is ignored too: after realpath normalisation the root is
 * trusted only when it lies strictly inside the home directory and is not
 * itself sweepable. That refuses `/` and `$HOME`, but also every ancestor of
 * `$HOME` (`/Users`), which is strictly wider than the `$HOME` case and was the
 * gap an earlier equality-only check left open.
 *
 * These roots only widen where *legacy* receipts may live. The authoritative
 * native review root is fixed below and is never operator-configurable.
 */
function configuredEvidenceRoot(
  home: string,
  value = process.env[EVIDENCE_ROOT_ENV],
): { root: string; resolved: string } | null {
  const raw = value?.trim()
  if (!raw || !path.isAbsolute(raw) || raw.split(path.sep).includes('..')) return null

  let resolved: string
  try {
    resolved = realpathSync(raw)
    if (!lstatSync(resolved).isDirectory()) return null
  } catch {
    return null
  }

  let realHome: string
  try {
    realHome = realpathSync(home)
  } catch {
    return null
  }

  // Strictly inside $HOME. This is the single breadth rule: it refuses `/`,
  // `$HOME` itself, and any ancestor of it, without enumerating them.
  if (!strictlyUnder(resolved, realHome)) return null

  // Disposable locations are refused even when they sit inside $HOME: `~/tmp`
  // is the sweepable root this variable exists to escape, and the system temp
  // root is no more durable. `/tmp` resolves to `/private/tmp` on macOS, so
  // both spellings are covered by resolving before comparing.
  for (const disposable of [path.join(realHome, 'tmp'), '/tmp']) {
    let realDisposable: string
    try {
      realDisposable = realpathSync(disposable)
    } catch {
      // A directory that does not resolve cannot contain this one.
      continue
    }
    if (resolved === realDisposable || strictlyUnder(resolved, realDisposable)) return null
  }
  return { root: raw, resolved }
}

/** Canonical runtime roots. Never derived from request input. */
export function defaultResumeEvidenceDeps(): ResumeEvidenceDeps {
  const home = homedir()
  const receiptRoots = [path.join(home, 'tmp')]
  const configured = configuredEvidenceRoot(home)
  if (configured) receiptRoots.push(configured.root)
  const accepted = new Set(configured ? [configured.resolved] : [])
  for (const entry of (process.env[RECEIPT_ROOTS_ENV] ?? '').split(',')) {
    if (receiptRoots.length >= MAX_RECEIPT_ROOTS) break
    const root = configuredEvidenceRoot(home, entry)
    if (!root || accepted.has(root.resolved)) continue
    accepted.add(root.resolved)
    receiptRoots.push(root.root)
  }

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
    receiptRoots,
    nativeReviewRoot: path.join(
      home,
      '.openclaw',
      'state',
      'babysential-codex-review',
      'perPR',
    ),
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
 * rather than followed. The raw bytes are returned so callers can verify the
 * digests the native receipts assert over exact file content.
 */
function readBoundedFile(
  filePath: string,
  roots: string[],
  maxBytes = MAX_FILE_BYTES,
): BoundedFile {
  if (!path.isAbsolute(filePath) || filePath.split(path.sep).includes('..')) {
    throw new Error('non-canonical path')
  }
  const stat = lstatSync(filePath)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a regular file')
  if (stat.size > maxBytes) throw new Error('file too large')
  // Containment is checked on the resolved path, so a symlinked parent
  // directory cannot smuggle a file in from outside the trusted roots.
  const real = realpathSync(filePath)
  if (!containedIn(real, roots)) throw new Error('outside the trusted roots')
  const raw = readFileSync(real)
  // Hash original bytes and reject lossy decoding of immutable evidence.
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
  return { realPath: real, raw, json: JSON.parse(decoded) }
}

function readBoundedJson(filePath: string, roots: string[]): unknown {
  return readBoundedFile(filePath, roots).json
}

/** Resolve a path once; an unresolvable fixed root simply trusts nothing. */
function resolveReal(target: string): string | null {
  try {
    return realpathSync(target)
  } catch {
    return null
  }
}

interface JournalWorker {
  workerId: string
  phase: string | null
  status: string
  sessionRef: string | null
  receiptRef: string | null
  models: string[]
  accountIds: string[]
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
        models: [worker.route?.model, worker.route?.modelId, worker.dispatch?.modelId, worker.dispatch?.hostModelId].filter((v): v is string => typeof v === 'string'),
        accountIds: [worker.route?.accountId, worker.dispatch?.accountId].filter((v): v is string => typeof v === 'string'),
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
  const resolvedNativeRoot = resolveReal(deps.nativeReviewRoot)
  const nativeReviewRoot = resolvedNativeRoot === path.resolve(deps.nativeReviewRoot) ? resolvedNativeRoot : null
  const trustedReceiptRoots = nativeReviewRoot
    ? [...deps.receiptRoots, nativeReviewRoot]
    : deps.receiptRoots

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

    let file: BoundedFile
    let kind: ReturnType<typeof classifyReceipt>
    try {
      // Native results are accepted only within the fixed native review root.
      const insideNativeRoot =
        nativeReviewRoot !== null &&
        containedIn(resolveReal(worker.receiptRef) ?? '', [nativeReviewRoot])
      file = readBoundedFile(
        worker.receiptRef,
        trustedReceiptRoots,
        insideNativeRoot ? MAX_NATIVE_FILE_BYTES : MAX_FILE_BYTES,
      )
      kind = classifyReceipt(file.json)
      // The native review root holds authoritative results only, and an
      // authoritative result is only trusted from that root.
      if (insideNativeRoot && file.realPath !== path.resolve(worker.receiptRef)) {
        throw new Error('native path contains a symlink')
      }
      if (insideNativeRoot && kind !== 'native_result') {
        throw new Error('the native review root holds native result receipts only')
      }
      if (!insideNativeRoot && kind === 'native_result') {
        throw new Error('a native result outside the fixed native review root is not trusted')
      }
    } catch (error) {
      return fail(
        'receipt_mismatch',
        'A native terminal receipt is missing or unreadable, so the workers cannot be proven finished',
        `worker ${worker.workerId} receipt: ${(error as Error).message}`,
      )
    }

    if (kind !== 'legacy') {
      // Immutable native Codex receipt, read directly or through its one
      // derived host observation. Nothing here is rewritten to the flat shape.
      let native: NativeTerminalEvidence
      try {
        native = verifyNativeTerminalEvidence(
          file,
          kind,
          {
            taskId: request.taskId,
            status: worker.status,
            sessionRef: worker.sessionRef,
            models: worker.models,
            accountIds: worker.accountIds,
          },
          { read: (filePath, roots, maxBytes) => {
            const result = readBoundedFile(filePath, roots, maxBytes)
            if (result.realPath !== path.resolve(filePath)) throw new Error('native path contains a symlink')
            return result
          }, nativeReviewRoot },
        )
      } catch (error) {
        return fail(
          'receipt_mismatch',
          'A native terminal receipt does not prove the recorded worker finished',
          `worker ${worker.workerId} native receipt: ${(error as Error).message}`,
        )
      }

      const { native_result_ref: nativeResultRef, ...provenance } = native
      reconciled.push({
        worker_id: worker.workerId,
        phase: worker.phase,
        status: worker.status,
        session_ref: worker.sessionRef,
        receipt_status: native.native_status,
        receipt_exit_code: native.child_exit_code,
        receipt_digest: digest(JSON.stringify(file.json)),
        run_id: worker.runId,
        native: provenance,
      })
      receiptRefs.push(worker.receiptRef)
      if (nativeResultRef !== worker.receiptRef) receiptRefs.push(nativeResultRef)
      continue
    }

    let receipt: z.infer<typeof receiptSchema>
    try {
      receipt = receiptSchema.parse(file.json)
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
