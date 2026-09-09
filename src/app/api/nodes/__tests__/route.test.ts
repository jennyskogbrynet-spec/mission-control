// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const { rpc, auth } = vi.hoisted(() => ({ rpc: vi.fn(), auth: vi.fn() }))
vi.mock('@/lib/openclaw-gateway', () => ({ callOpenClawGateway: rpc }))
vi.mock('@/lib/auth', () => ({ requireRole: auth }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
import { GET, POST } from '../route'
beforeEach(() => { vi.clearAllMocks(); auth.mockReturnValue({ user: { workspace_id: 1, tenant_id: 1 } }) })
describe('nodes distinguish empty from unavailable', () => {
  it.each([{ workspace_id: 2, tenant_id: 1 }, { workspace_id: 1, tenant_id: 2 }, {}])('denies non-primary or missing scope before gateway access: %j', async scope => {
    auth.mockReturnValue({ user: { role: 'admin', ...scope } })
    for (const action of ['list', 'devices']) {
      expect((await GET(new NextRequest(`http://localhost/api/nodes?action=${action}`))).status).toBe(403)
    }
    for (const action of ['approve', 'reject', 'rotate-token', 'revoke-token']) {
      const response = await POST(new NextRequest('http://localhost/api/nodes', { method: 'POST', body: JSON.stringify({ action, requestId: 'pending-id', deviceId: 'paired-id' }) }))
      expect(response.status).toBe(403)
    }
    expect(rpc).not.toHaveBeenCalled()
  })
  it('permits primary-workspace device management', async () => {
    rpc.mockResolvedValueOnce({ ok: true })
    const response = await POST(new NextRequest('http://localhost/api/nodes', { method: 'POST', body: JSON.stringify({ action: 'reject', requestId: 'pending-id' }) }))
    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('device.pair.reject', { requestId: 'pending-id' }, 10000)
  })
  it('reports an authenticated empty node response as healthy', async () => {
    rpc.mockResolvedValueOnce({ nodes: [] })
    const response = await GET(new NextRequest('http://localhost/api/nodes'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ nodes: [], connected: true })
  })
  it('does not report successful empty data when the RPC fails', async () => {
    rpc.mockRejectedValueOnce(new Error('private gateway details'))
    const response = await GET(new NextRequest('http://localhost/api/nodes'))
    expect(response.status).toBe(502)
    const data = await response.json()
    expect(data.connected).toBe(false)
    expect(data).not.toHaveProperty('nodes')
    expect(data.error).not.toContain('private')
  })
  it('preserves paired and pending devices returned by current OpenClaw', async () => {
    rpc.mockResolvedValueOnce({ paired: [{ deviceId: 'paired-id' }], pending: [{ requestId: 'pending-id' }] })
    const response = await GET(new NextRequest('http://localhost/api/nodes?action=devices'))
    expect(await response.json()).toMatchObject({ paired: [{ deviceId: 'paired-id' }], pending: [{ requestId: 'pending-id' }], connected: true })
  })
  it('rejects malformed successful RPC data as unavailable', async () => {
    rpc.mockResolvedValueOnce({ result: 'not a list' })
    expect((await GET(new NextRequest('http://localhost/api/nodes?action=devices'))).status).toBe(502)
  })
})
