import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const { setJobs } = vi.hoisted(() => ({ setJobs: vi.fn() }))
const job = { id: 'test-id', name: 'Test automation', enabled: false, schedule: '0 6 * * *', command: 'Public test', agentId: 'main' }
vi.mock('@/store', () => ({ useMissionControl: () => ({ cronJobs: [job], setCronJobs: setJobs, dashboardMode: 'gateway' }) }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/components/ui/loader', () => ({ Loader: () => null }))
import { CronManagementPanel } from '../cron-management-panel'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => vi.clearAllMocks())

describe('manual cron run receipts', () => {
  it.each([
    [{ success: true, result: { ok: true, enqueued: true, runId: 'manual:test' } }, 'Run queued. Check run history for the outcome.'],
    [{ success: true, result: { ok: true, ran: true } }, 'Run finished. Check run history for the outcome.'],
    [{ success: false, result: { ok: true, ran: false, reason: 'not-due' }, error: 'Run not started: this job is not due yet.' }, 'Run request failed: Run not started: this job is not due yet.'],
    [{ success: false, result: { ok: true, ran: false, reason: 'invalid-spec' }, error: 'Run not started: the job configuration is invalid.' }, 'Run request failed: Run not started: the job configuration is invalid.'],
    [{ success: true, result: { ok: true } }, 'The scheduler did not confirm whether the run started. Refresh before retrying.'],
  ])('shows the actual run disposition: %j', async (receipt, message) => {
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => init?.method === 'POST' ? receipt : { jobs: [job], models: [] },
    }))
    vi.stubGlobal('fetch', fetchMock)
    render(<CronManagementPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'run' }))
    await waitFor(() => expect(alert).toHaveBeenCalledWith(message))
    const mutationCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(mutationCalls).toHaveLength(1)
    expect(JSON.parse(mutationCalls[0][1]?.body as string)).toMatchObject({ action: 'trigger', jobId: job.id, mode: 'force' })
  })
})
