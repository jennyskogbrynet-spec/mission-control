import { readFile } from 'node:fs/promises'
import { config } from '@/lib/config'
import { getDatabase } from '@/lib/db'
import { getAllGatewaySessions } from '@/lib/sessions'
import { getKnownModelPricing } from '@/lib/token-pricing'
import { extractAgentName, filterByTimeframe, getUsageCoverage, reconcileTokenSources, type TokenUsageRecord } from '@/lib/token-ledger'

export function priceUsage(model: string, inputTokens: number, outputTokens: number): Pick<TokenUsageRecord, 'cost' | 'costSource'> {
  const pricing = getKnownModelPricing(model)
  if (!pricing) return { cost: 0, costSource: 'unknown' }
  // Subscription possession does not prove that this request used subscription billing.
  return { cost: (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) / 1000000, costSource: 'catalogue_estimate' }
}

export async function loadTokenData(workspaceId: number, timeframe = 'all', now = Date.now(), sinceMs?: number) {
  const records: TokenUsageRecord[] = []
  const unavailableSources: string[] = []
  try {
    const rows = getDatabase().prepare(`SELECT id, model, session_id, input_tokens, output_tokens, task_id, workspace_id, created_at, cost_usd, agent_name FROM token_usage WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 10000`).all(workspaceId) as Array<{ id: number; model: string; session_id: string; input_tokens: number; output_tokens: number; task_id: number | null; workspace_id: number; created_at: number; cost_usd?: number | null; agent_name?: string | null }>
    for (const row of rows) records.push({ id: `db-${row.id}`, model: row.model, sessionId: row.session_id,
      agentName: extractAgentName(row.session_id, row.agent_name || undefined), timestamp: row.created_at * 1000,
      inputTokens: row.input_tokens, outputTokens: row.output_tokens, totalTokens: row.input_tokens + row.output_tokens,
      ...(typeof row.cost_usd === 'number' && Number.isFinite(row.cost_usd) && row.cost_usd >= 0 ? { cost: row.cost_usd, costSource: 'reported' as const } : priceUsage(row.model, row.input_tokens, row.output_tokens)),
      taskId: row.task_id, workspaceId, operation: 'reported_usage', source: 'database',
    })
  } catch { unavailableSources.push('database') }
  try {
    const stored: unknown = JSON.parse(await readFile(config.tokensPath, 'utf8'))
    if (!Array.isArray(stored)) throw new Error('Invalid manual usage store')
    for (const row of stored) {
      if (!row || typeof row !== 'object') continue
      if (Number(row.workspaceId ?? 1) !== workspaceId || !row.model || !row.sessionId) continue
      const inputTokens = Number(row.inputTokens ?? 0), outputTokens = Number(row.outputTokens ?? 0)
      const price = row.costSource === 'reported' && typeof row.cost === 'number' && Number.isFinite(row.cost) && row.cost >= 0
        ? { cost: row.cost, costSource: 'reported' as const } : priceUsage(String(row.model), inputTokens, outputTokens)
      records.push({ id: String(row.id || `${row.sessionId}|${row.timestamp}|${inputTokens}|${outputTokens}`), model: String(row.model), sessionId: String(row.sessionId),
        agentName: extractAgentName(String(row.sessionId), typeof row.agentName === 'string' ? row.agentName : undefined), timestamp: Number(row.timestamp), inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
        ...price, taskId: row.taskId ?? null, workspaceId, operation: row.operation || 'reported_usage', duration: row.duration, source: 'manual',
      })
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailableSources.push('manual') }
  if (workspaceId === 1) {
    try {
      for (const session of getAllGatewaySessions(Infinity)) {
        const inputTokens = session.inputTokens || 0, outputTokens = session.outputTokens || 0
        if (inputTokens + outputTokens <= 0) continue
        records.push({ id: `snapshot-${session.agent}-${session.sessionId || session.key}`, model: session.model || 'unknown',
          sessionId: session.key, sessionIdentity: `${session.agent}:${session.sessionId || session.key}`,
          sessionAliases: [session.key, session.sessionId].filter(Boolean), agentName: extractAgentName(session.key, session.agent),
          timestamp: session.updatedAt, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
          ...priceUsage(session.model || '', inputTokens, outputTokens), taskId: null, workspaceId, operation: 'session_snapshot', source: 'session_snapshot',
        })
      }
    } catch { unavailableSources.push('session_snapshots') }
  }
  const valid = records.filter(record => Number.isFinite(record.inputTokens) && record.inputTokens >= 0 && Number.isFinite(record.outputTokens) && record.outputTokens >= 0)
  const reconciliation = reconcileTokenSources(filterByTimeframe(valid, timeframe, now).filter(record => sinceMs == null || record.timestamp >= sinceMs))
  return { records: reconciliation.records, coverage: { ...getUsageCoverage(reconciliation.records, reconciliation), unavailableSources }, asOf: now }
}
