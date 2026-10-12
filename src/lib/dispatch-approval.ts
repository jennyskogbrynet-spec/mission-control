/**
 * Turn the morning meeting's `approved-outcomes.json` into the setting the dispatch
 * brake reads (`general.task_dispatch_approved`, see dispatch-scope.ts).
 *
 * The file format is the one `ines-commute morning --outcomes` already checks: a JSON
 * list of 1-3 objects `{task_id, owner, approved: true, outcome, sources[], acceptance[]}`.
 * The same rules are applied again here, against the live board at write time, because
 * the meeting's snapshot can be hours old:
 *
 * - every task exists (in the caller's workspace) and is not `done`/`failed`;
 * - `owner` is the task's single observed owner (`assigned_to` / `claimed_by`), exactly
 *   as `ines-commute` requires;
 * - `approved` is literally `true`; `outcome`, `sources` and `acceptance` are non-empty.
 *
 * The server stamps `approved_at`; a caller cannot back- or forward-date an approval.
 * Re-sending the outcomes already stored (same task ids and owners) does NOT restart the
 * 36 h window: a job that replays yesterday's file keeps yesterday's clock. Approving the
 * same outcomes again on a new day takes an explicit `reapprove`.
 * `sources` and `acceptance` stay in the meeting record; the setting keeps what dispatch
 * needs (id, owner, outcome text).
 */
import type Database from 'better-sqlite3'
import {
  APPROVED_MAX_OUTCOMES,
  DISPATCH_APPROVED_SETTING,
  parseTaskIdStrict,
  type ApprovedList,
  type ApprovedOutcome,
} from './dispatch-scope'

const OUTCOME_TEXT_MAX = 500
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface ApprovalValidation {
  ok: boolean
  errors: string[]
  outcomes: ApprovedOutcome[]
  /** Facts that do not block the approval but decide whether MC itself can run the task. */
  notes: Array<{ task_id: number; note: string }>
}

function nonEmptyStrings(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && v.trim() !== '')
}

export function validateApprovedOutcomes(
  db: Database.Database,
  input: unknown,
  opts: { workspaceId?: number } = {},
): ApprovalValidation {
  const errors: string[] = []
  const notes: ApprovalValidation['notes'] = []
  const outcomes: ApprovedOutcome[] = []

  if (!Array.isArray(input) || input.length < 1 || input.length > APPROVED_MAX_OUTCOMES) {
    return { ok: false, errors: [`approved outcomes must be a list of 1-${APPROVED_MAX_OUTCOMES} objects`], outcomes, notes }
  }

  const seen = new Set<number>()
  input.forEach((entry, index) => {
    const at = `outcome ${index + 1}`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at}: not an object`)
      return
    }
    const e = entry as Record<string, unknown>
    const taskId = parseTaskIdStrict(e.task_id)
    if (taskId === null) { errors.push(`${at}: task_id is not a task id`); return }
    if (seen.has(taskId)) { errors.push(`${at}: task ${taskId} is listed twice`); return }
    seen.add(taskId)

    if (e.approved !== true) errors.push(`${at}: approved must be true`)
    if (typeof e.owner !== 'string' || !e.owner.trim()) errors.push(`${at}: owner is required`)
    if (typeof e.outcome !== 'string' || !e.outcome.trim()) errors.push(`${at}: outcome is required`)
    if (!nonEmptyStrings(e.sources)) errors.push(`${at}: sources must be a non-empty list of strings`)
    if (!nonEmptyStrings(e.acceptance)) errors.push(`${at}: acceptance must be a non-empty list of strings`)

    const task = db.prepare(`
      SELECT t.id, t.status, t.assigned_to, t.claimed_by, t.workspace_id, a.name AS agent
      FROM tasks t LEFT JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
      WHERE t.id = ?`).get(taskId) as
      { id: number; status: string; assigned_to: string | null; claimed_by: string | null; workspace_id: number; agent: string | null } | undefined
    if (!task || (opts.workspaceId !== undefined && task.workspace_id !== opts.workspaceId)) {
      errors.push(`${at}: task ${taskId} not found`)
      return
    }
    if (task.status === 'done' || task.status === 'failed') errors.push(`${at}: task ${taskId} is ${task.status}`)

    const owner = typeof e.owner === 'string' ? e.owner.trim() : ''
    const observed = new Set([task.assigned_to, task.claimed_by].filter((v): v is string => typeof v === 'string' && v !== ''))
    if (owner && (observed.size !== 1 || !observed.has(owner))) {
      errors.push(`${at}: owner must be task ${taskId}'s single observed owner (assigned_to/claimed_by: ${[...observed].join(', ') || 'none'})`)
    }

    if (task.status === 'inbox' && task.assigned_to) notes.push({ task_id: taskId, note: 'inbox with an assignee: MC dispatch only takes it once status is assigned' })
    else if (task.status === 'assigned' && !task.agent) notes.push({ task_id: taskId, note: `assignee ${task.assigned_to} is not an MC agent: MC dispatch cannot run it` })
    else if (!['inbox', 'assigned'].includes(task.status)) notes.push({ task_id: taskId, note: `status ${task.status}: MC dispatch does not move it` })

    outcomes.push({ task_id: taskId, owner, outcome: typeof e.outcome === 'string' ? e.outcome.trim().slice(0, OUTCOME_TEXT_MAX) : '' })
  })

  return { ok: errors.length === 0, errors, outcomes, notes }
}

/** Calendar date in Oslo (the meeting's day), YYYY-MM-DD. */
export function osloDate(nowMs = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs))
}

/** Today and yesterday in Oslo: the only dates an approval may carry. */
export function allowedApprovalDates(nowMs = Date.now()): string[] {
  return [osloDate(nowMs), osloDate(nowMs - 24 * 3600 * 1000)]
}

/** Same decision: the same task ids with the same owners (outcome wording may differ). */
export function sameApprovedOutcomes(a: ApprovedOutcome[], b: ApprovedOutcome[]): boolean {
  const key = (list: ApprovedOutcome[]) => list.map(o => `${o.task_id}:${o.owner}`).sort().join('|')
  return key(a) === key(b)
}

export function buildApprovedList(outcomes: ApprovedOutcome[], opts: { now: number; date?: string; source?: string }): ApprovedList {
  const date = opts.date && DATE_RE.test(opts.date) ? opts.date : osloDate(opts.now * 1000)
  return { date, approved_at: opts.now, source: opts.source?.trim() || 'morning-meeting', outcomes }
}

/** Upsert the setting the same way PUT /api/settings does. */
export function writeApprovedList(db: Database.Database, list: ApprovedList, updatedBy: string): void {
  db.prepare(`
    INSERT INTO settings (key, value, description, category, updated_by, updated_at)
    VALUES (?, ?, ?, 'general', ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = unixepoch()
  `).run(DISPATCH_APPROVED_SETTING, JSON.stringify(list), 'Tasks the morning meeting approved for dispatch (written by POST /api/tasks/dispatch-approved)', updatedBy)
}
