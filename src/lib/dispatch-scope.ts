/**
 * The morning-meeting brake for Mission Control's own dispatch (F2).
 *
 * `task_dispatch` (scheduler.ts) runs autoRouteInboxTasks() then dispatchAssignedTasks().
 * Before F2 they took the oldest, highest-priority work in the whole queue. Under
 * `approved_only` they may only touch tasks the CURRENT morning meeting approved:
 *
 * - the approved list is the setting `general.task_dispatch_approved`, written by
 *   POST /api/tasks/dispatch-approved from the meeting's `approved-outcomes.json`
 *   (1-3 outcomes, each with one exact owner). The server stamps `approved_at`.
 * - a task qualifies if it is listed, or if its `metadata.outcome_task_id` is a listed
 *   id (MC has no parent column; one level only).
 * - missing, unparseable or older than 36 h: nothing qualifies. The scheduler moves
 *   nothing and writes one activity line (rate-limited), never falling back to `all`.
 * - at most 3 of those eligible tasks `in_progress` at once (the factory's own work in
 *   flight; other lanes' `in_progress` rows do not count, so they cannot hold the cap).
 * - at most 5 children per approved outcome, lowest ids first.
 *
 * `general.task_dispatch_scope` absent or anything but the exact string `all` means
 * `approved_only`. `general.task_dispatch` (the kill switch) absent means OFF.
 *
 * Everything here reads; nothing writes. Callers decide what to do with the context.
 */
import type Database from 'better-sqlite3'

export const DISPATCH_ENABLED_SETTING = 'general.task_dispatch'
export const DISPATCH_SCOPE_SETTING = 'general.task_dispatch_scope'
export const DISPATCH_APPROVED_SETTING = 'general.task_dispatch_approved'

export const APPROVED_MAX_AGE_HOURS = 36
/** Clock skew we accept on a server-stamped `approved_at` before calling it invalid. */
export const APPROVED_FUTURE_SKEW_SEC = 300
export const APPROVED_MAX_OUTCOMES = 3
export const APPROVED_ONLY_WIP_MAX = 3
/** Children per approved outcome (lowest ids first). Any agent can write `outcome_task_id`, so it is bounded. */
export const OUTCOME_CHILDREN_MAX = 5

export const DISPATCH_HELD_ACTIVITY = 'task_dispatch_held'
/** The same held reason is logged at most once per hour while it persists. */
export const DISPATCH_HELD_LOG_INTERVAL_SEC = 3600

export type DispatchScope = 'all' | 'approved_only'
export type ApprovedState = 'fresh' | 'missing' | 'stale' | 'invalid'
export type DispatchHeldReason = 'approved_list_missing' | 'approved_list_stale' | 'approved_list_invalid'

export interface ApprovedOutcome {
  task_id: number
  owner: string
  outcome: string
}

export interface ApprovedList {
  date: string
  approved_at: number
  source: string
  outcomes: ApprovedOutcome[]
}

export interface ApprovedReading {
  state: ApprovedState
  list: ApprovedList | null
  age_hours: number | null
  /** Why the stored value was rejected (state `invalid`). */
  problem: string | null
}

export interface DispatchScopeContext {
  now: number
  enabled: boolean
  scope: DispatchScope
  /** Raw setting value, so a typo ("al", "approved") is visible in the plan. */
  scope_setting: string | null
  approved: ApprovedReading
  held_reason: DispatchHeldReason | null
  /** Listed task id -> approved owner. Empty under `all`. */
  listed_owners: Map<number, string>
  /** Child task id -> the listed id it names in `metadata.outcome_task_id`. */
  children: Map<number, number>
  /** Children beyond OUTCOME_CHILDREN_MAX for their outcome: never eligible. */
  capped_children: number[]
  /** Ids dispatch may touch. `null` means every task (scope `all`). Empty when held. */
  eligible_ids: Set<number> | null
}

type Db = Database.Database

function readSettingValue(db: Db, key: string): { ok: true; value: string | null } | { ok: false } {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return { ok: true, value: row ? row.value : null }
  } catch {
    return { ok: false }
  }
}

/** Kill switch. Absent row or unreadable settings = OFF (fail closed). */
export function isDispatchEnabled(db: Db): boolean {
  const read = readSettingValue(db, DISPATCH_ENABLED_SETTING)
  return read.ok && read.value === 'true'
}

