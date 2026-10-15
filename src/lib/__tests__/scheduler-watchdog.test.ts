// @vitest-environment node
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * MC 1728 / TASK-1149. The daily backup did not fail, it never finished: one awaited call that
 * never settled left `running: true` on the task for good, every later tick skipped it, and
 * nothing was logged because only a returned `{ ok: false }` or a throw is ever reported. Seen
 * on the live scheduler 15 Oct: auto_backup, claude_session_scan and gateway_agent_sync all
 * `running: true` since 13/14 Oct while the other tasks kept ticking.
 *
 * These tests run the real scheduler loop (initScheduler + its 60 s tick) against a real
 * temporary backup directory. Everything else the scheduler touches is mocked.
 */
const mock = vi.hoisted(() => ({
  db: null as any,
  backup: vi.fn(),
  audit: vi.fn(),
  broadcast: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  syncClaudeSessions: vi.fn(),
  syncAgentsFromConfig: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ getDatabase: () => mock.db, logAuditEvent: mock.audit }))
vi.mock('@/lib/config', async () => {
  const { tmpdir } = await import('node:os')
  const { join: pjoin } = await import('node:path')
  const { mkdirSync: mk } = await import('node:fs')
  const root = pjoin(tmpdir(), `mc-scheduler-watchdog-${process.pid}`)
  return {
    config: {
      dbPath: pjoin(root, 'mission-control.db'),
      tokensPath: pjoin(root, 'tokens.json'),
      retention: { activities: 0, auditLog: 0, notifications: 0, pipelineRuns: 0, tokenUsage: 0, gatewaySessions: 0 },
    },
    ensureDirExists: (dir: string) => mk(dir, { recursive: true }),
  }
})
vi.mock('@/lib/logger', () => ({ logger: { error: mock.loggerError, warn: mock.loggerWarn, info: mock.loggerInfo } }))
vi.mock('@/lib/agent-sync', () => ({ syncAgentsFromConfig: mock.syncAgentsFromConfig }))
vi.mock('@/lib/webhooks', () => ({ processWebhookRetries: vi.fn().mockResolvedValue({ ok: true, message: 'No pending retries' }) }))
vi.mock('@/lib/claude-sessions', () => ({ syncClaudeSessions: mock.syncClaudeSessions }))
vi.mock('@/lib/sessions', () => ({ pruneGatewaySessionsOlderThan: vi.fn(), getAgentLiveStatuses: () => new Map() }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: mock.broadcast } }))
vi.mock('@/lib/skill-sync', () => ({ syncSkillsFromDisk: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }) }))
vi.mock('@/lib/local-agent-sync', () => ({ syncLocalAgents: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }) }))
vi.mock('@/lib/recurring-tasks', () => ({ spawnRecurringTasks: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }) }))
vi.mock('@/lib/task-dispatch', () => ({
  dispatchAssignedTasks: vi.fn().mockResolvedValue({ ok: true, message: 'No tasks' }),
  requeueStaleTasks: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  autoRouteInboxTasks: vi.fn().mockResolvedValue({ ok: true, message: 'No tasks' }),
}))

import { config } from '@/lib/config'
import { getSchedulerStatus, initScheduler, stopScheduler, triggerTask } from '../scheduler'

const BACKUP_DIR = join(dirname(config.dbPath), 'backups')
const MIN = 60_000
const HOUR = 60 * MIN
/** 08:00 UTC: far from the 03:00 backup slot, so only catch-up (not the schedule) can start a backup. */
const MORNING = Date.UTC(2026, 9, 14, 8, 0, 0)
/** 02:58:30 UTC: the 03:00 slot is the first thing the scheduler is waiting for. */
const BEFORE_SLOT = Date.UTC(2026, 9, 14, 2, 58, 30)

