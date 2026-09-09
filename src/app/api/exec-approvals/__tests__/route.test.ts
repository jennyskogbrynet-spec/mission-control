// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'node:fs/promises'
const { rpc, auth } = vi.hoisted(() => ({ rpc: vi.fn(), auth: vi.fn() }))
vi.mock('@/lib/openclaw-gateway', () => ({ callOpenClawGateway: rpc }))
vi.mock('@/lib/auth', () => ({ requireRole: auth }))
vi.mock('@/lib/config', () => ({ config: { openclawHome: '/unused' } }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
import { GET, POST, PUT } from '../route'
beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); auth.mockReturnValue({ user: { workspace_id: 1, tenant_id: 1 } }) })
const request = (body: unknown) => new NextRequest('http://localhost/api/exec-approvals', { method: 'POST', body: JSON.stringify(body) })
describe('acknowledged execution approval routes', () => {
  it.each([{ workspace_id: 2, tenant_id: 1 }, { workspace_id: 1, tenant_id: 2 }, {}])('denies non-primary or missing scope before gateway or local policy access: %j', async scope => {
    auth.mockReturnValue({ user: { role: 'admin', ...scope } })
    const read = vi.spyOn(fs, 'readFile').mockResolvedValue('{"version":1,"agents":{}}')
    const write = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined)
    const mkdir = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined)
    for (const suffix of ['', '?action=allowlist']) {
      expect((await GET(new NextRequest(`http://localhost/api/exec-approvals${suffix}`))).status).toBe(403)
    }
    for (const action of ['approve', 'deny', 'always_allow']) {
      expect((await POST(request({ id: 'test', action }))).status).toBe(403)
    }
    expect((await PUT(new NextRequest('http://localhost/api/exec-approvals', { method: 'PUT', body: JSON.stringify({ agents: { main: [{ pattern: '*' }] } }) }))).status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  })
  it('loads pending requests from actual gateway RPC', async () => {
    rpc.mockResolvedValueOnce([{ id: 'test', request: { agentId: 'ines', command: 'echo test' }, createdAtMs: 10 }])
    const response = await GET(new NextRequest('http://localhost/api/exec-approvals'))
    expect(await response.json()).toMatchObject({ approvals: [{ id: 'test', agentName: 'ines', command: 'echo test', status: 'pending' }] })
    expect(rpc).toHaveBeenCalledWith('exec.approval.list', {}, 10000)
  })
  it('does not hide unavailable approval queues as empty', async () => {
    rpc.mockRejectedValueOnce(new Error('offline'))
    expect((await GET(new NextRequest('http://localhost/api/exec-approvals'))).status).toBe(502)
  })
  it('requires explicit gateway acknowledgment before reporting success', async () => {
    rpc.mockResolvedValueOnce({ ok: false })
    expect((await POST(request({ id: 'test', action: 'approve' }))).status).toBe(502)
    rpc.mockResolvedValueOnce({ ok: true })
    const response = await POST(request({ id: 'test', action: 'deny' }))
    expect(await response.json()).toEqual({ ok: true, id: 'test', decision: 'deny' })
    expect(rpc).toHaveBeenLastCalledWith('exec.approval.resolve', { id: 'test', decision: 'deny' }, 10000)
  })
  it('enforces authorization and decision validation before RPC', async () => {
    expect((await POST(request({ id: 'test', action: 'execute' }))).status).toBe(400)
    auth.mockReturnValue({ error: 'Forbidden', status: 403 })
    expect((await POST(request({ id: 'test', action: 'approve' }))).status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })
})
