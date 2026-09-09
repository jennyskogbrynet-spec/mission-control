import { NextRequest, NextResponse } from 'next/server'
import { config } from '@/lib/config'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getDatabase } from '@/lib/db'
import { loadTokenData, priceUsage } from '@/lib/token-data'
import { calculateStats, extractAgentName, buildAgentCostBreakdown, type TokenUsageRecord, type TokenStats } from '@/lib/token-ledger'
import { generateCsvContent } from '@/lib/token-utils'
import { appendTokenRecord } from '@/lib/token-storage'
import { buildTaskCostReport, type TaskCostMetadata } from '@/lib/task-costs'

const DATA_PATH = config.tokensPath
interface ExportData { coverage?: unknown; usage: TokenUsageRecord[]; summary: TokenStats; models: Record<string, TokenStats>; sessions: Record<string, TokenStats> }
interface TaskMetadataRow extends TaskCostMetadata {}

function loadTaskMetadataById(workspaceId: number, taskIds: number[]): Record<number, TaskCostMetadata> {
  if (taskIds.length === 0) return {}
  const db = getDatabase()
  const placeholders = taskIds.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT
      t.id,
      t.title,
      t.status,
      t.priority,
      t.assigned_to,
      t.project_id,
      p.name as project_name,
      p.slug as project_slug,
      p.ticket_prefix as project_prefix,
      t.project_ticket_no
    FROM tasks t
    LEFT JOIN projects p
      ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.workspace_id = ?
      AND t.id IN (${placeholders})
  `).all(workspaceId, ...taskIds) as TaskMetadataRow[]

  const out: Record<number, TaskCostMetadata> = {}
  for (const row of rows) {
    out[row.id] = row
  }
  return out
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url)
    const action = (searchParams.get('action') || 'list').trim().toLowerCase()
    const timeframe = searchParams.get('timeframe') || 'all'
    const format = searchParams.get('format') || 'json'

    const workspaceId = auth.user.workspace_id ?? 1
    const ledger = await loadTokenData(workspaceId, timeframe)
    const filteredData = ledger.records

    if (action === 'list') {
      return NextResponse.json({
        usage: filteredData.slice(0, 100), coverage: ledger.coverage, asOf: ledger.asOf,
        total: filteredData.length,
        timeframe,
      })
    }

    if (action === 'session-costs') {
      const groups = new Map<string, TokenUsageRecord[]>()
      for (const record of filteredData) groups.set(record.sessionId, [...(groups.get(record.sessionId) || []), record])
      return NextResponse.json({ sessions: [...groups.entries()].map(([sessionId, entries]) => ({
        sessionId, model: [...new Set(entries.map(entry => entry.model))].join(', '),
        inputTokens: entries.reduce((sum, entry) => sum + entry.inputTokens, 0), outputTokens: entries.reduce((sum, entry) => sum + entry.outputTokens, 0),
        totalTokens: calculateStats(entries).totalTokens, totalCost: calculateStats(entries).totalCost, requestCount: entries.length,
        pricedTokens: calculateStats(entries).pricedTokens, pricedRecordCount: calculateStats(entries).pricedRecordCount,
        firstSeen: new Date(Math.min(...entries.map(entry => entry.timestamp))).toISOString(), lastSeen: new Date(Math.max(...entries.map(entry => entry.timestamp))).toISOString(),
      })), coverage: ledger.coverage, asOf: ledger.asOf, timeframe })
    }

    if (action === 'stats') {
      const overallStats = calculateStats(filteredData)

      const modelGroups = filteredData.reduce((acc, record) => {
        if (!acc[record.model]) acc[record.model] = []
        acc[record.model].push(record)
        return acc
      }, Object.create(null) as Record<string, TokenUsageRecord[]>)

      const modelStats: Record<string, TokenStats> = Object.create(null)
      for (const [model, records] of Object.entries(modelGroups)) {
        modelStats[model] = calculateStats(records)
      }

      const sessionGroups = filteredData.reduce((acc, record) => {
        if (!acc[record.sessionId]) acc[record.sessionId] = []
        acc[record.sessionId].push(record)
        return acc
      }, Object.create(null) as Record<string, TokenUsageRecord[]>)

      const sessionStats: Record<string, TokenStats> = Object.create(null)
      for (const [sessionId, records] of Object.entries(sessionGroups)) {
        sessionStats[sessionId] = calculateStats(records)
      }

      // Agent aggregation: extract agent name from sessionId (format: "agentName:chatType")
      const agentGroups = filteredData.reduce((acc, record) => {
        const agent = record.agentName || extractAgentName(record.sessionId)
        if (!acc[agent]) acc[agent] = []
        acc[agent].push(record)
        return acc
      }, Object.create(null) as Record<string, TokenUsageRecord[]>)

      const agentStats: Record<string, TokenStats> = Object.create(null)
      for (const [agent, records] of Object.entries(agentGroups)) {
        agentStats[agent] = calculateStats(records)
      }

      return NextResponse.json({
        summary: overallStats,
        models: modelStats,
        sessions: sessionStats,
        agents: agentStats,
        agentBreakdown: buildAgentCostBreakdown(filteredData, ({ hour: 1 / 24, day: 1, week: 7, month: 30 } as Record<string, number>)[timeframe] || 30),
        coverage: ledger.coverage, asOf: ledger.asOf,
        timeframe,
        recordCount: filteredData.length,
      })
    }

    if (action === 'agent-costs') {
      const agentGroups = filteredData.reduce((acc, record) => {
        const agent = record.agentName || extractAgentName(record.sessionId)
        if (!acc[agent]) acc[agent] = []
        acc[agent].push(record)
        return acc
      }, Object.create(null) as Record<string, TokenUsageRecord[]>)

      const agents: Record<string, {
        stats: TokenStats
        models: Record<string, TokenStats>
        sessions: string[]
        timeline: Array<{ date: string; cost: number; tokens: number }>
      }> = Object.create(null)

      for (const [agent, records] of Object.entries(agentGroups)) {
        const stats = calculateStats(records)

        // Per-agent model breakdown
        const modelGroups = records.reduce((acc, r) => {
          if (!acc[r.model]) acc[r.model] = []
          acc[r.model].push(r)
          return acc
        }, Object.create(null) as Record<string, TokenUsageRecord[]>)
        const models: Record<string, TokenStats> = Object.create(null)
        for (const [model, mrs] of Object.entries(modelGroups)) {
          models[model] = calculateStats(mrs)
        }

        // Unique sessions
        const sessions = [...new Set(records.map(r => r.sessionId))]

        // Daily timeline
        const dailyMap = records.reduce((acc, r) => {
          const date = new Date(r.timestamp).toISOString().split('T')[0]
          if (!acc[date]) acc[date] = { cost: 0, tokens: 0 }
          acc[date].cost += r.cost
          acc[date].tokens += r.totalTokens
          return acc
        }, {} as Record<string, { cost: number; tokens: number }>)

        const timeline = Object.entries(dailyMap)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, data]) => ({ date, ...data }))

        agents[agent] = { stats, models, sessions, timeline }
      }

      return NextResponse.json({
        agents,
        timeframe,
        recordCount: filteredData.length,
      })
    }

    if (action === 'task-costs' || action === 'task_costs' || action === 'taskcosts') {
      const attributedTaskIds = [...new Set(
        filteredData
          .map((record) => record.taskId)
          .filter((taskId): taskId is number => Number.isFinite(taskId) && Number(taskId) > 0)
          .map((taskId) => Number(taskId))
      )]
      const taskMetadataById = loadTaskMetadataById(workspaceId, attributedTaskIds)
      const report = buildTaskCostReport(
        filteredData.map((record) => ({
          model: record.model,
          agentName: record.agentName || extractAgentName(record.sessionId),
          timestamp: record.timestamp,
          totalTokens: record.totalTokens,
          cost: record.cost,
          costSource: record.costSource,
          taskId: record.taskId ?? null,
        })),
        taskMetadataById
      )

      return NextResponse.json({
        ...report, coverage: ledger.coverage,
        timeframe,
        recordCount: filteredData.length,
        attributedRecordCount: report.summary.requestCount,
      })
    }

    if (action === 'export') {
      const overallStats = calculateStats(filteredData)
      const modelStats: Record<string, TokenStats> = Object.create(null)
      const sessionStats: Record<string, TokenStats> = Object.create(null)

      const modelGroups = filteredData.reduce((acc, record) => {
        if (!acc[record.model]) acc[record.model] = []
        acc[record.model].push(record)
        return acc
      }, Object.create(null) as Record<string, TokenUsageRecord[]>)

      for (const [model, records] of Object.entries(modelGroups)) {
        modelStats[model] = calculateStats(records)
      }

      const sessionGroups = filteredData.reduce((acc, record) => {
        if (!acc[record.sessionId]) acc[record.sessionId] = []
        acc[record.sessionId].push(record)
        return acc
      }, Object.create(null) as Record<string, TokenUsageRecord[]>)

      for (const [sessionId, records] of Object.entries(sessionGroups)) {
        sessionStats[sessionId] = calculateStats(records)
      }

      const exportData: ExportData = {
        coverage: ledger.coverage,
        usage: filteredData,
        summary: overallStats,
        models: modelStats,
        sessions: sessionStats,
      }

      if (format === 'csv') {
        const headers = ['timestamp', 'agentName', 'model', 'sessionId', 'operation', 'inputTokens', 'outputTokens', 'totalTokens', 'cost', 'costSource', 'source', 'taskId', 'duration']
        const csv = generateCsvContent(filteredData.map(record => ({ ...record,
          timestamp: new Date(record.timestamp).toISOString(), cost: record.costSource === 'unknown' ? '' : record.cost,
        })), headers)

        return new NextResponse(csv, {
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename=token-usage-${timeframe}-${new Date().toISOString().split('T')[0]}.csv`,
          },
        })
      }

      return NextResponse.json(exportData, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename=token-usage-${timeframe}-${new Date().toISOString().split('T')[0]}.json`,
        },
      })
    }

    if (action === 'trends') {
      const recentData = filteredData

      const hourlyTrends: Record<string, { tokens: number; cost: number; requests: number }> = {}

      recentData.forEach(record => {
        const hour = new Date(record.timestamp).toISOString().slice(0, 13) + ':00:00.000Z'
        if (!hourlyTrends[hour]) {
          hourlyTrends[hour] = { tokens: 0, cost: 0, requests: 0 }
        }
        hourlyTrends[hour].tokens += record.totalTokens
        hourlyTrends[hour].cost += record.cost
        hourlyTrends[hour].requests += 1
      })

      const trends = Object.entries(hourlyTrends)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([timestamp, data]) => ({ timestamp, ...data }))

      return NextResponse.json({ trends, timeframe })
    }

    return NextResponse.json({ error: 'Invalid action', action }, { status: 400 })
  } catch (error) {
    logger.error({ err: error }, 'Tokens API error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const body = await request.json()
    const workspaceId = auth.user.workspace_id ?? 1
    const { model, sessionId, inputTokens, outputTokens, operation = 'chat_completion', duration, taskId } = body

    if (typeof model !== 'string' || !model.trim() || typeof sessionId !== 'string' || !sessionId.trim() || !Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const totalTokens = inputTokens + outputTokens
    const price = priceUsage(model, inputTokens, outputTokens)
    const parsedTaskId =
      taskId != null && Number.isFinite(Number(taskId)) && Number(taskId) > 0
        ? Number(taskId)
        : null

    let validatedTaskId: number | null = null
    if (parsedTaskId) {
      const db = getDatabase()
      const taskRow = db.prepare(
        'SELECT id FROM tasks WHERE id = ? AND workspace_id = ?'
      ).get(parsedTaskId, workspaceId) as { id?: number } | undefined
      if (taskRow?.id) validatedTaskId = taskRow.id
    }

    const record: TokenUsageRecord = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      model,
      sessionId,
      agentName: extractAgentName(sessionId),
      timestamp: Date.now(),
      inputTokens,
      outputTokens,
      totalTokens,
      ...price, source: 'manual',
      operation,
      taskId: validatedTaskId,
      workspaceId,
      duration,
    }

    await appendTokenRecord(DATA_PATH, { ...record }, workspaceId)

    return NextResponse.json({ success: true, record })
  } catch (error) {
    logger.error({ err: error }, 'Error saving token usage')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
