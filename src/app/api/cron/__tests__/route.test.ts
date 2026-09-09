// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const { rpc, auth } = vi.hoisted(() => ({ rpc: vi.fn(), auth: vi.fn() }))
vi.mock('@/lib/openclaw-gateway', () => ({ callOpenClawGateway: rpc }))
vi.mock('@/lib/auth', () => ({ requireRole: auth }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }))
import { GET, POST } from '../route'
const job = { id: 'real-id', name: 'Existing', enabled: true, schedule: { kind: 'cron', expr: '0 6 * * *' }, sessionTarget: 'isolated', wakeMode: 'now', payload: { kind: 'agentTurn', message: 'test' } }
const request = (body: unknown) => new NextRequest('http://localhost/api/cron', { method: 'POST', body: JSON.stringify(body) })
beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs()
  auth.mockReturnValue({ user: { workspace_id: 1, tenant_id: 1 } })
  rpc.mockImplementation(async method => method === 'cron.run' ? { ok: true, enqueued: true, runId: 'manual:test' } : { jobs: [job] })
})
describe('cron route uses the scheduler', () => {
  it.each(['toggle', 'remove', 'trigger', 'clone'])('never resolves an explicit missing jobId as another job name for %s', async action => {
    vi.stubEnv('MISSION_CONTROL_ALLOW_COMMAND_TRIGGER', '1')
    rpc.mockResolvedValueOnce({ jobs: [job, { ...job, id: 'other-id', name: 'missing-id' }] })
    expect((await POST(request({ action, jobId: 'missing-id', jobName: job.name }))).status).toBe(404)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('cron.list', expect.anything(), expect.anything())
  })
  it.each([null, '', ' ', 12, false, [], {}])('rejects an invalid explicit jobId without falling back to jobName: %j', async jobId => {
    expect((await POST(request({ action: 'toggle', jobId, jobName: job.name }))).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('resolves a legacy name only as a unique exact name, never as an ID', async () => {
    rpc.mockResolvedValueOnce({ jobs: [{ ...job, id: job.name, name: 'Unrelated' }, job] })
    expect((await POST(request({ action: 'toggle', jobName: job.name, enabled: false }))).status).toBe(200)
    expect(rpc).toHaveBeenLastCalledWith('cron.update', { id: job.id, patch: { enabled: false } })
  })
  it('rejects ambiguous legacy names before mutation but permits explicit IDs', async () => {
    const duplicateJobs = [job, { ...job, id: 'second-id' }]
    rpc.mockResolvedValueOnce({ jobs: duplicateJobs })
    const response = await POST(request({ action: 'remove', jobName: job.name }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('jobId') })
    expect(rpc).toHaveBeenCalledTimes(1)
    rpc.mockResolvedValueOnce({ jobs: duplicateJobs })
    expect((await POST(request({ action: 'remove', jobId: 'second-id' }))).status).toBe(200)
    expect(rpc).toHaveBeenLastCalledWith('cron.remove', { id: 'second-id' })
  })
  it.each([
    ['not-due', 'not due yet'], ['already-running', 'already running'],
    ['invalid-spec', 'configuration is invalid'], ['restart-recovery-pending', 'recovering after a restart'],
  ])('preserves the scheduler refusal and explains why no run started: %s', async (reason, message) => {
    vi.stubEnv('MISSION_CONTROL_ALLOW_COMMAND_TRIGGER', '1')
    rpc.mockResolvedValueOnce({ jobs: [job] }).mockResolvedValueOnce({ ok: true, ran: false, reason })
    const response = await POST(request({ action: 'trigger', jobId: job.id }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: false, error: expect.stringContaining(message), result: { ran: false, reason } })
  })
  it.each([{ ok: true, enqueued: true, runId: 'manual:test' }, { ok: true, ran: true }])('preserves confirmed queued or finished receipts: %j', async result => {
    vi.stubEnv('MISSION_CONTROL_ALLOW_COMMAND_TRIGGER', '1')
    rpc.mockResolvedValueOnce({ jobs: [job] }).mockResolvedValueOnce(result)
    const response = await POST(request({ action: 'trigger', jobId: job.id }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, result })
  })
  it.each([{ ok: true }, { ok: false }, { enqueued: true }])('does not report an ambiguous or failed run receipt as success: %j', async result => {
    vi.stubEnv('MISSION_CONTROL_ALLOW_COMMAND_TRIGGER', '1')
    rpc.mockResolvedValueOnce({ jobs: [job] }).mockResolvedValueOnce(result)
    expect((await POST(request({ action: 'trigger', jobId: job.id }))).status).toBe(503)
    expect(rpc).toHaveBeenCalledTimes(2)
  })
  it.each([{ workspace_id: 2, tenant_id: 1 }, { workspace_id: 1, tenant_id: 2 }, {}])('denies non-primary or missing scope before gateway access: %j', async scope => {
    auth.mockReturnValue({ user: { role: 'admin', ...scope } })
    for (const action of ['list', 'history', 'logs']) {
      expect((await GET(new NextRequest(`http://localhost/api/cron?action=${action}&jobId=real-id&job=real-id`))).status).toBe(403)
    }
    for (const action of ['add', 'toggle', 'trigger', 'remove', 'clone']) {
      expect((await POST(request({ action, jobId: 'real-id', name: 'New', command: 'test', schedule: '0 * * * *' }))).status).toBe(403)
    }
    expect(rpc).not.toHaveBeenCalled()
  })
  it('fails visibly when the gateway is unavailable', async () => {
    rpc.mockRejectedValueOnce(new Error('unavailable'))
    const response = await GET(new NextRequest('http://localhost/api/cron?action=list'))
    expect(response.status).toBe(503)
    expect(await response.json()).not.toHaveProperty('jobs')
  })
  it('requires admin before accessing global schedules', async () => {
    auth.mockReturnValueOnce({ error: 'Forbidden', status: 403 })
    expect((await GET(new NextRequest('http://localhost/api/cron?action=list'))).status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('uses explicit desired enabled state rather than toggling stale file state', async () => {
    expect((await POST(request({ action: 'toggle', jobId: 'real-id', enabled: true }))).status).toBe(200)
    expect(rpc).toHaveBeenLastCalledWith('cron.update', { id: 'real-id', patch: { enabled: true } })
  })
  it('uses real cron.run due mode and retains the manual execution gate', async () => {
    expect((await POST(request({ action: 'trigger', jobId: 'real-id' }))).status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
    vi.stubEnv('MISSION_CONTROL_ALLOW_COMMAND_TRIGGER', '1')
    expect((await POST(request({ action: 'trigger', jobId: 'real-id', mode: 'due' }))).status).toBe(200)
    expect(rpc).toHaveBeenLastCalledWith('cron.run', { id: 'real-id', mode: 'due' })
  })
  it('never replaces an existing same-name job on add', async () => {
    expect((await POST(request({ action: 'add', name: 'Existing', schedule: '0 * * * *', command: 'test' }))).status).toBe(409)
    expect(rpc).toHaveBeenCalledTimes(1)
  })
  it('creates real gateway jobs with bounded agent runtime and no delivery', async () => {
    expect((await POST(request({ action: 'add', name: 'New', schedule: '0 * * * *', command: 'test' }))).status).toBe(200)
    expect(rpc).toHaveBeenLastCalledWith('cron.add', expect.objectContaining({ name: 'New', sessionTarget: 'isolated', delivery: { mode: 'none' }, payload: expect.objectContaining({ timeoutSeconds: 300 }) }))
  })
  it('validates malformed history pages and bodies before RPC', async () => {
    expect((await GET(new NextRequest('http://localhost/api/cron?action=history&jobId=a&page=NaN'))).status).toBe(400)
    expect((await POST(new NextRequest('http://localhost/api/cron', { method: 'POST', body: '{broken' }))).status).toBe(400)
    expect((await POST(request({ action: 'add', name: 'New', schedule: '99 * * * *', command: 'test' }))).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('clones without creating another active automation', async () => {
    const response = await POST(request({ action: 'clone', jobId: 'real-id' }))
    expect(await response.json()).toMatchObject({ enabled: false, clonedName: 'Existing (copy)' })
    expect(rpc).toHaveBeenLastCalledWith('cron.add', expect.objectContaining({ enabled: false }))
  })
})
