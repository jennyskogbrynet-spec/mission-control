import { getDatabase, logAuditEvent } from './db'
import { syncAgentsFromConfig } from './agent-sync'
import { config, ensureDirExists } from './config'
import { join, dirname } from 'path'
import { readdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { logger } from './logger'
import { processWebhookRetries } from './webhooks'
import { syncClaudeSessions } from './claude-sessions'
import { pruneGatewaySessionsOlderThan, getAgentLiveStatuses } from './sessions'
import { eventBus } from './event-bus'
import { syncSkillsFromDisk } from './skill-sync'
import { syncLocalAgents } from './local-agent-sync'
import { dispatchAssignedTasks, requeueStaleTasks, autoRouteInboxTasks } from './task-dispatch'
import { spawnRecurringTasks } from './recurring-tasks'
import { CLAIM_LEASE_SWEEP_SETTING, readActiveNativeWorkerTaskIds, readClaimLeaseHours, sweepExpiredClaims } from './claim-lease'

const BACKUP_DIR = join(dirname(config.dbPath), 'backups')

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

/** The daily backup's slot, in UTC. */
const BACKUP_SLOT_HOUR_UTC = 3
/** After a failed or timed-out backup, try again this much later (not a day later). */
const BACKUP_RETRY_MS = 30 * MINUTE_MS
/** A backup this old means a daily slot was missed; run one now (24 h cadence + 1 h grace, so the normal run never trips it). */
const BACKUP_CATCHUP_AGE_MS = 25 * HOUR_MS
/** The freshness alert fires later than the catch-up, so a catch-up that works never raises it. */
const BACKUP_STALE_ALERT_AGE_HOURS = 26
/** First catch-up run after a start that finds the newest backup too old. */
const BACKUP_STARTUP_DELAY_MS = 30 * 1000
/** A backup is followed by the next 03:00 UTC slot at least this far away, so a catch-up just before 03:00 is not repeated minutes later. */
const BACKUP_MIN_GAP_MS = 12 * HOUR_MS
/** Housekeeping (catch-up and freshness) runs at most this often, from the tick, independent of any task's switch. */
const HOUSEKEEPING_INTERVAL_MS = 5 * MINUTE_MS
/** A stale-backup alert, and a repeated failure of one task, are logged and audited at most this often. */
const REPORT_REPEAT_MS = HOUR_MS

/**
 * One awaited call that never settles used to leave `running: true` on its task for good (MC 1728):
 * every later tick skipped the task and nothing was logged. A run that outlives its limit is
 * released, recorded as a failure with the call it was stuck in, and tried again.
 */
const DEFAULT_TASK_TIMEOUT_MS = 10 * MINUTE_MS
const TASK_TIMEOUT_MS: Record<string, number> = {
  auto_backup: 15 * MINUTE_MS,
  // Dispatch invokes agents and can be slow on purpose; a release here only frees the flag.
  task_dispatch: 30 * MINUTE_MS,
}

class TaskTimeoutError extends Error {
  constructor(taskId: string, timeoutMs: number, stage?: string) {
    super(`${taskId} timed out after ${Math.round(timeoutMs / MINUTE_MS)} min${stage ? ` (stuck in: ${stage})` : ''}`)
    this.name = 'TaskTimeoutError'
  }
}

function setStage(taskId: string, stage: string) {
  const task = tasks.get(taskId)
  if (task) task.stage = stage
}

interface ScheduledTask {
  name: string
  intervalMs: number
  lastRun: number | null
  nextRun: number
  enabled: boolean
  running: boolean
  lastResult?: { ok: boolean; message: string; timestamp: number }
  /** When the current run started; null/undefined while idle. */
  runningSince?: number | null
  /** Runs in a row that failed, threw or timed out. Reset by the next success. */
  consecutiveFailures?: number
  /** When a failure of this task was last logged + audited (they are throttled to one per hour). */
  lastFailureReportAt?: number | null
  /** Where the current run says it is, so a timeout can name the call it was stuck in. */
  stage?: string
}

const tasks: Map<string, ScheduledTask> = new Map()
let tickInterval: ReturnType<typeof setInterval> | null = null

/** Check if a setting is enabled (reads from settings table, falls back to default) */
function isSettingEnabled(key: string, defaultValue: boolean): boolean {
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (row) return row.value === 'true'
    return defaultValue
  } catch {
    return defaultValue
  }
}

