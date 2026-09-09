'use client'

import { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { useMissionControl } from '@/store'
import { createClientLogger } from '@/lib/client-logger'
import { getLowestRecordedUnitCost, describeUsageCost, getKnownCostShare, formatPriceCoverage, type CostCoverage, formatUsageCost as formatCost } from '@/lib/cost-insights'
import {
  COST_SCOPE_NOTICE,
  COST_COVERAGE_TOOLTIP,
  COST_ROW_UNPRICED_TOOLTIP,
  COST_UNAVAILABLE_PLACEHOLDER,
  computePricedCoverage,
  resolveDisplayCoverage,
  isAggregateCostDisplayable,
  isRowCostDisplayable,
  formatAggregateCost,
} from '@/lib/cost-display'
import {
  PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, BarChart, Bar,
} from 'recharts'

const log = createClientLogger('CostTracker')

// ── Types ──────────────────────────────────────────

interface TokenStats extends CostCoverage {
  totalTokens: number; totalCost: number; requestCount: number
  avgTokensPerRequest: number; avgCostPerRequest: number
}

interface UsageCoverage {
  sourceRecords: { database: number; manual: number; sessionSnapshots: number }
  billedCost: number; estimatedCost: number; excludedReportedRecords: number
  pricedTokenPercent: number | null; unknownCostTokens: number; excludedSnapshots: number; unavailableSources: string[]; unattributedTokens: number
}

interface UsageStats {
  coverage?: UsageCoverage
  summary: TokenStats
  models: Record<string, TokenStats>
  sessions: Record<string, { totalTokens: number; totalCost: number; requestCount: number }>
  timeframe: string
  recordCount: number
}

interface TrendData {
  trends: Array<{ timestamp: string; tokens: number; cost: number; requests: number }>
  timeframe: string
}

interface ByAgentModelBreakdown {
  pricing?: CostCoverage
  model: string; input_tokens: number; output_tokens: number; request_count: number; cost: number
}

interface ByAgentEntry {
  pricing?: CostCoverage
  agent: string; total_input_tokens: number; total_output_tokens: number
  total_tokens: number; total_cost: number; session_count: number
  request_count: number; last_active: string; models: ByAgentModelBreakdown[]
}

interface ByAgentResponse {
  agents: ByAgentEntry[]
  summary: { pricing?: CostCoverage; total_cost: number; total_tokens: number; agent_count: number; days: number }
}

interface TaskCostEntry {
  taskId: number; title: string; status: string; priority: string
  assignedTo?: string | null
  project: { id?: number | null; name?: string | null; slug?: string | null; ticketRef?: string | null }
  stats: TokenStats
  models: Record<string, TokenStats>
}

interface TaskCostsResponse {
  summary: TokenStats
  tasks: TaskCostEntry[]
  agents: Record<string, { stats: TokenStats; taskCount: number; taskIds: number[] }>
  unattributed: TokenStats
  timeframe: string
}

interface SessionCostEntry extends CostCoverage {
  sessionId: string; sessionKey?: string; model: string
  totalTokens: number; inputTokens: number; outputTokens: number
  totalCost: number; requestCount: number; firstSeen: string; lastSeen: string
}

// ── Helpers ──────────────────────────────────────────

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d', '#ffc658', '#ff6b6b']

const formatNumber = (num: number) => {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M'
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K'
  return num.toString()
}


// Every tab in this panel reads the same token ledger, so one coverage number
// describes all of them. It is provided through context rather than threaded as
// a prop because the four views nest several levels deep and a missed prop would
// silently restore the un-gated number this panel exists to stop showing.
//
// The context governs AGGREGATES only — totals, sums and shares computed across
// rows. Per-row amounts use <RowCost>, which never reads it. See the module doc
// in lib/cost-display.ts for why the two layers must not share a rule.
const CostCoverageContext = createContext<number | null>(null)

function useGatedCostFormat() {
  const coverage = useContext(CostCoverageContext)
  const gated = !isAggregateCostDisplayable(coverage)
  return {
    /** An aggregate dollar amount, or the placeholder when coverage cannot back it. */
    fc: (cost: number) => formatAggregateCost(cost, coverage, formatCost),
    /**
     * A ready-made aggregate label from `describeUsageCost`. Labels that already
     * withhold ('Unknown', 'No usage') pass through untouched: they are not
     * claims about an amount, so the coverage gate has nothing to withhold.
     */
    gl: (label: string) => (gated && label.includes('$') ? COST_UNAVAILABLE_PLACEHOLDER : label),
    gated,
  }
}

/**
 * An AGGREGATE `describeUsageCost` label — a total, a sum, or a figure summed
 * over every row. Withheld when the ledger's priced coverage cannot back it.
 */
function AggregateCostLabel({ label }: { label: string }) {
  const { gl, gated } = useGatedCostFormat()
  const withheld = gated && label.includes('$')
  return <span title={withheld ? COST_COVERAGE_TOOLTIP : undefined}>{gl(label)}</span>
}

/**
 * ONE ROW's own amount. Deliberately not gated on panel coverage: this row's
 * catalogue price is the only evidence relevant to this row's cost, and
 * `describeUsageCost` has already withheld ('Unknown') when there is none. The
 * row-level tooltip names that narrower reason so it cannot be mistaken for the
 * ledger-wide one.
 */
function RowCost({ info }: { info: { hasKnownCost: boolean; label: string } }) {
  const shown = isRowCostDisplayable(info.hasKnownCost)
  return <span title={shown ? undefined : COST_ROW_UNPRICED_TOOLTIP}>{info.label}</span>
}

/** A row-level rate, or the row-level withheld marker when the row has no price. */
function RowRate({ children }: { children: React.ReactNode }) {
  return <span title={COST_ROW_UNPRICED_TOOLTIP}>{children}</span>
}

const getModelDisplayName = (name: string) => name.split('/').pop() || name

type View = 'overview' | 'agents' | 'sessions' | 'tasks'
type Timeframe = 'hour' | 'day' | 'week' | 'month'

// ── Main Component ──────────────────────────────────

export function CostTrackerPanel() {
  const t = useTranslations('costTracker')
  const { sessions } = useMissionControl()

  const [view, setView] = useState<View>('overview')
  const [timeframe, setTimeframe] = useState<Timeframe>('day')
  const [chartMode, setChartMode] = useState<'incremental' | 'cumulative'>('incremental')
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)

  // Data
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null)
  const [trendData, setTrendData] = useState<TrendData | null>(null)
  const [byAgentData, setByAgentData] = useState<ByAgentResponse | null>(null)
  const [taskData, setTaskData] = useState<TaskCostsResponse | null>(null)
  const [sessionCosts, setSessionCosts] = useState<SessionCostEntry[]>([])
  const [sessionSort, setSessionSort] = useState<'cost' | 'tokens' | 'requests' | 'recent'>('cost')
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)

  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadData = useCallback(async () => {
    setIsLoading(true)
    try {
      const [statsRes, trendRes, taskRes] = await Promise.all([
        fetch(`/api/tokens?action=stats&timeframe=${timeframe}`),
        fetch(`/api/tokens?action=trends&timeframe=${timeframe}`),
        fetch(`/api/tokens?action=task-costs&timeframe=${timeframe}`),
      ])
      const [statsJson, trendJson, taskJson] = await Promise.all([
        statsRes.json(), trendRes.json(), taskRes.json(),
      ])
      if (!statsRes.ok) throw new Error(statsJson.error || 'Cost report unavailable')
      if (!trendRes.ok) throw new Error(trendJson.error || 'Cost trends unavailable')
      if (!taskRes.ok) throw new Error(taskJson.error || 'Task attribution unavailable')
      setLoadError(null)
      setUsageStats(statsJson)
      setTrendData(trendJson)
      setByAgentData(statsJson.agentBreakdown || null)
      setTaskData(taskJson)
    } catch (err) {
      log.error('Failed to load cost data:', err)
      setLoadError(err instanceof Error ? err.message : 'Cost report unavailable')
    } finally {
      setIsLoading(false)
    }
  }, [timeframe])

  const loadSessionCosts = useCallback(async () => {
    try {
      const res = await fetch(`/api/tokens?action=session-costs&timeframe=${timeframe}`)
      const data = await res.json()
      if (!res.ok || !Array.isArray(data?.sessions)) throw new Error(data.error || 'Session cost report unavailable')
      setSessionCosts(data.sessions)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Session cost report unavailable')
    }
  }, [timeframe])

  useEffect(() => { loadData() }, [loadData])
  useEffect(() => {
    refreshTimer.current = setInterval(loadData, 30_000)
    return () => { if (refreshTimer.current) clearInterval(refreshTimer.current) }
  }, [loadData])
  useEffect(() => { if (view === 'sessions') loadSessionCosts() }, [view, loadSessionCosts, usageStats])

  const exportData = async (format: 'json' | 'csv') => {
    setIsExporting(true)
    try {
      const res = await fetch(`/api/tokens?action=export&timeframe=${timeframe}&format=${format}`)
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.style.display = 'none'; a.href = url
      a.download = `cost-tracker-${timeframe}-${new Date().toISOString().split('T')[0]}.${format}`
      document.body.appendChild(a); a.click()
      window.URL.revokeObjectURL(url); document.body.removeChild(a)
    } catch (err) {
      log.error('Export failed:', err)
    } finally {
      setIsExporting(false)
    }
  }

  // Priced coverage for the selected timeframe. `usageStats.models` is the token
  // breakdown per model, which is exactly the denominator the gate needs: tokens
  // whose model the catalogue prices, over all tokens. Anything else in this
  // panel is a slice of the same ledger, so one number governs every tab.
  const pricedCoverage = useMemo(
    () => computePricedCoverage(
      Object.entries(usageStats?.models || {}).map(([model, stats]) => ({
        model,
        totalTokens: stats.totalTokens,
      })),
    ),
    [usageStats],
  )
  // The server measures this too, and measures it better. Its number wins; the
  // client computation above is the fallback for a payload without a coverage
  // envelope. See resolveDisplayCoverage for why null is not the same as absent.
  const displayCoverage = resolveDisplayCoverage(usageStats?.coverage?.pricedTokenPercent, pricedCoverage)
  const coveragePercent = displayCoverage.coverage === null
    ? null
    : Math.round(displayCoverage.coverage * 1000) / 10

  // Derived data
  const summary = usageStats?.summary
  const agentSummary = byAgentData?.summary
  const agentList = byAgentData?.agents || []
  const maxAgentCost = Math.max(...agentList.map(a => a.total_cost), 0)

  const getAgentTasks = (agentName: string): TaskCostEntry[] => {
    if (!taskData) return []
    const entry = taskData.agents[agentName]
    if (!entry) return []
    return taskData.tasks.filter(t => entry.taskIds.includes(t.taskId))
  }

  return (
    <CostCoverageContext.Provider value={displayCoverage.coverage}>
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="border-b border-border pb-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold text-foreground">{t('title')}</h1>
            <p className="text-muted-foreground mt-1">{t('subtitle')}</p>
          </div>
          <div className="flex items-center gap-3">
            {/* View tabs */}
            <div className="flex rounded-lg border border-border overflow-hidden">
              {(['overview', 'agents', 'sessions', 'tasks'] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    view === v ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
            {/* Timeframe */}
            <div className="flex space-x-1">
              {(['hour', 'day', 'week', 'month'] as const).map(tf => (
                <Button key={tf} onClick={() => setTimeframe(tf)} variant={timeframe === tf ? 'default' : 'secondary'} size="sm">
                  {tf.charAt(0).toUpperCase() + tf.slice(1)}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {loadError && <div role="alert" className="text-sm text-red-400">{loadError}</div>}

      {/* Scope and coverage. Rendered outside the tab switch so it is on every
          tab: the tabs are different cuts of one ledger, not different sources. */}
      <div
        data-testid="cost-scope-notice"
        className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground space-y-1"
      >
        <div>{COST_SCOPE_NOTICE}</div>
        <div>
          {coveragePercent === null
            ? 'No token records in this timeframe, so no priced coverage can be computed. Amounts are withheld.'
            : `Priced coverage: ${coveragePercent} % of ${formatNumber(pricedCoverage.totalTokens)} tokens have a catalogue price.${
                isAggregateCostDisplayable(displayCoverage.coverage)
                  ? ''
                  : ' Dollar amounts are withheld below 50 % — the remainder would be priced at a default rate, not a known one.'
              }`}
        </div>
      </div>

      {/* The measurement disclosure below is deliberately NOT gated: it is the
          statement of what is and is not priced, so withholding its own figures
          would remove the explanation the gate points at. */}
      {usageStats?.coverage && <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground space-y-1">
        <div>Shared usage data: {usageStats.coverage.sourceRecords.database + usageStats.coverage.sourceRecords.manual} reported usage records + {usageStats.coverage.sourceRecords.sessionSnapshots} session snapshots without identified overlaps. Overview and agents use the same data.</div>
        <div>Reported cost: {formatCost(usageStats.coverage.billedCost)}. Catalogue estimate: {formatCost(usageStats.coverage.estimatedCost)}; Claude and Grok base prices verified 2026-09-08; other provider estimates were not reverified. Excludes cache pricing, tools and special pricing modifiers.</div>
        <div>Price coverage: {formatPriceCoverage(usageStats.coverage.pricedTokenPercent)} of tokens. {formatNumber(usageStats.coverage.unknownCostTokens)} tokens have unknown cost; their dollars are excluded.</div>
        {usageStats.coverage.excludedSnapshots > 0 && <div>{usageStats.coverage.excludedSnapshots} overlapping or ambiguous snapshots excluded to avoid double counting.</div>}
        {usageStats.coverage.excludedReportedRecords > 0 && <div>{usageStats.coverage.excludedReportedRecords} duplicate or overlapping reported records excluded.</div>}
        {usageStats.coverage.unattributedTokens > 0 && <div>{formatNumber(usageStats.coverage.unattributedTokens)} tokens remain in the unattributed agent bucket.</div>}
        {usageStats.coverage.unavailableSources.length > 0 && <div role="alert" className="text-amber-400">Unavailable sources: {usageStats.coverage.unavailableSources.join(', ')}. Totals are incomplete.</div>}
      </div>}
      {isLoading && !usageStats ? (
        <Loader variant="panel" label={t('loadingCostData')} />
      ) : view === 'overview' ? (
        <OverviewView
          stats={usageStats} trendData={trendData} agentSummary={agentSummary}
          taskData={taskData} timeframe={timeframe} chartMode={chartMode}
          setChartMode={setChartMode} exportData={exportData} isExporting={isExporting}
          onRefresh={loadData}
        />
      ) : view === 'agents' ? (
        <AgentsView
          agents={agentList} summary={agentSummary} maxCost={maxAgentCost}
          expandedAgent={expandedAgent} setExpandedAgent={setExpandedAgent}
          getAgentTasks={getAgentTasks} onRefresh={loadData}
        />
      ) : view === 'sessions' ? (
        <SessionsView
          sessionCosts={sessionCosts} sessions={sessions}
          sessionSort={sessionSort} setSessionSort={setSessionSort}
        />
      ) : (
        <TasksView taskData={taskData} onRefresh={loadData} />
      )}
    </div>
    </CostCoverageContext.Provider>
  )
}

// ── Overview View ──────────────────────────────────

function OverviewView({
  stats, trendData, agentSummary, taskData, timeframe, chartMode, setChartMode,
  exportData, isExporting, onRefresh,
}: {
  stats: UsageStats | null; trendData: TrendData | null
  agentSummary: ByAgentResponse['summary'] | undefined; taskData: TaskCostsResponse | null
  timeframe: Timeframe; chartMode: 'incremental' | 'cumulative'
  setChartMode: (m: 'incremental' | 'cumulative') => void
  exportData: (f: 'json' | 'csv') => void; isExporting: boolean
  onRefresh: () => void
}) {
  const t = useTranslations('costTracker')
  if (!stats) {
    return (
      <div className="text-center text-muted-foreground py-12">
        <div className="text-lg mb-2">{t('noUsageData')}</div>
        <div className="text-sm max-w-sm mx-auto">
          {t('noUsageDataDesc')}
        </div>
        <Button onClick={onRefresh} variant="outline" size="sm" className="mt-4 text-xs">{t('refresh')}</Button>
      </div>
    )
  }

  const modelData = Object.entries(stats.models)
    .map(([model, s]) => ({ name: getModelDisplayName(model), fullName: model, tokens: s.totalTokens, cost: s.totalCost, requests: s.requestCount, costInfo: describeUsageCost(s) }))
    .sort((a, b) => b.cost - a.cost)

  const pieData = modelData.filter(m => m.costInfo.hasKnownCost).slice(0, 6).map(m => ({ name: m.name, value: m.cost }))

  const trendChartData = (() => {
    if (!trendData?.trends) return []
    const raw = trendData.trends.map(t => ({
      time: new Date(t.timestamp).toLocaleString([], { ...(timeframe === 'week' || timeframe === 'month' ? { month: 'short', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' }),
      tokens: t.tokens, cost: t.cost, requests: t.requests,
    }))
    if (chartMode === 'cumulative') {
      let ct = 0, cc = 0, cr = 0
      return raw.map(d => { ct += d.tokens; cc += d.cost; cr += d.requests; return { ...d, tokens: ct, cost: cc, requests: cr } })
    }
    return raw
  })()

  // Performance metrics
  const models = Object.entries(stats.models)
  const mostEfficient = getLowestRecordedUnitCost(stats.models)
  const efficientCostPerToken = mostEfficient?.costPerToken ?? 0
  const taskRecordCount = (taskData?.summary.requestCount || 0) + (taskData?.unattributed.requestCount || 0)
  const taskAttribution = taskData && taskRecordCount > 0 ? taskData.summary.requestCount / taskRecordCount * 100 : null

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">Catalogue usage estimate, not an invoice. Unknown models are excluded from dollar totals. A subscription alone does not prove free API usage. Session snapshots are selected by last activity, not billed usage within the period.</p>
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-3xl font-bold text-foreground"><AggregateCostLabel label={describeUsageCost(stats.summary).label} /></div>
          <div className="text-sm text-muted-foreground">{t('totalCost', { timeframe })}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-3xl font-bold text-foreground">{formatNumber(stats.summary.totalTokens)}</div>
          <div className="text-sm text-muted-foreground">{t('totalTokens')}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-3xl font-bold text-foreground">{formatNumber(stats.summary.requestCount)}</div>
          <div className="text-sm text-muted-foreground">Usage records</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-3xl font-bold text-foreground">{agentSummary?.agent_count ?? '-'}</div>
          <div className="text-sm text-muted-foreground">{t('activeAgents')}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-3xl font-bold text-foreground">
            {taskAttribution != null ? `${taskAttribution.toFixed(0)}%` : taskData ? 'No usage' : '-'}
          </div>
          <div className="text-sm text-muted-foreground">Task-attributed records</div>
        </div>
      </div>

      {/* Charts */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Trend chart */}
        <div className="bg-card border border-border rounded-lg p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">{t('usageTrends')}</h2>
            <div className="flex rounded-md border border-border overflow-hidden">
              {(['incremental', 'cumulative'] as const).map(m => (
                <button key={m} onClick={() => setChartMode(m)}
                  className={`px-2 py-1 text-[10px] font-medium ${chartMode === m ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground'}`}
                >{m === 'incremental' ? t('perTurn') : t('cumulative')}</button>
              ))}
            </div>
          </div>
          <div className="h-64">
            {trendChartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">{t('noTrendData')}</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendChartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" /><YAxis />
                  <Tooltip /><Legend />
                  <Line type="monotone" dataKey="tokens" stroke="#8884d8" strokeWidth={2} name="Tokens" />
                  <Line type="monotone" dataKey="requests" stroke="#82ca9d" strokeWidth={2} name="Usage records" />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Model bar chart */}
        <div className="bg-card border border-border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">{t('tokenUsageByModel')}</h2>
          <div className="h-64">
            {modelData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">{t('noModelData')}</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={modelData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" angle={-45} textAnchor="end" height={80} interval={0} />
                  <YAxis /><Tooltip formatter={(v, n) => [formatNumber(Number(v)), n]} />
                  <Bar dataKey="tokens" fill="#8884d8" name="Tokens" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Cost pie */}
        <div className="bg-card border border-border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">{t('costDistributionByModel')}</h2>
          <div className="h-64">
            {pieData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">{t('noCostData')}</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={80} paddingAngle={5} dataKey="value">
                    {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  {/* pieData is filtered to hasKnownCost rows, so each slice is a
                      priced row: a per-row amount, not an aggregate. */}
                  <Tooltip formatter={(v) => formatCost(Number(v))} /><Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Performance insights */}
      {models.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">{t('performanceInsights')}</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div className="bg-secondary rounded-lg p-4">
              <div className="text-xs text-muted-foreground mb-1">Lowest recorded unit cost</div>
              <div className="text-lg font-bold text-green-500">{mostEfficient ? getModelDisplayName(mostEfficient.model) : '-'}</div>
              {!mostEfficient && <div className="text-xs text-muted-foreground">No positive, attributed model cost to compare.</div>}
              {/* One named model's own rate — getLowestRecordedUnitCost only
                  considers rows with a positive, known cost per 1K. */}
              {mostEfficient && <div className="text-xs text-muted-foreground">{formatCost(efficientCostPerToken * 1000)}/1K priced tokens</div>}
            </div>
            <div className="bg-secondary rounded-lg p-4">
              <div className="text-xs text-muted-foreground mb-1">{t('avgTokensPerRequest')}</div>
              <div className="text-lg font-bold text-foreground">{formatNumber(stats.summary.avgTokensPerRequest)}</div>
            </div>
            <div className="bg-secondary rounded-lg p-4">
              <div className="text-xs text-muted-foreground mb-1">Savings forecast</div>
              <div className="text-lg font-bold text-orange-500">Not available</div>
              <div className="text-xs text-muted-foreground">Token counts do not measure task quality or comparable billing.</div>
            </div>
          </div>
          {/* Model efficiency bars */}
          <div className="space-y-2">
            {modelData.map(m => {
              const costPer1k = m.costInfo.costPerThousand
              const maxCostPer1k = Math.max(...modelData.map(d => d.costInfo.costPerThousand ?? 0), 0)
              return (
                <div key={m.fullName} className="flex items-center text-sm">
                  <div className="w-32 truncate text-muted-foreground">{m.name}</div>
                  <div className="flex-1 mx-3">
                    <div className="w-full bg-secondary rounded-full h-2">
                      <div className="bg-green-500 h-2 rounded-full" style={{ width: `${costPer1k != null && maxCostPer1k > 0 ? costPer1k / maxCostPer1k * 100 : 0}%` }} />
                    </div>
                  </div>
                  <div className="w-36 text-right text-xs text-muted-foreground">{costPer1k == null ? <RowRate>Unknown</RowRate> : `${formatCost(costPer1k)}/1K${m.costInfo.partial ? ' priced (partial)' : ''}`}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Export */}
      <div className="bg-card border border-border rounded-lg p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('exportData')}</h2>
            <p className="text-sm text-muted-foreground">{t('exportDataDesc')}</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => exportData('csv')} disabled={isExporting} size="sm" variant="secondary">{isExporting ? t('exporting') : 'CSV'}</Button>
            <Button onClick={() => exportData('json')} disabled={isExporting} size="sm" variant="secondary">{isExporting ? t('exporting') : 'JSON'}</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Agents View ──────────────────────────────────

function AgentsView({
  agents, summary, maxCost, expandedAgent, setExpandedAgent, getAgentTasks, onRefresh,
}: {
  agents: ByAgentEntry[]; summary: ByAgentResponse['summary'] | undefined
  maxCost: number; expandedAgent: string | null
  setExpandedAgent: (a: string | null) => void
  getAgentTasks: (name: string) => TaskCostEntry[]; onRefresh: () => void
}) {
  const { fc, gated } = useGatedCostFormat()
  const t = useTranslations('costTracker')
  const [expandedSection, setExpandedSection] = useState<'models' | 'tasks'>('tasks')

  if (!summary || agents.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-12">
        <div className="text-lg mb-2">{t('noAgentData')}</div>
        <div className="text-sm">{t('noAgentDataDesc')}</div>
        <Button onClick={onRefresh} className="mt-4">{t('refresh')}</Button>
      </div>
    )
  }

  const summaryCost = describeUsageCost({ totalTokens: summary.total_tokens, totalCost: summary.total_cost, ...summary.pricing })
  return (
    <div className="space-y-6">
      {/* Summary row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-3xl font-bold text-foreground">{summary.agent_count}</div>
          <div className="text-sm text-muted-foreground">{t('agents')}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-3xl font-bold text-foreground"><AggregateCostLabel label={summaryCost.label} /></div>
          <div className="text-sm text-muted-foreground">{t('totalCostDays', { days: summary.days })}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-3xl font-bold text-foreground">{formatNumber(summary.total_tokens)}</div>
          <div className="text-sm text-muted-foreground">{t('totalTokens')}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-3xl font-bold text-foreground">
            {summaryCost.costPerThousand == null ? 'Unknown' : fc(summaryCost.costPerThousand)}
          </div>
          <div className="text-sm text-muted-foreground">Avg per 1K priced tokens{summaryCost.partial ? ' (partial)' : ''}</div>
        </div>
      </div>

      {/* Cost bar chart */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">{t('perAgentCost')}</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={agents.filter(a => describeUsageCost({ totalTokens: a.total_tokens, totalCost: a.total_cost, ...a.pricing }).hasKnownCost).slice(0, 12).map(a => ({
              name: a.agent.length > 12 ? a.agent.slice(0, 11) + '\u2026' : a.agent,
              cost: a.total_cost,
            }))}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} />
              {/* Filtered to hasKnownCost agents above, so each bar is a priced row. */}
              <Tooltip formatter={(v) => formatCost(Number(v))} />
              <Bar dataKey="cost" fill="#0088FE" name="Cost ($)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Agent detail rows */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">{t('agentBreakdown')}</h2>
        <div className="space-y-2 max-h-[600px] overflow-y-auto">
          {agents.map(agent => {
            const costInfo = describeUsageCost({ totalTokens: agent.total_tokens, totalCost: agent.total_cost, ...agent.pricing })
            const costShare = costInfo.hasKnownCost ? getKnownCostShare(agent.total_cost, summary.total_cost) : null
            const isExpanded = expandedAgent === agent.agent
            const agentTasks = getAgentTasks(agent.agent)
            return (
              <div key={agent.agent} className="border border-border rounded-lg overflow-hidden">
                <Button onClick={() => setExpandedAgent(isExpanded ? null : agent.agent)}
                  variant="ghost" className="w-full p-4 h-auto flex items-center justify-between text-left">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-medium text-foreground truncate">{agent.agent}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground shrink-0">
                      {agent.session_count} session{agent.session_count !== 1 ? 's' : ''}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500 shrink-0">
                      {agent.request_count} record{agent.request_count !== 1 ? 's' : ''}
                    </span>
                    {agentTasks.length > 0 && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500 shrink-0">
                        {agentTasks.length} task{agentTasks.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-sm shrink-0">
                    <div className="w-24 hidden md:block">
                      <div className="w-full bg-secondary rounded-full h-2">
                        <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${costInfo.hasKnownCost && maxCost > 0 ? agent.total_cost / maxCost * 100 : 0}%` }} />
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium text-foreground"><RowCost info={costInfo} /></div>
                      {/* The share divides this row by the summed known cost, so it
                          is computed across rows and gates with the aggregates. */}
                      <div className="text-xs text-muted-foreground">{costShare == null || gated
                        ? <span title={gated ? COST_COVERAGE_TOOLTIP : undefined}>{COST_UNAVAILABLE_PLACEHOLDER}</span>
                        : `${costShare.toFixed(1)}% of known cost`}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-muted-foreground">{formatNumber(agent.total_tokens)}</div>
                      <div className="text-xs text-muted-foreground">{t('tokens')}</div>
                    </div>
                    <svg className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <polyline points="4,6 8,10 12,6" />
                    </svg>
                  </div>
                </Button>

                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-border bg-secondary/30">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-3 mb-3">
                      <div><div className="text-xs text-muted-foreground">{t('inputTokens')}</div><div className="text-sm font-medium">{formatNumber(agent.total_input_tokens)}</div></div>
                      <div><div className="text-xs text-muted-foreground">{t('outputTokens')}</div><div className="text-sm font-medium">{formatNumber(agent.total_output_tokens)}</div></div>
                      <div><div className="text-xs text-muted-foreground">{t('ioRatio')}</div><div className="text-sm font-medium">{agent.total_output_tokens > 0 ? (agent.total_input_tokens / agent.total_output_tokens).toFixed(2) : '-'}</div></div>
                      <div><div className="text-xs text-muted-foreground">{t('lastActive')}</div><div className="text-sm font-medium">{new Date(agent.last_active).toLocaleDateString()}</div></div>
                    </div>

                    <div className="flex gap-2 mb-3">
                      <Button variant={expandedSection === 'tasks' ? 'default' : 'ghost'} size="sm" onClick={(e) => { e.stopPropagation(); setExpandedSection('tasks') }}>Tasks ({agentTasks.length})</Button>
                      <Button variant={expandedSection === 'models' ? 'default' : 'ghost'} size="sm" onClick={(e) => { e.stopPropagation(); setExpandedSection('models') }}>Models ({agent.models.length})</Button>
                    </div>

                    {expandedSection === 'tasks' && (
                      <div className="text-sm">
                        {agentTasks.length === 0 ? (
                          <div className="text-xs text-muted-foreground italic py-2">{t('noTaskCosts')}</div>
                        ) : (
                          <div className="space-y-1.5">
                            {agentTasks.map(task => (
                              <div key={task.taskId} className="flex items-center justify-between text-xs">
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                    task.priority === 'critical' ? 'bg-red-500/10 text-red-500' :
                                    task.priority === 'high' ? 'bg-orange-500/10 text-orange-500' :
                                    task.priority === 'medium' ? 'bg-yellow-500/10 text-yellow-500' :
                                    'bg-secondary text-muted-foreground'
                                  }`}>{task.priority}</span>
                                  {task.project.ticketRef && <span className="text-muted-foreground font-mono">{task.project.ticketRef}</span>}
                                  <span className="text-foreground truncate">{task.title}</span>
                                </div>
                                <span className="font-medium text-foreground w-16 text-right shrink-0"><RowCost info={describeUsageCost(task.stats)} /></span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {expandedSection === 'models' && agent.models.length > 0 && (
                      <div className="space-y-1.5">
                        {agent.models.map(m => (
                          <div key={m.model} className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground truncate">{getModelDisplayName(m.model)}</span>
                            <div className="flex gap-4 shrink-0">
                              <span>{formatNumber(m.input_tokens)} in</span>
                              <span>{formatNumber(m.output_tokens)} out</span>
                              <span>{m.request_count} reqs</span>
                              <span className="font-medium text-foreground w-16 text-right"><RowCost info={describeUsageCost({ totalTokens: m.input_tokens + m.output_tokens, totalCost: m.cost, ...m.pricing })} /></span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Sessions View ──────────────────────────────────

function SessionsView({
  sessionCosts, sessions, sessionSort, setSessionSort,
}: {
  sessionCosts: SessionCostEntry[]; sessions: any[]
  sessionSort: 'cost' | 'tokens' | 'requests' | 'recent'
  setSessionSort: (s: 'cost' | 'tokens' | 'requests' | 'recent') => void
}) {
  const t = useTranslations('costTracker')
  const sorted = [...sessionCosts].sort((a, b) => {
    switch (sessionSort) {
      case 'cost': return b.totalCost - a.totalCost
      case 'tokens': return b.totalTokens - a.totalTokens
      case 'requests': return b.requestCount - a.requestCount
      case 'recent': return (b.lastSeen || '').localeCompare(a.lastSeen || '')
      default: return 0
    }
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">{t('sortBy')}:</span>
        {(['cost', 'tokens', 'requests', 'recent'] as const).map(s => (
          <button key={s} onClick={() => setSessionSort(s)}
            className={`px-2 py-1 text-xs rounded ${sessionSort === s ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
          >{s === 'requests' ? 'Records' : s.charAt(0).toUpperCase() + s.slice(1)}</button>
        ))}
      </div>

      {sorted.length === 0 ? (
        <div className="text-center text-muted-foreground py-12">
          <p className="text-lg mb-1">{t('noSessionCostData')}</p>
          <p className="text-sm">{t('noSessionCostDataDesc')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map(entry => {
            const sessionInfo = sessions.find((s: any) => s.id === entry.sessionId)
            const costInfo = describeUsageCost(entry)
            return (
              <div key={entry.sessionId} role="group" aria-label={`Session ${entry.sessionId}`} className="bg-card border border-border rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="min-w-0">
                    <div className="font-medium text-foreground truncate">
                      {entry.sessionKey || sessionInfo?.key || entry.sessionId}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                      {sessionInfo?.active && <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />}
                      <span>{sessionInfo?.active ? t('activeStatus') : t('inactiveStatus')}</span>
                      {entry.model && <span>| {getModelDisplayName(entry.model)}</span>}
                      {sessionInfo?.kind && <span>| {sessionInfo.kind}</span>}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-lg font-bold text-foreground"><RowCost info={costInfo} /></div>
                    <div className="text-xs text-muted-foreground">{formatNumber(entry.totalTokens)} tokens</div>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-4 text-xs text-muted-foreground border-t border-border/50 pt-2 mt-2">
                  <div><span className="font-medium text-foreground">{entry.requestCount}</span> records</div>
                  <div><span className="font-medium text-foreground">{formatNumber(entry.inputTokens || 0)}</span> {t('inShort')}</div>
                  <div><span className="font-medium text-foreground">{formatNumber(entry.outputTokens || 0)}</span> {t('outShort')}</div>
                  <div>{costInfo.costPerRecord == null ? <RowRate>Unknown</RowRate> : <span className="font-medium text-foreground">{formatCost(costInfo.costPerRecord)}</span>} avg/priced record{costInfo.partial ? ' (partial)' : ''}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Tasks View ──────────────────────────────────

function TasksView({ taskData, onRefresh }: { taskData: TaskCostsResponse | null; onRefresh: () => void }) {
  const t = useTranslations('costTracker')
  if (!taskData || taskData.tasks.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-12">
        <div className="text-lg mb-2">{t('noTaskCostData')}</div>
        <div className="text-sm">{t('noTaskCostDataDesc')}</div>
        <Button onClick={onRefresh} className="mt-4">{t('refresh')}</Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-3xl font-bold text-foreground">{taskData.tasks.length}</div>
          <div className="text-sm text-muted-foreground">{t('tasksWithCosts')}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-3xl font-bold text-foreground"><AggregateCostLabel label={taskData.summary.requestCount === 0 ? 'No usage' : describeUsageCost(taskData.summary).label} /></div>
          <div className="text-sm text-muted-foreground">{t('attributedCost')}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-3xl font-bold text-foreground">{formatNumber(taskData.summary.totalTokens)}</div>
          <div className="text-sm text-muted-foreground">{t('attributedTokens')}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-3xl font-bold text-orange-500"><AggregateCostLabel label={taskData.unattributed.requestCount === 0 ? 'No usage' : describeUsageCost(taskData.unattributed).label} /></div>
          <div className="text-sm text-muted-foreground">{t('unattributed')}</div>
        </div>
      </div>

      {/* Task list */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">{t('tasksByCost')}</h2>
        <div className="space-y-2 max-h-[600px] overflow-y-auto">
          {taskData.tasks.map(task => (
            <div key={task.taskId} role="group" aria-label={`Task ${task.title}`} className="border border-border rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
                    task.priority === 'critical' ? 'bg-red-500/10 text-red-500' :
                    task.priority === 'high' ? 'bg-orange-500/10 text-orange-500' :
                    task.priority === 'medium' ? 'bg-yellow-500/10 text-yellow-500' :
                    'bg-secondary text-muted-foreground'
                  }`}>{task.priority}</span>
                  {task.project.ticketRef && <span className="text-xs text-muted-foreground font-mono shrink-0">{task.project.ticketRef}</span>}
                  <span className="font-medium text-foreground truncate">{task.title}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] shrink-0 ${
                    task.status === 'done' ? 'bg-green-500/10 text-green-500' :
                    task.status === 'in_progress' ? 'bg-blue-500/10 text-blue-500' :
                    'bg-secondary text-muted-foreground'
                  }`}>{task.status}</span>
                </div>
                <div className="text-right shrink-0 ml-3">
                  <div className="font-medium text-foreground"><RowCost info={describeUsageCost(task.stats)} /></div>
                  <div className="text-xs text-muted-foreground">{formatNumber(task.stats.totalTokens)} {t('tokens')} | {task.stats.requestCount} {t('reqs')}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
