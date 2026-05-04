import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, type Task } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

function formatTicketRef(prefix?: string | null, num?: number | null): string | undefined {
  if (!prefix || typeof num !== 'number' || !Number.isFinite(num) || num <= 0) return undefined
  return `${prefix}-${String(num).padStart(3, '0')}`
}

function mapTaskRow(task: any): Task & { tags: string[]; metadata: Record<string, unknown> } {
  return {
    ...task,
    tags: task.tags ? JSON.parse(task.tags) : [],
    metadata: task.metadata ? JSON.parse(task.metadata) : {},
    ticket_ref: formatTicketRef(task.project_prefix, task.project_ticket_no),
  }
}

/**
 * POST /api/tasks/[id]/release
 *
 * Clean release of a claimed ticket. Sets claim_state='Released',
 * clears claimed_by + claimed_at. Caller must be the current claimer (or admin)
 * to prevent stealing.
 *
 * Body: { "agent": "<agent_id>" }   — required, must match current claimer
 *
 * Returns:
 *   200 + task                   — released
 *   400                          — missing/invalid agent
 *   403                          — agent does not own this claim
 *   404                          — task not found
 *   409 + { current_claim_state } — task is not in a claimable state
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
    const agent = typeof body?.agent === 'string' ? body.agent.trim() : ''
    if (!agent) {
      return NextResponse.json({ error: 'Missing required field: agent' }, { status: 400 })
    }

    const now = Math.floor(Date.now() / 1000)
    const isAdmin = auth.user.role === 'admin'

    const release = db.transaction(() => {
      return db
        .prepare(
          `
          UPDATE tasks
          SET claim_state = 'Released', claimed_by = NULL, claimed_at = NULL, updated_at = ?
          WHERE id = ? AND workspace_id = ?
            AND claim_state IN ('Claimed', 'Running')
            ${isAdmin ? '' : 'AND claimed_by = ?'}
          `,
        )
        .run(...(isAdmin ? [now, taskId, workspaceId] : [now, taskId, workspaceId, agent])).changes
    })

    const changedRows = release()

    if (changedRows === 0) {
      const existing = db
        .prepare(
          `SELECT id, claim_state, claimed_by FROM tasks WHERE id = ? AND workspace_id = ?`,
        )
        .get(taskId, workspaceId) as
        | { id: number; claim_state: string; claimed_by: string | null }
        | undefined
      if (!existing) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 })
      }
      if (!['Claimed', 'Running'].includes(existing.claim_state)) {
        return NextResponse.json(
          { error: 'Task is not currently claimed', current_claim_state: existing.claim_state },
          { status: 409 },
        )
      }
      return NextResponse.json(
        {
          error: 'Agent does not own this claim',
          claimed_by: existing.claimed_by,
        },
        { status: 403 },
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
    eventBus.broadcast('task.updated', { ...parsed, claim_state: 'Released', released_by: agent })

    return NextResponse.json({ task: parsed, released_by: agent })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/[id]/release error')
    return NextResponse.json({ error: 'Failed to release task' }, { status: 500 })
  }
}
