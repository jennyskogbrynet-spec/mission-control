// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), cli: vi.fn(), command: vi.fn(), latest: vi.fn(), policy: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireRole: mocks.auth }))
vi.mock('@/lib/command', () => ({ runOpenClaw: mocks.cli, runCommand: mocks.command }))
vi.mock('@/lib/config', () => ({ config: { openclawStateDir: '/fixture/.openclaw' } }))
vi.mock('@/lib/db', () => ({ getDatabase: () => ({ prepare: () => ({ run: mocks.audit }) }) }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/openclaw-upgrade-policy', async (original) => ({
  ...await original<typeof import('@/lib/openclaw-upgrade-policy')>(),
  getLatestOpenClawRelease: mocks.latest, getOpenClawUpgradePolicy: mocks.policy,
}))
import { POST } from '../update/route'
import { GET } from '../version/route'
const request = () => new Request('http://localhost/api/openclaw/update', { method: 'POST' })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockReturnValue({ user: { username: 'test', role: 'admin', workspace_id: 1, tenant_id: 1 } })
  mocks.cli.mockResolvedValue({ stdout: 'OpenClaw 2026.7.1-2 (0790d9f)' })
  mocks.latest.mockResolvedValue({ latest: '2026.9.2', releaseUrl: 'https://github.com/openclaw/openclaw/releases/tag/v2026.9.2', releaseNotes: 'notes' })
  mocks.policy.mockReturnValue({ guardPath: '/fixture/.openclaw/scripts/safe-openclaw-update.sh', updateBlocked: true, updateBlockedReason: '2026.9.2: scheduler regression', updateCommand: null })
  mocks.command.mockResolvedValue({ stdout: 'healthy', code: 0 })
})

describe('OpenClaw update routes', () => {
  it('reports the real installed suffix and a held latest release without unsafe command', async () => {
    const response = await GET(new Request('http://localhost/api/openclaw/version'))
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({ installed: '2026.7.1-2', latest: '2026.9.2', updateAvailable: true, updateBlocked: true, updateCommand: null, canUpdate: false })
  })
  it('rejects held upgrades before any mutation', async () => {
    const response = await POST(request())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ updateBlocked: true, detail: '2026.9.2: scheduler regression' })
    expect(mocks.command).not.toHaveBeenCalled()
    expect(mocks.cli).toHaveBeenCalledTimes(1)
    expect(mocks.cli).toHaveBeenCalledWith(['--version'], expect.any(Object))
  })
  it.each([{ workspace_id: 2, tenant_id: 1 }, { workspace_id: 1, tenant_id: 2 }])('rejects non-primary scope %j without touching local runtime', async (scope) => {
    mocks.auth.mockReturnValue({ user: { username: 'test', role: 'admin', ...scope } })
    expect((await POST(request())).status).toBe(403)
    expect((await GET(new Request('http://localhost/api/openclaw/version'))).status).toBe(403)
    expect(mocks.cli).not.toHaveBeenCalled()
    expect(mocks.command).not.toHaveBeenCalled()
  })
  it('enforces admin authentication before mutations', async () => {
    mocks.auth.mockReturnValue({ error: 'Forbidden', status: 403 })
    expect((await POST(request())).status).toBe(403)
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), 'admin')
    expect(mocks.command).not.toHaveBeenCalled()
  })
  it('runs only the guarded wrapper with full backup and no destructive process timeout', async () => {
    mocks.policy.mockReturnValue({ guardPath: '/fixture/.openclaw/scripts/safe-openclaw-update.sh', updateBlocked: false, updateBlockedReason: null })
    mocks.cli.mockResolvedValueOnce({ stdout: 'OpenClaw 2026.7.1-2 (0790d9f)' }).mockResolvedValueOnce({ stdout: 'OpenClaw 2026.9.2 (3928bad)' })
    expect((await POST(request())).status).toBe(200)
    expect(mocks.command).toHaveBeenCalledWith('/bin/bash', ['/fixture/.openclaw/scripts/safe-openclaw-update.sh', '2026.9.2'], expect.objectContaining({ env: expect.objectContaining({ OC_BACKUP_FULL_SQLITE: '1' }) }))
    expect(mocks.command.mock.calls[0][2].timeoutMs).toBeUndefined()
    expect(mocks.cli.mock.calls.every(([args]) => JSON.stringify(args) === JSON.stringify(['--version']))).toBe(true)
  })
  it('does not report success when recovery keeps the old version', async () => {
    mocks.policy.mockReturnValue({ guardPath: '/fixture/guard.sh', updateBlocked: false })
    expect((await POST(request())).status).toBe(500)
  })
})
