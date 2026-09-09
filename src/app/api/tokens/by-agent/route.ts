import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { loadTokenData } from '@/lib/token-data'
import { buildAgentCostBreakdown } from '@/lib/token-ledger'
import { logger } from '@/lib/logger'

/** Identical ledger/source selection to the cost overview, including unattributed usage. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const params = request.nextUrl.searchParams
  const requestedDays = Number(params.get('days') || '30')
  if (!Number.isFinite(requestedDays) || requestedDays <= 0) return NextResponse.json({ error: 'Invalid days' }, { status: 400 })
  const days = Math.min(365, requestedDays)
  const timeframe = params.get('timeframe') || 'all'
  try {
    const now = Date.now()
    const ledger = await loadTokenData(auth.user.workspace_id ?? 1, timeframe, now, params.has('timeframe') ? undefined : now - days * 86400000)
    const records = ledger.records
    return NextResponse.json({ ...buildAgentCostBreakdown(records, ({ hour: 1 / 24, day: 1, week: 7, month: 30 } as Record<string, number>)[timeframe] || days), sourceCoverage: ledger.coverage, asOf: ledger.asOf, timeframe })
  } catch {
    logger.warn('Agent cost report unavailable')
    return NextResponse.json({ error: 'Agent cost report unavailable' }, { status: 500 })
  }
}
