// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mock = vi.hoisted(() => ({
  send: vi.fn(), query: vi.fn(), settings: vi.fn(), prepare: vi.fn(),
  auth: vi.fn(), limiter: vi.fn(), injection: vi.fn(), notification: vi.fn(),
  activity: vi.fn(), security: vi.fn(), warn: vi.fn(), error: vi.fn(),
  actor: { username: 'operator', workspace_id: 1, tenant_id: 7 },
}))
vi.mock('@/lib/auth', () => ({ requireRole: mock.auth }))
vi.mock('@/lib/db', () => ({
  getDatabase: () => ({ prepare: mock.prepare }),
  db_helpers: { createNotification: mock.notification, logActivity: mock.activity },
}))
vi.mock('@/lib/agent-delivery', () => ({ getAgentCommandSession: () => 'agent:research:mc', sendAgentCommand: mock.send }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: mock.limiter }))
vi.mock('@/lib/injection-guard', () => ({ scanForInjection: mock.injection }))
// Keep the real profile resolver and credential scanner; only their DB/transport are mocked.
vi.mock('@/lib/security-events', () => ({ logSecurityEvent: mock.security }))
vi.mock('@/lib/logger', () => ({ logger: { error: mock.error, warn: mock.warn } }))
import { POST } from './route'

const retryKey = '12345678-1234-4234-a234-123456789012'
const request = (body: unknown) => new NextRequest('http://localhost/api/agents/message', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': retryKey }, body: JSON.stringify(body),
})
// Deliberately synthetic, recognized by the existing scanner; never sent outside mocked transport.
const credential = 'AKIAIOSFODNN7EXAMPLE'
const assertNoPayloadSideEffects = () => {
  expect(mock.send).not.toHaveBeenCalled()
  expect(mock.notification).not.toHaveBeenCalled()
  expect(mock.activity).not.toHaveBeenCalled()
}

