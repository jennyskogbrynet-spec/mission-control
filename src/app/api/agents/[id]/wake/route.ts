import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { getAgentCommandSession, sendAgentCommand } from '@/lib/agent-delivery'
import { mutationLimiter } from '@/lib/rate-limit'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const resolvedParams = await params
    const agentId = resolvedParams.id
    const workspaceId = auth.user.workspace_id ?? 1;
    const body = await request.json().catch(() => ({}))
    const customMessage =
      typeof body?.message === 'string' ? body.message.trim() : ''

    const db = getDatabase()
    const agent: any = isNaN(Number(agentId))
      ? db.prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = ?').get(agentId, workspaceId)
      : db.prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?').get(Number(agentId), workspaceId)

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const sessionKey = getAgentCommandSession(agent, workspaceId)
    if (!sessionKey) {
      return NextResponse.json(
        { error: 'Agent has no OpenClaw identity or command session configured' },
        { status: 400 }
      )
    }

    const message =
      customMessage ||
      `Wake up check-in for ${agent.name}. Please review assigned tasks and notifications.`

    if (message.length > 6000) return NextResponse.json({ error: 'Message must be at most 6000 characters' }, { status: 400 })
    const idempotencyKey = request.headers.get('idempotency-key') || undefined
    if (idempotencyKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) return NextResponse.json({ error: 'Invalid idempotency key' }, { status: 400 })
    const delivery = await sendAgentCommand(sessionKey, message, idempotencyKey)
    db_helpers.logActivity('agent_wake', 'agent', agent.id, auth.user.username,
      `Gateway accepted check-in for ${agent.name}`, delivery, workspaceId)
    // An accepted run is not proof that the agent is idle or has completed work.
    return NextResponse.json({ success: true, session_key: sessionKey, ...delivery })

  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents/[id]/wake error')
    return NextResponse.json({ error: 'Check-in delivery could not be confirmed. Check the session before retrying.', status: 'outcome_unknown' }, { status: 502 })
  }
}
