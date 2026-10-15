// @vitest-environment node
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
  autoRoute: vi.fn(),
  dispatch: vi.fn(),
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
  dispatchAssignedTasks: mock.dispatch,
  requeueStaleTasks: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  autoRouteInboxTasks: mock.autoRoute,
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

const YESTERDAYS_BACKUP = 'mc-backup-2026-10-13_03-00-32.db'
/** A 24 h old backup: inside the 25 h catch-up age, so the 03:00 UTC slot itself is what starts the next run. */
const plantYesterdaysBackup = () => plantBackup(YESTERDAYS_BACKUP, 24 * HOUR)

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
  mock.autoRoute.mockResolvedValue({ ok: true, message: 'No tasks' })
  mock.dispatch.mockResolvedValue({ ok: true, message: 'No tasks' })
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
    plantYesterdaysBackup()
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
    plantYesterdaysBackup()
    mock.backup.mockImplementationOnce(() => new Promise(() => {}))
    initScheduler()
    await vi.advanceTimersByTimeAsync(18 * MIN)
    expect(task('auto_backup').lastResult!.ok).toBe(false)
    expect(finishedBackups()).toEqual([YESTERDAYS_BACKUP])

    await vi.advanceTimersByTimeAsync(32 * MIN)
    expect(mock.backup).toHaveBeenCalledTimes(2)
    expect(task('auto_backup').lastResult).toMatchObject({ ok: true })
    expect(finishedBackups()).toHaveLength(2)
    expect(auditCalls('auto_backup')).toHaveLength(1)
    // After success the schedule is back on the 03:00 UTC slot, not a day from the retry.
    expect(task('auto_backup').nextRun).toBe(Date.UTC(2026, 9, 15, 3, 0, 0))
  })

  it('ignores a late settle: the abandoned call cannot overwrite the recorded timeout', async () => {
    vi.setSystemTime(BEFORE_SLOT)
    plantYesterdaysBackup()
    // A late settle that has really written its file: only the abort guards in runBackup stand
    // between it and a rename plus an `auto_backup` audit row for a run the watchdog already failed.
    let settle: () => void = () => {}
    mock.backup.mockImplementationOnce((dest: string) => new Promise(resolve => {
      settle = () => { writeFileSync(dest, 'x'.repeat(2048)); resolve({ totalPages: 1, remainingPages: 0 }) }
    }))
    initScheduler()
    await vi.advanceTimersByTimeAsync(18 * MIN)
    expect(task('auto_backup').lastResult!.message).toMatch(/timed out/)

    settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(task('auto_backup').lastResult!.message).toMatch(/timed out/)
    expect(auditCalls('auto_backup')).toHaveLength(0)
    expect(auditCalls('auto_backup_failed')).toHaveLength(1) // the timeout, reported once; the late run says nothing
    expect(finishedBackups()).toEqual([YESTERDAYS_BACKUP])
    expect(readdirSync(BACKUP_DIR).filter(f => f.endsWith('.partial'))).toEqual([])
  })
})

