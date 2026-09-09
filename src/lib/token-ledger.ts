/** Shared usage ledger. Unknown dollars remain excluded and are counted as missing coverage. */
export interface TokenUsageRecord {
  id: string; model: string; sessionId: string; agentName: string; timestamp: number
  inputTokens: number; outputTokens: number; totalTokens: number; cost: number; operation: string
  taskId?: number | null; workspaceId?: number; duration?: number
  source: 'database' | 'manual' | 'session_snapshot'
  costSource: 'reported' | 'catalogue_estimate' | 'legacy_estimate' | 'unknown'
  sessionIdentity?: string; sessionAliases?: string[]
}
export interface TokenStats {
  pricedTokens: number; pricedRecordCount: number
  totalTokens: number; totalCost: number; requestCount: number; avgTokensPerRequest: number; avgCostPerRequest: number
}

export function extractAgentName(sessionId: string, explicit?: string): string {
  const explicitName = explicit?.trim()
  const generatedIdentity = /^(?:task-\d+|[0-9a-f]{8}-[0-9a-f-]{27,})$/i
  if (explicitName && !['unknown', 'unattributed', 'agent'].includes(explicitName.toLowerCase()) && !generatedIdentity.test(explicitName)) return explicitName
  const canonical = sessionId.match(/^agent:([^:]+):/)
  if (canonical) return canonical[1]
  // These legacy keys are emitted by MC's documented heartbeat/manual usage producers.
  const legacy = sessionId.match(/^([^:]+):(?:cli|chat|direct|channel|group|main)$/)
  return legacy?.[1] || 'unattributed'
}

export function calculateStats(records: TokenUsageRecord[]): TokenStats {
  const totalTokens = records.reduce((sum, record) => sum + record.totalTokens, 0)
  const totalCost = records.reduce((sum, record) => sum + record.cost, 0)
  const pricedRecords = records.filter(record => record.costSource !== 'unknown')
  return { totalTokens, totalCost, pricedTokens: pricedRecords.reduce((sum, record) => sum + record.totalTokens, 0), pricedRecordCount: pricedRecords.length, requestCount: records.length,
    avgTokensPerRequest: records.length ? Math.round(totalTokens / records.length) : 0,
    avgCostPerRequest: records.length ? totalCost / records.length : 0 }
}

export function filterByTimeframe(records: TokenUsageRecord[], timeframe: string, now = Date.now()): TokenUsageRecord[] {
  const duration = ({ hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 } as Record<string, number>)[timeframe]
  return records.filter(record => Number.isFinite(record.timestamp) && (!duration || record.timestamp >= now - duration) && record.timestamp <= now)
}

/** Prefer reported events over snapshots, never add two observations of the same session. */
export function reconcileTokenSources(records: TokenUsageRecord[]) {
  const snapshots = new Map<string, TokenUsageRecord>()
  const aliases = new Map<string, string>()
  let duplicateSnapshots = 0
  for (const record of records.filter(record => record.source === 'session_snapshot')) {
    const identity = record.sessionIdentity || record.sessionId
    const previous = snapshots.get(identity)
    if (previous) duplicateSnapshots++
    if (!previous || record.timestamp > previous.timestamp || (record.timestamp === previous.timestamp && record.totalTokens > previous.totalTokens)) snapshots.set(identity, record)
    for (const alias of [record.sessionId, ...(record.sessionAliases || [])]) if (alias) aliases.set(alias, identity)
  }
  const identityFor = (record: TokenUsageRecord) => aliases.get(record.sessionId) || record.sessionId
  const modelKey = (record: TokenUsageRecord) => `${identityFor(record)}|${record.model}`
  const dbKeys = new Set(records.filter(record => record.source === 'database').map(modelKey))
  const observed = new Set<string>()
  const reported: TokenUsageRecord[] = []
  let excludedReportedRecords = 0
  for (const record of records.filter(record => record.source !== 'session_snapshot')) {
    const key = `${record.source}:${record.id}`
    if (observed.has(key) || (record.source === 'manual' && dbKeys.has(modelKey(record)))) { excludedReportedRecords++; continue }
    observed.add(key)
    const linked = snapshots.get(identityFor(record))
    reported.push({ ...record, sessionId: linked?.sessionId || record.sessionId,
      agentName: record.agentName === 'unattributed' && linked ? linked.agentName : record.agentName })
  }
  const reportedIdentities = new Set(reported.map(identityFor))
  const ambiguousAgentModels = new Set(reported.filter(record => !aliases.has(record.sessionId) && record.agentName !== 'unattributed').map(record => `${record.agentName}|${record.model}`))
  const ambiguousModels = new Set(reported.filter(record => !aliases.has(record.sessionId) && record.agentName === 'unattributed').map(record => record.model))
  const included = [...reported]
  let excludedSnapshots = duplicateSnapshots
  let excludedSnapshotTokens = records.filter(record => record.source === 'session_snapshot').reduce((sum, record) => sum + record.totalTokens, 0)
  for (const [identity, record] of snapshots) {
    if (reportedIdentities.has(identity) || ambiguousAgentModels.has(`${record.agentName}|${record.model}`) || ambiguousModels.has(record.model)) {
      excludedSnapshots++
    } else { included.push(record); excludedSnapshotTokens -= record.totalTokens }
  }
  included.sort((a, b) => b.timestamp - a.timestamp)
  return { records: included, excludedSnapshots, excludedSnapshotTokens, excludedReportedRecords }
}

