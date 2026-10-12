import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers, logAuditEvent } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { planDispatch } from '@/lib/task-dispatch'
import { readApprovedList, DISPATCH_APPROVED_SETTING } from '@/lib/dispatch-scope'
import { buildApprovedList, validateApprovedOutcomes, writeApprovedList } from '@/lib/dispatch-approval'

/**
 * GET /api/tasks/dispatch-approved
 *
 * The approved list the dispatch brake reads (`general.task_dispatch_approved`):
 * state `fresh` | `missing` | `stale` (older than 36 h) | `invalid`, with its age.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const reading = readApprovedList(getDatabase(), Math.floor(Date.now() / 1000))
    return NextResponse.json({ setting: DISPATCH_APPROVED_SETTING, ...reading })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/dispatch-approved error')
    return NextResponse.json({ error: 'Failed to read approved list' }, { status: 500 })
  }
}

/**
 * POST /api/tasks/dispatch-approved
 *
 * Body: { outcomes: <the morning meeting's approved-outcomes.json list>, date?: "YYYY-MM-DD",
 *         source?: string, apply?: boolean }
 *
 * DRY RUN unless `apply` is exactly `true`. Validates the list against the live board
 * (1-3 outcomes, approved: true, owner = the task's single observed owner, sources and
 * acceptance present) and, on apply, replaces the approved list with a server-stamped
 * `approved_at`. It never starts dispatch: `general.task_dispatch` is not touched.
 * 422 when the list does not validate (nothing is written).
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Body must be a JSON object with "outcomes"' }, { status: 400 })
    const apply = body.apply === true

    const validation = validateApprovedOutcomes(db, body.outcomes, { workspaceId })
    if (!validation.ok) {
      return NextResponse.json({ dry_run: !apply, applied: false, errors: validation.errors, notes: validation.notes }, { status: 422 })
    }

    const now = Math.floor(Date.now() / 1000)
    const list = buildApprovedList(validation.outcomes, {
      now,
      date: typeof body.date === 'string' ? body.date : undefined,
      source: typeof body.source === 'string' ? body.source : undefined,
    })

    if (!apply) {
      return NextResponse.json({ dry_run: true, applied: false, would_write: { key: DISPATCH_APPROVED_SETTING, value: list }, notes: validation.notes })
    }

    const actor = auth.user.username || 'dispatch-approved'
    const previous = db.prepare('SELECT value FROM settings WHERE key = ?').get(DISPATCH_APPROVED_SETTING) as { value: string } | undefined
    writeApprovedList(db, list, actor)
    logAuditEvent({
      action: 'settings_update',
      actor,
      actor_id: auth.user.id,
      detail: { updated_keys: [DISPATCH_APPROVED_SETTING], changes: { [DISPATCH_APPROVED_SETTING]: { old: previous?.value ?? null, new: JSON.stringify(list) } } },
      ip_address: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown',
    })
    db_helpers.logActivity('task_dispatch_approved', 'system', 0, actor,
      `Morning meeting approved ${list.outcomes.length} outcome(s) for dispatch: ${list.outcomes.map(o => o.task_id).join(', ')}`,
      { date: list.date, approved_at: list.approved_at, task_ids: list.outcomes.map(o => o.task_id), owners: list.outcomes.map(o => o.owner) },
      workspaceId)

    return NextResponse.json({ dry_run: false, applied: true, written: { key: DISPATCH_APPROVED_SETTING, value: list }, notes: validation.notes, plan: planDispatch(db) })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/dispatch-approved error')
    return NextResponse.json({ error: 'Failed to write approved list' }, { status: 500 })
  }
}