function getSettingNumber(key: string, defaultValue: number): number {
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (row) return parseInt(row.value) || defaultValue
    return defaultValue
  } catch {
    return defaultValue
  }
}

/**
 * Release claims that nobody has touched for the lease period (default 72 h, setting
 * `general.claim_lease_hours`). Off by default: enable with `general.claim_lease_sweep=true`
 * after one reviewed manual pass (POST /api/tasks/claim-leases). Never releases a claim
 * with an active run or native worker; if the controller journal cannot be read, it
 * releases nothing. See src/lib/claim-lease.ts.
 */
async function runClaimLeaseSweep(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()
  const leaseHours = readClaimLeaseHours(db)
  const native = readActiveNativeWorkerTaskIds()
  if (!native.ok) return { ok: false, message: `Claim lease sweep skipped: ${native.reason}` }
  const result = sweepExpiredClaims(db, {
    apply: true,
    leaseHours,
    activeNativeTaskIds: native.ids,
    actor: 'claim-lease',
    broadcast: (event, payload) => eventBus.broadcast(event, payload),
  })
  if (result.released.length > 0) {
    logger.warn({ released: result.released, lease_hours: leaseHours }, 'claim lease sweep released expired claims')
  }
  return {
    ok: true,
    message: `Claim lease ${leaseHours}h: ${result.released.length} released, ${result.protected.length} protected, ${result.within_lease} within lease of ${result.evaluated} held`,
  }
}

/** Finished backups only: `mc-backup-*.db`. A run in progress writes `….db.partial` and renames when done. */
function isFinishedBackup(name: string): boolean {
  return name.startsWith('mc-backup-') && name.endsWith('.db')
}

/** mtime of the newest finished backup, or 0 when there is none (or the directory cannot be read). */
function newestBackupMtimeMs(): number {
  let newest = 0
  try {
    for (const f of readdirSync(BACKUP_DIR)) {
      if (!isFinishedBackup(f)) continue
      const mtime = statSync(join(BACKUP_DIR, f)).mtimeMs
      if (mtime > newest) newest = mtime
    }
  } catch {
    return 0
  }
  return newest
}

/** Age of the newest finished backup; Infinity when there is none. */
function newestBackupAgeMs(nowMs: number): number {
  const newest = newestBackupMtimeMs()
  return newest === 0 ? Infinity : nowMs - newest
}

/** The next 03:00 UTC slot after `nowMs`, skipping one when it is under 12 h away (a catch-up just before it). */
function nextBackupSlot(nowMs: number): number {
  const slot = new Date(nowMs)
  slot.setUTCHours(BACKUP_SLOT_HOUR_UTC, 0, 0, 0)
  if (slot.getTime() <= nowMs) slot.setUTCDate(slot.getUTCDate() + 1)
  if (slot.getTime() - nowMs < BACKUP_MIN_GAP_MS) slot.setUTCDate(slot.getUTCDate() + 1)
  return slot.getTime()
}

function removeQuietly(path: string) {
  try { unlinkSync(path) } catch { /* not there, or already gone */ }
}

/**
 * Run a database backup. It writes `<name>.db.partial` and renames it when the copy is complete,
 * so a run in progress or a failed one is never taken for a finished backup (freshness, pruning).
 * Every failure is logged and audited as `auto_backup_failed` with the error's own message.
 * `signal` is the scheduler watchdog's: once aborted, better-sqlite3 is told to stop at its next
 * progress callback and nothing more is written, logged or renamed by this (abandoned) run.
 */
