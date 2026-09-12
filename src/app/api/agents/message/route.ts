import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { getAgentCommandSession, sendAgentCommand } from '@/lib/agent-delivery'
import { requireRole } from '@/lib/auth'
import { validateBody, createMessageSchema } from '@/lib/validation'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { scanForInjection } from '@/lib/injection-guard'
import { redactSecrets, scanForSecrets } from '@/lib/secret-scanner'
import { logSecurityEvent } from '@/lib/security-events'
import { getActiveProfile } from '@/lib/hook-profiles'

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  // Both the local gateway and its hook-profile settings belong to the primary workspace.
  const workspaceId = auth.user.workspace_id
  if (workspaceId !== 1) return NextResponse.json({ error: 'Agent commands are only available in the primary workspace' }, { status: 403 })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const result = await validateBody(request, createMessageSchema)
    if ('error' in result) return result.error
    const { to, message } = result.data
    if (message.length > 6000) return NextResponse.json({ error: 'Message must be at most 6000 characters' }, { status: 400 })
    const from = auth.user.display_name || auth.user.username || 'system'

    // Scan message for injection — this gets forwarded directly to an agent
    const injectionReport = scanForInjection(message, { context: 'prompt' })
    if (!injectionReport.safe) {
      const criticals = injectionReport.matches.filter(m => m.severity === 'critical')
      if (criticals.length > 0) {
        logger.warn({ to, rules: criticals.map(m => m.rule) }, 'Blocked agent message: injection detected')
        return NextResponse.json(
          { error: 'Message blocked: potentially unsafe content detected', injection: criticals.map(m => ({ rule: m.rule, description: m.description })) },
          { status: 422 }
        )
      }
    }

    const profile = getActiveProfile()
    const secretHits = profile.scanSecrets || profile.blockOnSecretDetection ? scanForSecrets(message) : []
    if (secretHits.length > 0) {
      const types = [...new Set(secretHits.map(hit => hit.type))]
      try { logSecurityEvent({ event_type: 'secret_exposure', severity: 'critical', source: 'agent-message', agent_name: from, detail: JSON.stringify({ count: secretHits.length, types, blocked: profile.blockOnSecretDetection }), workspace_id: workspaceId, tenant_id: auth.user.tenant_id ?? 1 }) } catch {}
      // Never dispatch or create a message preview before the blocking policy is enforced.
      if (profile.blockOnSecretDetection) {
        return NextResponse.json({ error: 'Message blocked: remove credentials before sending', secretTypes: types }, { status: 422 })
      }
    }

    const db = getDatabase()
    const agent = db
      .prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = ?')
      .get(to, workspaceId) as any
    if (!agent) {
      return NextResponse.json({ error: 'Recipient agent not found' }, { status: 404 })
    }
    const sessionKey = getAgentCommandSession(agent, workspaceId)
    if (!sessionKey) {
      return NextResponse.json(
        { error: 'Recipient has no OpenClaw identity or command session configured' },
        { status: 400 }
      )
    }

    const idempotencyKey = request.headers.get('idempotency-key') || undefined
    if (idempotencyKey && !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) return NextResponse.json({ error: 'Invalid idempotency key' }, { status: 400 })
    const delivery = await sendAgentCommand(sessionKey, `Message from ${from}: ${message}`, idempotencyKey)

    // Nonblocking profiles may permit delivery, but notification previews need no credentials.
    const preview = redactSecrets(message)
    db_helpers.createNotification(
      to,
      'message',
      'Direct Message',
      `${from}: ${preview.substring(0, 200)}${preview.length > 200 ? '...' : ''}`,
      'agent',
      agent.id,
      workspaceId
    )

    db_helpers.logActivity(
      'agent_message',
      'agent',
      agent.id,
      from,
      `Gateway accepted message to ${to}`,
      { to, ...delivery },
      workspaceId
    )

    return NextResponse.json({ success: true, ...delivery })
  } catch {
    // Gateway exceptions can echo the supplied message; never persist that payload in logs.
    logger.error('POST /api/agents/message failed; delivery may be unknown')
    return NextResponse.json({ error: 'Command delivery could not be confirmed. Check the session before retrying.', status: 'outcome_unknown' }, { status: 502 })
  }
}
