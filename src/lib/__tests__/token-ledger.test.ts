import { describe, expect, it } from 'vitest'
import { buildAgentCostBreakdown, calculateStats, extractAgentName, getUsageCoverage, reconcileTokenSources, type TokenUsageRecord } from '../token-ledger'
const record = (patch: Partial<TokenUsageRecord>): TokenUsageRecord => ({ id: 'base', model: 'known-model', sessionId: 'session-a', agentName: 'ines', timestamp: 100,
  inputTokens: 100, outputTokens: 20, totalTokens: 120, cost: 0.01, operation: 'usage', source: 'database', costSource: 'reported', ...patch })
describe('one reconciled ledger for every cost view', () => {
  it('uses event records over the same physical session snapshot and its aliases', () => {
    const result = reconcileTokenSources([
      record({ id: 'db1', sessionId: 'uuid-a' }),
      record({ id: 'manual1', source: 'manual', sessionId: 'agent:ines:main' }),
      record({ id: 'snapshot-a', source: 'session_snapshot', sessionIdentity: 'ines:uuid-a', sessionId: 'agent:ines:main', sessionAliases: ['uuid-a'], totalTokens: 2000 }),
      record({ id: 'snapshot-alias', source: 'session_snapshot', sessionIdentity: 'ines:uuid-a', sessionId: 'agent:ines:cron:run:a', sessionAliases: ['uuid-a'], totalTokens: 2000 }),
    ])
    expect(result.records).toHaveLength(1)
    expect(result.records[0].id).toBe('db1')
    expect(calculateStats(result.records).totalTokens).toBe(120)
    expect(result.excludedSnapshots).toBe(2)
    expect(result.excludedReportedRecords).toBe(1)
  })
  it('does not add a snapshot when coarse agent usage may overlap it', () => {
    const result = reconcileTokenSources([record({ sessionId: 'ines:cli' }), record({ id: 'snapshot', source: 'session_snapshot', sessionId: 'agent:ines:main', sessionIdentity: 'ines:uuid' })])
    expect(result.records).toHaveLength(1)
    expect(result.excludedSnapshots).toBe(1)
  })
  it('keeps unmapped usage as unattributed and does not invent an agent from a task id', () => {
    expect(extractAgentName('task-1295')).toBe('unattributed')
    expect(extractAgentName('task-1295', 'task-1295')).toBe('unattributed')
    expect(extractAgentName('agent:ines:main', 'agent')).toBe('ines')
    expect(extractAgentName('uuid-unknown')).toBe('unattributed')
    expect(extractAgentName('task-1295', 'reidar')).toBe('reidar')
    expect(extractAgentName('agent:ines:main')).toBe('ines')
  })
  it('makes agent, model and overview totals reconcilable including unattributed unknown cost', () => {
    const result = reconcileTokenSources([
      record({ id: 'known', sessionId: 'agent:ines:a', cost: 0.000007 }),
      record({ id: 'other', sessionId: 'agent:reidar:b', agentName: 'reidar', source: 'session_snapshot', costSource: 'catalogue_estimate', cost: 0.000004 }),
      record({ id: 'unknown', model: 'unpriced', sessionId: 'opaque', agentName: 'unattributed', costSource: 'unknown', cost: 0 }),
    ])
    const overall = calculateStats(result.records)
    const byAgent = buildAgentCostBreakdown(result.records, 1)
    expect(byAgent.summary.total_cost).toBe(overall.totalCost)
    expect(byAgent.agents.reduce((sum, agent) => sum + agent.total_tokens, 0)).toBe(overall.totalTokens)
    expect(byAgent.agents.flatMap(agent => agent.models).reduce((sum, model) => sum + model.cost, 0)).toBe(overall.totalCost)
    expect(byAgent.agents.find(agent => agent.agent === 'unattributed')?.total_tokens).toBe(120)
    expect(overall).toMatchObject({ pricedTokens: 240, pricedRecordCount: 2 })
    expect(byAgent.summary.pricing).toEqual({ pricedTokens: 240, pricedRecordCount: 2 })
    expect(byAgent.agents.find(agent => agent.agent === 'unattributed')?.pricing).toEqual({ pricedTokens: 0, pricedRecordCount: 0 })
    expect(byAgent.agents.find(agent => agent.agent === 'ines')?.models[0].pricing).toEqual({ pricedTokens: 120, pricedRecordCount: 1 })
    expect(overall.totalCost).toBeCloseTo(0.000011, 12)
    expect(getUsageCoverage(result.records).unknownCostTokens).toBe(120)
  })
})
