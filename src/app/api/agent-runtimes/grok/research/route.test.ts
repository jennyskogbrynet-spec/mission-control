// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mock = vi.hoisted(() => ({ role: vi.fn(), start: vi.fn(), get: vi.fn(), list: vi.fn(() => []), cancel: vi.fn(), secrets: vi.fn(() => []) }))
vi.mock('@/lib/auth', () => ({ requireRole: mock.role }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/secret-scanner', () => ({ scanForSecrets: mock.secrets }))
vi.mock('@/lib/grok-research', () => ({ startGrokResearch: mock.start, getGrokResearchRun: mock.get, listGrokResearchRuns: mock.list, cancelGrokResearch: mock.cancel }))
import { POST, GET, DELETE } from './route'
const req = (body: unknown) => new NextRequest('http://localhost/api/agent-runtimes/grok/research', { method: 'POST', body: JSON.stringify(body) })
describe('Grok research API', () => {
  beforeEach(() => { vi.clearAllMocks(); mock.role.mockReturnValue({ user: { workspace_id: 1, tenant_id: 1 } }) })
  it.each([{ workspace_id: 2, tenant_id: 1 }, { workspace_id: 1, tenant_id: 2 }, { workspace_id: 1 }, { tenant_id: 1 }, {}])('rejects non-primary or missing scope before local research access: %j', async scope => {
    mock.role.mockReturnValue({ user: { role: 'admin', ...scope } })
    for (const suffix of ['', '?id=one']) {
      expect((await GET(new NextRequest(`http://localhost/api/agent-runtimes/grok/research${suffix}`))).status).toBe(403)
    }
    expect((await POST(req({ prompt: 'Public docs', idempotencyKey: 'one' }))).status).toBe(403)
    expect((await DELETE(new NextRequest('http://localhost/api/agent-runtimes/grok/research?id=one'))).status).toBe(403)
    expect(mock.start).not.toHaveBeenCalled()
    expect(mock.get).not.toHaveBeenCalled()
    expect(mock.list).not.toHaveBeenCalled()
    expect(mock.cancel).not.toHaveBeenCalled()
    expect(mock.secrets).not.toHaveBeenCalled()
  })
  it('requires operator access and keeps other workspaces away from the local runtime', async () => {
    mock.role.mockReturnValueOnce({ error: 'Forbidden', status: 403 })
    expect((await POST(req({}))).status).toBe(403)
    mock.role.mockReturnValueOnce({ user: { workspace_id: 2 } })
    expect((await POST(req({ prompt: 'Public docs', idempotencyKey: 'one' }))).status).toBe(403)
    expect(mock.start).not.toHaveBeenCalled()
  })
  it('requires a request key and returns accepted with the concrete run', async () => {
    expect((await POST(req({ prompt: 'Public docs' }))).status).toBe(400)
    mock.start.mockReturnValueOnce({ id: 'one', status: 'running' })
    const response = await POST(req({ prompt: 'Public docs', idempotencyKey: 'one' }))
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ run: { id: 'one', status: 'running' } })
  })
  it('returns saved results and only cancels an owned active run', async () => {
    mock.get.mockReturnValueOnce({ id: 'one', status: 'completed', reply: 'Source' })
    expect((await GET(new NextRequest('http://localhost/api/agent-runtimes/grok/research?id=one'))).status).toBe(200)
    mock.cancel.mockReturnValueOnce(false)
    expect((await DELETE(new NextRequest('http://localhost/api/agent-runtimes/grok/research?id=one'))).status).toBe(409)
  })
})
