/**
 * Claim lease: a claim that nobody has touched for `leaseHours` is released back
 * to Unclaimed, with a comment, unless a run linked to the task is still active.
 *
 * Why: `POST /api/tasks/:id/claim` is an atomic compare-and-set, but nothing ever
 * expired a claim. Measured 2026-10-11: 80 tasks held a claim, 57 of them for
 * more than 14 days, so the work they stood for could not be picked up again.
 * `sweep-stalled` (default 300 s, capped at 24 h, counts from `claimed_at`) and
 * `requeueStaleTasks()` (in_progress + agent offline) both exist, but the first
 * has no caller and neither looks at task activity or at active runs.
 *
 * What counts as activity: the newest of `tasks.updated_at`, the claim time, the
 * newest comment, activity-log row and quality review for the task, and the
 * start/end of any run linked to it. A long-lived claim that is still being
 * worked on therefore keeps its lease (MC 1494, the serial release ticket, has
 * been claimed since 09-23 and is updated hourly).
 *
 * What protects a claim regardless of idle time:
 *  - a `runs` row for the task that is pending/running, not ended, and younger
 *    than `activeRunMaxAgeHours` (an older "running" row is a zombie, not a run);
 *  - a non-terminal native worker for the task in the controller journal
 *    (`readActiveNativeWorkerTaskIds`), passed in by the caller.
 *
 * `retry_count` is NOT incremented: an expired lease is housekeeping, not a failed
 * attempt, and `retry_count` feeds the dispatch retry budget.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { parseClaimedAtMs } from './claim-time'

type Db = Database.Database

/** The subset of the server event bus the sweeps emit. */
export type TaskEventType = 'task.updated' | 'task.status_changed'
export type TaskEventSink = (event: TaskEventType, payload: Record<string, unknown>) => void
export type Env = Record<string, string | undefined>

export const DEFAULT_CLAIM_LEASE_HOURS = 72
export const MIN_CLAIM_LEASE_HOURS = 1
export const MAX_CLAIM_LEASE_HOURS = 24 * 90
export const DEFAULT_ACTIVE_RUN_MAX_AGE_HOURS = 24
export const CLAIM_LEASE_SETTING = 'general.claim_lease_hours'
export const CLAIM_LEASE_SWEEP_SETTING = 'general.claim_lease_sweep'
export const CLAIM_LEASE_ENV = 'MC_CLAIM_LEASE_HOURS'
export const CLAIM_LEASE_ACTOR = 'claim-lease'

const HOUR_MS = 3_600_000
const ACTIVE_RUN_STATUSES = new Set(['pending', 'running'])
const TERMINAL_WORKER_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const MAX_JOURNAL_FILES = 400
const MAX_JOURNAL_BYTES = 512_000

export function clampLeaseHours(value: unknown, fallback = DEFAULT_CLAIM_LEASE_HOURS): number {
  const n = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(MAX_CLAIM_LEASE_HOURS, Math.max(MIN_CLAIM_LEASE_HOURS, n))
}

/** Lease length: `settings.general.claim_lease_hours`, else `MC_CLAIM_LEASE_HOURS`, else 72. */
export function readClaimLeaseHours(db: Db, env: Env = process.env): number {
  let fromSetting: unknown
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CLAIM_LEASE_SETTING) as { value?: string } | undefined
    fromSetting = row?.value
  } catch {
    fromSetting = undefined
  }
  return clampLeaseHours(fromSetting, clampLeaseHours(env[CLAIM_LEASE_ENV]))
}

export interface LeaseOptions {
  /** Restrict to one workspace. Omit only for the process-wide scheduler. */
  workspaceId?: number
  leaseHours: number
  nowMs?: number
  /** Task ids with a non-terminal native worker (see `readActiveNativeWorkerTaskIds`). */
  activeNativeTaskIds?: ReadonlySet<number>
  activeRunMaxAgeHours?: number
}

export type LeaseVerdict = 'expired' | 'within_lease' | 'protected_active_run' | 'protected_native_worker'

