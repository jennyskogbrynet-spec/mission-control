import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { CostTrackerPanel } from '../cost-tracker-panel'
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/store', () => ({ useMissionControl: () => ({ sessions: [] }) }))
vi.mock('recharts', () => ({
  ResponsiveContainer: () => null, PieChart: () => null, Pie: () => null, Cell: () => null,
  LineChart: () => null, Line: () => null, XAxis: () => null, YAxis: () => null,
  CartesianGrid: () => null, Tooltip: () => null, Legend: () => null, BarChart: () => null, Bar: () => null,
}))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('cost rows with incomplete pricing', () => {
  it('shows unknown model/agent costs, true local zero and exact tiny-cost shares', async () => {
    const pricing = { pricedTokens: 4, pricedRecordCount: 1 }
    const unknown = { pricedTokens: 0, pricedRecordCount: 0 }
    const stats = (totalTokens: number, totalCost: number, priced: typeof pricing) => ({ totalTokens, totalCost, requestCount: 1, avgTokensPerRequest: totalTokens, avgCostPerRequest: totalCost, ...priced })
    const agent = (name: string, totalTokens: number, totalCost: number, priced: typeof pricing) => ({ agent: name, total_tokens: totalTokens, total_cost: totalCost, total_input_tokens: totalTokens, total_output_tokens: 0, session_count: 1, request_count: 1, last_active: '2026-09-08T00:00:00Z', models: [], pricing: priced })
    const data = {
      summary: stats(1701004, 0.000014, { pricedTokens: 1004, pricedRecordCount: 2 }), models: { 'claude-sonnet-5': stats(4, 0.000014, pricing), 'glm-5.2': stats(1700000, 0, unknown), 'ollama/qwen2.5:3b': stats(1000, 0, { pricedTokens: 1000, pricedRecordCount: 1 }) }, sessions: {},
      agentBreakdown: { agents: [agent('main', 4, 0.000014, pricing), agent('research', 1700000, 0, unknown), agent('local', 1000, 0, { pricedTokens: 1000, pricedRecordCount: 1 })], summary: { total_cost: 0.000014, total_tokens: 1701004, agent_count: 3, days: 1, pricing: { pricedTokens: 1004, pricedRecordCount: 2 } } },
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('action=stats') ? data : url.includes('trends') ? { trends: [] } : { tasks: [], agents: {}, summary: {}, unattributed: {} })))
    render(<CostTrackerPanel />)
    const modelName = await screen.findByText('glm-5.2')
    expect(within(modelName.parentElement!).getByText('Unknown')).toBeInTheDocument()
    expect(screen.getByText('$0.0000/1K')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Agents$/ }))
    expect(screen.getByText('100.0% of known cost')).toBeInTheDocument()
    expect(screen.queryByText('14.0%')).not.toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: /^research / })).getByText('Unknown')).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: /^local / })).getByText('$0.0000')).toBeInTheDocument()
  })
})


it('preserves unknown, local zero and partial amounts through Sessions and Tasks tabs', async () => {
  const stats = (cost: number, pricedTokens: number, pricedRecordCount: number) => ({ totalTokens: 1000, totalCost: cost, requestCount: 10, avgTokensPerRequest: 100, avgCostPerRequest: cost / 10, pricedTokens, pricedRecordCount })
  const records = [{ name: 'unpriced', stats: stats(0, 0, 0) }, { name: 'local', stats: stats(0, 1000, 10) }, { name: 'mixed', stats: stats(0.000014, 4, 1) }]
  const taskData = { summary: { ...stats(0.000014, 1004, 11), totalTokens: 3000, requestCount: 30 }, unattributed: stats(0, 0, 0), agents: {}, tasks: records.map((record, id) => ({ taskId: id + 1, title: record.name, stats: record.stats, status: 'done', priority: 'medium', project: {}, models: {} })) }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(
    url.includes('session-costs') ? { sessions: records.map(record => ({ sessionId: record.name, model: record.name, inputTokens: 1000, outputTokens: 0, firstSeen: '', lastSeen: '', ...record.stats })) } :
    url.includes('action=stats') ? { summary: { ...stats(0.000014, 1004, 11), totalTokens: 3000, requestCount: 30 }, models: {}, sessions: {} } :
    url.includes('trends') ? { trends: [] } : taskData,
  )))
  render(<CostTrackerPanel />)
  expect(await screen.findByText('75%')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^Sessions$/ }))
  const unpricedSession = await screen.findByRole('group', { name: 'Session unpriced' })
  expect(within(unpricedSession).getByText('Unknown')).toBeInTheDocument()
  expect(unpricedSession).toHaveTextContent('Unknown avg/priced record')
  expect(within(screen.getByRole('group', { name: 'Session local' })).getAllByText('$0.0000')).toHaveLength(2)
  expect(within(screen.getByRole('group', { name: 'Session mixed' })).getByText('$0.0000140 (partial)')).toBeInTheDocument()
  expect(within(screen.getByRole('group', { name: 'Session mixed' })).getByText('$0.0000140')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^Tasks$/ }))
  expect(within(screen.getByRole('group', { name: 'Task unpriced' })).getByText('Unknown')).toBeInTheDocument()
  expect(within(screen.getByRole('group', { name: 'Task local' })).getByText('$0.0000')).toBeInTheDocument()
  expect(within(screen.getByRole('group', { name: 'Task mixed' })).getByText('$0.0000140 (partial)')).toBeInTheDocument()
})
