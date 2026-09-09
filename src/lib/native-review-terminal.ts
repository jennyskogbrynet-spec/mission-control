import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'

/**
 * Readers for the immutable native Codex review receipts.
 *
 * Two receipt shapes are produced by the native reviewer and neither may ever be
 * rewritten to fit the older flat shape:
 *
 *  1. the authoritative `result.json` written by the native run, paired with the
 *     `request.json` it was launched from, under the fixed per-PR root; and
 *  2. a derived host observation summary under the legacy receipt root that
 *     points at exactly one such `result.json`.
 *
 * Both are validated against the authoritative request/result pair. The wrapper
 * CLI's own exit code is a *decision* exit and is recorded separately; it never
 * stands in for the observed native child exit.
 */

export const HOST_OBSERVATION_KIND = 'host_observation_of_native_release_review'

/** All receipt reads retain the existing bounded metadata size. */
export const MAX_NATIVE_FILE_BYTES = 512_000

export const TERMINAL_WORKER_STATUSES = ['completed', 'failed', 'cancelled'] as const
export type TerminalStatus = (typeof TERMINAL_WORKER_STATUSES)[number]

export const isTerminalStatus = (status: string): status is TerminalStatus =>
  (TERMINAL_WORKER_STATUSES as readonly string[]).includes(status)

/** A turn that is still open proves nothing about the child process. */
const TERMINAL_TURN_STATUSES = ['completed', 'failed', 'cancelled', 'aborted']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const uuid = z.string().regex(UUID)
const gitSha = z.string().regex(/^[0-9a-f]{40}$/)
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

const gitStateSchema = z
  .object({ headSha: gitSha, treeSha: gitSha, dirty: z.boolean() })
  .passthrough()

const accountSchema = z
  .object({
    type: z.literal('chatgpt'),
    emailHash: sha256Hex,
    planType: z.string().min(1).max(64).nullish(),
  })
  .passthrough()

const nativeRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: uuid,
    candidate: z
      .object({
        repo: z.string().min(1).max(200),
        prNumber: z.number().int().positive(),
        baseSha: gitSha,
        headSha: gitSha,
        treeSha: gitSha,
        policyCommit: gitSha,
        policySha256: sha256Hex,
      })
      .passthrough(),
    taskRef: z.string().min(1).max(64),
    accountId: z.string().min(1).max(200),
    expectedEmailHash: sha256Hex,
    model: z.string().min(1).max(120),
    packetSha256: sha256Hex,
  })
  .passthrough()

const nativeResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: uuid,
    requestSha256: sha256Hex,
    native: z
      .object({
        mechanism: z.literal('turn/start+outputSchema'),
        status: z.string().min(1).max(32),
        decision: z.enum(['pass', 'hold']),
        review: z.object({ decision: z.enum(['pass', 'hold']) }).passthrough(),
        requestedModel: z.string().min(1).max(120),
        observedModel: z.string().min(1).max(120),
        accountBefore: accountSchema,
        accountAfter: accountSchema,
        sourceThreadId: uuid,
        reviewThreadId: uuid,
        turnId: uuid,
        terminal: z
          .object({
            method: z.string().min(1).max(64),
            threadId: uuid,
            turn: z
              .object({
                id: uuid,
                status: z.string().min(1).max(32),
                startedAt: z.number().nullish(),
                completedAt: z.number().nullish(),
              })
              .passthrough(),
          })
          .passthrough(),
        exitedReviewMode: z.unknown().nullish(),
        childExit: z
          .object({
            observed: z.boolean(),
            code: z.number().int().nullish(),
            signal: z.string().nullish(),
          })
          .passthrough(),
        errorCode: z.string().max(200).nullish(),
      })
      .passthrough(),
    gitBefore: gitStateSchema,
    gitAfter: gitStateSchema,
  })
  .passthrough()

const hostObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal(HOST_OBSERVATION_KIND),
    status: z.string().min(1).max(32),
    exitCode: z.number().int(),
    // Descriptive only. MC1297's PASS observations predate the field, so its
    // absence is recorded as null rather than refusing otherwise valid evidence.
    exitCodeMeaning: z.string().min(1).max(300).nullish(),
    sessionRef: z.string().min(1).max(300),
    decision: z.enum(['pass', 'hold']),
    runId: uuid,
    nativeResultRef: z.string().min(1).max(1000),
    pr: z.number().int().positive(),
    task: z.number().int().positive(),
    headSha: gitSha,
  })
  .passthrough()

