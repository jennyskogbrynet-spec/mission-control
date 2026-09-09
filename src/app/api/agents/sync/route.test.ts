// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mock = vi.hoisted(() => ({ role: vi.fn(), sync: vi.fn(), local: vi.fn(), preview: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireRole: mock.role }))
vi.mock('@/lib/agent-sync', () => ({ syncAgentsFromConfig: mock.sync, previewSyncDiff: mock.preview }))
vi.mock('@/lib/local-agent-sync', () => ({ syncLocalAgents: mock.local }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
import { GET, POST } from './route'
beforeEach(() => { vi.clearAllMocks(); mock.role.mockReturnValue({ user: { username: 'admin', workspace_id: 1, tenant_id: 1 } }) })
describe('local agent sync access', () => {
  it.each([{ workspace_id: 2, tenant_id: 1 }, { workspace_id: 1, tenant_id: 2 }, {}])('denies another or missing scope before any disk or database operation: %j', async scope => {
    mock.role.mockReturnValue({ user: { username: 'other-admin', ...scope } })
    for (const suffix of ['', '?source=local']) {
      expect((await POST(new NextRequest(`http://localhost/api/agents/sync${suffix}`, { method: 'POST' }))).status).toBe(403)
    }
    expect((await GET(new NextRequest('http://localhost/api/agents/sync'))).status).toBe(403)
    expect(mock.sync).not.toHaveBeenCalled()
    expect(mock.local).not.toHaveBeenCalled()
    expect(mock.preview).not.toHaveBeenCalled()
  })
  it('permits the primary admin and records the actual actor', async () => {
    mock.sync.mockResolvedValueOnce({ synced: 1 })
    mock.local.mockResolvedValueOnce({ ok: true, message: 'Synced' })
    mock.preview.mockResolvedValueOnce({ inConfig: 1 })
    expect((await POST(new NextRequest('http://localhost/api/agents/sync', { method: 'POST' }))).status).toBe(200)
    expect((await POST(new NextRequest('http://localhost/api/agents/sync?source=local', { method: 'POST' }))).status).toBe(200)
    expect((await GET(new NextRequest('http://localhost/api/agents/sync'))).status).toBe(200)
    expect(mock.sync).toHaveBeenCalledWith('admin')
    expect(mock.local).toHaveBeenCalledWith('admin')
  })
  it('does not report a failed local sync as HTTP success', async () => {
    mock.local.mockResolvedValueOnce({ ok: false, message: 'Failed' })
    expect((await POST(new NextRequest('http://localhost/api/agents/sync?source=local', { method: 'POST' }))).status).toBe(500)
  })
})
