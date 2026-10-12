import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { planDispatch } from '@/lib/task-dispatch'

/**
 * GET /api/tasks/dispatch-plan
 *
 * Read-only. What the next `task_dispatch` tick would route (inbox -> assigned) and
 * dispatch (assigned -> in_progress) under the current `general.task_dispatch_scope`,
 * approved list and WIP cap, without moving anything or writing an activity line.
 * With the kill switch off, `next_tick.runs` is false and `route`/`dispatch` show what
 * would be taken once it is switched on.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    return NextResponse.json({ plan: planDispatch(getDatabase()) })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/dispatch-plan error')
    return NextResponse.json({ error: 'Failed to compute dispatch plan' }, { status: 500 })
  }
}
