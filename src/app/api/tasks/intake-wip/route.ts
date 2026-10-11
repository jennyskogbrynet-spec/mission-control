import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { applyDeferredPromotion, intakeReport, planDeferredPromotion, resolveWipRules } from '@/lib/intake-wip'

/**
 * GET /api/tasks/intake-wip
 *
 * Read-only: the effective caps (defaults < env MC_INTAKE_WIP_CAPS < setting
 * `intake.wip_caps`) and, per project and source, how many tasks are open, how
 * many are deferred, and whether the source is at or over its cap.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const rules = resolveWipRules(db)
    return NextResponse.json({ rules, rows: intakeReport(db, workspaceId, rules) })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/intake-wip error')
    return NextResponse.json({ error: 'Failed to read intake counts' }, { status: 500 })
  }
}

/**
 * POST /api/tasks/intake-wip   Body: { apply?: boolean, project_id?: number, limit?: number }
 *
 * Dry run unless `apply` is exactly `true`. Promotes the OLDEST deferred tasks
 * (backlog + metadata.wip_deferred) back to the status they were filed with, as
 * many as fit under each source's cap.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const apply = body.apply === true
    const projectId = Number.isInteger(body.project_id) ? (body.project_id as number) : undefined
    const limit = Number.isInteger(body.limit) && (body.limit as number) > 0 ? Math.min(body.limit as number, 200) : 50
    const plan = planDeferredPromotion(db, { workspaceId, projectId, limit })
    const result = apply
      ? applyDeferredPromotion(db, workspaceId, plan.items, { actor: auth.user.username || 'intake-wip', broadcast: (event, payload) => eventBus.broadcast(event, payload) })
      : null
    return NextResponse.json({ dry_run: !apply, plan, result })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/intake-wip error')
    return NextResponse.json({ error: 'Failed to promote deferred tasks' }, { status: 500 })
  }
}