async function runBackup(signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const backupPath = join(BACKUP_DIR, `mc-backup-${timestamp}.db`)
  const partialPath = `${backupPath}.partial`

  try {
    setStage('auto_backup', 'preparing backup directory')
    ensureDirExists(BACKUP_DIR)
    const db = getDatabase()

    setStage('auto_backup', 'db.backup')
    await db.backup(partialPath, {
      progress: () => {
        if (signal?.aborted) throw new Error('Backup cancelled: the scheduler watchdog timed out this run')
        return 100 // pages per step: better-sqlite3's own default, restated because the callback must return a number
      },
    })
    if (signal?.aborted) throw new Error('Backup cancelled: the scheduler watchdog timed out this run')

    setStage('auto_backup', 'finalizing backup file')
    const stat = statSync(partialPath)
    if (stat.size === 0) throw new Error('Backup produced an empty file')
    renameSync(partialPath, backupPath)
    logAuditEvent({
      action: 'auto_backup',
      actor: 'scheduler',
      detail: { path: backupPath, size: stat.size },
    })

    // Prune old backups
    setStage('auto_backup', 'pruning old backups')
    const maxBackups = getSettingNumber('general.backup_retention_count', 10)
    try {
      const files = readdirSync(BACKUP_DIR)
        .filter(isFinishedBackup)
        .map(f => ({ name: f, mtime: statSync(join(BACKUP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)

      for (const file of files.slice(maxBackups)) {
        unlinkSync(join(BACKUP_DIR, file.name))
      }
    } catch {
      // Best-effort pruning
    }

    const sizeKB = Math.round(stat.size / 1024)
    return { ok: true, message: `Backup created (${sizeKB}KB)` }
  } catch (err: any) {
    removeQuietly(partialPath)
    const message = err?.message ?? String(err)
    if (signal?.aborted) {
      // The watchdog already recorded this run's timeout; do not report it a second time.
      return { ok: false, message: `Backup cancelled: ${message}` }
    }
    logger.error({ err, path: backupPath }, `Backup failed: ${message}`)
    logAuditEvent({ action: 'auto_backup_failed', actor: 'scheduler', detail: { message, path: backupPath } })
    return { ok: false, message: `Backup failed: ${message}` }
  }
}

/** Run data cleanup based on retention settings */
/**
 * Backup freshness alert (committee P0-3): the auto-backup silently never ran
 * for two months because the tick defaulted it to disabled. Broadcast + audit
 * when the newest automatic backup is older than the alert threshold so a
 * silent regression can never go unnoticed again.
 */
function checkBackupFreshness(): void {
  const maxAgeHours = BACKUP_STALE_ALERT_AGE_HOURS
  const nowMs = Date.now()
  const newestMs = newestBackupMtimeMs()
  const ageHours = newestMs === 0 ? Infinity : (nowMs - newestMs) / 3_600_000
  if (ageHours <= maxAgeHours) return
  // Called every few minutes from the tick: say it once, then again each hour while it stays true.
  if (lastStaleAlertAt !== null && nowMs - lastStaleAlertAt < REPORT_REPEAT_MS) return
  lastStaleAlertAt = nowMs
  const detail = newestMs === 0
    ? 'No automatic backup (mc-backup-*.db) exists at all'
    : `Newest automatic backup is ${Math.round(ageHours)}h old (threshold ${maxAgeHours}h)`
  logger.error({ backupDir: BACKUP_DIR, ageHours }, `Backup freshness alert: ${detail}`)
  logAuditEvent({ action: 'backup_stale', actor: 'scheduler', detail: { message: detail } })
  eventBus.broadcast('backup.stale', { detail, newest_backup_ms: newestMs || null })
}

let lastStaleAlertAt: number | null = null
let lastHousekeepingAt = 0

/**
 * Backup housekeeping, run from the tick every five minutes whatever any task's switch says
 * (the freshness check used to live only inside auto_cleanup, which is off by default, so 0
 * `backup_stale` rows ever existed while the backup was hanging). Two things:
 *  - catch up: when auto backup is on and the newest backup is older than 25 h, a daily slot
 *    was missed (restart, hang, failed run), so make the backup due now. A failed run's
 *    30-minute backoff is respected: only a far-away `nextRun` is pulled forward.
 *  - alert: `checkBackupFreshness()`.
 * It never throws: a broken housekeeping must not stop the tick.
 */
function runBackupHousekeeping(nowMs: number): void {
  if (nowMs - lastHousekeepingAt < HOUSEKEEPING_INTERVAL_MS) return
  lastHousekeepingAt = nowMs
  try {
    const backup = tasks.get('auto_backup')
    if (
      backup && !backup.running &&
      backup.nextRun - nowMs > BACKUP_RETRY_MS &&
      isSettingEnabled('general.auto_backup', true) &&
      newestBackupAgeMs(nowMs) > BACKUP_CATCHUP_AGE_MS
    ) {
      logger.warn({ backupDir: BACKUP_DIR }, 'Newest backup is older than 25h: running the missed backup now')
      backup.nextRun = nowMs
    }
    checkBackupFreshness()
  } catch (err) {
    logger.error({ err }, 'Backup housekeeping failed')
  }
}

async function runCleanup(): Promise<{ ok: boolean; message: string }> {
  checkBackupFreshness()
  try {
    const db = getDatabase()
    const now = Math.floor(Date.now() / 1000)
    const ret = config.retention
    let totalDeleted = 0

    const targets = [
      { table: 'activities', column: 'created_at', days: ret.activities },
      { table: 'audit_log', column: 'created_at', days: ret.auditLog },
      { table: 'notifications', column: 'created_at', days: ret.notifications },
      { table: 'pipeline_runs', column: 'created_at', days: ret.pipelineRuns },
    ]

    for (const { table, column, days } of targets) {
      if (days <= 0) continue
      const cutoff = now - days * 86400
      try {
        const res = db.prepare(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoff)
        totalDeleted += res.changes
      } catch {
        // Table might not exist
      }
    }

    // Clean token usage file
    if (ret.tokenUsage > 0) {
      try {
        const { readFile, writeFile } = require('fs/promises')
        const raw = await readFile(config.tokensPath, 'utf-8')
        const data = JSON.parse(raw)
        const cutoffMs = Date.now() - ret.tokenUsage * 86400000
        const kept = data.filter((r: any) => r.timestamp >= cutoffMs)
        const removed = data.length - kept.length

        if (removed > 0) {
          await writeFile(config.tokensPath, JSON.stringify(kept, null, 2))
          totalDeleted += removed
        }
      } catch {
        // No token file
      }
    }

    if (ret.gatewaySessions > 0) {
      const sessionCleanup = pruneGatewaySessionsOlderThan(ret.gatewaySessions)
      totalDeleted += sessionCleanup.deleted
    }

    if (totalDeleted > 0) {
      logAuditEvent({
        action: 'auto_cleanup',
        actor: 'scheduler',
        detail: { total_deleted: totalDeleted },
      })
    }

    return { ok: true, message: `Cleaned ${totalDeleted} stale record${totalDeleted === 1 ? '' : 's'}` }
  } catch (err: any) {
    return { ok: false, message: `Cleanup failed: ${err.message}` }
  }
}

/** Check agent liveness - mark agents offline if not seen recently */
async function runHeartbeatCheck(): Promise<{ ok: boolean; message: string }> {
  try {
    const db = getDatabase()
    const now = Math.floor(Date.now() / 1000)
    const timeoutMinutes = getSettingNumber('general.agent_timeout_minutes', 10)
    const threshold = now - timeoutMinutes * 60

    // Find agents that are not offline but haven't been seen recently
    const staleAgents = db.prepare(`
      SELECT id, name, status, last_seen FROM agents
      WHERE status != 'offline' AND (last_seen IS NULL OR last_seen < ?)
    `).all(threshold) as Array<{ id: number; name: string; status: string; last_seen: number | null }>

    if (staleAgents.length === 0) {
      return { ok: true, message: 'All agents healthy' }
    }

    // Mark stale agents as offline
    const markOffline = db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?')
    const logActivity = db.prepare(`
      INSERT INTO activities (type, entity_type, entity_id, actor, description)
      VALUES ('agent_status_change', 'agent', ?, 'heartbeat', ?)
    `)

    const names: string[] = []
    db.transaction(() => {
      for (const agent of staleAgents) {
        markOffline.run('offline', now, agent.id)
        logActivity.run(agent.id, `Agent "${agent.name}" marked offline (no heartbeat for ${timeoutMinutes}m)`)
        names.push(agent.name)

        // Create notification for each stale agent
        try {
          db.prepare(`
            INSERT INTO notifications (recipient, type, title, message, source_type, source_id)
            VALUES ('system', 'heartbeat', ?, ?, 'agent', ?)
          `).run(
            `Agent offline: ${agent.name}`,
            `Agent "${agent.name}" was marked offline after ${timeoutMinutes} minutes without heartbeat`,
            agent.id
          )
        } catch { /* notification creation failed */ }
      }
    })()

    logAuditEvent({
      action: 'heartbeat_check',
      actor: 'scheduler',
      detail: { marked_offline: names },
    })

    return { ok: true, message: `Marked ${staleAgents.length} agent(s) offline: ${names.join(', ')}` }
  } catch (err: any) {
    return { ok: false, message: `Heartbeat check failed: ${err.message}` }
  }
}

/** Sync live agent statuses from gateway session files into the DB */
async function syncAgentLiveStatuses(): Promise<number> {
  const liveStatuses = getAgentLiveStatuses()
  if (liveStatuses.size === 0) return 0

  const db = getDatabase()
  const agents = db.prepare('SELECT id, name, config FROM agents').all() as Array<{
    id: number; name: string; config: string | null
  }>

  const update = db.prepare('UPDATE agents SET status = ?, last_seen = ?, last_activity = ?, updated_at = ? WHERE id = ?')
  let refreshed = 0

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')

  db.transaction(() => {
    for (const agent of agents) {
      // Match by agent name or openclawId from config
      let openclawId: string | null = null
      if (agent.config) {
        try {
          const cfg = JSON.parse(agent.config)
          if (typeof cfg.openclawId === 'string' && cfg.openclawId.trim()) {
            openclawId = cfg.openclawId.trim()
          }
        } catch { /* ignore */ }
      }

      const candidates = [openclawId, agent.name].filter(Boolean).map(s => normalize(s!))
      let matched: { status: 'active' | 'idle' | 'offline'; lastActivity: number; channel: string } | undefined

      for (const [sessionAgent, info] of liveStatuses) {
        if (candidates.includes(normalize(sessionAgent))) {
          matched = info
          break
        }
      }

      if (!matched || matched.status === 'offline') continue

      const now = Math.floor(Date.now() / 1000)
      const activity = `Gateway session (${matched.channel || 'unknown'})`
      update.run(matched.status, now, activity, now, agent.id)
      refreshed++

      eventBus.broadcast('agent.status_changed', {
        id: agent.id,
        name: agent.name,
        status: matched.status,
        last_seen: now,
        last_activity: activity,
      })
    }
  })()

  return refreshed
}

const DAILY_MS = 24 * 60 * 60 * 1000
const FIVE_MINUTES_MS = 5 * 60 * 1000
const TICK_MS = 60 * 1000 // Check every minute

/** Initialize the scheduler */
export function initScheduler() {
  if (tickInterval) return // Already running

  // Auto-sync agents from openclaw.json on startup
  syncAgentsFromConfig('startup').catch(err => {
    logger.warn({ err }, 'Agent auto-sync failed')
  })

  // Register tasks
  const now = Date.now()
  lastStaleAlertAt = null
  lastHousekeepingAt = 0
  // Stagger the initial runs: backup at ~3 AM, cleanup at ~4 AM (relative to process start)
  const msUntilNextBackup = getNextDailyMs(BACKUP_SLOT_HOUR_UTC)
  const msUntilNextCleanup = getNextDailyMs(4)
  // Due-ness is not kept in memory only: a start that finds the newest backup older than a day
  // (no backup at all included) runs one right away instead of waiting for the next 03:00 UTC.
  const backupOverdueAtStart = isSettingEnabled('general.auto_backup', true) && newestBackupAgeMs(now) > BACKUP_CATCHUP_AGE_MS

  tasks.set('auto_backup', {
    name: 'Auto Backup',
    intervalMs: DAILY_MS,
    lastRun: null,
    nextRun: backupOverdueAtStart ? now + BACKUP_STARTUP_DELAY_MS : now + msUntilNextBackup,
    enabled: true,
    running: false,
  })

  tasks.set('auto_cleanup', {
    name: 'Auto Cleanup',
    intervalMs: DAILY_MS,
    lastRun: null,
    nextRun: now + msUntilNextCleanup,
    enabled: true,
    running: false,
  })

  tasks.set('agent_heartbeat', {
    name: 'Agent Heartbeat Check',
    intervalMs: FIVE_MINUTES_MS,
    lastRun: null,
    nextRun: now + FIVE_MINUTES_MS,
    enabled: true,
    running: false,
  })

  tasks.set('webhook_retry', {
    name: 'Webhook Retry',
    intervalMs: TICK_MS, // Every 60s, matching scheduler tick resolution
    lastRun: null,
    nextRun: now + TICK_MS,
    enabled: true,
    running: false,
  })

  tasks.set('claude_session_scan', {
    name: 'Claude Session Scan',
    intervalMs: TICK_MS, // Every 60s — lightweight file stat checks
    lastRun: null,
    nextRun: now + 5_000, // First scan 5s after startup
    enabled: true,
    running: false,
  })

  tasks.set('skill_sync', {
    name: 'Skill Sync',
    intervalMs: TICK_MS, // Every 60s — lightweight file stat checks
    lastRun: null,
    nextRun: now + 10_000, // First scan 10s after startup
    enabled: true,
    running: false,
  })

  tasks.set('local_agent_sync', {
    name: 'Local Agent Sync',
    intervalMs: TICK_MS, // Every 60s — lightweight dir scan
    lastRun: null,
    nextRun: now + 15_000, // First scan 15s after startup
    enabled: true,
    running: false,
  })

  tasks.set('gateway_agent_sync', {
    name: 'Gateway Agent Sync',
    intervalMs: TICK_MS, // Every 60s — re-read openclaw.json
    lastRun: null,
    nextRun: now + 20_000, // First scan 20s after startup (after local sync)
    enabled: true,
    running: false,
  })

  // The factory. OFF unless `general.task_dispatch` is exactly "true" (F2: an absent row
  // no longer means on), and under `general.task_dispatch_scope` = approved_only (the
  // default) it only moves what the morning meeting approved. See dispatch-scope.ts.
  tasks.set('task_dispatch', {
    name: 'Task Dispatch',
    intervalMs: TICK_MS, // Every 60s — check for assigned tasks to dispatch
    lastRun: null,
    nextRun: now + 10_000, // First check 10s after startup
    enabled: true,
    running: false,
  })

  // NOTE: the automated 'aegis_review' scheduled task was removed 2026-07-31.
  // It re-sent a full review prompt to a gateway agent every 60s per task in
  // 'review' status, with no bound on retries and no global spend ceiling. When
  // the reviewer path broke it burned ~1.14B input tokens over two days. Tasks
  // now stay in 'review' for human triage. Do not reintroduce an automated
  // agent-invoking scheduler task without a bounded retry AND a budget guard
  // (see assertAgentInvocationBudget in task-dispatch.ts).

  tasks.set('recurring_task_spawn', {
    name: 'Recurring Task Spawn',
    intervalMs: TICK_MS, // Every 60s — check for recurring tasks due
    lastRun: null,
    nextRun: now + 20_000, // First check 20s after startup
    enabled: true,
    running: false,
  })

  tasks.set('stale_task_requeue', {
    name: 'Stale Task Requeue',
    intervalMs: TICK_MS, // Every 60s — check for stale in_progress tasks
    lastRun: null,
    nextRun: now + 25_000, // First check 25s after startup
    enabled: true,
    running: false,
  })

  tasks.set('claim_lease_sweep', {
    name: 'Claim Lease Sweep',
    intervalMs: 15 * 60_000, // Every 15 min — release claims idle past the lease
    lastRun: null,
    nextRun: now + 5 * 60_000,
    enabled: true,
    running: false,
  })

  // Start the tick loop
  tickInterval = setInterval(tick, TICK_MS)
  logger.info('Scheduler initialized - backup at ~3AM, cleanup at ~4AM, heartbeat every 5m, webhook/claude/skill/local-agent/gateway-agent sync every 60s')
}

/** Calculate ms until next occurrence of a given hour (UTC) */
function getNextDailyMs(hour: number): number {
  const now = new Date()
  const next = new Date(now)
  next.setUTCHours(hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next.getTime() - now.getTime()
}

/** Run one scheduled task. `signal` is aborted by the watchdog when the run outlives its limit. */
async function executeTask(id: string, signal: AbortSignal): Promise<{ ok: boolean; message: string }> {
  return id === 'auto_backup' ? await runBackup(signal)
    : id === 'agent_heartbeat' ? await runHeartbeatCheck()
    : id === 'webhook_retry' ? await processWebhookRetries()
    : id === 'claude_session_scan' ? await syncClaudeSessions()
    : id === 'skill_sync' ? await syncSkillsFromDisk()
    : id === 'local_agent_sync' ? await syncLocalAgents()
    : id === 'gateway_agent_sync' ? await syncAgentsFromConfig('scheduled').then(async r => {
        const refreshed = await syncAgentLiveStatuses()
        return { ok: true, message: `Gateway sync: ${r.created} created, ${r.updated} updated, ${r.synced} total | Live status: ${refreshed} refreshed` }
      })
    : id === 'task_dispatch' ? await autoRouteInboxTasks().then(async (routeResult) => {
        const dispatchResult = await dispatchAssignedTasks()
        const parts = [routeResult.message, dispatchResult.message].filter(m => m && !m.includes('No '))
        return { ok: routeResult.ok && dispatchResult.ok, message: parts.join(' | ') || 'No tasks to route or dispatch' }
      })
    : id === 'recurring_task_spawn' ? await spawnRecurringTasks()
    : id === 'stale_task_requeue' ? await requeueStaleTasks()
    : id === 'claim_lease_sweep' ? await runClaimLeaseSweep()
    : await runCleanup()
}

/**
 * Log and audit what a run did. A success clears the task's failure streak (and says so when it
 * ends one). A failure, whether returned as `{ ok: false }`, thrown, or a watchdog timeout, is
 * logged and audited: the backup every time (its failure rows are the signal the freshness
 * alert used to be the only substitute for), any other task once an hour while it keeps failing,
 * with the streak length so a task that has been down for a day reads as one.
 * `source: 'result'` means the runner already reported it itself (runBackup does, so a manual
 * trigger is covered too). Never throws.
 */
function recordTaskOutcome(
  id: string,
  task: ScheduledTask,
  ok: boolean,
  message: string,
  info: { source: 'result' | 'error'; timedOut: boolean; err?: unknown },
): void {
  try {
    if (ok) {
      const streak = task.consecutiveFailures ?? 0
      if (streak > 0) {
        logger.info({ task: id, failed_runs: streak }, `Scheduler task ${id} recovered after ${streak} failed run(s)`)
      }
      task.consecutiveFailures = 0
      task.lastFailureReportAt = null
      return
    }

    const streak = (task.consecutiveFailures ?? 0) + 1
    task.consecutiveFailures = streak
    const nowMs = Date.now()
    const isBackup = id === 'auto_backup'
    if (isBackup && info.source === 'result') return // runBackup logged and audited it

    const repeatDue = task.lastFailureReportAt == null || nowMs - task.lastFailureReportAt >= REPORT_REPEAT_MS
    if (!isBackup && !repeatDue) return
    task.lastFailureReportAt = nowMs
    logger.error(
      { task: id, err: info.err, timed_out: info.timedOut, consecutive_failures: streak },
      `Scheduler task ${id} failed (${streak} in a row): ${message}`,
    )
    logAuditEvent({
      action: isBackup ? 'auto_backup_failed' : 'scheduler_task_failed',
      actor: 'scheduler',
      detail: isBackup
        ? { message, timed_out: info.timedOut, consecutive_failures: streak }
        : { task: id, message, timed_out: info.timedOut, consecutive_failures: streak },
    })
  } catch (err) {
    logger.error({ err, task: id }, 'Could not record scheduler task outcome')
  }
}

/** When a task runs again: the backup on its 03:00 UTC slot (or the retry backoff after a failure), everything else one interval after the tick. */
function nextRunAfter(id: string, task: ScheduledTask, tickMs: number): number {
  if (id === 'auto_backup') {
    return task.lastResult?.ok ? nextBackupSlot(Date.now()) : Date.now() + BACKUP_RETRY_MS
  }
  return tickMs + task.intervalMs
}

/** Check and run due tasks */
async function tick() {
  const now = Date.now()

  runBackupHousekeeping(now)

  for (const [id, task] of tasks) {
    if (task.running || now < task.nextRun) continue

    // Check if this task is enabled in settings (heartbeat is always enabled)
    const settingKey = id === 'auto_backup' ? 'general.auto_backup'
      : id === 'auto_cleanup' ? 'general.auto_cleanup'
      : id === 'webhook_retry' ? 'webhooks.retry_enabled'
      : id === 'claude_session_scan' ? 'general.claude_session_scan'
      : id === 'skill_sync' ? 'general.skill_sync'
      : id === 'local_agent_sync' ? 'general.local_agent_sync'
      : id === 'gateway_agent_sync' ? 'general.gateway_agent_sync'
      : id === 'task_dispatch' ? 'general.task_dispatch'
      : id === 'recurring_task_spawn' ? 'general.recurring_task_spawn'
      : id === 'stale_task_requeue' ? 'general.stale_task_requeue'
      : id === 'claim_lease_sweep' ? CLAIM_LEASE_SWEEP_SETTING
      : 'general.agent_heartbeat'
    const defaultEnabled = id === 'auto_backup' || id === 'agent_heartbeat' || id === 'webhook_retry' || id === 'claude_session_scan' || id === 'skill_sync' || id === 'local_agent_sync' || id === 'gateway_agent_sync' || id === 'recurring_task_spawn' || id === 'stale_task_requeue'
    if (!isSettingEnabled(settingKey, defaultEnabled)) continue

    task.running = true
    task.runningSince = now
    task.stage = undefined
    const abort = new AbortController()
    const timeoutMs = TASK_TIMEOUT_MS[id] ?? DEFAULT_TASK_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      // The watchdog: a run that never settles is released after `timeoutMs` instead of holding
      // `running: true` until the next restart. The abandoned call is told to stop (the backup
      // honours the signal) and anything it settles with later is ignored.
      const result = await Promise.race([
        executeTask(id, abort.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            abort.abort()
            reject(new TaskTimeoutError(id, timeoutMs, task.stage))
          }, timeoutMs)
        }),
      ])
      task.lastResult = { ...result, timestamp: now }
      recordTaskOutcome(id, task, result.ok, result.message, { source: 'result', timedOut: false })
    } catch (err: any) {
      const message = err?.message ?? String(err)
      task.lastResult = { ok: false, message, timestamp: now }
      recordTaskOutcome(id, task, false, message, { source: 'error', timedOut, err })
    } finally {
      clearTimeout(timer)
      task.running = false
      task.runningSince = null
      task.lastRun = now
      task.nextRun = nextRunAfter(id, task, now)
    }
  }
}

/** Get scheduler status (for API) */
export function getSchedulerStatus() {
  const result: Array<{
    id: string
    name: string
    enabled: boolean
    lastRun: number | null
    nextRun: number
    running: boolean
    runningSince: number | null
    consecutiveFailures: number
    lastResult?: { ok: boolean; message: string; timestamp: number }
  }> = []

  for (const [id, task] of tasks) {
    const settingKey = id === 'auto_backup' ? 'general.auto_backup'
      : id === 'auto_cleanup' ? 'general.auto_cleanup'
      : id === 'webhook_retry' ? 'webhooks.retry_enabled'
      : id === 'claude_session_scan' ? 'general.claude_session_scan'
      : id === 'skill_sync' ? 'general.skill_sync'
      : id === 'local_agent_sync' ? 'general.local_agent_sync'
      : id === 'gateway_agent_sync' ? 'general.gateway_agent_sync'
      : id === 'task_dispatch' ? 'general.task_dispatch'
      : id === 'recurring_task_spawn' ? 'general.recurring_task_spawn'
      : id === 'stale_task_requeue' ? 'general.stale_task_requeue'
      : id === 'claim_lease_sweep' ? CLAIM_LEASE_SWEEP_SETTING
      : 'general.agent_heartbeat'
    const defaultEnabled = id === 'auto_backup' || id === 'agent_heartbeat' || id === 'webhook_retry' || id === 'claude_session_scan' || id === 'skill_sync' || id === 'local_agent_sync' || id === 'gateway_agent_sync' || id === 'recurring_task_spawn' || id === 'stale_task_requeue'
    result.push({
      id,
      name: task.name,
      enabled: isSettingEnabled(settingKey, defaultEnabled),
      lastRun: task.lastRun,
      nextRun: task.nextRun,
      running: task.running,
      runningSince: task.runningSince ?? null,
      consecutiveFailures: task.consecutiveFailures ?? 0,
      lastResult: task.lastResult,
    })
  }

  return result
}

/** Manually trigger a scheduled task */
export async function triggerTask(taskId: string): Promise<{ ok: boolean; message: string }> {
  if (taskId === 'auto_backup') return runBackup()
  if (taskId === 'auto_cleanup') return runCleanup()
  if (taskId === 'agent_heartbeat') return runHeartbeatCheck()
  if (taskId === 'webhook_retry') return processWebhookRetries()
  if (taskId === 'claude_session_scan') return syncClaudeSessions()
  if (taskId === 'skill_sync') return syncSkillsFromDisk()
  if (taskId === 'local_agent_sync') return syncLocalAgents()
  if (taskId === 'gateway_agent_sync') return syncAgentsFromConfig('manual').then(r => ({ ok: true, message: `Gateway sync: ${r.created} created, ${r.updated} updated, ${r.synced} total` }))
  if (taskId === 'task_dispatch') return autoRouteInboxTasks().then(async (r) => { const d = await dispatchAssignedTasks(); return { ok: r.ok && d.ok, message: [r.message, d.message].filter(m => m && !m.includes('No ')).join(' | ') || 'No tasks' } })
  if (taskId === 'aegis_review') return { ok: false, message: 'Aegis auto-review was removed 2026-07-31 (unbounded retry loop drained the codex quota). Review tasks manually.' }
  if (taskId === 'recurring_task_spawn') return spawnRecurringTasks()
  if (taskId === 'stale_task_requeue') return requeueStaleTasks()
  if (taskId === 'claim_lease_sweep') return runClaimLeaseSweep()
  return { ok: false, message: `Unknown task: ${taskId}` }
}

/** Stop the scheduler */
export function stopScheduler() {
  if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = null
  }
}
