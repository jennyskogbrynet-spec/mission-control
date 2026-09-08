import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, type Task } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { reconcileNativeTerminalEvidence } from '@/lib/task-review-resume'

/** Only an unfinished review may be resumed; done/failed and friends never qualify. */
const RESUMABLE_STATUSES = ['review', 'quality_review']

function formatTicketRef(prefix?: string | null, num?: number | null): string | undefined {
  if (!prefix || typeof num !== 'number' || !Number.isFinite(num) || num <= 0) return undefined
  return `${prefix}-${String(num).padStart(3, '0')}`
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

function mapTaskRow(task: any): Task & { tags: string[]; metadata: Record<string, unknown> } {
  return {
    ...task,
    tags: parseTags(task.tags),
    metadata: task.metadata ? JSON.parse(task.metadata) : {},
    ticket_ref: formatTicketRef(task.project_prefix, task.project_ticket_no),
  }
}

interface TaskRow {
  id: number
  status: string
  claim_state: string
  claimed_by: string | null
  claimed_at: string | null
  updated_at: number
  project_id: number | null
  metadata: string | null
}

/**
 * POST /api/tasks/[id]/resume-review
 *
 * Operator-authorized recovery of a review ticket that was Released while its
 * review was still unfinished. Released is not claimable and requeue only
 * accepts Claimed/Running, so such a ticket has no supported way back into the
 * queue. This route moves it Released -> Unclaimed once, and only after the
 * server itself reconciles that every native worker recorded for the task
 * ended with a real terminal receipt.
 *
 * Claim, release and requeue semantics are untouched; the review status,
 * history, metadata and prior receipts are preserved.
 *
 * Body: { "reason": "<nonempty>", "expected_updated_at": <integer> }
 *
 * Returns:
 *   200 + { task, resumed_by, reason, evidence }
 *   400 — invalid id, missing reason or non-integer expected_updated_at
 *   404 — task not found in this workspace
 *   409 — wrong status/claim state, live or unknown owner, stale revision,
 *         concurrent duplicate, or unproven worker evidence (no mutation)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const resolvedParams = await params
    const taskId = Number(resolvedParams.id)
    const workspaceId = auth.user.workspace_id ?? 1

    if (!/^[1-9]\d*$/.test(resolvedParams.id) || !Number.isSafeInteger(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
    if (!reason) {
      return NextResponse.json({ error: 'Missing required field: reason' }, { status: 400 })
    }
    const expectedUpdatedAt = body?.expected_updated_at
    if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) {
      return NextResponse.json(
        { error: 'Missing or invalid required field: expected_updated_at (integer)' },
        { status: 400 },
      )
    }

    const actor = auth.user.username

    const existing = db
      .prepare(
        `SELECT id, status, claim_state, claimed_by, claimed_at, updated_at, project_id, metadata
         FROM tasks WHERE id = ? AND workspace_id = ?`,
      )
      .get(taskId, workspaceId) as TaskRow | undefined

    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }
    if (!RESUMABLE_STATUSES.includes(existing.status)) {
      return NextResponse.json(
        { error: 'Only an unfinished review can be resumed', current_status: existing.status },
        { status: 409 },
      )
    }
    if (existing.claim_state !== 'Released') {
      return NextResponse.json(
        { error: 'Only a Released review can be resumed', current_claim_state: existing.claim_state },
        { status: 409 },
      )
    }
    if (existing.claimed_by !== null || existing.claimed_at !== null) {
      return NextResponse.json(
        { error: 'Task still records an owner; resolve the claim first' },
        { status: 409 },
      )
    }
    if (existing.updated_at !== expectedUpdatedAt) {
      return NextResponse.json(
        {
          error: 'Stale revision',
          expected_updated_at: expectedUpdatedAt,
          current_updated_at: existing.updated_at,
        },
        { status: 409 },
      )
    }

    // The caller never asserts its workers stopped — the server reconciles the
    // canonical controller journal and the native terminal receipts itself.
    const evidence = reconcileNativeTerminalEvidence({
      taskId,
      projectId: existing.project_id ?? null,
      workspaceId,
    })
    if (!evidence.ok) {
      logger.warn(
        { taskId, workspaceId, actor, code: evidence.code, detail: evidence.detail },
        'resume-review evidence rejected',
      )
      // Public errors carry the reason code only, never local filesystem paths.
      return NextResponse.json(
        { error: evidence.message, evidence_code: evidence.code },
        { status: 409 },
      )
    }

    const now = Math.floor(Date.now() / 1000)

    const resume = db.transaction((): { kind: 'ok' | 'race' | 'bad-metadata' } => {
      // Re-assert the full precondition inside the write so a concurrent
      // duplicate finds nothing to change.
      const row = db
        .prepare(
          `SELECT metadata FROM tasks
           WHERE id = ? AND workspace_id = ? AND claim_state = 'Released'
             AND status IN ('review', 'quality_review')
             AND claimed_by IS NULL AND claimed_at IS NULL AND updated_at = ?`,
        )
        .get(taskId, workspaceId, expectedUpdatedAt) as { metadata: string | null } | undefined
      if (!row) return { kind: 'race' }

      let metadata: Record<string, unknown>
      try {
        metadata = row.metadata ? JSON.parse(row.metadata) : {}
      } catch {
        return { kind: 'bad-metadata' }
      }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return { kind: 'bad-metadata' }
      }

      // Append-only audit: existing keys, prior receipts and earlier resume
      // entries are preserved exactly as they were.
      if (metadata.review_resumes !== undefined && !Array.isArray(metadata.review_resumes)) {
        return { kind: 'bad-metadata' }
      }
      const history = Array.isArray(metadata.review_resumes) ? metadata.review_resumes : []
      const auditEntry = {
        at: new Date().toISOString(),
        actor,
        reason,
        from: { claim_state: 'Released', status: existing.status },
        to: { claim_state: 'Unclaimed', status: existing.status },
        expected_updated_at: expectedUpdatedAt,
        evidence: {
          journal_count: evidence.journal_count,
          workers: evidence.workers,
          receipt_refs: evidence.receipt_refs,
        },
      }
      const nextMetadata = { ...metadata, review_resumes: [...history, auditEntry] }

      const result = db
        .prepare(
          `UPDATE tasks
           SET claim_state = 'Unclaimed',
               metadata = ?,
               updated_at = MAX(?, updated_at + 1)
           WHERE id = ? AND workspace_id = ? AND claim_state = 'Released'
             AND status IN ('review', 'quality_review')
             AND claimed_by IS NULL AND claimed_at IS NULL AND updated_at = ?`,
        )
        .run(JSON.stringify(nextMetadata), now, taskId, workspaceId, expectedUpdatedAt)
      if (result.changes === 0) return { kind: 'race' }

      db.prepare(
        `INSERT INTO activities (type, entity_type, entity_id, actor, description, data, workspace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'task_review_resumed',
        'task',
        taskId,
        actor,
        `Review resumed to Unclaimed: ${reason}`,
        JSON.stringify(auditEntry),
        workspaceId,
      )

      return { kind: 'ok' }
    })

    const result = resume()

    if (result.kind === 'bad-metadata') {
      return NextResponse.json(
        { error: 'Task metadata is unreadable; repair it before resuming the review' },
        { status: 409 },
      )
    }
    if (result.kind === 'race') {
      const current = db
        .prepare(`SELECT claim_state, updated_at FROM tasks WHERE id = ? AND workspace_id = ?`)
        .get(taskId, workspaceId) as { claim_state: string; updated_at: number } | undefined
      return NextResponse.json(
        {
          error: 'Task changed before the resume could be applied',
          current_claim_state: current?.claim_state ?? null,
          current_updated_at: current?.updated_at ?? null,
        },
        { status: 409 },
      )
    }

    const updatedTask = db
      .prepare(
        `
        SELECT t.*, p.name as project_name, p.ticket_prefix as project_prefix
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
        WHERE t.id = ? AND t.workspace_id = ?
        `,
      )
      .get(taskId, workspaceId) as Task

    const parsed = mapTaskRow(updatedTask)

    logger.info(
      { taskId, workspaceId, actor, reason, workers: evidence.workers.length },
      'task review resumed',
    )

    // A broadcast failure must not undo a committed transition.
    try {
      eventBus.broadcast('task.updated', {
        ...parsed,
        claim_state: 'Unclaimed',
        resumed_by: actor,
        reason,
      })
    } catch (error) {
      logger.warn({ err: error, taskId }, 'resume-review broadcast failed')
    }

    return NextResponse.json({
      task: parsed,
      resumed_by: actor,
      reason,
      evidence: { journal_count: evidence.journal_count, workers: evidence.workers },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/[id]/resume-review error')
    return NextResponse.json({ error: 'Failed to resume review' }, { status: 500 })
  }
}
