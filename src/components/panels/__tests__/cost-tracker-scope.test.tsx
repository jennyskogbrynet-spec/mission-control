import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COST_SCOPE_NOTICE,
  COST_COVERAGE_TOOLTIP,
  COST_ROW_UNPRICED_TOOLTIP,
  COST_UNAVAILABLE_PLACEHOLDER,
} from '@/lib/cost-display'

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
type ServerCoverage = { pricedTokenPercent: number | null }

/** The `coverage` envelope `/api/tokens` returns, filled in around the one field under test. */
function serverCoverage(pricedTokenPercent: number | null) {
  return {
    sourceRecords: { database: 1, manual: 0, sessionSnapshots: 0 },
    billedCost: 0, estimatedCost: 0, excludedReportedRecords: 0,
    pricedTokenPercent, unknownCostTokens: 0, excludedSnapshots: 0,
    unavailableSources: [] as string[], unattributedTokens: 0,
  }
}

/** One agent row as `/api/tokens` returns it inside `agentBreakdown`. */
function agentRow(agent: string, totalTokens: number, totalCost: number, pricedTokens: number, pricedRecordCount: number) {
  return {
    agent, total_tokens: totalTokens, total_cost: totalCost,
    total_input_tokens: totalTokens, total_output_tokens: 0,
    session_count: 1, request_count: 1, last_active: '2026-09-09T00:00:00Z',
    models: [], pricing: { pricedTokens, pricedRecordCount },
  }
}

function mockTokenApi(
  models: Record<string, { totalTokens: number; totalCost: number; requestCount: number }>,
  totalCost: number,
  coverage?: ServerCoverage,
  agentBreakdown?: unknown,
) {
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
        ...(agentBreakdown ? { agentBreakdown } : {}),
        ...(coverage ? { coverage: serverCoverage(coverage.pricedTokenPercent) } : {}),
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
  it('withholds the aggregate total when priced coverage is below the threshold', async () => {
    // The measured 2026-09-09 shape: a sliver of priced tokens in a large ledger.
    mockTokenApi({
      'claude-sonnet-4-5': { totalTokens: 3_336, totalCost: 0.00024, requestCount: 1 },
      'openclaw-cron-runtime': { totalTokens: 2_406_664, totalCost: 0, requestCount: 1 },
    }, 0.00024)
    render(<CostTrackerPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-notice')).toHaveTextContent(/Priced coverage: 0\.1 %/)
    })
    // The summed figure is the one the sparse ledger cannot back.
    const withheld = screen.getAllByTitle(COST_COVERAGE_TOOLTIP)
    expect(withheld.length).toBeGreaterThan(0)
    expect(withheld[0]).toHaveTextContent(COST_UNAVAILABLE_PLACEHOLDER)
    expect(screen.getByText('totalCost')).toBeInTheDocument()
    expect(screen.getByText('totalCost').parentElement).toHaveTextContent(COST_UNAVAILABLE_PLACEHOLDER)
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


/**
 * The server already measures priced coverage over the same ledger, with a fuller
 * view of which records carry a known price than the model breakdown alone gives.
 * When `/api/tokens` reports it, the panel must use that number rather than
 * recomputing a weaker one on the client.
 */
describe('CostTrackerPanel server-reported coverage', () => {
  const slivers = {
    'claude-sonnet-4-5': { totalTokens: 3_336, totalCost: 1.25, requestCount: 1 },
    'openclaw-cron-runtime': { totalTokens: 2_406_664, totalCost: 0, requestCount: 1 },
  }

  it('uses coverage.pricedTokenPercent from the API instead of the client computation', async () => {
    // Client-side the breakdown is 0.1 % priced; the server says 90 %.
    mockTokenApi(slivers, 1.25, { pricedTokenPercent: 90 })
    render(<CostTrackerPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-notice')).toHaveTextContent(/Priced coverage: 90 %/)
    })
    expect(screen.getAllByText('$1.2500').length).toBeGreaterThan(0)
    expect(screen.queryAllByTitle(COST_COVERAGE_TOOLTIP)).toHaveLength(0)
  })

  it('gates on the server number when the server reports low coverage', async () => {
    // Inverted: the client breakdown would allow the amounts, the server says no.
    mockTokenApi(
      { 'claude-sonnet-4-5': { totalTokens: 1_000, totalCost: 1.25, requestCount: 1 } },
      1.25,
      { pricedTokenPercent: 4 },
    )
    render(<CostTrackerPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-notice')).toHaveTextContent(/Priced coverage: 4 %/)
    })
    const withheld = screen.getAllByTitle(COST_COVERAGE_TOOLTIP)
    expect(withheld.length).toBeGreaterThan(0)
    expect(withheld[0]).toHaveTextContent(COST_UNAVAILABLE_PLACEHOLDER)
  })

  it('falls back to the client computation when the API sends no coverage envelope', async () => {
    mockTokenApi(slivers, 1.25)
    render(<CostTrackerPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-notice')).toHaveTextContent(/Priced coverage: 0\.1 %/)
    })
    expect(screen.getAllByTitle(COST_COVERAGE_TOOLTIP).length).toBeGreaterThan(0)
  })
})


