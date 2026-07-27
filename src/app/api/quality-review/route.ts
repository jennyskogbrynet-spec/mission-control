import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { validateBody, qualityReviewSchema } from '@/lib/validation'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { eventBus } from '@/lib/event-bus'
import { isActiveClaim } from '@/lib/claim-time'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const { searchParams } = new URL(request.url)
    const workspaceId = auth.user.workspace_id ?? 1;
    const taskIdsParam = searchParams.get('taskIds')
    const taskId = parseInt(searchParams.get('taskId') || '')

    if (taskIdsParam) {
      const ids = taskIdsParam
        .split(',')
        .map((id) => parseInt(id.trim()))
        .filter((id) => !Number.isNaN(id))

      if (ids.length === 0) {
        return NextResponse.json({ error: 'taskIds must include at least one numeric id' }, { status: 400 })
      }

      const placeholders = ids.map(() => '?').join(',')
      const rows = db.prepare(`
        SELECT * FROM quality_reviews
        WHERE task_id IN (${placeholders}) AND workspace_id = ?
        ORDER BY task_id ASC, created_at DESC
      `).all(...ids, workspaceId) as Array<{ task_id: number; reviewer?: string; status?: string; created_at?: number }>

      const byTask: Record<number, { status?: string; reviewer?: string; created_at?: number } | null> = {}
      for (const id of ids) {
        byTask[id] = null
      }

      for (const row of rows) {
        const existing = byTask[row.task_id]
        if (!existing || (row.created_at || 0) > (existing.created_at || 0)) {
          byTask[row.task_id] = { status: row.status, reviewer: row.reviewer, created_at: row.created_at }
        }
      }

      return NextResponse.json({ latest: byTask })
    }

    if (isNaN(taskId)) {
      return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
    }

    const reviews = db.prepare(`
      SELECT * FROM quality_reviews
      WHERE task_id = ? AND workspace_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(taskId, workspaceId)

    return NextResponse.json({ reviews })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/quality-review error')
    return NextResponse.json({ error: 'Failed to fetch quality reviews' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const validated = await validateBody(request, qualityReviewSchema)
    if ('error' in validated) return validated.error
    const { taskId, reviewer, status, notes, expected_updated_at } = validated.data

    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1;

    const task = db
      .prepare('SELECT id, title, assigned_to, claimed_by, updated_at, retry_count, tags, claim_state, claimed_at FROM tasks WHERE id = ? AND workspace_id = ?')
      .get(taskId, workspaceId) as
        | {
            id: number
            title: string
            assigned_to: string | null
            claimed_by: string | null
            updated_at: number | null
            retry_count: number | null
            tags: string | null
            claim_state: string | null
            claimed_at: string | number | null
          }
        | undefined
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    // Separation of duties: the agent that did (or claimed) the work cannot
    // approve/reject it. Checked against both the reviewer field and the
    // authenticated agent identity so a caller cannot bypass it by relabeling.
    const workingParties = [task.assigned_to, task.claimed_by]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim().toLowerCase())
    const reviewerIdentities = [reviewer, auth.user.agent_name ?? '']
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0)
    if (status !== 'in_progress' && reviewerIdentities.some((r) => workingParties.includes(r))) {
      return NextResponse.json(
        {
          error: 'separation_of_duties',
          detail: `Reviewer "${reviewer}" matches the task's working agent (assigned_to/claimed_by). A different agent must review.`,
        },
        { status: 403 },
      )
    }

    // Revision binding: reject reviews of a task state the reviewer has not seen.
    if (expected_updated_at !== undefined && task.updated_at !== expected_updated_at) {
      return NextResponse.json(
        {
          error: 'stale_review',
          detail: 'Task changed since the reviewed revision. Re-fetch and re-review.',
          current_updated_at: task.updated_at,
        },
        { status: 409 },
      )
    }

    if (status === 'in_progress') {
      return NextResponse.json({ success: true, wait: true, reason: 'in_progress' })
    }

    if (status === 'rejected') {
      const { active, claimAgeMs } = isActiveClaim(task.claim_state, task.claimed_at)
      if (active) {
        return NextResponse.json({
          success: true,
          deferred: true,
          reason: 'agent_active',
          claim_age_ms: claimAgeMs,
        })
      }
    }

    const result = db.prepare(`
      INSERT INTO quality_reviews (task_id, reviewer, status, notes, workspace_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, reviewer, status, notes, workspaceId)

    db_helpers.logActivity(
      'quality_review',
      'task',
      taskId,
      reviewer,
      `Quality review ${status} for task: ${task.title}`,
      { status, notes },
      workspaceId
    )

    // Auto-advance task based on review outcome
    if (status === 'approved') {
      // Set completed_at on the done-transition, mirroring the direct PUT path
      // (PUT /api/tasks/[id] sets completed_at when a task first reaches 'done').
      // COALESCE keeps any existing timestamp so re-approvals stay idempotent.
      // Terminal transition must also release an active claim atomically.
      db.prepare(`
        UPDATE tasks SET
          status = ?,
          completed_at = COALESCE(completed_at, unixepoch()),
          updated_at = unixepoch(),
          claim_state = CASE WHEN claim_state IN ('Claimed', 'Running') THEN 'Released' ELSE claim_state END,
          claimed_by = CASE WHEN claim_state IN ('Claimed', 'Running') THEN NULL ELSE claimed_by END,
          claimed_at = CASE WHEN claim_state IN ('Claimed', 'Running') THEN NULL ELSE claimed_at END
        WHERE id = ? AND workspace_id = ?
      `).run('done', taskId, workspaceId)
      eventBus.broadcast('task.status_changed', {
        id: taskId,
        status: 'done',
        previous_status: 'review',
        updated_at: Math.floor(Date.now() / 1000),
      })
    } else if (status === 'rejected') {
      // Rejected: push back to in_progress with the rejection notes as error_message
      db.prepare('UPDATE tasks SET status = ?, error_message = ?, updated_at = unixepoch() WHERE id = ? AND workspace_id = ?')
        .run('in_progress', `Quality review rejected by ${reviewer}: ${notes}`, taskId, workspaceId)
      eventBus.broadcast('task.status_changed', {
        id: taskId,
        status: 'in_progress',
        previous_status: 'review',
        updated_at: Math.floor(Date.now() / 1000),
      })
    }

    return NextResponse.json({ success: true, id: result.lastInsertRowid })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/quality-review error')
    return NextResponse.json({ error: 'Failed to create quality review' }, { status: 500 })
  }
}
