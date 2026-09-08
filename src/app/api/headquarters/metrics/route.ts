import { NextResponse } from 'next/server'
import { requireHQAccess } from '@/lib/hq-access'
import { getHQMetrics, isHQMetricProject } from '@/lib/hq-metrics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const access = requireHQAccess(request)
  if (access instanceof NextResponse) return access
  const project = new URL(request.url).searchParams.get('project')
  if (project !== null && !isHQMetricProject(project)) {
    return NextResponse.json({ error: 'Ukjent prosjekt.' }, { status: 400 })
  }
  const result = await getHQMetrics(project || undefined)
  return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
}