/**
 * Ruling 2026-09-09: the coverage gate governs AGGREGATES — totals, sums,
 * "this week" figures and shares computed across rows. A single row's own
 * amount is a narrower claim, and it stands or falls on that row's own
 * catalogue price. Withholding it because the rest of the ledger is unpriced
 * removes decision support the snapshot's per-row layer already earned.
 */
describe('CostTrackerPanel per-row amounts under a low aggregate coverage', () => {
  // 0.1 % priced ledger-wide, but the claude row itself has a known cost.
  const sparseLedger = {
    'claude-sonnet-4-5': { totalTokens: 3_336, totalCost: 0.5, requestCount: 1 },
    'openclaw-cron-runtime': { totalTokens: 2_406_664, totalCost: 0, requestCount: 1 },
  }

  it('shows a row that has a catalogue price while the total stays withheld', async () => {
    mockTokenApi(sparseLedger, 0.5)
    render(<CostTrackerPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-notice')).toHaveTextContent(/Priced coverage: 0\.1 %/)
    })
    // Row: 0.5 USD over 3 336 priced tokens = $0.1499 per 1K. Rendered, not hidden.
    const pricedRow = screen.getByText('$0.1499/1K')
    expect(pricedRow).toBeInTheDocument()
    expect(pricedRow).not.toHaveAttribute('title', COST_COVERAGE_TOOLTIP)
    // Aggregate: withheld, for the ledger-wide reason.
    expect(screen.getByText('totalCost').parentElement).toHaveTextContent(COST_UNAVAILABLE_PLACEHOLDER)
  })

  it('withholds a row whose own price is unknown, with the row-level reason', async () => {
    mockTokenApi(sparseLedger, 0.5)
    render(<CostTrackerPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-notice')).toHaveTextContent(/Priced coverage: 0\.1 %/)
    })
    const unpricedRow = screen.getByText('openclaw-cron-runtime').parentElement!
    // The row-level placeholder says which of the two reasons applies. It is
    // deliberately not the aggregate em dash: "this row has no price" and "the
    // ledger is barely priced" are different statements about different things.
    expect(within(unpricedRow).getByTitle(COST_ROW_UNPRICED_TOOLTIP)).toBeInTheDocument()
    expect(within(unpricedRow).queryAllByTitle(COST_COVERAGE_TOOLTIP)).toHaveLength(0)
    expect(unpricedRow).not.toHaveTextContent('$')
  })

  it('shows both layers once the ledger is mostly catalogue-priced', async () => {
    mockTokenApi({
      'claude-sonnet-4-5': { totalTokens: 900, totalCost: 1.25, requestCount: 1 },
      'openclaw-cron-runtime': { totalTokens: 100, totalCost: 0, requestCount: 1 },
    }, 1.25)
    render(<CostTrackerPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-notice')).toHaveTextContent(/Priced coverage: 90 %/)
    })
    expect(screen.getByText('totalCost').parentElement).toHaveTextContent('$1.2500')
    expect(screen.getByText('$1.3889/1K')).toBeInTheDocument()
    expect(screen.queryAllByTitle(COST_COVERAGE_TOOLTIP)).toHaveLength(0)
  })
})

/**
 * `costShare` is a percentage of the summed known cost, so it is computed
 * ACROSS rows and gates with the other aggregates — even though the row it sits
 * next to keeps its own amount.
 */
describe('CostTrackerPanel cross-row cost share', () => {
  const agentBreakdown = {
    agents: [
      agentRow('main', 3_336, 0.5, 3_336, 1),
      agentRow('cron', 2_406_664, 0, 0, 0),
    ],
    summary: {
      total_cost: 0.5, total_tokens: 2_410_000, agent_count: 2, days: 1,
      pricing: { pricedTokens: 3_336, pricedRecordCount: 1 },
    },
  }
  const sparseLedger = {
    'claude-sonnet-4-5': { totalTokens: 3_336, totalCost: 0.5, requestCount: 1 },
    'openclaw-cron-runtime': { totalTokens: 2_406_664, totalCost: 0, requestCount: 1 },
  }

  it('withholds the share at low coverage while the agent row keeps its amount', async () => {
    mockTokenApi(sparseLedger, 0.5, undefined, agentBreakdown)
    render(<CostTrackerPanel />)
    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-notice')).toHaveTextContent(/Priced coverage: 0\.1 %/)
    })
    fireEvent.click(screen.getByRole('button', { name: /^Agents$/ }))

    const mainRow = await screen.findByRole('button', { name: /^main / })
    expect(within(mainRow).getByText('$0.5000')).toBeInTheDocument()
    expect(within(mainRow).queryByText(/% of known cost/)).toBeNull()
    expect(within(mainRow).getAllByTitle(COST_COVERAGE_TOOLTIP).length).toBeGreaterThan(0)
  })

  it('shows the share once the ledger is priced enough to back it', async () => {
    mockTokenApi(sparseLedger, 0.5, { pricedTokenPercent: 90 }, agentBreakdown)
    render(<CostTrackerPanel />)
    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-notice')).toHaveTextContent(/Priced coverage: 90 %/)
    })
    fireEvent.click(screen.getByRole('button', { name: /^Agents$/ }))

    const mainRow = await screen.findByRole('button', { name: /^main / })
    expect(within(mainRow).getByText('100.0% of known cost')).toBeInTheDocument()
  })
})