export type NativeEvidenceKind = 'native_result' | typeof HOST_OBSERVATION_KIND

/** Path-free provenance recorded alongside the existing reconciled worker fields. */
export interface NativeTerminalEvidence {
  evidence_kind: NativeEvidenceKind
  native_status: TerminalStatus
  /** The observed exit of the native reviewer child process. */
  child_exit_code: number
  child_exit_signal: null
  /** The wrapper CLI's decision exit, when a host observation recorded one. */
  wrapper_exit_code: number | null
  wrapper_exit_meaning: string | null
  /** Preserved verbatim; a HOLD stays a HOLD. */
  review_decision: string
  native_run_id: string
  pr_number: number
  head_sha: string
  task_ref: string
  observed_model: string
  thread_id: string
  turn_id: string
  /** SHA-256 of the raw request.json bytes, as asserted by the result. */
  request_sha256: string
  /** SHA-256 of the raw result.json bytes. */
  result_digest: string
  /** SHA-256 of the raw host observation bytes, when one was followed. */
  wrapper_digest: string | null
  /** Absolute path of the authoritative result.json (server-side audit only). */
  native_result_ref: string
}

export interface BoundedFile {
  realPath: string
  raw: Uint8Array
  json: unknown
}

export type BoundedReader = (filePath: string, roots: string[], maxBytes: number) => BoundedFile

export interface NativeTerminalDeps {
  read: BoundedReader
  /** Resolved `<...>/babysential-codex-review/perPR` root, or null if absent. */
  nativeReviewRoot: string | null
}

export interface NativeWorkerBinding {
  taskId: number
  /** Terminal status the controller journal recorded for this worker. */
  status: TerminalStatus
  sessionRef: string
  /** Registered model for the worker's route, when the journal records one. */
  models: string[]
  accountIds: string[]
}

const rawDigest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

/** Native Codex controller sessions use the explicit Codex runtime prefix. */
const sessionBinds = (sessionRef: string, threadId: string) =>
  sessionRef === `codex:${threadId}`

/**
 * Decide which reader a receipt must use. Presence of any native discriminator
 * commits the receipt to the strict native path: a malformed native receipt is
 * rejected rather than retried against the lax legacy matcher.
 */
export function classifyReceipt(json: unknown): 'native_result' | 'host_observation' | 'legacy' {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'legacy'
  const record = json as Record<string, unknown>
  if (record.kind === HOST_OBSERVATION_KIND || record.nativeResultRef !== undefined) return 'host_observation'
  if (record.native !== undefined || record.requestSha256 !== undefined) return 'native_result'
  return 'legacy'
}

/**
 * Require `<perPR>/<positive PR>/<canonical uuid>/result.json` exactly, with no
 * extra nesting. The PR number and run id in the path are themselves evidence
 * and are cross-checked against the request and result contents.
 */
function parseResultLocation(
  realPath: string,
  nativeReviewRoot: string | null,
): { dir: string; runId: string; prNumber: number } {
  if (!nativeReviewRoot) throw new Error('the native review root is unavailable')
  if (path.basename(realPath) !== 'result.json') throw new Error('native receipt is not result.json')
  const dir = path.dirname(realPath)
  const runId = path.basename(dir)
  const prDir = path.basename(path.dirname(dir))
  if (path.dirname(path.dirname(dir)) !== nativeReviewRoot) {
    throw new Error('result.json is not directly under <perPR>/<pr>/<runId>')
  }
  if (!UUID.test(runId)) throw new Error(`run directory ${runId} is not a canonical uuid`)
  if (!/^[1-9]\d*$/.test(prDir)) throw new Error(`pr directory ${prDir} is not a positive number`)
  return { dir, runId, prNumber: Number(prDir) }
}

/**
 * Validate one authoritative native result plus its sibling request.
 *
 * Every identity the pair asserts must agree with the directory it lives in,
 * with the worker the controller registered, and with itself. Anything missing,
 * contradictory or merely unobserved throws.
 */
