import { NextRequest, NextResponse } from 'next/server'
import { requireComputeAccess, readComputeBody, computeErrorResponse } from '@/lib/compute-access'
import { mutateCompute, readComputeOverview } from '@/lib/compute-store'
import { mutationLimiter, readLimiter } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest) {
  const access = requireComputeAccess(request)
  if (access instanceof NextResponse) return access
  const limited = readLimiter(request)
  if (limited) return limited
  try { return NextResponse.json(readComputeOverview(access.workspaceId), { headers: { 'Cache-Control': 'private, no-store' } }) }
  catch (error) { return computeErrorResponse(error) }
}
export async function POST(request: NextRequest) {
  const access = requireComputeAccess(request, 'admin')
  if (access instanceof NextResponse) return access
  const limited = mutationLimiter(request)
  if (limited) return limited
  try {
    const result = mutateCompute(await readComputeBody(request), access.workspaceId)
    return NextResponse.json(result, { status: 'created' in result && result.created ? 201 : 200, headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return computeErrorResponse(error) }
}