function makeDb() {
  const real = new Database(':memory:')
  real.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  real.exec('CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT, status TEXT, last_seen INTEGER, updated_at INTEGER)')
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'backup') return (...args: unknown[]) => mock.backup(...args)
      const value = (target as any)[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function setSetting(key: string, value: string) {
  mock.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

/** Plant a backup file whose mtime is `ageMs` before the faked "now". */
function plantBackup(name: string, ageMs: number) {
  mkdirSync(BACKUP_DIR, { recursive: true })
  const file = join(BACKUP_DIR, name)
  writeFileSync(file, 'sqlite')
  const at = new Date(Date.now() - ageMs)
  utimesSync(file, at, at)
  return file
}

const finishedBackups = () => (existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR).filter(f => /^mc-backup-.*\.db$/.test(f)) : [])
const task = (id: string) => getSchedulerStatus().find(t => t.id === id)!
const auditCalls = (action: string) => mock.audit.mock.calls.map(c => c[0]).filter(c => c.action === action)

/** Writes the destination like better-sqlite3 does, then resolves. */
const backupWritesFile = async (dest: string) => { writeFileSync(dest, 'x'.repeat(2048)); return { totalPages: 1, remainingPages: 0 } }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(MORNING)
  vi.clearAllMocks()
  rmSync(dirname(config.dbPath), { recursive: true, force: true })
  mock.db = makeDb()
  mock.backup.mockImplementation(backupWritesFile)
  mock.syncClaudeSessions.mockResolvedValue({ ok: true, message: 'Scanned' })
  mock.syncAgentsFromConfig.mockResolvedValue({ created: 0, updated: 0, synced: 0 })
})
afterEach(() => {
  stopScheduler()
  vi.useRealTimers()
  mock.db.close()
  rmSync(dirname(config.dbPath), { recursive: true, force: true })
})

describe('a backup that never finishes (the 14 Oct failure)', () => {
  it('is released by the watchdog, audited as auto_backup_failed with its reason, and cancelled', async () => {
    vi.setSystemTime(BEFORE_SLOT)
    mock.backup.mockImplementation(() => new Promise(() => {}))
    initScheduler()

    await vi.advanceTimersByTimeAsync(2 * MIN) // 03:00:30 tick starts the backup
    expect(mock.backup).toHaveBeenCalledTimes(1)
    expect(task('auto_backup').running).toBe(true)

    await vi.advanceTimersByTimeAsync(16 * MIN)
    const status = task('auto_backup')
    expect(status.running).toBe(false)
    expect(status.lastResult).toMatchObject({ ok: false })
    expect(status.lastResult!.message).toMatch(/auto_backup .*timed out after 15 min/)

    const failures = auditCalls('auto_backup_failed')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ actor: 'scheduler' })
    expect(failures[0].detail.message).toMatch(/timed out after 15 min/)
    expect(failures[0].detail.timed_out).toBe(true)
    expect(mock.loggerError).toHaveBeenCalled()

    // The still-pending better-sqlite3 backup is told to stop at its next progress callback.
    const options = mock.backup.mock.calls[0][1]
    expect(() => options.progress({ totalPages: 10, remainingPages: 9 })).toThrow(/cancel/i)
  })

  it('retries after the backoff instead of waiting a day, and the retry succeeds', async () => {
    vi.setSystemTime(BEFORE_SLOT)
    mock.backup.mockImplementationOnce(() => new Promise(() => {}))
    initScheduler()
    await vi.advanceTimersByTimeAsync(18 * MIN)
    expect(task('auto_backup').lastResult!.ok).toBe(false)
    expect(finishedBackups()).toEqual([])

    await vi.advanceTimersByTimeAsync(32 * MIN)
    expect(mock.backup).toHaveBeenCalledTimes(2)
    expect(task('auto_backup').lastResult).toMatchObject({ ok: true })
    expect(finishedBackups()).toHaveLength(1)
    expect(auditCalls('auto_backup')).toHaveLength(1)
    // After success the schedule is back on the 03:00 UTC slot, not a day from the retry.
    expect(task('auto_backup').nextRun).toBe(Date.UTC(2026, 9, 15, 3, 0, 0))
  })

  it('ignores a late settle: the abandoned call cannot overwrite the recorded timeout', async () => {
    vi.setSystemTime(BEFORE_SLOT)
    let settle: (v: unknown) => void = () => {}
    mock.backup.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
    initScheduler()
    await vi.advanceTimersByTimeAsync(18 * MIN)
    expect(task('auto_backup').lastResult!.message).toMatch(/timed out/)

    settle({ totalPages: 1, remainingPages: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(task('auto_backup').lastResult!.message).toMatch(/timed out/)
    expect(auditCalls('auto_backup')).toHaveLength(0)
  })
})

