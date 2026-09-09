import { beforeEach, describe, expect, it, vi } from 'vitest'
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/lib/openclaw-gateway', () => ({ callOpenClawGateway: rpc }))
import { cloneGatewayCronDefinition, listGatewayCronJobs, loadGatewayCronHistory, mapGatewayCronJob, type GatewayCronJob } from '../cron-gateway'
import { getJobCalendarOccurrences } from '../cron-occurrences'
const job: GatewayCronJob = { id: 'test-id', name: 'Test job', enabled: true, schedule: { kind: 'cron', expr: '0 6 * * *', tz: 'UTC' }, sessionTarget: 'isolated', wakeMode: 'now', payload: { kind: 'agentTurn', message: 'A test' } }
beforeEach(() => rpc.mockReset())
describe('gateway cron contract', () => {
  it('loads beyond the 200-job first page including disabled jobs', async () => {
    rpc.mockResolvedValueOnce({ jobs: [job], hasMore: true, nextOffset: 200 }).mockResolvedValueOnce({ jobs: [{ ...job, id: 'later', enabled: false }], hasMore: false })
    expect(await listGatewayCronJobs()).toHaveLength(2)
    expect(rpc).toHaveBeenLastCalledWith('cron.list', { includeDisabled: true, limit: 200, offset: 200, sortBy: 'name', sortDir: 'asc' }, 10000)
  })
  it('rejects stuck pagination and malformed responses instead of showing empty', async () => {
    rpc.mockResolvedValueOnce({ jobs: [job], hasMore: true, nextOffset: 0 })
    await expect(listGatewayCronJobs()).rejects.toThrow('did not advance')
    rpc.mockResolvedValueOnce({ success: false })
    await expect(listGatewayCronJobs()).rejects.toThrow('Invalid')
  })
  it('normalizes current run fields and does not mark skipped as successful', () => {
    expect(mapGatewayCronJob({ ...job, lastRunStatus: 'ok', nextRunAtMs: 500, state: { nextRunAtMs: 400 } })).toMatchObject({ nextRun: 500, lastStatus: 'success' })
    expect(mapGatewayCronJob({ ...job, lastRunStatus: 'skipped' }).lastStatus).toBeUndefined()
    expect(mapGatewayCronJob({ ...job, state: { runningAtMs: 100 } }).lastStatus).toBe('running')
  })
  it('maps command and one-shot schedules without undefined labels', () => {
    expect(mapGatewayCronJob({ ...job, payload: { kind: 'command', argv: ['echo', 'test'] }, schedule: { kind: 'at', at: '2026-09-08T10:00:00Z' } })).toMatchObject({ command: 'echo test', schedule: 'at 2026-09-08T10:00:00Z' })
  })
  it('uses actual gateway run history and normalizes timestamps', async () => {
    rpc.mockResolvedValueOnce({ entries: [{ ts: 300, runAtMs: 200, status: 'ok' }], total: 21, hasMore: true })
    expect(await loadGatewayCronHistory('test-id', 2, 'error')).toMatchObject({ entries: [{ timestamp: 200 }], total: 21, hasMore: true, page: 2 })
    expect(rpc).toHaveBeenCalledWith('cron.runs', { id: 'test-id', limit: 20, offset: 20, query: 'error', sortDir: 'desc' }, 10000)
  })
  it('clones disabled and strips identity/run state without losing payload or delivery', () => {
    const clone = cloneGatewayCronDefinition({ ...job, state: { lastRunAtMs: 123 }, delivery: { mode: 'none' } }, 'Copy')
    expect(clone).toMatchObject({ name: 'Copy', enabled: false, payload: job.payload, delivery: { mode: 'none' } })
    expect(clone).not.toHaveProperty('id'); expect(clone).not.toHaveProperty('state')
  })
  it('omits disabled calendar jobs and expands anchored intervals', () => {
    expect(getJobCalendarOccurrences({ schedule: '* * * * *', enabled: false, nextRun: 10 }, 0, 100000)).toEqual([])
    expect(getJobCalendarOccurrences({ schedule: 'every 60s', enabled: true, everyMs: 60000, anchorMs: 30000 }, 60000, 240000).map(r => r.atMs)).toEqual([90000, 150000, 210000])
    expect(getJobCalendarOccurrences({ schedule: 'at 2026-09-08T10:00:00Z', enabled: true }, Date.parse('2026-09-08T00:00:00Z'), Date.parse('2026-09-09T00:00:00Z'))).toHaveLength(1)
  })
})