export interface LeaseEvaluation {
  task_id: number
  workspace_id: number
  project_id: number | null
  status: string
  claim_state: string
  claimed_by: string | null
  claimed_at: string | number | null
  updated_at: number
  last_activity_at: string
  last_activity_source: string
  idle_hours: number
  lease_hours: number
  verdict: LeaseVerdict
}

interface ClaimRow {
  id: number
  workspace_id: number
  project_id: number | null
  status: string
  claim_state: string
  claimed_by: string | null
  claimed_at: string | number | null
  updated_at: number
  last_comment_at: number | null
  last_activity_row_at: number | null
  last_review_at: number | null
}

interface RunRow {
  task_id: string
  status: string
  started_at: string | null
  ended_at: string | null
}

function isoMs(ms: number): string {
  return new Date(ms).toISOString()
}

/** Evaluate every held claim (Claimed/Running). Read-only. */
export function evaluateClaimLeases(db: Db, opts: LeaseOptions): LeaseEvaluation[] {
  const nowMs = opts.nowMs ?? Date.now()
  const leaseMs = opts.leaseHours * HOUR_MS
  const runMaxAgeMs = (opts.activeRunMaxAgeHours ?? DEFAULT_ACTIVE_RUN_MAX_AGE_HOURS) * HOUR_MS
  const scope = opts.workspaceId === undefined ? '' : 'AND t.workspace_id = ?'

  const claims = db
    .prepare(
      `
      SELECT t.id, t.workspace_id, t.project_id, t.status, t.claim_state, t.claimed_by, t.claimed_at, t.updated_at,
        (SELECT MAX(c.created_at) FROM comments c WHERE c.task_id = t.id) AS last_comment_at,
        (SELECT MAX(a.created_at) FROM activities a WHERE a.entity_type = 'task' AND a.entity_id = t.id) AS last_activity_row_at,
        (SELECT MAX(q.created_at) FROM quality_reviews q WHERE q.task_id = t.id) AS last_review_at
      FROM tasks t
      WHERE t.claim_state IN ('Claimed', 'Running') ${scope}
      ORDER BY t.id
      `,
    )
    .all(...(opts.workspaceId === undefined ? [] : [opts.workspaceId])) as ClaimRow[]

  const runsByTask = new Map<string, RunRow[]>()
  if (claims.length > 0) {
    const runs = db
      .prepare(
        `
        SELECT task_id, status, started_at, ended_at FROM runs
        WHERE task_id IS NOT NULL
          AND task_id IN (SELECT CAST(id AS TEXT) FROM tasks WHERE claim_state IN ('Claimed', 'Running'))
        `,
      )
      .all() as RunRow[]
    for (const run of runs) {
      const list = runsByTask.get(run.task_id)
      if (list) list.push(run)
      else runsByTask.set(run.task_id, [run])
    }
  }

  return claims.map((row) => {
    const signals: Array<[string, number | null]> = [
      ['task_updated', row.updated_at ? row.updated_at * 1000 : null],
      ['claimed', parseClaimedAtMs(row.claimed_at)],
      ['comment', row.last_comment_at ? row.last_comment_at * 1000 : null],
      ['activity_log', row.last_activity_row_at ? row.last_activity_row_at * 1000 : null],
      ['quality_review', row.last_review_at ? row.last_review_at * 1000 : null],
    ]
    let activeRun = false
    for (const run of runsByTask.get(String(row.id)) ?? []) {
      const started = run.started_at ? Date.parse(run.started_at) : NaN
      const ended = run.ended_at ? Date.parse(run.ended_at) : NaN
      if (Number.isFinite(started)) signals.push(['run', started])
      if (Number.isFinite(ended)) signals.push(['run', ended])
      if (
        ACTIVE_RUN_STATUSES.has(String(run.status)) &&
        !Number.isFinite(ended) &&
        Number.isFinite(started) &&
        nowMs - started < runMaxAgeMs
      ) {
        activeRun = true
      }
    }

    let lastMs = -Infinity
    let lastSource = 'none'
    for (const [source, ms] of signals) {
      if (ms !== null && Number.isFinite(ms) && ms > lastMs) {
        lastMs = ms
        lastSource = source
      }
    }
    // A claim with no readable timestamp at all is never released on a guess.
    const unknown = !Number.isFinite(lastMs)
    const idleMs = unknown ? 0 : Math.max(0, nowMs - lastMs)

    let verdict: LeaseVerdict = 'within_lease'
    if (!unknown && idleMs >= leaseMs) {
      if (activeRun) verdict = 'protected_active_run'
      else if (opts.activeNativeTaskIds?.has(row.id)) verdict = 'protected_native_worker'
      else verdict = 'expired'
    }

    return {
      task_id: row.id,
      workspace_id: row.workspace_id,
      project_id: row.project_id,
      status: row.status,
      claim_state: row.claim_state,
      claimed_by: row.claimed_by,
      claimed_at: row.claimed_at,
      updated_at: row.updated_at,
      last_activity_at: unknown ? '' : isoMs(lastMs),
      last_activity_source: lastSource,
      idle_hours: Math.round((idleMs / HOUR_MS) * 10) / 10,
      lease_hours: opts.leaseHours,
      verdict,
    }
  })
}

