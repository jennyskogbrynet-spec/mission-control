// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
const mock = vi.hoisted(() => ({ role: vi.fn(), start: vi.fn(), get: vi.fn(), list: vi.fn(), cancel: vi.fn(), reconcile: vi.fn(), prepare: vi.fn(), lookup: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireRole: mock.role }))
vi.mock('@/lib/db', () => ({ getDatabase: () => ({ prepare: mock.prepare }) }))
vi.mock('@/lib/compute-store', () => ({ readComputeOverview: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/subscription-runs', async original => ({ ...await original<object>(), startSubscriptionRun: mock.start,
  getSubscriptionRun: mock.get, listSubscriptionRuns: mock.list, cancelSubscriptionRun: mock.cancel, reconcileSubscriptionRun: mock.reconcile }))
import { GET, POST, DELETE, PATCH } from './route'
import { SubscriptionRunError } from '@/lib/subscription-runs'
const input = () => ({ idempotencyKey: randomUUID(), projectId: 3, bindingId: 'binding', modelId: 'model', prompt: 'Review this supplied plan.', difficulty: 'routine', dataClass: 'public' })
const request = (value: unknown, method = 'POST') => new NextRequest('http://localhost/api/compute/runs', { method, body: JSON.stringify(value) })
describe('subscription run routes', () => {
  beforeEach(() => { vi.clearAllMocks(); mock.role.mockReturnValue({ user: { workspace_id: 1, tenant_id: 1 } }); mock.prepare.mockReturnValue({ get: mock.lookup }); mock.lookup.mockReturnValue({ id: 3 }) })
  it.each([{ workspace_id: 2, tenant_id: 1 }, { workspace_id: 1, tenant_id: 2 }, { workspace_id: 1 }, {}])('rejects non-primary and missing ownership before any local access: %j', async scope => {
    mock.role.mockReturnValue({ user: scope })
    expect((await GET(new NextRequest('http://localhost/api/compute/runs'))).status).toBe(403)
    expect((await POST(request(input()))).status).toBe(403)
    expect((await DELETE(new NextRequest('http://localhost/api/compute/runs?id=one'))).status).toBe(403)
    expect((await PATCH(request({ action: 'reconcile', id: randomUUID() }, 'PATCH'))).status).toBe(403)
    for (const method of [mock.start, mock.get, mock.list, mock.cancel, mock.reconcile, mock.prepare]) expect(method).not.toHaveBeenCalled()
  })
  it('requires operator authentication', async () => {
    mock.role.mockReturnValue({ error: 'Unauthorized', status: 401 })
    expect((await POST(request(input()))).status).toBe(401)
    expect(mock.role).toHaveBeenCalledWith(expect.anything(), 'operator')
  })
  it('requires a scoped project and task without changing task state', async () => {
    mock.lookup.mockReturnValueOnce(undefined)
    expect((await POST(request(input()))).status).toBe(404)
    mock.lookup.mockReturnValueOnce({ id: 3 }).mockReturnValueOnce(undefined)
    expect((await POST(request({ ...input(), taskId: 91 }))).status).toBe(404)
    expect(mock.prepare).toHaveBeenLastCalledWith(expect.stringContaining('project_id = ? AND workspace_id = ?'))
    expect(mock.lookup).toHaveBeenLastCalledWith(91, 3, 1)
    expect(mock.start).not.toHaveBeenCalled()
  })
  it('rejects unknown fields and body overflow even without content-length', async () => {
    expect((await POST(request({ ...input(), cwd: '/etc' }))).status).toBe(400)
    expect((await POST(request({ ...input(), prompt: 'x'.repeat(40_000) }))).status).toBe(413)
    expect(mock.prepare).not.toHaveBeenCalled()
    expect(mock.start).not.toHaveBeenCalled()
  })
  it('returns 202 only for started work and 200 for a saved preflight failure', async () => {
    const value = input(); mock.start.mockReturnValueOnce({ id: value.idempotencyKey, status: 'running' })
    const response = await POST(request(value))
    expect(response.status).toBe(202); expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mock.start).toHaveBeenCalledWith(value, 1)
    mock.start.mockReturnValueOnce({ id: value.idempotencyKey, status: 'failed', error: 'No model request sent' })
    expect((await POST(request(value))).status).toBe(200)
  })
  it('exposes stable receipt lookup and safe bounded errors', async () => {
    const id = randomUUID(); mock.get.mockReturnValueOnce({ id, status: 'completed' })
    expect((await GET(new NextRequest(`http://localhost/api/compute/runs?id=${id}`))).status).toBe(200)
    expect(mock.get).toHaveBeenCalledWith(id, 1)
    mock.start.mockImplementationOnce(() => { throw new SubscriptionRunError('Remove credentials', 422) })
    expect((await POST(request(input()))).status).toBe(422)
    mock.start.mockImplementationOnce(() => { throw new Error('PRIVATE DETAIL') })
    const failed = await POST(request(input())); expect(failed.status).toBe(500); expect(JSON.stringify(await failed.json())).not.toContain('PRIVATE DETAIL')
  })
  it('does not turn a cancel failure or uncertain lock into success', async () => {
    mock.cancel.mockReturnValue(false)
    expect((await DELETE(new NextRequest('http://localhost/api/compute/runs?id=one'))).status).toBe(409)
    mock.reconcile.mockImplementationOnce(() => { throw new SubscriptionRunError('A process may still own this run') })
    expect((await PATCH(request({ action: 'reconcile', id: randomUUID() }, 'PATCH'))).status).toBe(409)
  })
})
