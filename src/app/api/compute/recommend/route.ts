import { NextRequest, NextResponse } from 'next/server'
import { requireComputeAccess, readComputeBody, computeErrorResponse } from '@/lib/compute-access'
import { ComputeInputError, readComputeOverview } from '@/lib/compute-store'
import { computeRecommendationSchema } from '@/lib/compute-validation'
import { recommendCompute } from '@/lib/compute-recommender'
import { getDatabase } from '@/lib/db'
import { readLimiter } from '@/lib/rate-limit'

export async function POST(request: NextRequest) {
  const access = requireComputeAccess(request)
  if (access instanceof NextResponse) return access
  const limited = readLimiter(request)
  if (limited) return limited
  try {
    const parsed = computeRecommendationSchema.safeParse(await readComputeBody(request))
    if (!parsed.success) throw new ComputeInputError('Invalid capacity recommendation request')
    if (parsed.data.projectId && !getDatabase().prepare("SELECT 1 FROM projects WHERE id=? AND workspace_id=? AND status='active'").get(parsed.data.projectId, access.workspaceId)) throw new ComputeInputError('Project not found in this workspace', 404)
    return NextResponse.json(recommendCompute(readComputeOverview(access.workspaceId), parsed.data), { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return computeErrorResponse(error) }
}
