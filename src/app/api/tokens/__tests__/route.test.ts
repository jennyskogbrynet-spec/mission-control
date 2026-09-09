// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const { auth, sessions, append, statement } = vi.hoisted(() => ({ auth: vi.fn(), sessions: vi.fn(), append: vi.fn(), statement: { all: vi.fn().mockReturnValue([]), get: vi.fn() } }))
vi.mock('@/lib/auth', () => ({ requireRole: auth }))
vi.mock('@/lib/sessions', () => ({ getAllGatewaySessions: sessions }))
vi.mock('@/lib/token-storage', () => ({ appendTokenRecord: append }))
vi.mock('@/lib/db', () => ({ getDatabase: () => ({ prepare: () => statement }) }))
vi.mock('@/lib/config', () => ({ config: { tokensPath: '/tmp/test-token-data.json' }, ensureDirExists: vi.fn() }))
vi.mock('fs/promises', () => ({ readFile: vi.fn().mockResolvedValue('[]'), access: vi.fn() }))
vi.mock('@/lib/provider-subscriptions', () => ({ getProviderSubscriptionFlags: () => ({}), getProviderFromModel: () => 'unknown' }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
import { GET, POST } from '../route'
import { GET as GET_BY_AGENT } from '../by-agent/route'
beforeEach(() => { vi.clearAllMocks(); statement.all.mockReturnValue([]); auth.mockReturnValue({ user: { workspace_id: 1 } }); sessions.mockReturnValue([{ agent: 'ines', key: 'agent:ines:unique-session', inputTokens: 100, outputTokens: 50, model: 'test', updatedAt: Date.now(), chatType: 'direct' }]) })
describe('token API scope and validation', () => {
  it('does not copy primary workspace sessions into another workspace', async () => {
    auth.mockReturnValue({ user: { workspace_id: 2 } })
    const response = await GET(new NextRequest('http://localhost/api/tokens?action=list'))
    expect(await response.json()).toMatchObject({ total: 0, usage: [] })
    expect(sessions).not.toHaveBeenCalled()
  })
  it('keeps the real session key instead of collapsing all agent chats', async () => {
    const response = await GET(new NextRequest('http://localhost/api/tokens?action=list'))
    expect((await response.json()).usage[0]).toMatchObject({ sessionId: 'agent:ines:unique-session', agentName: 'ines' })
  })
  it('rejects negative and fractional token counts', async () => {
    for (const inputTokens of [-1, 0.5]) {
      const response = await POST(new NextRequest('http://localhost/api/tokens', { method: 'POST', body: JSON.stringify({ model: 'test', sessionId: 'a', inputTokens, outputTokens: 1 }) }))
      expect(response.status).toBe(400)
    }
    expect(append).not.toHaveBeenCalled()
  })
  it('persists through the workspace-preserving append operation', async () => {
    const response = await POST(new NextRequest('http://localhost/api/tokens', { method: 'POST', body: JSON.stringify({ model: 'test', sessionId: 'agent:ines:id', inputTokens: 10, outputTokens: 1 }) }))
    expect(response.status).toBe(200)
    expect(append).toHaveBeenCalledWith('/tmp/test-token-data.json', expect.objectContaining({ workspaceId: 1, agentName: 'ines' }), 1)
  })
})


describe('consistent cost view contracts', () => {
  it('reconciles the by-agent endpoint and embedded atomic breakdown to overview', async () => {
    statement.all.mockReturnValue([{ id: 1, model: 'known-priced-report', session_id: 'task-1', input_tokens: 20, output_tokens: 3, cost_usd: 0.000004, agent_name: 'reidar', created_at: Math.floor(Date.now() / 1000), workspace_id: 1, task_id: 1 }])
    const overview = await (await GET(new NextRequest('http://localhost/api/tokens?action=stats&timeframe=day'))).json()
    const byAgent = await (await GET_BY_AGENT(new NextRequest('http://localhost/api/tokens/by-agent?timeframe=day'))).json()
    expect(byAgent.summary.total_tokens).toBe(overview.summary.totalTokens)
    expect(byAgent.summary.total_cost).toBe(overview.summary.totalCost)
    expect(overview.agentBreakdown.summary.total_cost).toBe(overview.summary.totalCost)
    expect(byAgent.agents).toHaveLength(2)
    expect(overview.models['known-priced-report']).toMatchObject({ pricedTokens: 23, pricedRecordCount: 1 })
    expect(overview.models.test).toMatchObject({ pricedTokens: 0, pricedRecordCount: 0 })
    expect(byAgent.summary.pricing).toEqual({ pricedTokens: 23, pricedRecordCount: 1 })
    expect(overview.coverage.unknownCostTokens).toBe(150)
    expect(overview.coverage.sourceRecords).toEqual({ database: 1, manual: 0, sessionSnapshots: 1 })
  })
  it('returns real session detail instead of an invalid action fallback', async () => {
    const data = await (await GET(new NextRequest('http://localhost/api/tokens?action=session-costs&timeframe=day'))).json()
    expect(data.sessions[0]).toMatchObject({ sessionId: 'agent:ines:unique-session', inputTokens: 100, outputTokens: 50, totalTokens: 150, pricedTokens: 0, pricedRecordCount: 0 })
    expect(Number.isFinite(Date.parse(data.sessions[0].lastSeen))).toBe(true)
  })
  it('does not drop earlier days from a weekly trend while retaining them in summary', async () => {
    sessions.mockReturnValue([])
    statement.all.mockReturnValue([{ id: 2, model: 'test', session_id: 'opaque', input_tokens: 20, output_tokens: 3, created_at: Math.floor(Date.now() / 1000) - 172800, workspace_id: 1 }])
    const overview = await (await GET(new NextRequest('http://localhost/api/tokens?action=stats&timeframe=week'))).json()
    const trend = await (await GET(new NextRequest('http://localhost/api/tokens?action=trends&timeframe=week'))).json()
    expect(trend.trends.reduce((sum: number, row: { tokens: number }) => sum + row.tokens, 0)).toBe(overview.summary.totalTokens)
    expect(overview.agents.unattributed.totalTokens).toBe(23)
  })
})


it('carries reported-zero versus unknown coverage through task-cost responses', async () => {
  sessions.mockReturnValue([])
  const base = { model: 'unverified', session_id: 'opaque', input_tokens: 2, output_tokens: 0, created_at: Math.floor(Date.now() / 1000), workspace_id: 1 }
  statement.all.mockImplementation((...params: unknown[]) => params.length > 1
    ? [1, 2].map(id => ({ id, title: `Task ${id}`, status: 'done', priority: 'medium' }))
    : [{ ...base, id: 1, task_id: 1, cost_usd: null }, { ...base, id: 2, task_id: 2, cost_usd: 0 }])
  const data = await (await GET(new NextRequest('http://localhost/api/tokens?action=task-costs&timeframe=day'))).json()
  expect(data.tasks.find((task: { taskId: number }) => task.taskId === 1)?.stats).toMatchObject({ pricedTokens: 0, pricedRecordCount: 0 })
  expect(data.tasks.find((task: { taskId: number }) => task.taskId === 2)?.stats).toMatchObject({ totalCost: 0, pricedTokens: 2, pricedRecordCount: 1 })
})