export function getUsageCoverage(records: TokenUsageRecord[], reconciliation?: { excludedSnapshots: number; excludedSnapshotTokens: number; excludedReportedRecords: number }) {
  const totalTokens = records.reduce((sum, record) => sum + record.totalTokens, 0)
  const unknownCostTokens = records.filter(record => record.costSource === 'unknown').reduce((sum, record) => sum + record.totalTokens, 0)
  return {
    sourceRecords: {
      database: records.filter(record => record.source === 'database').length,
      manual: records.filter(record => record.source === 'manual').length,
      sessionSnapshots: records.filter(record => record.source === 'session_snapshot').length,
    },
    unknownCostTokens, pricedTokenPercent: totalTokens ? (totalTokens - unknownCostTokens) / totalTokens * 100 : null,
    billedCost: records.filter(record => record.costSource === 'reported').reduce((sum, record) => sum + record.cost, 0),
    estimatedCost: records.filter(record => record.costSource !== 'reported').reduce((sum, record) => sum + record.cost, 0),
    unattributedTokens: records.filter(record => record.agentName === 'unattributed').reduce((sum, record) => sum + record.totalTokens, 0),
    snapshotTokens: records.filter(record => record.source === 'session_snapshot').reduce((sum, record) => sum + record.totalTokens, 0),
    excludedSnapshots: reconciliation?.excludedSnapshots || 0, excludedSnapshotTokens: reconciliation?.excludedSnapshotTokens || 0,
    excludedReportedRecords: reconciliation?.excludedReportedRecords || 0,
    method: 'prefer database over manual observations for the same session/model; include snapshots only without potentially overlapping reported session/agent-model observations',
  }
}

export function buildAgentCostBreakdown(records: TokenUsageRecord[], days: number) {
  const groups = new Map<string, TokenUsageRecord[]>()
  for (const record of records) {
    const agent = record.agentName || 'unattributed'
    groups.set(agent, [...(groups.get(agent) || []), record])
  }
  const agents = [...groups.entries()].map(([agent, entries]) => {
    const models = new Map<string, TokenUsageRecord[]>()
    for (const entry of entries) models.set(entry.model, [...(models.get(entry.model) || []), entry])
    const stats = calculateStats(entries)
    return {
      pricing: { pricedTokens: stats.pricedTokens, pricedRecordCount: stats.pricedRecordCount },
      agent, total_input_tokens: entries.reduce((sum, entry) => sum + entry.inputTokens, 0),
      total_output_tokens: entries.reduce((sum, entry) => sum + entry.outputTokens, 0),
      total_tokens: stats.totalTokens, total_cost: stats.totalCost,
      session_count: new Set(entries.map(entry => entry.sessionId)).size, request_count: entries.length,
      last_active: new Date(Math.max(...entries.map(entry => entry.timestamp))).toISOString(),
      models: [...models.entries()].map(([model, usage]) => ({ model,
        input_tokens: usage.reduce((sum, entry) => sum + entry.inputTokens, 0), output_tokens: usage.reduce((sum, entry) => sum + entry.outputTokens, 0),
        request_count: usage.length, cost: calculateStats(usage).totalCost,
        pricing: { pricedTokens: calculateStats(usage).pricedTokens, pricedRecordCount: calculateStats(usage).pricedRecordCount },
      })),
    }
  }).sort((a, b) => b.total_cost - a.total_cost)
  const stats = calculateStats(records)
  return { agents, summary: { pricing: { pricedTokens: stats.pricedTokens, pricedRecordCount: stats.pricedRecordCount }, total_cost: stats.totalCost, total_tokens: stats.totalTokens, agent_count: agents.filter(agent => agent.agent !== 'unattributed').length, days }, coverage: getUsageCoverage(records) }
}