/** Only the exact string `all` restores the legacy whole-queue behaviour. */
export function readDispatchScope(db: Db): { scope: DispatchScope; setting: string | null } {
  const read = readSettingValue(db, DISPATCH_SCOPE_SETTING)
  const setting = read.ok ? read.value : null
  return { scope: setting === 'all' ? 'all' : 'approved_only', setting }
}

/** Positive integer, or a string of digits only. Anything else (12.5, "12a", true) is not an id. */
export function parseTaskIdStrict(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value.trim())) {
    const n = Number(value.trim())
    return Number.isSafeInteger(n) ? n : null
  }
  return null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Parse the stored setting strictly. A half-valid list is invalid, never partially used. */
export function parseApprovedList(raw: string): { ok: true; list: ApprovedList } | { ok: false; problem: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, problem: 'not JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, problem: 'not an object' }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.date !== 'string' || !DATE_RE.test(obj.date)) return { ok: false, problem: 'date must be YYYY-MM-DD' }
  if (typeof obj.approved_at !== 'number' || !Number.isSafeInteger(obj.approved_at) || obj.approved_at <= 0) {
    return { ok: false, problem: 'approved_at must be unix seconds' }
  }
  if (typeof obj.source !== 'string' || !obj.source.trim()) return { ok: false, problem: 'source is required' }
  if (!Array.isArray(obj.outcomes) || obj.outcomes.length < 1 || obj.outcomes.length > APPROVED_MAX_OUTCOMES) {
    return { ok: false, problem: `outcomes must hold 1-${APPROVED_MAX_OUTCOMES} entries` }
  }
  const seen = new Set<number>()
  const outcomes: ApprovedOutcome[] = []
  for (const entry of obj.outcomes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, problem: 'outcome is not an object' }
    const e = entry as Record<string, unknown>
    const id = parseTaskIdStrict(e.task_id)
    if (id === null) return { ok: false, problem: 'outcome task_id is not a task id' }
    if (seen.has(id)) return { ok: false, problem: `task ${id} is listed twice` }
    seen.add(id)
    if (typeof e.owner !== 'string' || !e.owner.trim()) return { ok: false, problem: `task ${id} has no owner` }
    outcomes.push({ task_id: id, owner: e.owner.trim(), outcome: typeof e.outcome === 'string' ? e.outcome : '' })
  }
  return { ok: true, list: { date: obj.date, approved_at: obj.approved_at, source: obj.source, outcomes } }
}

export function readApprovedList(db: Db, now: number): ApprovedReading {
  const read = readSettingValue(db, DISPATCH_APPROVED_SETTING)
  if (!read.ok) return { state: 'invalid', list: null, age_hours: null, problem: 'settings unreadable' }
  if (read.value === null || read.value.trim() === '') return { state: 'missing', list: null, age_hours: null, problem: null }
  const parsed = parseApprovedList(read.value)
  if (!parsed.ok) return { state: 'invalid', list: null, age_hours: null, problem: parsed.problem }
  const list = parsed.list
  const ageSec = now - list.approved_at
  const ageHours = Math.round((ageSec / 3600) * 10) / 10
  if (ageSec < -APPROVED_FUTURE_SKEW_SEC) return { state: 'invalid', list, age_hours: ageHours, problem: 'approved_at is in the future' }
  if (ageSec > APPROVED_MAX_AGE_HOURS * 3600) return { state: 'stale', list, age_hours: ageHours, problem: null }
  return { state: 'fresh', list, age_hours: ageHours, problem: null }
}

/**
 * Tasks whose metadata names a listed id as `outcome_task_id`, in the same workspace as
 * that listed task, at most OUTCOME_CHILDREN_MAX per outcome (lowest ids). The LIKE is
 * only a prefilter; the value is parsed strictly.
 */
