import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

const DEFAULT_THRESHOLD_SECS = 300
const MAX_THRESHOLD_SECS = 24 * 60 * 60

/**
 * POST /api/tasks/sweep-stalled
 *
 * Bulk requeue of stuck claims. Anything in claim_state IN ('Claimed','Running')
 * with claimed_at older than the threshold gets bumped back to 'Unclaimed' with
 * retry_count++ in a single transaction. Designed to be called every 5 minutes
 * by an openclaw cron.
 *
 * Query params:
 *   threshold_secs — optional, default 300. Capped at 24h.
 *
 * Returns:
 *   200 + { swept: N, threshold_secs, requeued_ids: number[] }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const url = new URL(request.url)
    const raw = url.searchParams.get('threshold_secs')
    let threshold = raw ? parseInt(raw, 10) : DEFAULT_THRESHOLD_SECS
    if (!Number.isFinite(threshold) || threshold < 0) threshold = DEFAULT_THRESHOLD_SECS
    if (threshold > MAX_THRESHOLD_SECS) threshold = MAX_THRESHOLD_SECS

    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const cutoff = Math.floor(Date.now() / 1000) - threshold
    const now = Math.floor(Date.now() / 1000)

    const sweep = db.transaction(() => {
      const candidates = db
        .prepare(
          `
          SELECT id, claimed_by, retry_count
          FROM tasks
          WHERE workspace_id = ?
            AND claim_state IN ('Claimed', 'Running')
            AND claimed_at IS NOT NULL
            AND claimed_at < ?
          `,
        )
        .all(workspaceId, cutoff) as Array<{
        id: number
        claimed_by: string | null
        retry_count: number
      }>

      if (candidates.length === 0) return { swept: 0, requeued: [] as number[] }

      const ids = candidates.map((c) => c.id)
      const placeholders = ids.map(() => '?').join(',')
      db.prepare(
        `
        UPDATE tasks
        SET claim_state = 'Unclaimed',
            claimed_by = NULL,
            claimed_at = NULL,
            retry_count = retry_count + 1,
            updated_at = ?
        WHERE workspace_id = ?
          AND id IN (${placeholders})
        `,
      ).run(now, workspaceId, ...ids)

      return { swept: candidates.length, requeued: ids, candidates }
    })

    const result = sweep()

    if (result.swept > 0 && 'candidates' in result && result.candidates) {
      for (const c of result.candidates) {
        eventBus.broadcast('task.updated', {
          id: c.id,
          claim_state: 'Unclaimed',
          requeued_by: 'stall-guard',
          prev_claimed_by: c.claimed_by,
          retry_count: c.retry_count + 1,
          reason: `stalled > ${threshold}s`,
        })
      }
      logger.warn(
        { swept: result.swept, threshold_secs: threshold, ids: result.requeued },
        'stall-guard sweep requeued stuck claims',
      )
    }

    return NextResponse.json({
      swept: result.swept,
      threshold_secs: threshold,
      requeued_ids: result.requeued,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/sweep-stalled error')
    return NextResponse.json({ error: 'Failed to sweep stalled claims' }, { status: 500 })
  }
}