export interface ReleaseDeps {
  actor?: string
  nowSec?: number
  broadcast?: TaskEventSink
}

function leaseComment(ev: LeaseEvaluation): string {
  return [
    `Claim lease expired: the claim held by "${ev.claimed_by ?? 'unknown'}" since ${ev.claimed_at ?? 'unknown'} had no task activity for ${ev.idle_hours} h`,
    `(lease ${ev.lease_hours} h; last signal: ${ev.last_activity_source} at ${ev.last_activity_at}).`,
    'No run linked to this task is active. The claim is released to Unclaimed; the retry counter is unchanged.',
    `Re-claim with POST /api/tasks/${ev.task_id}/claim to continue.`,
  ].join(' ')
}

/**
 * Release one expired claim. Compare-and-set on the claim incarnation AND on
 * `updated_at`, so a claim renewed, handed over or touched since the evaluation
 * is left alone. Returns false when nothing changed.
 */
export function releaseExpiredClaim(db: Db, ev: LeaseEvaluation, deps: ReleaseDeps = {}): boolean {
  const actor = deps.actor ?? CLAIM_LEASE_ACTOR
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000)
  const released = db.transaction(() => {
    const changes = db
      .prepare(
        `
        UPDATE tasks
        SET claim_state = 'Unclaimed', claimed_by = NULL, claimed_at = NULL, updated_at = ?
        WHERE id = ? AND workspace_id = ?
          AND claim_state IN ('Claimed', 'Running')
          AND claimed_by IS ? AND claimed_at IS ?
          AND updated_at = ?
        `,
      )
      .run(nowSec, ev.task_id, ev.workspace_id, ev.claimed_by, ev.claimed_at, ev.updated_at).changes
    if (changes !== 1) return false
    db.prepare('INSERT INTO comments (task_id, author, content, created_at, workspace_id) VALUES (?, ?, ?, ?, ?)').run(
      ev.task_id,
      actor,
      leaseComment(ev),
      nowSec,
      ev.workspace_id,
    )
    db.prepare(
      'INSERT INTO activities (type, entity_type, entity_id, actor, description, data, created_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'task_updated',
      'task',
      ev.task_id,
      actor,
      `Claim lease expired: released claim of ${ev.claimed_by ?? 'unknown'}`,
      JSON.stringify({
        prev_claimed_by: ev.claimed_by,
        prev_claimed_at: ev.claimed_at,
        idle_hours: ev.idle_hours,
        lease_hours: ev.lease_hours,
        last_activity_source: ev.last_activity_source,
      }),
      nowSec,
      ev.workspace_id,
    )
    return true
  })()
  if (released) {
    deps.broadcast?.('task.updated', {
      id: ev.task_id,
      claim_state: 'Unclaimed',
      released_by: actor,
      prev_claimed_by: ev.claimed_by,
      reason: `claim lease expired after ${ev.idle_hours} h idle (lease ${ev.lease_hours} h)`,
    })
  }
  return released
}

