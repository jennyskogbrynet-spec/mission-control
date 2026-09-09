// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
const mocks = vi.hoisted(() => ({ access: vi.fn(), knowledge: vi.fn(), operations: vi.fn() }))
vi.mock('@/lib/hq-access', () => ({ requireHQAccess: mocks.access }))
vi.mock('@/lib/hq-knowledge', () => ({ getHQKnowledgeIndex: mocks.knowledge }))
vi.mock('@/lib/hq-operations', () => ({ readHQOperations: mocks.operations, HQInputError: class extends Error {} }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
import { GET } from '@/app/api/headquarters/route'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.access.mockReturnValue({ workspaceId: 7 })
  mocks.knowledge.mockResolvedValue({ notes: [], sources: [], links: [], coverage: {} })
  mocks.operations.mockReturnValue({ tasks: [], projects: [], agents: [], activity: [] })
})
describe('HQ registry project route', () => {
  it.each(['', '1suffix', '-1', '0', '9007199254740993'])('rejects invalid project ID %s without reading knowledge', async value => {
    const response = await GET(new NextRequest(`http://localhost/api/headquarters?projectId=${value}`))
    expect(response.status).toBe(400)
    expect(mocks.knowledge).not.toHaveBeenCalled()
  })
  it('passes the selected project and authenticated workspace to bounded operations', async () => {
    const response = await GET(new NextRequest('http://localhost/api/headquarters?projectId=44'))
    expect(response.status).toBe(200)
    expect(mocks.operations).toHaveBeenCalledWith(7, [], undefined, 44)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })
  it('retains HQ access protection before reading vault or projects', async () => {
    mocks.access.mockReturnValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    expect((await GET(new NextRequest('http://localhost/api/headquarters?projectId=44'))).status).toBe(403)
    expect(mocks.knowledge).not.toHaveBeenCalled()
    expect(mocks.operations).not.toHaveBeenCalled()
  })
})
