// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const access = vi.hoisted(() => vi.fn())
const metrics = vi.hoisted(() => vi.fn())
vi.mock('@/lib/hq-access', () => ({ requireHQAccess: access }))
vi.mock('@/lib/hq-metrics', () => ({ getHQMetrics: metrics, isHQMetricProject: (key: string) => ['babyhub', 'babysential', 'brrrr', 'shared'].includes(key) }))
import { GET } from '@/app/api/headquarters/metrics/route'

beforeEach(() => {
  vi.clearAllMocks()
  access.mockReturnValue({ user: { id: 1 }, workspaceId: 1 })
  metrics.mockResolvedValue({ generatedAt: '2026-09-08', metrics: [], sources: [] })
})

describe('GET headquarters/metrics', () => {
  it.each([401, 403])('requires authorized HQ workspace access before fetching analytics (%i)', async status => {
    access.mockReturnValue(NextResponse.json({ error: 'Access denied' }, { status }))
    const response = await GET(new Request('http://localhost/api/headquarters/metrics?project=babysential'))
    expect(response.status).toBe(status)
    expect(metrics).not.toHaveBeenCalled()
  })
  it('rejects unknown or empty project selectors', async () => {
    for (const project of ['unknown', '']) {
      const response = await GET(new Request(`http://localhost/api/headquarters/metrics?project=${project}`))
      expect(response.status).toBe(400)
    }
    expect(metrics).not.toHaveBeenCalled()
  })
  it('passes the explicit project and prevents public response caching', async () => {
    const response = await GET(new Request('http://localhost/api/headquarters/metrics?project=babysential'))
    expect(response.status).toBe(200)
    expect(metrics).toHaveBeenCalledWith('babysential')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })
})