describe('direct command API', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mock.auth.mockReturnValue({ user: mock.actor })
    mock.limiter.mockReturnValue(null)
    mock.injection.mockReturnValue({ safe: true, matches: [] })
    mock.settings.mockReturnValue({ value: 'strict' })
    mock.prepare.mockImplementation((sql: string) => ({ get: sql.includes('FROM settings') ? mock.settings : mock.query }))
    mock.query.mockReturnValue({ id: 2, name: 'Research', session_key: null, config: '{"openclawId":"research"}' })
    mock.send.mockResolvedValue({ status: 'accepted', runId: 'one' })
  })

  it('dispatches one clean strict-profile message and preserves the retry key and workspace query', async () => {
    const response = await POST(request({ to: 'Research', message: 'Small task' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, status: 'accepted', runId: 'one' })
    expect(mock.settings).toHaveBeenCalledTimes(1)
    expect(mock.query).toHaveBeenCalledWith('Research', 1)
    expect(mock.send).toHaveBeenCalledTimes(1)
    expect(mock.send).toHaveBeenCalledWith('agent:research:mc', 'Message from operator: Small task', retryKey)
    expect(mock.notification).toHaveBeenCalledTimes(1)
    expect(mock.activity).toHaveBeenCalledTimes(1)
    expect(mock.security).not.toHaveBeenCalled()
  })

  it('blocks a strict secret match before dispatch, notification, recipient lookup or payload storage', async () => {
    const response = await POST(request({ to: 'Research', message: `Use ${credential} ${credential}` }))
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body).toEqual({ error: 'Message blocked: remove credentials before sending', secretTypes: ['aws_access_key'] })
    expect(mock.query).not.toHaveBeenCalled()
    assertNoPayloadSideEffects()
    expect(mock.security).toHaveBeenCalledTimes(1)
    expect(mock.security).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: 1, tenant_id: 7, detail: JSON.stringify({ count: 2, types: ['aws_access_key'], blocked: true }) }))
    const observable = JSON.stringify([body, mock.security.mock.calls, mock.warn.mock.calls, mock.error.mock.calls])
    expect(observable).not.toContain(credential)
    expect(observable).not.toContain('redactedPreview')
    expect(observable).not.toContain('position')
  })

  it('keeps the strict block when the metadata-only audit event fails', async () => {
    mock.security.mockImplementation(() => { throw new Error('audit unavailable') })
    const response = await POST(request({ to: 'Research', message: credential }))
    expect(response.status).toBe(422)
    assertNoPayloadSideEffects()
    expect(mock.error).not.toHaveBeenCalled()
  })

  it.each(['standard', 'minimal'])('preserves the nonblocking %s profile and redacts the notification preview', async (profile) => {
    mock.settings.mockReturnValue({ value: profile })
    const response = await POST(request({ to: 'Research', message: `Use ${credential}` }))
    expect(response.status).toBe(200)
    expect(mock.send).toHaveBeenCalledTimes(1)
    expect(mock.send.mock.calls[0][1]).toContain(credential)
    expect(mock.notification).toHaveBeenCalledTimes(1)
    expect(mock.notification.mock.calls[0][3]).not.toContain(credential)
    expect(mock.notification.mock.calls[0][3]).toContain('REDACTED')
    expect(mock.security).toHaveBeenCalledTimes(profile === 'standard' ? 1 : 0)
  })

  it.each([2, undefined])('rejects nonprimary or missing workspace %s before accessing global policy or gateway', async (workspace) => {
    mock.auth.mockReturnValue({ user: { ...mock.actor, workspace_id: workspace } })
    const response = await POST(request({ to: 'Research', message: credential }))
    expect(response.status).toBe(403)
    expect(mock.prepare).not.toHaveBeenCalled()
    expect(mock.injection).not.toHaveBeenCalled()
    expect(mock.security).not.toHaveBeenCalled()
    assertNoPayloadSideEffects()
  })

  it('rejects unauthorized requests before reading policy or dispatching', async () => {
    mock.auth.mockReturnValue({ error: 'Forbidden', status: 403 })
    const response = await POST(request({ to: 'Research', message: credential }))
    expect(response.status).toBe(403)
    expect(mock.auth).toHaveBeenCalledWith(expect.any(NextRequest), 'operator')
    expect(mock.prepare).not.toHaveBeenCalled()
    expect(mock.security).not.toHaveBeenCalled()
    assertNoPayloadSideEffects()
  })

  it('preserves critical-injection rejection even for a nonblocking profile', async () => {
    mock.settings.mockReturnValue({ value: 'minimal' })
    mock.injection.mockReturnValue({ safe: false, matches: [{ severity: 'critical', rule: 'fixture', description: 'Synthetic unsafe instruction' }] })
    const response = await POST(request({ to: 'Research', message: 'Synthetic unsafe instruction' }))
    expect(response.status).toBe(422)
    expect(mock.settings).not.toHaveBeenCalled()
    assertNoPayloadSideEffects()
  })

  it('rejects the former content-only payload before reading policy or sending', async () => {
    const response = await POST(request({ to: 'Research', content: 'Small task' }))
    expect(response.status).toBe(400)
    expect(mock.settings).not.toHaveBeenCalled()
    assertNoPayloadSideEffects()
  })

  it('fails closed without retry when policy lookup is unavailable', async () => {
    mock.settings.mockImplementation(() => { throw new Error('settings unavailable') })
    const response = await POST(request({ to: 'Research', message: credential }))
    expect(response.status).toBe(502)
    assertNoPayloadSideEffects()
    expect(mock.query).not.toHaveBeenCalled()
  })

  it('reports unknown delivery honestly and does not log success or retry', async () => {
    mock.send.mockRejectedValueOnce(new Error('timeout'))
    const response = await POST(request({ to: 'Research', message: 'Small task' }))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ status: 'outcome_unknown' })
    expect(mock.send).toHaveBeenCalledTimes(1)
    expect(mock.activity).not.toHaveBeenCalled()
    expect(mock.notification).not.toHaveBeenCalled()
  })

  it('does not persist credentials echoed by a failed permitted dispatch', async () => {
    mock.settings.mockReturnValue({ value: 'standard' })
    mock.send.mockRejectedValueOnce(new Error(`gateway failed with ${credential}`))
    const response = await POST(request({ to: 'Research', message: credential }))
    expect(response.status).toBe(502)
    expect(JSON.stringify([await response.json(), mock.error.mock.calls, mock.security.mock.calls])).not.toContain(credential)
    expect(mock.send).toHaveBeenCalledTimes(1)
    expect(mock.notification).not.toHaveBeenCalled()
    expect(mock.activity).not.toHaveBeenCalled()
  })
})
