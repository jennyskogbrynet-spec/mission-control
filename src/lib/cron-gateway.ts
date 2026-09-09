import { callOpenClawGateway } from '@/lib/openclaw-gateway'

/** The gateway owns persistence (including SQLite in OpenClaw 2026.7+). */
export interface GatewayCronJob {
  id: string
  name: string
  enabled: boolean
  agentId?: string
  description?: string
  sessionKey?: string
  sessionTarget: string
  wakeMode: string
  deleteAfterRun?: boolean
  schedule: { kind: string; expr?: string; tz?: string; everyMs?: number; anchorMs?: number; at?: string; staggerMs?: number }
  payload: { kind?: string; type?: string; message?: string; text?: string; model?: string; argv?: string[]; [key: string]: unknown }
  delivery?: { mode: string; channel?: string; [key: string]: unknown }
  trigger?: unknown
  failureAlert?: unknown
  state?: { nextRunAtMs?: number; lastRunAtMs?: number; lastStatus?: string; lastRunStatus?: string; runningAtMs?: number; lastDurationMs?: number; lastError?: string }
  nextRunAtMs?: number
  lastRunAtMs?: number
  lastRunStatus?: string
  lastRunError?: string
}

export async function listGatewayCronJobs(): Promise<GatewayCronJob[]> {
  const jobs = new Map<string, GatewayCronJob>()
  let offset = 0
  // Guard against a broken/non-advancing gateway pagination response.
  for (let page = 0; page < 50; page++) {
    const data = await callOpenClawGateway<{ jobs: GatewayCronJob[]; hasMore?: boolean; nextOffset?: number }>(
      'cron.list', { includeDisabled: true, limit: 200, offset, sortBy: 'name', sortDir: 'asc' }, 10000,
    )
    if (!Array.isArray(data?.jobs)) throw new Error('Invalid cron.list response')
    for (const job of data.jobs) jobs.set(job.id, job)
    if (!data.hasMore) return [...jobs.values()]
    const next = data.nextOffset ?? offset + data.jobs.length
    if (!Number.isInteger(next) || next <= offset) throw new Error('Cron pagination did not advance')
    offset = next
  }
  throw new Error('Cron pagination limit exceeded')
}

export function mapGatewayCronJob(job: GatewayCronJob) {
  const schedule = job.schedule
  const scheduleText = schedule.kind === 'cron'
    ? `${schedule.expr || ''}${schedule.tz ? ` (${schedule.tz})` : ''}`
    : schedule.kind === 'every' ? `every ${(schedule.everyMs || 0) / 1000}s`
      : schedule.kind === 'at' ? `at ${schedule.at || ''}` : schedule.kind
  const payload = job.payload
  const command = payload.message || payload.text || payload.argv?.join(' ') || `${payload.kind || payload.type || 'job'} (${job.agentId || 'default'})`
  const status = job.lastRunStatus || job.state?.lastRunStatus || job.state?.lastStatus
  const lastStatus = job.state?.runningAtMs ? 'running'
    : ['ok', 'success', 'completed', 'updated'].includes(status || '') ? 'success'
      : ['error', 'failed'].includes(status || '') ? 'error'
        : ['running', 'pending'].includes(status || '') ? 'running' : undefined
  return {
    id: job.id, name: job.name, enabled: job.enabled, schedule: scheduleText,
    command: command.slice(0, 200) + (command.length > 200 ? '...' : ''),
    lastRun: job.lastRunAtMs ?? job.state?.lastRunAtMs,
    nextRun: job.nextRunAtMs ?? job.state?.nextRunAtMs,
    lastStatus, lastError: job.lastRunError ?? job.state?.lastError,
    agentId: job.agentId, timezone: schedule.tz, model: payload.model,
    delivery: job.delivery?.mode === 'none' ? undefined : job.delivery?.channel,
    // Preserve schedule anchors for accurate interval calendar expansion.
    scheduleKind: schedule.kind, everyMs: schedule.everyMs, anchorMs: schedule.anchorMs,
  }
}

export interface GatewayCronRun {
  ts?: number
  timestamp?: number
  runAtMs?: number
  startedAtMs?: number
  status?: string
  error?: string
  summary?: string
  [key: string]: unknown
}

export async function loadGatewayCronHistory(id: string, page = 1, query = '') {
  const data = await callOpenClawGateway<{ entries: GatewayCronRun[]; total?: number; hasMore?: boolean }>(
    'cron.runs', { id, limit: 20, offset: (page - 1) * 20, query, sortDir: 'desc' }, 10000,
  )
  if (!Array.isArray(data?.entries)) throw new Error('Invalid cron.runs response')
  return {
    entries: data.entries.map(entry => ({ ...entry, timestamp: entry.timestamp ?? entry.runAtMs ?? entry.ts ?? entry.startedAtMs })),
    total: data.total ?? data.entries.length, hasMore: data.hasMore ?? false, page,
  }
}

/** Copy only writable definition fields; never carry identity or past run state. */
export function cloneGatewayCronDefinition(job: GatewayCronJob, name: string) {
  return {
    name, enabled: false, agentId: job.agentId, description: job.description,
    sessionKey: job.sessionKey, sessionTarget: job.sessionTarget, wakeMode: job.wakeMode,
    deleteAfterRun: job.deleteAfterRun, schedule: job.schedule, payload: job.payload,
    delivery: job.delivery, trigger: job.trigger, failureAlert: job.failureAlert,
  }
}
