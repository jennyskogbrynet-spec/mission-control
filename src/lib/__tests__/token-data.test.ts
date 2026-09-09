// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const { rows, sessions, read } = vi.hoisted(() => ({ rows: vi.fn(), sessions: vi.fn(), read: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDatabase: () => ({ prepare: () => ({ all: rows }) }) }))
vi.mock('@/lib/sessions', () => ({ getAllGatewaySessions: sessions }))
vi.mock('node:fs/promises', () => ({ readFile: read }))
vi.mock('@/lib/config', () => ({ config: { tokensPath: '/unused' } }))
vi.mock('@/lib/provider-subscriptions', () => ({ getProviderFromModel: () => 'unknown' }))
import { loadTokenData, priceUsage } from '../token-data'
const now = Date.parse('2026-09-08T12:00:00Z')
beforeEach(() => { rows.mockReturnValue([]); sessions.mockReturnValue([]); read.mockResolvedValue('[]') })
describe('cost source loading', () => {
  it('does not make up prices for new unknown models', () => {
    expect(priceUsage('new-provider/new-model', 1000000, 1000000)).toEqual({ cost: 0, costSource: 'unknown' })
    expect(priceUsage('claude-sonnet-4', 1000000, 1000000)).toEqual({ cost: 18, costSource: 'catalogue_estimate' })
    expect(priceUsage('claude-sonnet-4-new-unverified', 1000000, 1000000)).toEqual({ cost: 0, costSource: 'unknown' })
  })
  it('reports updated API base rates as estimates, not subscription or invoice amounts', () => {
    expect(priceUsage('claude-opus-4-6', 1000, 100)).toEqual({ cost: 0.0075, costSource: 'catalogue_estimate' })
    expect(priceUsage('grok-4.6', 1000, 100)).toEqual({ cost: 0.0026, costSource: 'catalogue_estimate' })
    expect(priceUsage('ollama/qwen2.5:3b', 1000, 100)).toEqual({ cost: 0, costSource: 'catalogue_estimate' })
    expect(priceUsage('glm-5.3', 1000, 100)).toEqual({ cost: 0, costSource: 'unknown' })
  })
  it('uses explicitly reported dollars and agent instead of guessing from task id', async () => {
    rows.mockReturnValue([{ id: 1, model: 'new-model', session_id: 'task-1', input_tokens: 10, output_tokens: 2, cost_usd: 0.00001, agent_name: 'ines', created_at: now / 1000, workspace_id: 1, task_id: 1 }])
    const ledger = await loadTokenData(1, 'day', now)
    expect(ledger.records[0]).toMatchObject({ agentName: 'ines', taskId: 1, cost: 0.00001, costSource: 'reported' })
    expect(ledger.coverage.unknownCostTokens).toBe(0)
  })
  it('filters the selected time window before excluding overlapping sources', async () => {
    rows.mockReturnValue([{ id: 1, model: 'known', session_id: 'ines:cli', input_tokens: 10, output_tokens: 2, created_at: (now - 2 * 86400000) / 1000, workspace_id: 1 }])
    sessions.mockReturnValue([{ agent: 'ines', key: 'agent:ines:main', sessionId: 'uuid', model: 'known', inputTokens: 10, outputTokens: 2, updatedAt: now }])
    const ledger = await loadTokenData(1, 'all', now, now - 86400000)
    expect(ledger.records).toHaveLength(1)
    expect(ledger.records[0].source).toBe('session_snapshot')
    expect(ledger.coverage.excludedSnapshots).toBe(0)
  })
  it('ignores malformed manual entries without discarding valid usage', async () => {
    read.mockResolvedValue(JSON.stringify([null, false, { id: 'valid', model: 'unknown', sessionId: 'task-3', agentName: 42, timestamp: now, inputTokens: 5, outputTokens: 1 }]))
    const ledger = await loadTokenData(1, 'day', now)
    expect(ledger.records).toHaveLength(1)
    expect(ledger.records[0]).toMatchObject({ agentName: 'unattributed', totalTokens: 6 })
    expect(ledger.coverage.unavailableSources).toEqual([])
  })
  it('reports missing sources without forging a healthy zero total', async () => {
    rows.mockImplementation(() => { throw new Error('unavailable') }); read.mockRejectedValue(new Error('bad store'))
    const ledger = await loadTokenData(2, 'day', now)
    expect(ledger.coverage.unavailableSources).toEqual(['database', 'manual'])
    expect(ledger.coverage.pricedTokenPercent).toBeNull()
  })
})
