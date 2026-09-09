import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COST_SCOPE_NOTICE, COST_COVERAGE_TOOLTIP } from '@/lib/cost-display'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock('@/store', () => ({
  useMissionControl: () => ({ sessions: [] }),
}))

// Recharts needs a measured container; jsdom reports zero. The charts are not
// what this test is about, so they are stubbed down to inert markup.
vi.mock('recharts', () => {
  const Stub = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: Stub, PieChart: Stub, Pie: Stub, Cell: Stub,
    LineChart: Stub, Line: Stub, XAxis: Stub, YAxis: Stub,
    CartesianGrid: Stub, Tooltip: Stub, Legend: Stub, BarChart: Stub, Bar: Stub,
  }
})

import { CostTrackerPanel } from '../cost-tracker-panel'

/**
 * `models` drives the coverage denominator. `claude-sonnet-4-5` is in the
 * pricing catalogue; `openclaw-cron-runtime` is not, so its tokens are unpriced.
 */
function mockTokenApi(models: Record<string, { totalTokens: number; totalCost: number; requestCount: number }>, totalCost: number) {
  const totalTokens = Object.values(models).reduce((sum, m) => sum + m.totalTokens, 0)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('by-agent')) {
      return { ok: true, json: async () => ({ agents: [], summary: { total_cost: totalCost, total_tokens: totalTokens, agent_count: 0, days: 1 } }) } as Response
    }
    if (url.includes('task-costs')) {
      return { ok: true, json: async () => ({ summary: { totalTokens, totalCost, requestCount: 1, avgTokensPerRequest: 1, avgCostPerRequest: totalCost }, tasks: [], agents: {}, unattributed: { totalTokens: 0, totalCost: 0, requestCount: 0, avgTokensPerRequest: 0, avgCostPerRequest: 0 }, timeframe: 'day' }) } as Response
    }
    if (url.includes('trends')) {
      return { ok: true, json: async () => ({ trends: [], timeframe: 'day' }) } as Response
    }
    return {
      ok: true,
      json: async () => ({
        summary: { totalTokens, totalCost, requestCount: 1, avgTokensPerRequest: totalTokens, avgCostPerRequest: totalCost },
        models, sessions: {}, timeframe: 'day', recordCount: 1,
      }),
    } as Response
  }))
}

beforeEach(() => { vi.useRealTimers() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('CostTrackerPanel scope label', () => {
  it('states the data source and the excluded population on the panel itself', async () => {
    mockTokenApi({ 'claude-sonnet-4-5': { totalTokens: 1000, totalCost: 0.01, requestCount: 1 } }, 0.01)
    render(<CostTrackerPanel />)
    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-notice')).toHaveTextContent(COST_SCOPE_NOTICE)
    })
  })
})

describe('CostTrackerPanel coverage gating', () => {
  it('withholds dollar amounts when priced coverage is below the threshold', async () => {
    // The measured 2026-09-09 shape: a sliver of priced tokens in a large ledger.
    mockTokenApi({
      'claude-sonnet-4-5': { totalTokens: 3_336, totalCost: 0.00024, requestCount: 1 },
      'openclaw-cron-runtime': { totalTokens: 2_406_664, totalCost: 0, requestCount: 1 },
    }, 0.00024)
    render(<CostTrackerPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-notice')).toHaveTextContent(/Priced coverage: 0\.1 %/)
    })
    // No dollar figure anywhere, and the withheld amounts explain themselves.
    expect(screen.queryAllByText(/\$\d/)).toHaveLength(0)
    const withheld = screen.getAllByTitle(COST_COVERAGE_TOOLTIP)
    expect(withheld.length).toBeGreaterThan(0)
    expect(withheld[0]).toHaveTextContent('—')
  })

  it('shows the amounts once the ledger is mostly catalogue-priced', async () => {
    mockTokenApi({
      'claude-sonnet-4-5': { totalTokens: 900, totalCost: 1.25, requestCount: 1 },
      'openclaw-cron-runtime': { totalTokens: 100, totalCost: 0, requestCount: 1 },
    }, 1.25)
    render(<CostTrackerPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-notice')).toHaveTextContent(/Priced coverage: 90 %/)
    })
    expect(screen.getAllByText('$1.2500').length).toBeGreaterThan(0)
    expect(screen.queryAllByTitle(COST_COVERAGE_TOOLTIP)).toHaveLength(0)
  })

  it('withholds amounts when there are no token records at all', async () => {
    mockTokenApi({}, 0)
    render(<CostTrackerPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-notice')).toHaveTextContent(/no priced coverage can be computed/)
    })
    expect(screen.queryAllByText(/\$\d/)).toHaveLength(0)
  })
})