export interface SweepOptions extends LeaseOptions, ReleaseDeps {
  /** false = report only (the default for every caller that is not the scheduler). */
  apply: boolean
}

export interface SweepResult {
  applied: boolean
  lease_hours: number
  evaluated: number
  within_lease: number
  protected: LeaseEvaluation[]
  expired: LeaseEvaluation[]
  released: number[]
  skipped_changed: number[]
}

export function sweepExpiredClaims(db: Db, opts: SweepOptions): SweepResult {
  const evaluations = evaluateClaimLeases(db, opts)
  const expired = evaluations.filter((e) => e.verdict === 'expired')
  const result: SweepResult = {
    applied: opts.apply,
    lease_hours: opts.leaseHours,
    evaluated: evaluations.length,
    within_lease: evaluations.filter((e) => e.verdict === 'within_lease').length,
    protected: evaluations.filter((e) => e.verdict === 'protected_active_run' || e.verdict === 'protected_native_worker'),
    expired,
    released: [],
    skipped_changed: [],
  }
  if (!opts.apply) return result
  for (const ev of expired) {
    if (releaseExpiredClaim(db, ev, opts)) result.released.push(ev.task_id)
    else result.skipped_changed.push(ev.task_id)
  }
  return result
}

export interface NativeWorkerScan {
  ok: boolean
  ids: Set<number>
  scanned: number
  reason?: string
}

/** Default controller journal: `~/.openclaw/workspace/skills/babysential-backlog-orchestrator/.state/runs`. */
export function defaultJournalRoot(): string {
  return path.join(homedir(), '.openclaw', 'workspace', 'skills', 'babysential-backlog-orchestrator', '.state', 'runs')
}

/**
 * Task ids that still have a non-terminal native worker in the controller
 * journal. Only journals modified within `maxAgeHours` are read (an older file
 * with an unfinished worker is a crashed controller, not a live worker).
 *
 * Fails closed: if the journal directory exists but cannot be read, `ok` is
 * false and the caller must not release anything. A missing directory is fine
 * (no controller on this host) and yields an empty set.
 */
export function readActiveNativeWorkerTaskIds(
  opts: { dir?: string; nowMs?: number; maxAgeHours?: number } = {},
): NativeWorkerScan {
  const dir = opts.dir ?? defaultJournalRoot()
  const nowMs = opts.nowMs ?? Date.now()
  const maxAgeMs = (opts.maxAgeHours ?? DEFAULT_ACTIVE_RUN_MAX_AGE_HOURS) * HOUR_MS
  const ids = new Set<number>()
  if (!existsSync(dir)) return { ok: true, ids, scanned: 0 }

  let names: string[]
  try {
    const rootStat = lstatSync(dir)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('not a plain directory')
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch (error) {
    return { ok: false, ids, scanned: 0, reason: `journal root unreadable: ${(error as Error).message}` }
  }
  if (names.length > MAX_JOURNAL_FILES) {
    return { ok: false, ids, scanned: 0, reason: `${names.length} journal files exceeds the bound of ${MAX_JOURNAL_FILES}` }
  }

  let scanned = 0
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const stat = lstatSync(file)
      if (stat.isSymbolicLink() || !stat.isFile()) continue
      if (nowMs - stat.mtimeMs > maxAgeMs) continue
      if (stat.size > MAX_JOURNAL_BYTES) throw new Error(`${stat.size} bytes exceeds the bound`)
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { workers?: unknown }
      scanned += 1
      if (!Array.isArray(parsed.workers)) continue
      for (const worker of parsed.workers as Array<{ taskId?: unknown; status?: unknown }>) {
        const taskId = typeof worker?.taskId === 'number' ? worker.taskId : Number(worker?.taskId)
        if (!Number.isInteger(taskId)) continue
        if (!TERMINAL_WORKER_STATUSES.has(String(worker.status))) ids.add(taskId)
      }
    } catch (error) {
      return { ok: false, ids, scanned, reason: `journal ${name} unreadable: ${(error as Error).message}` }
    }
  }
  return { ok: true, ids, scanned }
}