function readNativeResult(
  receipt: BoundedFile,
  binding: NativeWorkerBinding,
  deps: NativeTerminalDeps,
): Omit<NativeTerminalEvidence, 'evidence_kind' | 'wrapper_exit_code' | 'wrapper_exit_meaning' | 'wrapper_digest'> {
  const { dir, runId, prNumber } = parseResultLocation(receipt.realPath, deps.nativeReviewRoot)
  const result = nativeResultSchema.parse(receipt.json)
  if (result.runId !== runId) {
    throw new Error(`result runId ${result.runId} does not match directory ${runId}`)
  }

  const requestFile = deps.read(
    path.join(dir, 'request.json'),
    [deps.nativeReviewRoot as string],
    MAX_NATIVE_FILE_BYTES,
  )
  // The result asserts the digest of the exact raw request bytes it ran from.
  const requestSha256 = rawDigest(requestFile.raw)
  if (requestSha256 !== result.requestSha256) {
    throw new Error('request.json does not hash to the requestSha256 recorded in result.json')
  }
  const request = nativeRequestSchema.parse(requestFile.json)
  if (request.runId !== runId) {
    throw new Error(`request runId ${request.runId} does not match directory ${runId}`)
  }
  if (request.candidate.prNumber !== prNumber) {
    throw new Error(`request PR ${request.candidate.prNumber} does not match directory ${prNumber}`)
  }
  const expectedTaskRef = `MC:${binding.taskId}`
  if (request.taskRef !== expectedTaskRef) {
    throw new Error(`request taskRef ${request.taskRef} is not ${expectedTaskRef}`)
  }

  const native = result.native
  if (!isTerminalStatus(native.status)) {
    throw new Error(`native status ${native.status} is not terminal`)
  }
  if (native.status !== binding.status) {
    throw new Error(`native status ${native.status} does not match worker status ${binding.status}`)
  }
  if (native.errorCode !== null && native.errorCode !== undefined) {
    throw new Error(`native run reported errorCode ${native.errorCode}`)
  }
  if (native.exitedReviewMode !== null && native.exitedReviewMode !== undefined) {
    throw new Error('native run left review mode')
  }

  // Observed child exit. Unobserved, missing or signalled exits prove nothing.
  const childExit = native.childExit
  if (childExit.observed !== true) throw new Error('native child exit was not observed')
  if (typeof childExit.code !== 'number') throw new Error('native child exit code is missing')
  if (childExit.signal !== null && childExit.signal !== undefined) {
    throw new Error(`native child was signalled with ${childExit.signal}`)
  }
  if (native.status === 'completed' && childExit.code !== 0) {
    throw new Error(`native status completed contradicts child exit ${childExit.code}`)
  }

  // Threads and turn: one source thread, reviewed and terminated in place.
  if (native.sourceThreadId !== native.reviewThreadId) {
    throw new Error('native source and review thread ids differ')
  }
  if (native.terminal.threadId !== native.sourceThreadId) {
    throw new Error('native terminal thread id does not match the source thread')
  }
  if (native.terminal.turn.id !== native.turnId) {
    throw new Error('native terminal turn id does not match the run turn id')
  }
  if (native.terminal.method !== 'turn/completed') {
    throw new Error(`native terminal method ${native.terminal.method} is not the terminal turn notification`)
  }
  const turnStatus = native.terminal.turn.status
  if (!TERMINAL_TURN_STATUSES.includes(turnStatus)) {
    throw new Error(`native turn status ${turnStatus} is not terminal`)
  }
  if (native.status === 'completed' && turnStatus !== 'completed') {
    throw new Error(`native status completed contradicts turn status ${turnStatus}`)
  }
  if (!sessionBinds(binding.sessionRef, native.sourceThreadId)) {
    throw new Error('worker session ref does not bind the native source thread')
  }

  // Model and account identity, checked wherever the receipts record them.
  if (native.requestedModel !== request.model || native.observedModel !== request.model) {
    throw new Error(
      `model mismatch: requested ${native.requestedModel} observed ${native.observedModel} request ${request.model}`,
    )
  }
  for (const model of binding.models) {
    if (model !== native.observedModel) throw new Error('registered worker model mismatch')
  }
  for (const accountId of binding.accountIds) {
    if (accountId !== request.accountId) throw new Error('registered worker account mismatch')
  }
  for (const [label, account] of [
    ['accountBefore', native.accountBefore],
    ['accountAfter', native.accountAfter],
  ] as const) {
    if (account && account.emailHash !== request.expectedEmailHash) {
      throw new Error(`${label} identity does not match the requested account`)
    }
  }
  if (native.accountBefore && native.accountAfter) {
    if (
      native.accountBefore.type !== native.accountAfter.type ||
      native.accountBefore.emailHash !== native.accountAfter.emailHash
    ) {
      throw new Error('the account changed during the native run')
    }
  }

  // Candidate linkage: the reviewed worktree must be the requested candidate.
  for (const [label, state] of [
    ['gitBefore', result.gitBefore],
    ['gitAfter', result.gitAfter],
  ] as const) {
    if (state.dirty) throw new Error(`${label} worktree was dirty`)
    if (state.headSha !== request.candidate.headSha || state.treeSha !== request.candidate.treeSha) {
      throw new Error(`${label} does not match the requested candidate head/tree`)
    }
  }

  // The review decision is preserved exactly as both fields recorded it.
  if (native.decision !== native.review.decision) {
    throw new Error(`decision ${native.decision} contradicts review.decision ${native.review.decision}`)
  }

  return {
    native_status: native.status,
    child_exit_code: childExit.code,
    child_exit_signal: null,
    review_decision: native.decision,
    native_run_id: runId,
    pr_number: prNumber,
    head_sha: request.candidate.headSha,
    task_ref: request.taskRef,
    observed_model: native.observedModel,
    thread_id: native.sourceThreadId,
    turn_id: native.turnId,
    request_sha256: requestSha256,
    result_digest: rawDigest(receipt.raw),
    native_result_ref: receipt.realPath,
  }
}