describe('a backup that throws (the case that used to be silent)', () => {
  it('logs and audits every failure with the error message, and leaves no partial file behind', async () => {
    vi.setSystemTime(BEFORE_SLOT)
    mock.backup.mockImplementationOnce(async (dest: string) => {
      writeFileSync(dest, 'half a database')
      throw new Error('SQLITE_FULL: database or disk is full')
    })
    initScheduler()
    await vi.advanceTimersByTimeAsync(2 * MIN)

    const failures = auditCalls('auto_backup_failed')
    expect(failures).toHaveLength(1)
    expect(failures[0].detail.message).toBe('SQLITE_FULL: database or disk is full')
    expect(mock.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: 'SQLITE_FULL: database or disk is full' }) }),
      expect.stringContaining('Backup failed'),
    )
    expect(task('auto_backup').lastResult).toMatchObject({ ok: false, message: 'Backup failed: SQLITE_FULL: database or disk is full' })
    expect(readdirSync(BACKUP_DIR)).toEqual([])
  })

  it('failures of a manual trigger are audited too, once', async () => {
    mock.backup.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    const result = await triggerTask('auto_backup')
    expect(result).toEqual({ ok: false, message: 'Backup failed: EACCES: permission denied' })
    expect(auditCalls('auto_backup_failed')).toHaveLength(1)
  })

  it('a partial file from a run in progress is never taken for a finished backup', async () => {
    vi.setSystemTime(BEFORE_SLOT)
    let seenWhileWriting: string[] | null = null
    mock.backup.mockImplementationOnce(async (dest: string) => {
      writeFileSync(dest, 'x'.repeat(100))
      seenWhileWriting = finishedBackups() // observed here, asserted below (an expect in here would be swallowed)
      return { totalPages: 1, remainingPages: 0 }
    })
    initScheduler()
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(seenWhileWriting).toEqual([]) // still being written: not a candidate for freshness or pruning
    expect(finishedBackups()).toHaveLength(1)
    expect(readdirSync(BACKUP_DIR).filter(f => f.endsWith('.partial'))).toEqual([])
  })
})

describe('due-ness survives a restart', () => {
  it('runs a backup right after startup when the newest one is older than a day', async () => {
    plantBackup('mc-backup-2026-10-12_03-00-32.db', 29 * HOUR)
    initScheduler()
    expect(mock.backup).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(mock.backup).toHaveBeenCalledTimes(1)
    expect(finishedBackups()).toHaveLength(2)
    // A catch-up at 08:00 still hands the schedule back to the 03:00 UTC slot.
    expect(task('auto_backup').nextRun).toBe(Date.UTC(2026, 9, 15, 3, 0, 0))
  })

  it('runs one right after startup when there is no automatic backup at all', async () => {
    initScheduler()
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(mock.backup).toHaveBeenCalledTimes(1)
  })

  it('leaves a fresh backup alone: the next one waits for the 03:00 UTC slot', async () => {
    plantBackup('mc-backup-2026-10-14_03-00-32.db', 5 * HOUR)
    initScheduler()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(mock.backup).not.toHaveBeenCalled()
    expect(task('auto_backup').nextRun).toBe(Date.UTC(2026, 9, 15, 3, 0, 0))
  })

  it('catches up while running when the schedule was lost (newest backup ages past a day)', async () => {
    const file = plantBackup('mc-backup-2026-10-14_03-00-32.db', 5 * HOUR)
    initScheduler()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(mock.backup).not.toHaveBeenCalled()

    // The file that proved freshness disappears (pruned, or the directory was swapped).
    rmSync(file)
    plantBackup('mc-backup-2026-10-12_03-00-32.db', 40 * HOUR)
    await vi.advanceTimersByTimeAsync(6 * MIN) // the 5-minute housekeeping notices
    expect(mock.backup).toHaveBeenCalledTimes(1)
  })

  it('does not hammer a failing backup: after a failure it waits for the retry slot', async () => {
    plantBackup('mc-backup-2026-10-12_03-00-32.db', 40 * HOUR)
    mock.backup.mockRejectedValue(new Error('disk I/O error'))
    initScheduler()
    await vi.advanceTimersByTimeAsync(25 * MIN)
    expect(mock.backup).toHaveBeenCalledTimes(1) // overdue, but inside the 30 min backoff
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(mock.backup).toHaveBeenCalledTimes(2)
    expect(auditCalls('auto_backup_failed')).toHaveLength(2)
  })

  it('does not run when auto backup is switched off, even if the newest backup is old', async () => {
    setSetting('general.auto_backup', 'false')
    plantBackup('mc-backup-2026-10-12_03-00-32.db', 40 * HOUR)
    initScheduler()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(mock.backup).not.toHaveBeenCalled()
  })
})

