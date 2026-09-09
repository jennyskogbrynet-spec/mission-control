import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ComputeAnalysisPanel } from '../compute-analysis-panel'
import type { ComputeAccount, ComputeBinding } from '@/lib/compute-types'
import type { SubscriptionRun } from '@/lib/subscription-runs'

const identity = vi.hoisted(() => ({ user: { id: 7, role: 'operator', workspace_id: 1, tenant_id: 1 } }))
vi.mock('@/store', () => ({ useMissionControl: (selector: (state: unknown) => unknown) => selector({ currentUser: identity.user }) }))
const runId = '10000000-1000-4000-8000-100000000001'
const storageKey = 'mc-compute-analysis:1:1:7'
const source = { kind: 'cli' as const, label: 'Verified test source' }
const account: ComputeAccount = { id: 'test-account', label: 'Testabonnement', provider: 'test', plan: 'Subscription', billingMode: 'subscription', enabled: true, status: 'ready', observedAt: '2026-09-08T12:00:00Z', source, pools: [], resetCredits: null }
const binding: ComputeBinding = { id: 'test-binding', accountId: account.id, runtimeId: 'claude-code', profileRef: 'private-profile', modelIds: ['model-one'], capabilities: ['analysis'], poolIds: [], dataClasses: ['public', 'internal'], enabled: true, modelCapabilities: [], identityStatus: 'verified', entitlementStatus: 'verified', verificationFreshness: 'fresh', verifiedAt: '2026-09-08T12:00:00Z', source, observationId: 'test-observation' }
const props = { projects: [{ id: 42, name: 'Testprosjekt' }], accounts: [account], bindings: [binding, { ...binding, id: 'other-binding', runtimeId: 'zai-claude-code' }] }
function receipt(status: SubscriptionRun['status'] = 'running'): SubscriptionRun {
  return { id: runId, workspaceId: 1, projectId: 42, taskId: null, bindingId: binding.id, accountId: account.id, runtimeId: binding.runtimeId, mode: 'packet_analysis', requestedModel: 'model-one', observedModel: status === 'completed' ? 'model-one-observed' : null,
    observedModels: status === 'completed' ? ['model-one-observed'] : [], status, prompt: 'Vurder denne produktideen.', reply: status === 'completed' ? 'Her er vurderingen.' : '', error: null, sessionId: 'opaque-session', startedAt: '2026-09-08T12:00:00Z', finishedAt: status === 'completed' ? '2026-09-08T12:00:30Z' : null,
    estimatedCostUsd: status === 'completed' ? 0.000014 : null, billedCostUsd: null, evidenceObservationIds: ['test-observation'], limitations: ['Submitted text only.'] }
}
function mockApi() {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? Response.json({ run: receipt() }, { status: 202 }) : Response.json({ runs: [] }))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
async function fillForm() {
  await screen.findByText('Ingen tekstanalyser er registrert.')
  fireEvent.change(screen.getByRole('combobox', { name: 'Prosjekt for analysen' }), { target: { value: '42' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Konto og verktøy' }), { target: { value: binding.id } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Modell for analysen' }), { target: { value: 'model-one' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Tekst og spørsmål' }), { target: { value: 'Vurder denne produktideen.' } })
}
beforeEach(() => {
  identity.user = { id: 7, role: 'operator', workspace_id: 1, tenant_id: 1 }
  sessionStorage.clear()
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(runId)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear() })

describe('bounded subscription text analysis UI', () => {
  it('does not read privileged receipts for viewers or another workspace', () => {
    const fetcher = mockApi()
    identity.user.role = 'viewer'
    const view = render(<ComputeAnalysisPanel {...props} />)
    expect(screen.getByText(/En operatør eller administrator/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start tekstanalyse' })).not.toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
    identity.user = { ...identity.user, role: 'operator', workspace_id: 2 }
    view.rerender(<ComputeAnalysisPanel {...props} />)
    expect(screen.getByText(/fra hovedarbeidsområdet/)).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires a supported subscription runtime and only starts the explicit text packet', async () => {
    const fetcher = mockApi()
    render(<ComputeAnalysisPanel {...props} />)
    await fillForm()
    fireEvent.change(screen.getByRole('combobox', { name: 'Konto og verktøy' }), { target: { value: 'other-binding' } })
    expect(screen.getByText(/Denne kjøreruten kan vurderes/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start tekstanalyse' })).toBeDisabled()
    fireEvent.change(screen.getByRole('combobox', { name: 'Konto og verktøy' }), { target: { value: binding.id } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Modell for analysen' }), { target: { value: 'model-one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start tekstanalyse' }))
    expect(await screen.findByRole('heading', { name: 'Analysen pågår' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Analysen er fullført' })).not.toBeInTheDocument()
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ idempotencyKey: runId, projectId: 42, bindingId: binding.id, modelId: 'model-one', prompt: 'Vurder denne produktideen.', difficulty: 'standard', dataClass: 'internal' })
    expect(sessionStorage.getItem(storageKey)).toBe(runId)
    expect(JSON.stringify(sessionStorage)).not.toContain('produktideen')
    expect(screen.getByText(/åpner ingen prosjektfiler/)).toBeInTheDocument()
  })

  it('distinguishes account/runtime duplicates by quota and keeps inactive routes out of analysis choices', async () => {
    const fetcher = mockApi()
    const pool = (id: string, label: string): ComputeAccount['pools'][number] => ({ id, accountId: account.id, key: id, label, modelIds: [], windowKeys: [], windows: [], effectiveRemainingPercent: null, status: 'unknown', observedAt: null, lastGoodObservedAt: null, source: null, observationId: null, lastObservationStatus: null, error: null })
    const options = { ...props, accounts: [{ ...account, pools: [pool('all', 'Generell kvote'), pool('deep', 'Grundig kvote')] }, { ...account, id: 'historical-account', label: 'Historisk abonnement', enabled: false }], bindings: [
      { ...binding, poolIds: ['all'] }, { ...binding, id: 'deep-binding', poolIds: ['all', 'deep'], modelIds: ['deep-model'] },
      { ...binding, id: 'disabled-binding', modelIds: ['disabled-model'], enabled: false },
      { ...binding, id: 'historical-binding', accountId: 'historical-account' },
    ] }
    const view = render(<ComputeAnalysisPanel {...options} />)
    await fillForm()
    const choices = screen.getByRole('combobox', { name: 'Konto og verktøy' })
    expect(within(choices).getByRole('option', { name: 'Testabonnement · Claude Code · Generell kvote' })).toHaveValue(binding.id)
    expect(within(choices).getByRole('option', { name: 'Testabonnement · Claude Code · Grundig kvote' })).toHaveValue('deep-binding')
    expect(within(choices).getAllByRole('option')).toHaveLength(3)
    expect(choices).not.toHaveTextContent('Historisk abonnement')
    expect(choices).not.toHaveTextContent('disabled-model')
    expect(screen.getByRole('button', { name: 'Start tekstanalyse' })).toBeEnabled()
    view.rerender(<ComputeAnalysisPanel {...options} bindings={options.bindings.map(item => item.id === binding.id ? { ...item, enabled: false } : item)} />)
    expect(screen.getByRole('button', { name: 'Start tekstanalyse' })).toBeDisabled()
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true)
  })

  it('uses exact model hints when duplicate runtime choices have no distinct quota names', async () => {
    mockApi()
    render(<ComputeAnalysisPanel {...props} bindings={[binding, { ...binding, id: 'second-model-binding', modelIds: ['model-two'] }]} />)
    const choices = screen.getByRole('combobox', { name: 'Konto og verktøy' })
    expect(within(choices).getByRole('option', { name: 'Testabonnement · Claude Code · model-one' })).toHaveValue(binding.id)
    expect(within(choices).getByRole('option', { name: 'Testabonnement · Claude Code · model-two' })).toHaveValue('second-model-binding')
    await screen.findByText('Ingen tekstanalyser er registrert.')
  })

  it('keeps the exact UUID and payload after an uncertain start, without automatic resend', async () => {
    const fetcher = mockApi()
    let posts = 0
    fetcher.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') { if (++posts === 1) throw new Error('connection lost'); return Response.json({ run: receipt() }) }
      return Response.json({ runs: [] })
    })
    render(<ComputeAnalysisPanel {...props} />)
    await fillForm()
    fireEvent.click(screen.getByRole('button', { name: 'Start tekstanalyse' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Kjøringen kan ha startet')
    expect(posts).toBe(1)
    expect(screen.getByRole('textbox', { name: 'Tekst og spørsmål' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Send samme innsending på nytt med samme referanse' }))
    expect(await screen.findByRole('heading', { name: 'Analysen pågår' })).toBeInTheDocument()
    const calls = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(calls).toHaveLength(2)
    expect(calls[1][1]?.body).toBe(calls[0][1]?.body)
  })

  it('recovers a lost response by UUID after remount, without replaying the private text', async () => {
    sessionStorage.setItem(storageKey, runId)
    const fetcher = mockApi()
    fetcher.mockImplementation(async url => Response.json(url.includes('?id=') ? { run: receipt('completed') } : { runs: [] }))
    render(<ComputeAnalysisPanel {...props} />)
    expect(await screen.findByRole('heading', { name: 'Analysen er fullført' })).toBeInTheDocument()
    expect(fetcher.mock.calls.some(([url]) => url === `/api/compute/runs?id=${runId}`)).toBe(true)
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true)
    const result = screen.getByRole('region', { name: 'Analysekvittering' })
    expect(within(result).getByText('Her er vurderingen.')).toBeInTheDocument()
    expect(result).toHaveTextContent('model-one-observed')
    expect(result).toHaveTextContent('0,000014 USD. Dette er ikke en faktura.')
    expect(result).toHaveTextContent('Faktisk fakturert beløp er ikke rapportert')
    expect(sessionStorage.getItem(storageKey)).toBeNull()
  })

  it('keeps a running receipt cancellable when status polling fails', async () => {
    vi.useFakeTimers()
    const fetcher = mockApi()
    fetcher.mockImplementation(async url => {
      if (url.includes('?id=')) throw new Error('temporary status outage')
      return Response.json({ runs: [receipt()] })
    })
    render(<ComputeAnalysisPanel {...props} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('heading', { name: 'Analysen pågår' })).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByRole('alert')).toHaveTextContent('Siste kjente status beholdes')
    expect(screen.getByRole('button', { name: 'Stopp analysen' })).toBeEnabled()
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true)
  })

  it('does not claim a successful stop until a terminal receipt confirms it', async () => {
    const fetcher = mockApi()
    let stopped = false
    fetcher.mockImplementation(async (url, init) => {
      if (init?.method === 'DELETE') return Response.json({ status: 'stopping' }, { status: 202 })
      return Response.json(url.includes('?id=') ? { run: receipt(stopped ? 'interrupted' : 'running') } : { runs: [receipt()] })
    })
    render(<ComputeAnalysisPanel {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Stopp analysen' }))
    expect(await screen.findByText('Stopp er forespurt. Venter på bekreftet avslutning.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Analysen pågår' })).toBeInTheDocument()
    stopped = true
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hent kvittering' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Hent kvittering' }))
    expect(await screen.findByRole('heading', { name: 'Analysen er stoppet' })).toBeInTheDocument()
    expect(screen.queryByText('Stopp er forespurt. Venter på bekreftet avslutning.')).not.toBeInTheDocument()
  })

  it('surfaces cancellation and preflight failures without creating a successful result', async () => {
    const fetcher = mockApi()
    fetcher.mockImplementation(async (_url, init) => init?.method === 'DELETE' ? Response.json({ error: 'Another process owns this run' }, { status: 409 }) : Response.json({ runs: [receipt()] }))
    const view = render(<ComputeAnalysisPanel {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Stopp analysen' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Stopp er ikke bekreftet')
    expect(screen.getByRole('heading', { name: 'Analysen pågår' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stopp analysen' })).toBeEnabled()
    view.unmount(); sessionStorage.clear()
    fetcher.mockImplementation(async (_url, init) => init?.method === 'POST' ? Response.json({ run: { ...receipt('failed'), error: 'No model request was sent' } }) : Response.json({ runs: [] }))
    render(<ComputeAnalysisPanel {...props} />)
    await fillForm()
    fireEvent.click(screen.getByRole('button', { name: 'Start tekstanalyse' }))
    expect(await screen.findByRole('heading', { name: 'Analysen feilet' })).toBeInTheDocument()
    expect(screen.getByText('No model request was sent')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Analysens svar' })).not.toBeInTheDocument()
  })

  it('reads an existing uncertain receipt after a start conflict and reconciles it without another POST', async () => {
    const fetcher = mockApi()
    fetcher.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') return Response.json({ error: 'Run persistence was interrupted' }, { status: 409 })
      if (init?.method === 'PATCH') return Response.json({ run: receipt('interrupted') })
      return Response.json(url.includes('?id=') ? { run: receipt('unknown') } : { runs: [] })
    })
    render(<ComputeAnalysisPanel {...props} />)
    await fillForm()
    fireEvent.click(screen.getByRole('button', { name: 'Start tekstanalyse' }))
    expect(await screen.findByRole('heading', { name: 'Kjøringen må avklares' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Avklar kjøringen' })).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Start tekstanalyse' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Avklar kjøringen' }))
    expect(await screen.findByRole('heading', { name: 'Analysen er stoppet' })).toBeInTheDocument()
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    const patch = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ id: runId, action: 'reconcile' })
  })

  it('does not replace a completed receipt with an older in-flight status response', async () => {
    const fetcher = mockApi()
    const finish: ((response: Response) => void)[] = []
    fetcher.mockImplementation(async url => url.includes('?id=')
      ? new Promise<Response>(resolve => { finish.push(resolve) }) : Response.json({ runs: [receipt()] }))
    render(<ComputeAnalysisPanel {...props} />)
    const read = await screen.findByRole('button', { name: 'Hent kvittering' })
    fireEvent.click(read); fireEvent.click(read)
    expect(finish).toHaveLength(2)
    await act(async () => { finish[1](Response.json({ run: receipt('completed') })) })
    await act(async () => { finish[0](Response.json({ run: receipt() })) })
    expect(screen.getByRole('heading', { name: 'Analysen er fullført' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stopp analysen' })).not.toBeInTheDocument()
  })
})