/**
 * Read a derived host observation and the one native result it names.
 *
 * The observation is a convenience summary, not evidence: every field it copies
 * is re-verified against the authoritative pair. Its own `exitCode` is the
 * wrapper's decision exit (non-zero on HOLD) and is kept strictly apart from the
 * child exit. Exactly one pointer is followed and the target must be a raw
 * native result, so there is no recursive or generic adapter chain.
 */
function readHostObservation(
  receipt: BoundedFile,
  binding: NativeWorkerBinding,
  deps: NativeTerminalDeps,
): NativeTerminalEvidence {
  const observation = hostObservationSchema.parse(receipt.json)
  if (observation.task !== binding.taskId) {
    throw new Error(`observation task ${observation.task} is not task ${binding.taskId}`)
  }
  if (observation.sessionRef !== binding.sessionRef) {
    throw new Error('observation session ref does not match the registered worker session')
  }
  if (!deps.nativeReviewRoot) throw new Error('the native review root is unavailable')

  const target = deps.read(
    observation.nativeResultRef,
    [deps.nativeReviewRoot],
    MAX_NATIVE_FILE_BYTES,
  )
  if (classifyReceipt(target.json) !== 'native_result') {
    throw new Error('nativeResultRef does not point at a raw native result')
  }
  const native = readNativeResult(target, binding, deps)

  if (observation.runId !== native.native_run_id) {
    throw new Error(`observation runId ${observation.runId} does not match the native run`)
  }
  if (observation.pr !== native.pr_number) {
    throw new Error(`observation PR ${observation.pr} does not match the native run`)
  }
  if (observation.headSha !== native.head_sha) {
    throw new Error('observation headSha does not match the requested candidate')
  }
  if (observation.decision !== native.review_decision) {
    throw new Error(
      `observation decision ${observation.decision} contradicts the native decision ${native.review_decision}`,
    )
  }
  if (observation.status !== native.native_status) {
    throw new Error(`observation status ${observation.status} contradicts the native status`)
  }
  if (!sessionBinds(observation.sessionRef, native.thread_id)) {
    throw new Error('observation session ref does not bind the native source thread')
  }

  return {
    ...native,
    evidence_kind: HOST_OBSERVATION_KIND,
    wrapper_exit_code: observation.exitCode,
    wrapper_exit_meaning: observation.exitCodeMeaning ?? null,
    wrapper_digest: rawDigest(receipt.raw),
  }
}

/**
 * Verify a native receipt in either accepted shape.
 *
 * Throws an `Error` whose message is server-log detail only; the caller maps it
 * to the public `receipt_mismatch` code without paths.
 */
export function verifyNativeTerminalEvidence(
  receipt: BoundedFile,
  kind: 'native_result' | 'host_observation',
  binding: NativeWorkerBinding,
  deps: NativeTerminalDeps,
): NativeTerminalEvidence {
  if (kind === 'host_observation') return readHostObservation(receipt, binding, deps)
  return {
    ...readNativeResult(receipt, binding, deps),
    evidence_kind: 'native_result',
    wrapper_exit_code: null,
    wrapper_exit_meaning: null,
    wrapper_digest: null,
  }
}
