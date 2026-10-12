import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { agentTaskLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { APPROVED_ONLY_WIP_MAX, DISPATCH_ENABLED_SETTING, factoryInProgress, resolveDispatchScope } from '@/lib/dispatch-scope'

type QueueReason = 'continue_current' | 'assigned' | 'at_capacity' | 'no_tasks_available' | 'dispatch_held'

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function mapTaskRow(task: any) {
  return {
    ...task,
    tags: safeParseJson(task.tags, [] as string[]),
    metadata: safeParseJson(task.metadata, {} as Record<string, unknown>),
  }
}

function priorityRankSql() {
  return `
    CASE priority
      WHEN 'critical' THEN 0
      WHEN 'high' THEN 1
      WHEN 'medium' THEN 2
      WHEN 'low' THEN 3
      ELSE 4
    END
  `
}

/**
 * GET /api/tasks/queue - Poll next task for an agent.
 *
 * Query params:
 * - agent: required agent name (or use x-agent-name header)
 * - max_capacity: optional integer 1..20 (default 1)
 *
 * A new claim here is dispatch by pull, so it obeys the same brake as the scheduler
 * (F2, src/lib/dispatch-scope.ts): nothing new while `general.task_dispatch` is not
 * "true" or the approved list is held; under `approved_only` only approved tasks and
 * their `outcome_task_id` children, a listed task only for its approved owner, and at
 * most 3 of them in progress. `continue_current` is unaffected: it moves nothing.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateLimited = agentTaskLimiter(request)
  if (rateLimited) return rateLimited

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id
    const { searchParams } = new URL(request.url)

    const agent =
      (searchParams.get('agent') || '').trim() ||
      (request.headers.get('x-agent-name') || '').trim()

    if (!agent) {
      return NextResponse.json({ error: 'Missing agent. Provide ?agent=... or x-agent-name header.' }, { status: 400 })
    }

    const maxCapacityRaw = searchParams.get('max_capacity') || '1'
    if (!/^\d+$/.test(maxCapacityRaw)) {
      return NextResponse.json({ error: 'Invalid max_capacity. Expected integer 1..20.' }, { status: 400 })
    }
    const maxCapacity = Number(maxCapacityRaw)
    if (!Number.isInteger(maxCapacity) || maxCapacity < 1 || maxCapacity > 20) {
      return NextResponse.json({ error: 'Invalid max_capacity. Expected integer 1..20.' }, { status: 400 })
    }

    const now = Math.floor(Date.now() / 1000)

    const currentTask = db.prepare(`
      SELECT *
      FROM tasks
      WHERE workspace_id = ? AND assigned_to = ? AND status = 'in_progress'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(workspaceId, agent) as any | undefined

    if (currentTask) {
      return NextResponse.json({
        task: mapTaskRow(currentTask),
        reason: 'continue_current' as QueueReason,
        agent,
        timestamp: now,
      })
    }

    const inProgressCount = (db.prepare(`
      SELECT COUNT(*) as c
      FROM tasks
      WHERE workspace_id = ? AND assigned_to = ? AND status = 'in_progress'
    `).get(workspaceId, agent) as { c: number }).c

    if (inProgressCount >= maxCapacity) {
      return NextResponse.json({
        task: null,
        reason: 'at_capacity' as QueueReason,
        agent,
        timestamp: now,
      })
    }

    const scope = resolveDispatchScope(db, now)
    if (!scope.enabled || scope.held_reason) {
      return NextResponse.json({
        task: null,
        reason: 'dispatch_held' as QueueReason,
        held: !scope.enabled ? `${DISPATCH_ENABLED_SETTING} is not "true"` : scope.held_reason,
        agent,
        timestamp: now,
      })
    }
    let scopeFilter = ''
    const scopeArgs: string[] = []
    if (scope.eligible_ids !== null) {
      if (factoryInProgress(db, scope.eligible_ids).length >= APPROVED_ONLY_WIP_MAX) {
        return NextResponse.json({ task: null, reason: 'at_capacity' as QueueReason, held: `WIP cap ${APPROVED_ONLY_WIP_MAX} reached`, agent, timestamp: now })
      }
      const notForThisAgent = [...scope.listed_owners].filter(([, owner]) => owner !== agent).map(([id]) => id)
      scopeFilter = 'AND id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?))'
      scopeArgs.push(JSON.stringify([...scope.eligible_ids]), JSON.stringify(notForThisAgent))
    }

    // Atomic claim: single UPDATE with subquery to eliminate SELECT-UPDATE race condition.
    const claimed = db.prepare(`
      UPDATE tasks
      SET status = 'in_progress', assigned_to = ?, updated_at = ?
      WHERE id = (
        SELECT id FROM tasks
        WHERE workspace_id = ?
          AND status IN ('assigned', 'inbox')
          AND (assigned_to IS NULL OR assigned_to = ?)
          ${scopeFilter}
        ORDER BY ${priorityRankSql()} ASC, due_date ASC NULLS LAST, created_at ASC
        LIMIT 1
      )
      RETURNING *
    `).get(agent, now, workspaceId, agent, ...scopeArgs) as any | undefined

    if (claimed) {
      return NextResponse.json({
        task: mapTaskRow(claimed),
        reason: 'assigned' as QueueReason,
        agent,
        timestamp: now,
      })
    }

    return NextResponse.json({
      task: null,
      reason: 'no_tasks_available' as QueueReason,
      agent,
      timestamp: now,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/queue error')
    return NextResponse.json({ error: 'Failed to poll task queue' }, { status: 500 })
  }
}
