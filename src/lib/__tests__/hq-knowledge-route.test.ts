// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { GET } from '@/app/api/headquarters/knowledge/route'
import { requireHQAccess } from '@/lib/hq-access'
import { getHQKnowledgeIndex, getHQNote, searchHQKnowledge } from '@/lib/hq-knowledge'

vi.mock('@/lib/hq-access', () => ({ requireHQAccess: vi.fn() }))
vi.mock('@/lib/hq-knowledge', () => ({ getHQKnowledgeIndex: vi.fn(), getHQNote: vi.fn(), searchHQKnowledge: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireHQAccess).mockReturnValue({ workspaceId: 1, user: { id: 1, role: 'admin' } } as ReturnType<typeof requireHQAccess>)
})

describe('HQ knowledge HTTP boundary', () => {
  it('returns access denial before touching the vault or search process', async () => {
    vi.mocked(requireHQAccess).mockReturnValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    const response = await GET(new NextRequest('http://localhost/api/headquarters/knowledge?q=anything'))
    expect(response.status).toBe(403)
    expect(getHQKnowledgeIndex).not.toHaveBeenCalled()
    expect(searchHQKnowledge).not.toHaveBeenCalled()
    expect(getHQNote).not.toHaveBeenCalled()
  })

  it('rejects an unknown project and overlong queries without executing QMD', async () => {
    const invalid = await GET(new NextRequest('http://localhost/api/headquarters/knowledge?q=text&project=private'))
    expect(invalid.status).toBe(400)
    const long = await GET(new NextRequest('http://localhost/api/headquarters/knowledge?q=' + 'x'.repeat(201)))
    expect(long.status).toBe(400)
    expect(searchHQKnowledge).not.toHaveBeenCalled()
  })

  it('returns a generic missing-note response without disclosing filesystem details', async () => {
    vi.mocked(getHQNote).mockResolvedValue(null)
    const response = await GET(new NextRequest('http://localhost/api/headquarters/knowledge?id=../../private'))
    expect(response.status).toBe(404)
    expect(JSON.stringify(await response.json())).not.toContain('../../private')
  })
})
