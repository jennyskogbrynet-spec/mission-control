// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mock = vi.hoisted(() => ({ send: vi.fn(), activity: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireRole: () => ({ user: { username: 'operator', workspace_id: 1 } }) }))
vi.mock('@/lib/db', () => ({ getDatabase: () => ({ prepare: () => ({ get: () => ({ id: 2, name: 'Research' }) }) }), db_helpers: { logActivity: mock.activity } }))
vi.mock('@/lib/agent-delivery', () => ({ getAgentCommandSession: () => 'agent:research:mc', sendAgentCommand: mock.send }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
import { POST } from './route'
const key = '12345678-1234-4234-a234-123456789012'
const request = (id = key) => new NextRequest('http://localhost/api/agents/Research/wake', { method: 'POST', headers: { 'Idempotency-Key': id }, body: JSON.stringify({ message: 'Check pending work' }) })
const params = () => ({ params: Promise.resolve({ id: 'Research' }) })
beforeEach(() => vi.clearAllMocks())
describe('wake delivery identity', () => {
  it('passes the same caller key on a retry after unknown delivery', async () => {
    mock.send.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ status: 'accepted', runId: 'one', idempotencyKey: key })
    expect((await POST(request(), params())).status).toBe(502)
    expect(mock.activity).not.toHaveBeenCalled()
    const retry = await POST(request(), params())
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ status: 'accepted', idempotencyKey: key })
    expect(mock.send.mock.calls[0]).toEqual(['agent:research:mc', 'Check pending work', key])
    expect(mock.send.mock.calls[1]).toEqual(mock.send.mock.calls[0])
  })
  it('rejects malformed request keys before gateway invocation', async () => {
    expect((await POST(request('invalid'), params())).status).toBe(400)
    expect(mock.send).not.toHaveBeenCalled()
  })
})