export function findOutcomeChildren(db: Db, listedIds: number[]): { children: Map<number, number>; capped: number[] } {
  const children = new Map<number, number>()
  const capped: number[] = []
  if (listedIds.length === 0) return { children, capped }
  const listed = new Set(listedIds)
  const perParent = new Map<number, number>()
  const parentWorkspace = new Map<number, number>()
  const parents = db.prepare('SELECT id, workspace_id FROM tasks WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(listedIds)) as Array<{ id: number; workspace_id: number }>
  for (const p of parents) parentWorkspace.set(p.id, p.workspace_id)
  const rows = db.prepare("SELECT id, workspace_id, metadata FROM tasks WHERE metadata LIKE '%outcome_task_id%' ORDER BY id ASC")
    .all() as Array<{ id: number; workspace_id: number; metadata: string | null }>
  for (const row of rows) {
    if (listed.has(row.id) || !row.metadata) continue
    let meta: unknown
    try { meta = JSON.parse(row.metadata) } catch { continue }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue
    const parent = parseTaskIdStrict((meta as Record<string, unknown>).outcome_task_id)
    if (parent === null || !listed.has(parent)) continue
    if (parentWorkspace.get(parent) !== row.workspace_id) continue
    perParent.set(parent, (perParent.get(parent) ?? 0) + 1)
    if (perParent.get(parent)! > OUTCOME_CHILDREN_MAX) capped.push(row.id)
    else children.set(row.id, parent)
  }
  return { children, capped }
}

export function resolveDispatchScope(db: Db, now = Math.floor(Date.now() / 1000)): DispatchScopeContext {
  const enabled = isDispatchEnabled(db)
  const { scope, setting } = readDispatchScope(db)
  const approved = readApprovedList(db, now)
  const base = { now, enabled, scope, scope_setting: setting, approved }

  if (scope === 'all') {
    return { ...base, held_reason: null, listed_owners: new Map(), children: new Map(), capped_children: [], eligible_ids: null }
  }

  if (approved.state !== 'fresh' || !approved.list) {
    const held_reason: DispatchHeldReason = approved.state === 'stale' ? 'approved_list_stale'
      : approved.state === 'invalid' ? 'approved_list_invalid'
      : 'approved_list_missing'
    return { ...base, held_reason, listed_owners: new Map(), children: new Map(), capped_children: [], eligible_ids: new Set() }
  }

  const listed_owners = new Map(approved.list.outcomes.map(o => [o.task_id, o.owner] as const))
  const { children, capped } = findOutcomeChildren(db, [...listed_owners.keys()])
  const eligible_ids = new Set<number>([...listed_owners.keys(), ...children.keys()])
  return { ...base, held_reason: null, listed_owners, children, capped_children: capped, eligible_ids }
}

/** `in_progress` rows, optionally only among `ids` (the eligible set). */
export function countInProgress(db: Db, ids?: Set<number> | null): number {
  if (!ids) return (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'in_progress'").get() as { c: number }).c
  if (ids.size === 0) return 0
  return (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'in_progress' AND id IN (SELECT value FROM json_each(?))")
    .get(JSON.stringify([...ids])) as { c: number }).c
}

export function describeHeld(ctx: DispatchScopeContext): string {
  const a = ctx.approved
  if (ctx.held_reason === 'approved_list_stale') {
    return `Dispatch held: the approved list from ${a.list?.date ?? '?'} is ${a.age_hours} h old (max ${APPROVED_MAX_AGE_HOURS} h). Nothing moved.`
  }
  if (ctx.held_reason === 'approved_list_invalid') {
    return `Dispatch held: ${DISPATCH_APPROVED_SETTING} is invalid (${a.problem ?? 'unknown'}). Nothing moved.`
  }
  return `Dispatch held: no approved list from the morning meeting (${DISPATCH_APPROVED_SETTING} is missing). Nothing moved.`
}

/**
 * Whether a held line is due: not when a line with the same reason was written within the
 * interval (reasons flipping A, B, A still write A once an hour). Read-only; the caller
 * writes the line.
 */
export function isHeldActivityDue(db: Db, reason: DispatchHeldReason, now: number): boolean {
  try {
    const recent = db.prepare(`
      SELECT 1 FROM activities
      WHERE type = ? AND created_at > ?
        AND CASE WHEN json_valid(data) THEN json_extract(data, '$.reason') = ? ELSE 0 END
      LIMIT 1`).get(DISPATCH_HELD_ACTIVITY, now - DISPATCH_HELD_LOG_INTERVAL_SEC, reason)
    return !recent
  } catch {
    return true
  }
}