describe('backup freshness is checked without auto_cleanup', () => {
  it('raises backup_stale from the housekeeping loop (auto_cleanup is off by default), once an hour at most', async () => {
    setSetting('general.auto_backup', 'false')
    plantBackup('mc-backup-2026-10-12_03-00-32.db', 40 * HOUR)
    initScheduler()
    expect(task('auto_cleanup').enabled).toBe(false)

    await vi.advanceTimersByTimeAsync(6 * MIN)
    expect(auditCalls('backup_stale')).toHaveLength(1)
    expect(auditCalls('backup_stale')[0].detail.message).toMatch(/Newest automatic backup is 40h old/)
    expect(mock.broadcast).toHaveBeenCalledWith('backup.stale', expect.objectContaining({ detail: expect.any(String) }))

    await vi.advanceTimersByTimeAsync(40 * MIN)
    expect(auditCalls('backup_stale')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30 * MIN) // past the hour: it says so again
    expect(auditCalls('backup_stale')).toHaveLength(2)
  })

  it('stays quiet when the newest backup is fresh', async () => {
    plantBackup('mc-backup-2026-10-14_03-00-32.db', 5 * HOUR)
    initScheduler()
    await vi.advanceTimersByTimeAsync(20 * MIN)
    expect(auditCalls('backup_stale')).toHaveLength(0)
  })
})

describe('the other scheduled tasks are covered by the same watchdog and logging', () => {
  it('a hung claude_session_scan is released, reported once per hour, and the other tasks keep ticking', async () => {
    plantBackup('mc-backup-2026-10-14_03-00-32.db', 5 * HOUR)
    mock.syncClaudeSessions.mockImplementation(() => new Promise(() => {}))
    initScheduler()

    await vi.advanceTimersByTimeAsync(20 * MIN)
    const scan = task('claude_session_scan')
    expect(scan.lastResult).toMatchObject({ ok: false })
    expect(scan.lastResult!.message).toMatch(/claude_session_scan .*timed out after 10 min/)
    expect(scan.consecutiveFailures).toBeGreaterThanOrEqual(1)
    expect(task('skill_sync').lastResult).toMatchObject({ ok: true })

    await vi.advanceTimersByTimeAsync(40 * MIN) // several more timeouts inside the same hour
    const reports = auditCalls('scheduler_task_failed').filter(c => c.detail.task === 'claude_session_scan')
    expect(reports).toHaveLength(1)
    expect(reports[0].detail).toMatchObject({ timed_out: true })
    expect(reports[0].detail.message).toMatch(/timed out/)
    expect(task('claude_session_scan').consecutiveFailures).toBeGreaterThan(reports[0].detail.consecutive_failures)
  })

  it('a task that recovers is logged as recovered and its failure count resets', async () => {
    mock.syncAgentsFromConfig.mockImplementation(async (actor: string) => {
      if (actor === 'scheduled') throw new Error('ENOENT: openclaw.json')
      return { created: 0, updated: 0, synced: 0 }
    })
    initScheduler()
    await vi.advanceTimersByTimeAsync(3 * MIN)
    const failing = task('gateway_agent_sync')
    expect(failing.lastResult).toMatchObject({ ok: false, message: 'ENOENT: openclaw.json' })
    expect(failing.consecutiveFailures).toBeGreaterThanOrEqual(2)
    expect(auditCalls('scheduler_task_failed').filter(c => c.detail.task === 'gateway_agent_sync')).toHaveLength(1)

    mock.syncAgentsFromConfig.mockResolvedValue({ created: 0, updated: 0, synced: 0 })
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(task('gateway_agent_sync')).toMatchObject({ consecutiveFailures: 0, lastResult: expect.objectContaining({ ok: true }) })
    expect(mock.loggerInfo).toHaveBeenCalledWith(expect.objectContaining({ task: 'gateway_agent_sync' }), expect.stringContaining('recovered'))
  })

  it('a task that reports {ok:false} is logged and audited too, not only one that throws', async () => {
    mock.syncClaudeSessions.mockResolvedValue({ ok: false, message: 'Session scan failed: EMFILE' })
    initScheduler()
    await vi.advanceTimersByTimeAsync(2 * MIN)
    const reports = auditCalls('scheduler_task_failed').filter(c => c.detail.task === 'claude_session_scan')
    expect(reports).toHaveLength(1)
    expect(reports[0].detail).toMatchObject({ message: 'Session scan failed: EMFILE', timed_out: false })
  })

  it('healthy tasks write no failure rows', async () => {
    plantBackup('mc-backup-2026-10-14_03-00-32.db', 5 * HOUR)
    initScheduler()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(auditCalls('scheduler_task_failed')).toHaveLength(0)
    expect(auditCalls('auto_backup_failed')).toHaveLength(0)
    expect(getSchedulerStatus().every(t => !t.consecutiveFailures)).toBe(true)
  })
})
