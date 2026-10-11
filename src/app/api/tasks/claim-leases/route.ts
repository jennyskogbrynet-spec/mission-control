import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import {
  clampLeaseHours,
  readActiveNativeWorkerTaskIds,
  readClaimLeaseHours,
  sweepExpiredClaims,
} from '@/lib/claim-lease'

/**
 * GET /api/tasks/claim-leases[?lease_hours=72]
 *
 * Read-only report: every held claim whose lease has expired (no task activity for
 * `lease_hours`, default setting `general.claim_lease_hours` or 72), and the claims
 * that would be expired but are protected by an active run or native worker.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const raw = new URL(request.url).searchParams.get('lease_hours')
    const leaseHours = raw ? clampLeaseHours(raw) : readClaimLeaseHours(db)
    const native = readActiveNativeWorkerTaskIds()
    const result = sweepExpiredClaims(db, { apply: false, workspaceId, leaseHours, activeNativeTaskIds: native.ids })
    return NextResponse.json({ ...result, native_journal: { ok: native.ok, reason: native.reason ?? null } })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/claim-leases error')
    return NextResponse.json({ error: 'Failed to evaluate claim leases' }, { status: 500 })
  }
}

/**
 * POST /api/tasks/claim-leases   Body: { apply?: boolean, lease_hours?: number }
 *
 * Dry run unless `apply` is exactly `true`. Releases expired claims to Unclaimed
 * with a comment; retry_count is unchanged. Refuses to apply (409) while the
 * controller journal cannot be read, because a live native worker could not be
 * ruled out.
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
    const leaseHours = body.lease_hours === undefined ? readClaimLeaseHours(db) : clampLeaseHours(body.lease_hours)
    const native = readActiveNativeWorkerTaskIds()
    if (apply && !native.ok) {
      return NextResponse.json(
        { error: 'Controller journal unreadable; refusing to release claims while a live native worker cannot be ruled out', reason: native.reason },
        { status: 409 },
      )
    }
    const result = sweepExpiredClaims(db, {
      apply,
      workspaceId,
      leaseHours,
      activeNativeTaskIds: native.ids,
      actor: 'claim-lease',
      broadcast: (event, payload) => eventBus.broadcast(event, payload),
    })
    if (apply && result.released.length > 0) {
      logger.warn({ released: result.released, lease_hours: leaseHours, actor: auth.user.username }, 'claim lease sweep released expired claims')
    }
    return NextResponse.json({ ...result, native_journal: { ok: native.ok, reason: native.reason ?? null } })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/claim-leases error')
    return NextResponse.json({ error: 'Failed to sweep claim leases' }, { status: 500 })
  }
}
