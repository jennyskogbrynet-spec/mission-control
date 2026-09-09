import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ComputeDashboardPanel } from '../compute-dashboard-panel'
import type { ComputeAccount, ComputeOverview, ComputeRecommendation, ComputeWindow } from '@/lib/compute-types'

const observedAt = '2026-09-08T10:00:00Z'
const source = { kind: 'cli' as const, label: 'Bekreftet kvotekilde', evidenceRef: 'https://example.com/usage' }
const quota = (key: string, remaining: number | null): ComputeWindow => ({ key, label: key, remainingPercent: remaining, usedPercent: remaining == null ? null : 100 - remaining, used: null, limit: null, unit: 'percent', resetsAt: '2099-09-08T15:00:00Z', observedAt, source, freshness: remaining == null ? 'unknown' : 'fresh' })
function account(id: string, windows: ComputeWindow[]): ComputeAccount {
  return { id, label: `Konto ${id}`, provider: 'example-provider', plan: `Plan ${id}`, billingMode: 'subscription', enabled: true, status: 'ready', observedAt, source, resetCredits: null,
    pools: [{ id: `pool-${id}`, accountId: id, key: 'primary', label: 'Arbeidskvote', modelIds: ['model-one'], windowKeys: windows.map(window => window.key), windows, effectiveRemainingPercent: null, status: 'ready', observedAt, lastGoodObservedAt: observedAt, source, observationId: 'observation-one', lastObservationStatus: 'success', error: null }] }
}
function snapshot(): ComputeOverview {
  const first = account('a', [quota('Fem timer', 70), quota('Uke', 35)])
  first.resetCredits = { available: 3, observedAt, source, freshness: 'fresh', event: 'availability' }
  const second = account('b', [quota('Ukjent vindu', null)])
  second.status = 'login_required'; second.pools[0].status = 'unknown'
  return { asOf: observedAt, accounts: [first, second], warnings: [], refresh: { enabled: false, intervalHours: null, lastAttemptAt: null, lastSuccessAt: null, nextDueAt: null, status: 'not_configured' },
    bindings: [{ id: 'binding-a', accountId: 'a', runtimeId: 'claude-code', profileRef: 'opaque-private-profile', modelIds: ['model-one'], capabilities: ['coding', 'research'], poolIds: ['pool-a'], dataClasses: ['public', 'internal'], enabled: true, modelCapabilities: [{ modelId: 'model-one', tier: 'balanced', capabilities: ['coding'], notes: 'Egnet til avgrensede kodeoppgaver.', verifiedAt: observedAt, evidence: 'https://example.com/model' }], identityStatus: 'verified', entitlementStatus: 'verified', verifiedAt: observedAt, verificationFreshness: 'fresh', source, observationId: 'access-one' }, { id: 'binding-b', accountId: 'b', runtimeId: 'codex', profileRef: 'opaque-second-profile', modelIds: ['model-two'], capabilities: ['research'], poolIds: ['pool-b'], dataClasses: ['public', 'internal'], enabled: true, modelCapabilities: [], identityStatus: 'unknown', entitlementStatus: 'unknown', verifiedAt: null, verificationFreshness: 'unknown', source: null, observationId: null }] }
}
function recommendation(): ComputeRecommendation {
  return { asOf: observedAt, reservePercent: 20, candidates: [
    { bindingId: 'binding-a', accountId: 'a', runtimeId: 'claude-code', modelId: 'model-one', executable: true, refreshRecommended: false, effectiveRemainingPercent: 35, reasonCodes: ['ready'], evidenceObservationIds: ['access-one', 'observation-one'], score: 100 },
    { bindingId: 'binding-b', accountId: 'b', runtimeId: 'codex', modelId: 'model-two', executable: false, refreshRecommended: true, effectiveRemainingPercent: null, reasonCodes: ['access_refresh_required', 'quota_unknown'], evidenceObservationIds: [], score: 0 },
  ] }
}
function mockApi(data = snapshot()) {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/compute/recommend' && options?.method === 'POST') return Response.json(recommendation())
    if (url === '/api/projects') return Response.json({ projects: [{ id: 42, name: 'Prosjekt fra registeret' }] })
    return Response.json(data)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('compute capacity dashboard', () => {
  it('keeps each account/window separate and unknown quotas distinct from zero', async () => {
    const fetcher = mockApi()
    render(<ComputeDashboardPanel />)
    const first = await screen.findByRole('article', { name: 'Konto Konto a' })
    expect(within(first).getByText('70 % igjen')).toBeInTheDocument()
    expect(within(first).getByText('35 % igjen')).toBeInTheDocument()
    const unknown = screen.getByRole('group', { name: 'Kvote Ukjent vindu' })
    expect(within(unknown).getByText('Kvote ukjent')).toBeInTheDocument()
    expect(within(unknown).queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByText('Innlogging trengs')).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Resetreserve Konto a' })).toHaveTextContent('3 tilgjengelig')
    expect(screen.queryByRole('button', { name: /bruk.*reset|nullstill/i })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Automatisk oppdatering' })).toHaveTextContent('Ingen aktiv oppdateringsjobb')
    expect(fetcher.mock.calls).toHaveLength(2)
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true)
  })

  it('counts only active accounts while retaining collapsed account history and disabled binding evidence', async () => {
    const data = snapshot()
    const historical = account('historical', [quota('Tidligere uke', 60)])
    historical.enabled = false; historical.status = 'disabled'
    data.accounts.push(historical)
    data.bindings.push({ ...data.bindings[0], id: 'historical-binding', accountId: historical.id, enabled: false })
    mockApi(data)
    render(<ComputeDashboardPanel />)
    const primary = await screen.findByRole('region', { name: 'Aktive kontoer og abonnementer' })
    expect(within(primary).getAllByRole('article')).toHaveLength(2)
    expect(within(primary).queryByText('Konto historical')).not.toBeInTheDocument()
    expect(screen.getByText('Aktive kontoer').parentElement).toHaveTextContent(/^2Aktive kontoer/)
    expect(screen.getByText('Trenger kontroll').parentElement).toHaveTextContent(/^1Trenger kontroll/)
    expect(screen.getByText('Bekreftede kontokoblinger').parentElement).toHaveTextContent(/^1Bekreftede kontokoblinger/)
    const historyToggle = screen.getByText('Historiske kontoer (1)')
    expect(historyToggle.parentElement).not.toHaveAttribute('open')
    expect(screen.getByText('Konto historical')).not.toBeVisible()
    fireEvent.click(historyToggle)
    expect(historyToggle.parentElement).toHaveAttribute('open')
    expect(screen.getByText('Konto historical')).toBeVisible()
    expect(screen.getByText('60 % igjen')).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: 'Verktøy og modeller' }))
    expect(screen.getByText('Konto historical · 1 modeller')).toBeVisible()
    expect(screen.getByText('Deaktivert')).toBeVisible()
  })

  it('uses live project IDs and only previews routes, with no paid API fallback by default', async () => {
    const fetcher = mockApi()
    render(<ComputeDashboardPanel />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Finn kjørerute' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Prosjekt' }), { target: { value: '42' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kode' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Oppgaven er avklart og klar til gjennomføring' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Oppgaven er prioritert og har verdi for prosjektet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Vurder kjørerute' }))
    expect(await screen.findByText('Anbefalt')).toBeInTheDocument()
    expect(screen.getByText('Innlogging og modelltilgang må bekreftes på nytt.')).toBeInTheDocument()
    expect(screen.getByText('Gjenstående kvote er ikke målt.')).toBeInTheDocument()
    const posts = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0][0]).toBe('/api/compute/recommend')
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ projectId: 42, requiredCapabilities: ['coding'], difficulty: 'standard', dataClass: 'internal', ready: true, valuable: true, reservePercent: 20, allowedBillingModes: ['subscription', 'local'] })
    expect(screen.queryByRole('button', { name: /start|kjør nå|bruk reset/i })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Prosjekt' }), { target: { value: '' } })
    expect(screen.queryByText('Anbefalt')).not.toBeInTheDocument()
  })

  it('clamps a requested 100 percent reserve to the server-supported 90 percent boundary', async () => {
    const fetcher = mockApi()
    render(<ComputeDashboardPanel />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Finn kjørerute' }))
    const reserve = screen.getByRole('spinbutton', { name: /Hold igjen kvote som reserve/ })
    expect(reserve).toHaveAttribute('max', '90')
    fireEvent.change(reserve, { target: { value: '100' } })
    expect(reserve).toHaveValue(90)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Vurder kjørerute' }))
    await screen.findByText('Anbefalt')
    const post = fetcher.mock.calls.find(([url, options]) => url === '/api/compute/recommend' && options?.method === 'POST')
    expect(JSON.parse(String(post?.[1]?.body)).reservePercent).toBe(90)
  })

  it('omits inactive account and binding candidates from normal route results while retaining active blocked routes', async () => {
    const data = snapshot()
    data.accounts.push({ ...account('historical', []), enabled: false, status: 'disabled' })
    data.bindings.push({ ...data.bindings[0], id: 'historical-binding', accountId: 'historical' }, { ...data.bindings[0], id: 'disabled-binding', enabled: false, capabilities: ['historical_only'] })
    const preview = recommendation()
    preview.candidates.push({ ...preview.candidates[0], bindingId: 'historical-binding', accountId: 'historical', modelId: 'historical-model', executable: false, reasonCodes: ['account_disabled'] }, { ...preview.candidates[0], bindingId: 'disabled-binding', modelId: 'disabled-model', executable: false, reasonCodes: ['binding_disabled'] })
    const fetcher = mockApi(data)
    fetcher.mockImplementation(async url => Response.json(url === '/api/compute/recommend' ? preview : url === '/api/projects' ? { projects: [] } : data))
    render(<ComputeDashboardPanel />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Finn kjørerute' }))
    expect(screen.queryByRole('checkbox', { name: 'historical only' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Vurder kjørerute' }))
    const results = await screen.findByRole('region', { name: 'Vurderte kjøreruter' })
    expect(within(results).getAllByRole('article')).toHaveLength(2)
    expect(results).toHaveTextContent('1 kjørerute oppfyller kravene')
    expect(results).toHaveTextContent('Gjenstående kvote er ikke målt.')
    expect(results).not.toHaveTextContent('historical-model')
    expect(results).not.toHaveTextContent('disabled-model')
    fireEvent.click(screen.getByRole('tab', { name: 'Verktøy og modeller' }))
    expect(screen.getByText('Konto historical · 1 modeller')).toBeVisible()
    expect(screen.getByText('Deaktivert')).toBeVisible()
  })

  it('shows last-good figures as uncertain after a failed read, and actual collector failure', async () => {
    const data = snapshot()
    data.accounts[0].pools[0].lastObservationStatus = 'failed'
    data.accounts[0].pools[0].status = 'unavailable'
    data.accounts[0].pools[0].error = 'Innlesingen lyktes ikke.'
    data.refresh = { enabled: true, intervalHours: 24, lastAttemptAt: observedAt, lastSuccessAt: '2026-09-07T10:00:00Z', nextDueAt: '2026-09-09T10:00:00Z', status: 'failed', lastError: 'En kontokilde svarte ikke.' }
    mockApi(data)
    render(<ComputeDashboardPanel />)
    const quotaGroup = await screen.findByRole('group', { name: 'Kvote Fem timer' })
    expect(quotaGroup).toHaveTextContent('Sist målt')
    expect(quotaGroup).toHaveTextContent('Kontroll mislyktes')
    expect(quotaGroup).not.toHaveTextContent('Nylig målt')
    const refresh = screen.getByRole('complementary', { name: 'Automatisk oppdatering' })
    expect(refresh).toHaveTextContent('Oppdatering feilet')
    expect(refresh).toHaveTextContent('En kontokilde svarte ikke.')
    expect(refresh).toHaveTextContent('hver 24 time')
  })

  it('explains collector codes while keeping specific human-readable details and account verification scope', async () => {
    const data = snapshot()
    data.accounts[0].pools[0].lastObservationStatus = 'failed'
    data.accounts[0].pools[0].status = 'unavailable'
    data.accounts[0].pools[0].error = 'required_quota_window_missing'
    data.refresh = { ...data.refresh, status: 'failed', lastError: 'provider_cli_failed: Kontroller innloggingen i verktøyet.' }
    data.warnings = ['Leverandøren har endret måleperioden.', 'Ny kilde: unfamiliar_provider_detail']
    mockApi(data)
    render(<ComputeDashboardPanel />)
    const first = await screen.findByRole('article', { name: 'Konto Konto a' })
    expect(first).toHaveTextContent('En nødvendig kvoteperiode mangler i målingen')
    expect(first).not.toHaveTextContent('required_quota_window_missing')
    expect(within(first).getByRole('group', { name: 'Kvote Fem timer' })).toHaveTextContent('Sist målt')
    const refresh = screen.getByRole('complementary', { name: 'Automatisk oppdatering' })
    expect(refresh).toHaveTextContent('Kontoverktøyet kunne ikke hente status: Kontroller innloggingen i verktøyet.')
    expect(refresh).not.toHaveTextContent('provider_cli_failed')
    expect(screen.getByText('Leverandøren har endret måleperioden.')).toBeInTheDocument()
    expect(screen.getByText('Ny kilde: unfamiliar_provider_detail')).toBeInTheDocument()
    expect(screen.getByText('Bekreftede kontokoblinger')).toBeInTheDocument()
    expect(screen.getByText('Kontoen er bekreftet i verktøyet')).toBeInTheDocument()
    expect(screen.queryByText('Konto og modelltilgang er identifisert')).not.toBeInTheDocument()
  })

  it('distinguishes API failure from an empty account inventory and can reread', async () => {
    const fetcher = mockApi()
    fetcher.mockImplementation(async (url: string) => url === '/api/projects' ? Response.json({ projects: [] }) : Response.json({ error: 'Kapasitetskilden svarer ikke.' }, { status: 503 }))
    render(<ComputeDashboardPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Kapasitetskilden svarer ikke.')
    expect(screen.queryByText('Ingen aktive kontoer')).not.toBeInTheDocument()
    fetcher.mockImplementation(async (url: string) => Response.json(url === '/api/projects' ? { projects: [] } : snapshot()))
    fireEvent.click(screen.getByRole('button', { name: 'Last inn lagret status' }))
    expect(await screen.findByRole('article', { name: 'Konto Konto a' })).toBeInTheDocument()
  })

  it('supports keyboard tabs and shows per-model evidence without private profile references', async () => {
    mockApi()
    render(<ComputeDashboardPanel />)
    const accountsTab = await screen.findByRole('tab', { name: 'Kontoer og kvoter' })
    fireEvent.keyDown(accountsTab, { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Verktøy og modeller' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Egnet til avgrensede kodeoppgaver.', { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Modellgrunnlag/ })).toHaveAttribute('href', 'https://example.com/model')
    expect(screen.queryByText('opaque-private-profile')).not.toBeInTheDocument()
  })

  it('does not surface an obsolete preview after a status reread', async () => {
    const fetcher = mockApi()
    let finish: (response: Response) => void = () => {}
    fetcher.mockImplementation(async (url: string) => url === '/api/compute/recommend' ? new Promise<Response>(resolve => { finish = resolve }) : Response.json(url === '/api/projects' ? { projects: [] } : snapshot()))
    render(<ComputeDashboardPanel />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Finn kjørerute' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Vurder kjørerute' }))
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/compute/recommend')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Last inn lagret status' }))
    await act(async () => { finish(Response.json(recommendation())) })
    expect(screen.queryByText('Anbefalt')).not.toBeInTheDocument()
  })
})