describe('a backup that throws (the case that used to be silent)', () => {
  it('logs and audits every failure with the error message, and leaves no partial file behind', async () => {
    vi.setSystemTime(BEFORE_SLOT)
    plantYesterdaysBackup()
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
    expect(readdirSync(BACKUP_DIR)).toEqual([YESTERDAYS_BACKUP])
  })

  it('failures of a manual trigger are audited too, once', async () => {
    mock.backup.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    const result = await triggerTask('auto_backup')
    expect(result).toEqual({ ok: false, message: 'Backup failed: EACCES: permission denied' })
    expect(auditCalls('auto_backup_failed')).toHaveLength(1)
  })

  it('a partial file from a run in progress is never taken for a finished backup', async () => {
    vi.setSystemTime(BEFORE_SLOT)
    plantYesterdaysBackup()
    let seenWhileWriting: string[] | null = null
    mock.backup.mockImplementationOnce(async (dest: string) => {
      writeFileSync(dest, 'x'.repeat(100))
      seenWhileWriting = finishedBackups() // observed here, asserted below (an expect in here would be swallowed)
      return { totalPages: 1, remainingPages: 0 }
    })
    initScheduler()
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(seenWhileWriting).toEqual([YESTERDAYS_BACKUP]) // still being written: not a candidate for freshness or pruning
    expect(finishedBackups()).toHaveLength(2)
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
  it('raises backup_stale from the housekeeping loop (auto_cleanup is off by default); switched off on purpose it is a daily reminder', async () => {
    setSetting('general.auto_backup', 'false')
    plantBackup('mc-backup-2026-10-12_03-00-32.db', 40 * HOUR)
    initScheduler()
    expect(task('auto_cleanup').enabled).toBe(false)

    await vi.advanceTimersByTimeAsync(6 * MIN)
    expect(auditCalls('backup_stale')).toHaveLength(1)
    expect(auditCalls('backup_stale')[0].detail.message).toMatch(/Newest automatic backup is 40h old/)
    expect(mock.broadcast).toHaveBeenCalledWith('backup.stale', expect.objectContaining({ detail: expect.any(String) }))

    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(auditCalls('backup_stale')).toHaveLength(1) // switched off on purpose: a daily reminder, not hourly
    await vi.advanceTimersByTimeAsync(23 * HOUR)
    expect(auditCalls('backup_stale')).toHaveLength(2)
  })

  it('with auto backup on and every attempt failing, the alert repeats hourly', async () => {
    plantBackup('mc-backup-2026-10-12_03-00-32.db', 40 * HOUR)
    mock.backup.mockRejectedValue(new Error('disk I/O error'))
    initScheduler()
    await vi.advanceTimersByTimeAsync(46 * MIN)
    expect(auditCalls('backup_stale')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30 * MIN) // past the hour
    expect(auditCalls('backup_stale')).toHaveLength(2)
    expect(auditCalls('auto_backup_failed').length).toBeGreaterThanOrEqual(2)
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

describe('findings of the independent review of PR 1', () => {
  it('dispatch is never released: a healthy 35 min run is reported as stalled once and not started a second time', async () => {
    plantBackup('mc-backup-2026-10-14_03-00-32.db', 5 * HOUR)
    setSetting('general.task_dispatch', 'true')
    mock.dispatch.mockImplementationOnce(
      () => new Promise(resolve => setTimeout(() => resolve({ ok: true, message: 'Dispatched 1 task' }), 35 * MIN)),
    )
    initScheduler()
    await vi.advanceTimersByTimeAsync(33 * MIN)
    expect(mock.dispatch).toHaveBeenCalledTimes(1)
    expect(task('task_dispatch').running).toBe(true)
    const stalled = auditCalls('scheduler_task_stalled').filter(c => c.detail.task === 'task_dispatch')
    expect(stalled).toHaveLength(1)
    expect(stalled[0].detail.minutes).toBe(30)

    await vi.advanceTimersByTimeAsync(5 * MIN) // the run finishes at ~36 min
    expect(task('task_dispatch').lastResult).toMatchObject({ ok: true })
    expect(auditCalls('scheduler_task_failed').filter(c => c.detail.task === 'task_dispatch')).toHaveLength(0)
    expect(auditCalls('scheduler_task_stalled')).toHaveLength(1)
  })

  it('one unreadable entry in the backup directory does not read as "no backup": no catch-up, no false alert', async () => {
    plantBackup('mc-backup-2026-10-14_03-00-32.db', 5 * HOUR)
    symlinkSync('/nonexistent/target.db', join(BACKUP_DIR, 'mc-backup-dangling.db'))
    initScheduler()
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(mock.backup).not.toHaveBeenCalled()
    expect(auditCalls('backup_stale')).toHaveLength(0)
  })

  it('pruning goes entry by entry: an unreadable entry does not stop older backups being removed', async () => {
    setSetting('general.backup_retention_count', '2')
    for (const [hours, name] of [[30, 'a'], [29, 'b'], [28, 'c'], [27, 'd']] as const) {
      plantBackup(`mc-backup-2026-10-1${hours % 10}_0${name === 'a' ? 1 : 2}-00-00.db`, hours * HOUR)
    }
    symlinkSync('/nonexistent/target.db', join(BACKUP_DIR, 'mc-backup-dangling.db'))
    initScheduler() // newest is 27 h old: overdue, so a backup runs and then prunes
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(mock.backup).toHaveBeenCalledTimes(1)
    const kept = finishedBackups().filter(f => f !== 'mc-backup-dangling.db')
    expect(kept).toHaveLength(2) // the new one and the 27 h old one
    expect(kept).toContain('mc-backup-2026-10-17_02-00-00.db')
  })

  it('a backup this process just finished is not repeated by the catch-up when the folder cannot be listed', async () => {
    initScheduler() // no backup at all: catch-up runs one
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(mock.backup).toHaveBeenCalledTimes(1)
    chmodSync(BACKUP_DIR, 0o300) // the file is still there, the listing fails
    try {
      await vi.advanceTimersByTimeAsync(30 * MIN)
      expect(mock.backup).toHaveBeenCalledTimes(1)
    } finally {
      chmodSync(BACKUP_DIR, 0o700)
    }
  })

  it('but when the folder is emptied or swapped after that backup, the catch-up runs again', async () => {
    initScheduler()
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(mock.backup).toHaveBeenCalledTimes(1)
    rmSync(BACKUP_DIR, { recursive: true, force: true })
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(mock.backup).toHaveBeenCalledTimes(2)
    expect(finishedBackups()).toHaveLength(1)
  })

  it('removes what a run that died left behind and keeps a copy that is in progress', async () => {
    const dead = plantBackup('mc-backup-2026-10-13_03-00-32.db.partial', 3 * HOUR)
    const deadJournal = plantBackup('mc-backup-2026-10-13_03-00-32.db.partial-journal', 3 * HOUR)
    const live = plantBackup('mc-backup-2026-10-14_07-59-30.db.partial', 2 * MIN)
    plantBackup('mc-backup-2026-10-12_03-00-32.db', 30 * HOUR) // overdue: a backup runs and cleans up first
    initScheduler()
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(mock.backup).toHaveBeenCalledTimes(1)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(deadJournal)).toBe(false)
    expect(existsSync(live)).toBe(true)
  })

  it('two backups started in the same second (a manual trigger beside the scheduled one) get different paths', async () => {
    const paths: string[] = []
    mock.backup.mockImplementation(async (dest: string) => {
      paths.push(dest)
      await new Promise(resolve => setTimeout(resolve, 1000))
      writeFileSync(dest, 'x'.repeat(2048))
      return { totalPages: 1, remainingPages: 0 }
    })
    const both = Promise.all([triggerTask('auto_backup'), triggerTask('auto_backup')])
    await vi.advanceTimersByTimeAsync(1500)
    const results = await both
    expect(results.map(r => r.ok)).toEqual([true, true])
    expect(new Set(paths).size).toBe(2)
    expect(finishedBackups()).toHaveLength(2)
  })

  it('an afternoon catch-up is followed by the coming 03:00 UTC slot, not the one after (the schedule does not walk)', async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 14, 16, 0, 0))
    plantBackup('mc-backup-2026-10-12_03-00-32.db', 40 * HOUR)
    initScheduler()
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(mock.backup).toHaveBeenCalledTimes(1)
    expect(task('auto_backup').nextRun).toBe(Date.UTC(2026, 9, 15, 3, 0, 0))
  })

  it('a catch-up in the hour before the slot is not repeated at the slot', async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 14, 2, 20, 0))
    plantBackup('mc-backup-2026-10-12_03-00-32.db', 40 * HOUR)
    initScheduler()
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(mock.backup).toHaveBeenCalledTimes(1)
    expect(task('auto_backup').nextRun).toBe(Date.UTC(2026, 9, 15, 3, 0, 0))
  })

  it('a task that hangs for good backs off, stops at three abandoned calls, and runs again once one settles', async () => {
    plantBackup('mc-backup-2026-10-14_03-00-32.db', 5 * HOUR)
    const settlers: Array<(v: unknown) => void> = []
    mock.syncClaudeSessions.mockImplementation(() => new Promise(resolve => { settlers.push(resolve) }))
    initScheduler()
    await vi.advanceTimersByTimeAsync(6 * HOUR)
    expect(mock.syncClaudeSessions).toHaveBeenCalledTimes(3) // 1st at +1 min, then +5, +10 min after each timeout, then the cap
    expect(task('claude_session_scan')).toMatchObject({ running: false, abandonedRuns: 3, lastResult: expect.objectContaining({ ok: false }) })
    expect(auditCalls('scheduler_task_failed').filter(c => c.detail.task === 'claude_session_scan')[0].detail.abandoned_runs).toBe(1)

    settlers[0]({ ok: true, message: 'very late' })
    mock.syncClaudeSessions.mockResolvedValue({ ok: true, message: 'Scanned' })
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(mock.syncClaudeSessions.mock.calls.length).toBeGreaterThanOrEqual(4) // running again, at the normal cadence
    expect(task('claude_session_scan')).toMatchObject({ abandonedRuns: 2, consecutiveFailures: 0, lastResult: expect.objectContaining({ ok: true }) })
  })

  it('a task parked at the abandoned-run cap is reported every hour, not only once (it must not go silent)', async () => {
    plantBackup('mc-backup-2026-10-14_03-00-32.db', 5 * HOUR)
    mock.syncClaudeSessions.mockImplementation(() => new Promise(() => {}))
    initScheduler()
    await vi.advanceTimersByTimeAsync(6 * HOUR)
    expect(task('claude_session_scan')).toMatchObject({ running: false, abandonedRuns: 3 })
    const blocked = auditCalls('scheduler_task_blocked').filter(c => c.detail.task === 'claude_session_scan')
    expect(blocked.length).toBeGreaterThanOrEqual(5) // roughly hourly while parked
    expect(blocked.length).toBeLessThanOrEqual(6)
    expect(blocked[0].detail).toMatchObject({ abandoned_runs: 3 })
    expect(blocked[0].detail.message).toMatch(/timed out/)
  })

  it('a dispatch that is still running is reported again every 6 h, and its timers are gone when it ends', async () => {
    plantBackup('mc-backup-2026-10-14_03-00-32.db', 5 * HOUR)
    setSetting('general.task_dispatch', 'true')
    mock.dispatch.mockImplementationOnce(
      () => new Promise(resolve => setTimeout(() => resolve({ ok: true, message: 'done' }), 13 * HOUR)),
    )
    initScheduler()
    await vi.advanceTimersByTimeAsync(14 * HOUR)
    const stalled = auditCalls('scheduler_task_stalled').filter(c => c.detail.task === 'task_dispatch')
    expect(stalled.map(c => c.detail.minutes)).toEqual([30, 360, 720])
    expect(task('task_dispatch').lastResult).toMatchObject({ ok: true })
  })

  it('the backoff counts timeouts, not failures in general: ten plain failures then one timeout waits 5 minutes', async () => {
    plantBackup('mc-backup-2026-10-14_03-00-32.db', 5 * HOUR)
    mock.syncClaudeSessions.mockResolvedValue({ ok: false, message: 'EMFILE' })
    initScheduler()
    await vi.advanceTimersByTimeAsync(12 * MIN) // ~10 failed runs, one a minute
    expect(task('claude_session_scan').consecutiveFailures).toBeGreaterThanOrEqual(10)
    const before = mock.syncClaudeSessions.mock.calls.length
    mock.syncClaudeSessions.mockImplementation(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(12 * MIN) // hangs once, released after 10 min
    expect(task('claude_session_scan').lastResult!.message).toMatch(/timed out/)
    const afterTimeout = mock.syncClaudeSessions.mock.calls.length
    expect(afterTimeout).toBeGreaterThan(before)
    await vi.advanceTimersByTimeAsync(3 * MIN) // inside the 5 min backoff: no new call
    expect(mock.syncClaudeSessions.mock.calls.length).toBe(afterTimeout)
    await vi.advanceTimersByTimeAsync(4 * MIN) // past it
    expect(mock.syncClaudeSessions.mock.calls.length).toBe(afterTimeout + 1)
  })

  it('a copy this process is still writing is never removed as stale, however quiet its file is', async () => {
    plantBackup('mc-backup-2026-10-12_03-00-32.db', 30 * HOUR) // overdue: a scheduled backup runs
    const slowPartial = join(BACKUP_DIR, 'mc-backup-2026-10-14_06-30-00_manual.db.partial')
    let manualDone: () => void = () => {}
    mock.backup.mockImplementationOnce((dest: string) => new Promise(resolve => {
      // the "manual" copy: has written its partial long ago and is stuck waiting
      writeFileSync(dest, 'x'.repeat(100))
      const old = new Date(Date.now() - 3 * HOUR)
      utimesSync(dest, old, old)
      manualDone = () => resolve({ totalPages: 1, remainingPages: 0 })
    }))
    const manual = triggerTask('auto_backup')
    await vi.advanceTimersByTimeAsync(0)
    const inFlightPartial = readdirSync(BACKUP_DIR).find(f => f.endsWith('.partial'))!
    expect(inFlightPartial).toBeDefined()
    initScheduler()
    await vi.advanceTimersByTimeAsync(2 * MIN) // the scheduled catch-up starts and runs removeStalePartials
    expect(mock.backup).toHaveBeenCalledTimes(2)
    expect(existsSync(join(BACKUP_DIR, inFlightPartial))).toBe(true)
    manualDone()
    expect((await manual).ok).toBe(true)
    void slowPartial
  })

  it('after a timeout the task waits 5 minutes before its next run, not one interval', async () => {
    plantBackup('mc-backup-2026-10-14_03-00-32.db', 5 * HOUR)
    mock.syncClaudeSessions.mockImplementation(() => new Promise(() => {}))
    initScheduler()
    await vi.advanceTimersByTimeAsync(14 * MIN) // 1st run at +1 min, released at +11 min
    expect(mock.syncClaudeSessions).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4 * MIN) // +16 min: the backoff is over
    expect(mock.syncClaudeSessions).toHaveBeenCalledTimes(2)
  })

  it('a timeout names the stage of the scheduled run, also after a manual trigger ran', async () => {
    plantBackup('mc-backup-2026-10-14_03-00-32.db', 5 * HOUR)
    initScheduler()
    await triggerTask('auto_backup')
    expect(getSchedulerStatus().find(t => t.id === 'auto_backup')!.running).toBe(false)
    // A timeout names the stage of the scheduled run, never a leftover of the manual one.
    mock.backup.mockImplementation(() => new Promise(() => {}))
    vi.setSystemTime(BEFORE_SLOT)
    stopScheduler()
    plantYesterdaysBackup()
    initScheduler()
    await vi.advanceTimersByTimeAsync(18 * MIN)
    expect(task('auto_backup').lastResult!.message).toMatch(/stuck in: db\.backup/)
  })
})
