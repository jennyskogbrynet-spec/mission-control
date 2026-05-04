import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, type Task } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

function formatTicketRow(task: any): Task & { tags: string[]; metadata: Record<string, unknown> } {
  return {
    ...task,
    tags: task.tags ? JSON.parse(task.tags) : [],
    metadata: task.metadata ? JSON.parse(task.metadata) : {},
  }
}

/**
 * POST /api/tasks/[id]/requeue
 *
 * Move a stuck claim back to Unclaimed and bump retry_count. Used by the
 * stall-guard cron when claimed_at is older than the stall threshold,
 * or by an admin / supervisor agent who needs to forcibly free a claim.
 *
 * Body (all optional):
 *   { "reason": "<short string>", "by": "<actor>" }
 *
 * Returns:
 *   200 + { task, prev_claimed_by, retry_count }
 *   404 — task not found
 *   409 — task is not in a claimable state (Claimed/Running)
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
    const taskId = parseInt(resolvedParams.id)
    const workspaceId = auth.user.workspace_id ?? 1

    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 200) : null
    const actor = typeof body?.by === 'string' ? body.by.slice(0, 100) : auth.user.username

    const now = Math.floor(Date.now() / 1000)

    const requeue = db.transaction(() => {
      const before = db
        .prepare(
          `SELECT id, claim_state, claimed_by, retry_count FROM tasks WHERE id = ? AND workspace_id = ?`,
        )
        .get(taskId, workspaceId) as
        | { id: number; claim_state: string; claimed_by: string | null; retry_count: number }
        | undefined
      if (!before) return { kind: 'not-found' as const }
      if (!['Claimed', 'Running'].includes(before.claim_state)) {
        return { kind: 'not-claimed' as const, claim_state: before.claim_state }
      }
      const result = db
        .prepare(
          `
          UPDATE tasks
          SET claim_state = 'Unclaimed',
              claimed_by = NULL,
              claimed_at = NULL,
              retry_count = retry_count + 1,
              updated_at = ?
          WHERE id = ? AND workspace_id = ?
            AND claim_state IN ('Claimed', 'Running')
          `,
        )
        .run(now, taskId, workspaceId)
      if (result.changes === 0) {
        return { kind: 'race' as const, claim_state: before.claim_state }
      }
      return {
        kind: 'ok' as const,
        prev_claimed_by: before.claimed_by,
        retry_count: before.retry_count + 1,
      }
    })

    const result = requeue()

    if (result.kind === 'not-found') {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }
    if (result.kind === 'not-claimed' || result.kind === 'race') {
      return NextResponse.json(
        { error: 'Task is not currently claimed', current_claim_state: result.claim_state },
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

    const parsed = formatTicketRow(updatedTask)
    eventBus.broadcast('task.updated', {
      ...parsed,
      claim_state: 'Unclaimed',
      requeued_by: actor,
      reason,
      retry_count: result.retry_count,
    })

    logger.info(
      {
        taskId,
        prev_claimed_by: result.prev_claimed_by,
        retry_count: result.retry_count,
        actor,
        reason,
      },
      'task requeued',
    )

    return NextResponse.json({
      task: parsed,
      prev_claimed_by: result.prev_claimed_by,
      retry_count: result.retry_count,
      reason,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/[id]/requeue error')
    return NextResponse.json({ error: 'Failed to requeue task' }, { status: 500 })
  }
}
