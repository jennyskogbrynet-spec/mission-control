// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mock = vi.hoisted(() => ({ send: vi.fn(), query: vi.fn(), actor: { username: 'operator', workspace_id: 1 }, activity: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireRole: () => ({ user: mock.actor }) }))
vi.mock('@/lib/db', () => ({ getDatabase: () => ({ prepare: () => ({ get: mock.query }) }), db_helpers: { createNotification: vi.fn(), logActivity: mock.activity } }))
vi.mock('@/lib/agent-delivery', () => ({ getAgentCommandSession: () => 'agent:research:mc', sendAgentCommand: mock.send }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/injection-guard', () => ({ scanForInjection: () => ({ safe: true }) }))
vi.mock('@/lib/secret-scanner', () => ({ scanForSecrets: () => [] }))
vi.mock('@/lib/security-events', () => ({ logSecurityEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
import { POST } from './route'

const request = (body: unknown) => new NextRequest('http://localhost/api/agents/message', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': '12345678-1234-4234-a234-123456789012' }, body: JSON.stringify(body),
})
describe('direct command API', () => {
  beforeEach(() => { vi.clearAllMocks(); mock.query.mockReturnValue({ id: 2, name: 'Research', session_key: null, config: '{"openclawId":"research"}' }) })
  it('accepts the command UI message contract without a saved session key and preserves the retry key', async () => {
    mock.send.mockResolvedValueOnce({ status: 'accepted', runId: 'one' })
    const response = await POST(request({ to: 'Research', message: 'Small task' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, status: 'accepted', runId: 'one' })
    expect(mock.query).toHaveBeenCalledWith('Research', 1)
    expect(mock.send).toHaveBeenCalledWith('agent:research:mc', 'Message from operator: Small task', '12345678-1234-4234-a234-123456789012')
  })
  it('rejects the former content-only payload before sending', async () => {
    const response = await POST(request({ to: 'Research', content: 'Small task' }))
    expect(response.status).toBe(400)
    expect(mock.send).not.toHaveBeenCalled()
  })
  it('reports unknown delivery honestly and does not log success or retry', async () => {
    mock.send.mockRejectedValueOnce(new Error('timeout'))
    const response = await POST(request({ to: 'Research', message: 'Small task' }))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ status: 'outcome_unknown' })
    expect(mock.send).toHaveBeenCalledTimes(1)
    expect(mock.activity).not.toHaveBeenCalled()
  })
})
