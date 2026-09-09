import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { callOpenClawGateway } from '@/lib/openclaw-gateway'
import { cloneGatewayCronDefinition, listGatewayCronJobs, loadGatewayCronHistory, mapGatewayCronJob } from '@/lib/cron-gateway'
import { generateCloneName, validateCronExpression } from '@/lib/cron-utils'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (auth.user.workspace_id !== 1 || auth.user.tenant_id !== 1) {
    return NextResponse.json({ error: 'Local gateway schedules belong to the primary workspace only' }, { status: 403 })
  }
  const params = request.nextUrl.searchParams
  const action = params.get('action')
  try {
    if (action === 'list') {
      const jobs = await listGatewayCronJobs()
      return NextResponse.json({ jobs: jobs.map(mapGatewayCronJob), source: 'openclaw-gateway' })
    }
    if (action === 'history' || action === 'logs') {
      const id = params.get(action === 'history' ? 'jobId' : 'job')
      if (!id) return NextResponse.json({ error: 'Job ID required' }, { status: 400 })
      const page = Number(params.get('page') || '1')
      if (!Number.isSafeInteger(page) || page < 1 || page > 50000) {
        return NextResponse.json({ error: 'Invalid page' }, { status: 400 })
      }
      const history = await loadGatewayCronHistory(id, page, params.get('query') || '')
      if (action === 'history') return NextResponse.json(history)
      return NextResponse.json({ logs: history.entries.map(entry => ({
        timestamp: entry.timestamp,
        message: entry.error || entry.summary || `Job executed — status: ${entry.status || 'unknown'}`,
        level: ['error', 'failed'].includes(entry.status || '') ? 'error' : 'info',
      })) })
    }
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch {
    // Do not log RPC command errors: those can contain prompts or delivery details.
    logger.warn({ action }, 'OpenClaw cron read failed')
    return NextResponse.json({ error: 'OpenClaw scheduler unavailable. Check the gateway connection.' }, { status: 503 })
  }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (auth.user.workspace_id !== 1 || auth.user.tenant_id !== 1) {
    return NextResponse.json({ error: 'Local gateway schedules belong to the primary workspace only' }, { status: 403 })
  }
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const action = body.action
  if (!['add', 'toggle', 'trigger', 'remove', 'clone'].includes(action)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }
  try {
    if (action === 'add') {
      const name = body.jobName || body.name
      if (typeof name !== 'string' || !name.trim() || typeof body.command !== 'string' || !body.command.trim() || typeof body.schedule !== 'string') {
        return NextResponse.json({ error: 'Schedule, command, and name required' }, { status: 400 })
      }
      const scheduleError = validateCronExpression(body.schedule)
      if (scheduleError) return NextResponse.json({ error: scheduleError }, { status: 400 })
      if (body.staggerSeconds != null && (!Number.isFinite(body.staggerSeconds) || body.staggerSeconds < 0)) {
        return NextResponse.json({ error: 'Invalid stagger seconds' }, { status: 400 })
      }
      const existing = await listGatewayCronJobs()
      if (existing.some(job => job.name.toLowerCase() === name.trim().toLowerCase())) {
        return NextResponse.json({ error: 'A job with this name already exists' }, { status: 409 })
      }
      const result = await callOpenClawGateway('cron.add', {
        name: name.trim(), enabled: true,
        agentId: process.env.MC_CRON_AGENT_ID || process.env.MC_COORDINATOR_AGENT || 'main',
        description: typeof body.description === 'string' ? body.description : undefined,
        schedule: { kind: 'cron', expr: body.schedule.trim(), ...(body.staggerSeconds != null ? { staggerMs: body.staggerSeconds * 1000 } : {}) },
        sessionTarget: 'isolated', wakeMode: 'now',
        payload: { kind: 'agentTurn', message: body.command, timeoutSeconds: 300, ...(typeof body.model === 'string' && body.model.trim() ? { model: body.model.trim() } : {}) },
        delivery: { mode: 'none' },
      })
      return NextResponse.json({ success: true, result })
    }
    const hasJobId = Object.prototype.hasOwnProperty.call(body, 'jobId')
    const id = hasJobId ? body.jobId : body.jobName
    if (typeof id !== 'string' || !id.trim()) return NextResponse.json({ error: 'Job ID required' }, { status: 400 })
    if (action === 'trigger') {
      if (process.env.MISSION_CONTROL_ALLOW_COMMAND_TRIGGER !== '1') {
        return NextResponse.json({ error: 'Manual triggers disabled. Set MISSION_CONTROL_ALLOW_COMMAND_TRIGGER=1 to enable.' }, { status: 403 })
      }
      if (body.mode && !['force', 'due'].includes(body.mode)) {
        return NextResponse.json({ error: 'Invalid trigger mode' }, { status: 400 })
      }
    }
    const jobs = await listGatewayCronJobs()
    // An explicit ID must never be reinterpreted as a name after deletion or a stale UI read.
    const matches = jobs.filter(candidate => hasJobId ? candidate.id === id : candidate.name === id)
    if (matches.length > 1) {
      return NextResponse.json({ error: 'Multiple jobs have this name. Use jobId to select one.' }, { status: 409 })
    }
    const job = matches[0]
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    if (action === 'toggle') {
      const enabled = typeof body.enabled === 'boolean' ? body.enabled : !job.enabled
      await callOpenClawGateway('cron.update', { id: job.id, patch: { enabled } })
      return NextResponse.json({ success: true, enabled })
    }
    if (action === 'remove') {
      await callOpenClawGateway('cron.remove', { id: job.id })
      return NextResponse.json({ success: true })
    }
    if (action === 'trigger') {
      const result = await callOpenClawGateway<{ ok?: boolean; enqueued?: boolean; ran?: boolean; reason?: string; runId?: string }>('cron.run', { id: job.id, mode: body.mode || 'force' })
      if (result?.ok !== true) throw new Error('Run request not acknowledged')
      if (result.ran === false) {
        const reasons: Record<string, string> = {
          'not-due': 'this job is not due yet',
          'already-running': 'this job is already running',
          'invalid-spec': 'the job configuration is invalid',
          'restart-recovery-pending': 'the scheduler is recovering after a restart',
        }
        const reason = typeof result.reason === 'string' && result.reason ? result.reason : 'the scheduler declined this run'
        return NextResponse.json({ success: false, result, error: `Run not started: ${reasons[reason] || reason}.` })
      }
      if (result.enqueued !== true && result.ran !== true) throw new Error('Unknown run receipt')
      return NextResponse.json({ success: true, result })
    }
    const clonedName = generateCloneName(job.name, jobs.map(candidate => candidate.name))
    await callOpenClawGateway('cron.add', cloneGatewayCronDefinition(job, clonedName))
    return NextResponse.json({ success: true, clonedName, enabled: false })
  } catch {
    logger.warn({ action }, 'OpenClaw cron mutation failed')
    return NextResponse.json({ error: 'OpenClaw scheduler did not confirm the change. Refresh before retrying.' }, { status: 503 })
  }
}
