import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireRole: mocks.auth }))
vi.mock('@/lib/skill-analytics', () => ({ readSkillAnalytics: mocks.read }))
import { GET } from './route'

beforeEach(() => vi.clearAllMocks())
describe('GET /api/skills/analytics', () => {
  it('requires authentication before accessing local data', async () => {
    mocks.auth.mockReturnValue({ error: 'Unauthorized', status: 401 })
    const res = await GET(new NextRequest('http://localhost/api/skills/analytics'))
    expect(res.status).toBe(401)
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('passes only authenticated workspace context and forbids caching', async () => {
    mocks.auth.mockReturnValue({ user: { workspace_id: 2 } })
    mocks.read.mockResolvedValue({ status: 'unavailable', snapshot: null })
    const res = await GET(new NextRequest('http://localhost/api/skills/analytics?workspaceId=1'))
    expect(mocks.read).toHaveBeenCalledWith(2)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await res.json()).toEqual({ status: 'unavailable', snapshot: null })
  })
})
