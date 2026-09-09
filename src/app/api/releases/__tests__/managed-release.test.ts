// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), exec: vi.fn(), readFile: vi.fn(), audit: vi.fn(), fetch: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireRole: mocks.auth }))
vi.mock('child_process', () => ({ execFileSync: mocks.exec }))
vi.mock('fs', () => ({ readFileSync: mocks.readFile, existsSync: () => false }))
vi.mock('node:fs', () => ({ readFileSync: mocks.readFile, existsSync: () => false }))
vi.mock('@/lib/db', () => ({ getDatabase: () => ({ prepare: () => ({ run: mocks.audit }) }) }))
vi.mock('@/lib/version', () => ({ APP_VERSION: '2.0.1' }))
import { POST } from '../update/route'
import { GET } from '../check/route'

const request = () => new Request('http://localhost/api/releases/update', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetVersion: '3.0.0' }),
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('MC_MANAGED_RELEASE', '1')
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.auth.mockReturnValue({ user: { username: 'test', role: 'admin', workspace_id: 1, tenant_id: 1 } })
  mocks.exec.mockReturnValue('')
  mocks.readFile.mockReturnValue(JSON.stringify({ version: '3.0.0' }))
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ tag_name: 'v3.0.0', html_url: 'https://example.com/release', body: 'notes' }) })
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('Managed Mission Control release routes', () => {
  it('blocks direct updates before any command or file access', async () => {
    const response = await POST(request())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ managedRelease: true, error: 'Updates for this customized dashboard are tested and installed together.' })
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
  })
  it.each([{ workspace_id: 2, tenant_id: 1 }, { workspace_id: 1, tenant_id: 2 }])('rejects non-primary scope %j even without managed mode', async (scope) => {
    vi.stubEnv('MC_MANAGED_RELEASE', '')
    mocks.auth.mockReturnValue({ user: { username: 'test', role: 'admin', ...scope } })
    expect((await POST(request())).status).toBe(403)
    expect(mocks.exec).not.toHaveBeenCalled()
  })
  it('requires administrator authentication', async () => {
    mocks.auth.mockReturnValue({ error: 'Forbidden', status: 403 })
    expect((await POST(request())).status).toBe(403)
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), 'admin')
    expect(mocks.exec).not.toHaveBeenCalled()
  })
  it('preserves the normal upstream flow when managed mode is unset', async () => {
    vi.stubEnv('MC_MANAGED_RELEASE', undefined)
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, newVersion: '3.0.0', restartRequired: true })
    expect(mocks.exec).toHaveBeenCalledWith('git', ['checkout', 'v3.0.0'], expect.any(Object))
    expect(mocks.exec).toHaveBeenCalledWith('pnpm', ['build'], expect.any(Object))
  })
  it('exposes managed status alongside available release information', async () => {
    const response = await GET()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({ updateAvailable: true, latestVersion: '3.0.0', managedRelease: true })
  })
  it('retains managed status when the release lookup fails', async () => {
    mocks.fetch.mockRejectedValue(new Error('offline'))
    expect(await (await GET()).json()).toMatchObject({ updateAvailable: false, managedRelease: true })
  })
})
