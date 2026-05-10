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
 * POST /api/tasks/[id]/claim
 *
 * Atomic claim of an Unclaimed ticket via BEGIN IMMEDIATE transaction.
 * Sets claim_state='Claimed', claimed_by=<agent>, claimed_at=UTC ISO timestamp.
 *
 * Body: { "agent": "<agent_id>" }   — required
 *
 * Returns:
 *   200 + { task, claimed_by }  — claim succeeded
 *   400                          — missing/invalid agent
 *   404                          — task not found
 *   409 + { current_claim_state, claimed_by } — already claimed
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
    const claimedAt = new Date().toISOString()

    // Atomic claim: only Unclaimed tasks transition. better-sqlite3 transactions
    // are IMMEDIATE by default for write statements, preventing dual-claim races.
    const claim = db.transaction(() => {
      return db
        .prepare(
          `
          UPDATE tasks
          SET claim_state = 'Claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND claim_state = 'Unclaimed'
          `,
        )
        .run(agent, claimedAt, now, taskId, workspaceId).changes
    })

    const changedRows = claim()

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
      return NextResponse.json(
        {
          error: 'Task already claimed',
          current_claim_state: existing.claim_state,
          claimed_by: existing.claimed_by,
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
    eventBus.broadcast('task.updated', { ...parsed, claim_state: 'Claimed', claimed_by: agent })

    return NextResponse.json({ task: parsed, claimed_by: agent })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/[id]/claim error')
    return NextResponse.json({ error: 'Failed to claim task' }, { status: 500 })
  }
}
