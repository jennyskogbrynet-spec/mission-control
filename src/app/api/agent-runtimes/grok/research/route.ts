import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { cancelGrokResearch, getGrokResearchRun, listGrokResearchRuns, startGrokResearch } from '@/lib/grok-research'
import { scanForSecrets } from '@/lib/secret-scanner'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const workspaceId = auth.user.workspace_id
  if (workspaceId !== 1 || auth.user.tenant_id !== 1) return NextResponse.json({ error: 'Local research is available in the primary workspace only' }, { status: 403 })
  const id = request.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ runs: listGrokResearchRuns(workspaceId) })
  const run = getGrokResearchRun(id, workspaceId)
  return run ? NextResponse.json({ run }) : NextResponse.json({ error: 'Run not found' }, { status: 404 })
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (auth.user.workspace_id !== 1 || auth.user.tenant_id !== 1) return NextResponse.json({ error: 'Local research is available in the primary workspace only' }, { status: 403 })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const body = await request.json().catch(() => null)
  if (typeof body?.prompt !== 'string' || typeof body?.idempotencyKey !== 'string') {
    return NextResponse.json({ error: 'prompt and idempotencyKey are required' }, { status: 400 })
  }
  if (scanForSecrets(body.prompt).length) return NextResponse.json({ error: 'Remove credentials from the research prompt' }, { status: 422 })
  try {
    const run = startGrokResearch(body.prompt, 1, body.idempotencyKey)
    return NextResponse.json({ run }, { status: run.status === 'running' ? 202 : 200 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not start research' }, { status: 409 })
  }
}

export const dynamic = 'force-dynamic'

export async function DELETE(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (auth.user.workspace_id !== 1 || auth.user.tenant_id !== 1) return NextResponse.json({ error: 'Local research is available in the primary workspace only' }, { status: 403 })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const id = request.nextUrl.searchParams.get('id') || ''
  const stopped = cancelGrokResearch(id, auth.user.workspace_id)
  return stopped ? NextResponse.json({ status: 'stopping' }, { status: 202 })
    : NextResponse.json({ error: 'No running research process owned by this workspace' }, { status: 409 })
}
