'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { ComputeAnalysisPanel } from './compute-analysis-panel'

import type { ComputeSource as EvidenceSource, ComputeWindow as QuotaWindow, ComputeAccount, ComputeBinding, ComputeOverview as ComputeSnapshot, ComputeRecommendation as RoutePreview, ComputeRecommendationInput as RouteRequest, ComputeReasonCode } from '@/lib/compute-types'
interface ProjectOption { id: number; name: string }
const views = [{ id: 'accounts', name: 'Kontoer og kvoter' }, { id: 'route', name: 'Finn kjørerute' }, { id: 'analysis', name: 'Tekstanalyse' }, { id: 'registry', name: 'Verktøy og modeller' }] as const

const statusLabels: Record<string, string> = {
  ready: 'Klar', login_required: 'Innlogging trengs', unknown: 'Ukjent', disabled: 'Deaktivert', unavailable: 'Utilgjengelig',
  refresh_required: 'Ny måling trengs', stale: 'Gammel måling', exhausted: 'Kvoten er brukt opp', reset_unconfirmed: 'Nullstilling må bekreftes',
  fresh: 'Nylig målt', refresh_due: 'Bør kontrolleres', verified: 'Bekreftet', unverified: 'Ikke bekreftet',
  not_configured: 'Ikke satt opp', running: 'Oppdatering pågår', success: 'Siste oppdatering fullført', failed: 'Oppdatering feilet', idle: 'Venter på neste oppdatering',
}
const collectorErrorLabels: Record<string, string> = {
  required_quota_window_missing: 'En nødvendig kvoteperiode mangler i målingen',
  provider_cli_failed: 'Kontoverktøyet kunne ikke hente status',
  provider_cli_unavailable: 'Kontoverktøyet er ikke tilgjengelig',
  provider_timeout: 'Leverandøren svarte ikke innen fristen',
  provider_output_too_large: 'Leverandørens svar var for stort til å leses',
  provider_protocol_closed: 'Forbindelsen til kontoverktøyet ble brutt',
  provider_rpc_failed: 'Kontoverktøyet avviste statuskontrollen',
  provider_response_invalid: 'Leverandørens svar kunne ikke tolkes',
  provider_quota_fetch_failed: 'Kvoten kunne ikke hentes fra leverandøren',
  provider_api_key_unavailable: 'Innloggingsopplysninger for kvotekilden mangler',
  provider_api_key_invalid: 'Innloggingsopplysningene for kvotekilden må kontrolleres',
  provider_api_key_file_invalid: 'Det lokale oppsettet for innlogging må kontrolleres',
  provider_api_key_file_unreadable: 'Lokale innloggingsopplysninger kunne ikke leses',
  provider_api_key_file_ambiguous: 'Oppsettet angir flere mulige innlogginger',
  account_identity_unavailable: 'Det kunne ikke bekreftes hvilken konto som er innlogget',
  account_changed_during_collection: 'Den innloggede kontoen endret seg under kontrollen',
  unexpected_account_identity: 'En annen konto enn forventet er innlogget',
  quota_account_identity_mismatch: 'Kvotemålingen tilhører en annen konto enn forventet',
  subscription_auth_not_verified: 'Innloggingen på abonnementet kunne ikke bekreftes',
  subscription_entitlement_unavailable: 'Tilgangen gjennom abonnementet kunne ikke bekreftes',
  subscription_changed_during_collection: 'Abonnementet endret seg under kontrollen',
  source_observation_time_missing: 'Tidspunktet for kvotemålingen mangler',
  source_observation_time_in_future: 'Kvotemålingen har et ugyldig tidspunkt i fremtiden',
  ambiguous_quota_window: 'Kvotemålingen angir ikke entydig hvilken periode den gjelder',
  duplicate_quota_window: 'Samme kvoteperiode er registrert flere ganger i oppsettet',
  profile_directory_unsupported: 'Denne kontoprofilen støttes ikke av innsamlingen',
  profile_directory_missing: 'Den lokale kontoprofilen mangler',
  profile_not_configured: 'Kontoprofilen er ikke satt opp for innsamling',
  duplicate_profile_reference: 'Samme kontoprofil er registrert flere ganger',
  expected_account_identity_required: 'Oppsettet mangler identiteten til kontoen som skal kontrolleres',
  registry_account_mismatch: 'Kontoprofilen stemmer ikke med kontoregisteret',
  registry_identity_mismatch: 'Kontoidentiteten stemmer ikke med kontoregisteret',
  registry_quota_constraints_mismatch: 'Kvotene i oppsettet stemmer ikke med kontoregisteret',
  registry_binding_mismatch: 'Verktøykoblingen stemmer ikke med kontoregisteret',
  registry_unavailable: 'Kontoregisteret kunne ikke hentes',
  manual_usage_observation_required: 'Denne kvotekilden må kontrolleres manuelt',
  incomplete_provider_observation: 'Leverandørens måling er ufullstendig',
  collector_config_invalid: 'Oppsettet for kvoteinnsamlingen må kontrolleres',
  collector_config_too_large: 'Oppsettet for kvoteinnsamlingen er for stort',
  collector_output_too_large: 'Resultatet fra kvoteinnsamlingen er for stort',
  collector_internal_error: 'Kvoteinnsamlingen stoppet på grunn av en intern feil',
  collector_configuration_or_transport_failed: 'Kvoteinnsamlingen kunne ikke koble til med gjeldende oppsett',
  publication_receipt_invalid: 'Lagringen av kvotemålingen kunne ikke bekreftes',
  publication_unconfirmed: 'Lagringen av kvotemålingen er ikke bekreftet',
}
function collectorDetail(message: string): string {
  return message.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, code => collectorErrorLabels[code] || code)
}
const capabilityLabels: Record<string, string> = {
  review: 'Kvalitetssjekk', coding: 'Kode', code: 'Kode', code_editing: 'Endre kode', research: 'Research', web_research: 'Nettresearch', analysis: 'Analyse',
  browser: 'Nettleser', browser_automation: 'Arbeid i nettleser', terminal: 'Terminal', files: 'Filer', vision: 'Bilder og skjerm',
  image_generation: 'Lage bilder', video: 'Video', writing: 'Skriving', long_context: 'Store dokumenter', reasoning: 'Resonnering',
  tools: 'Verktøybruk', tool_use: 'Verktøybruk', local: 'Lokal kjøring', private_data: 'Skjermede data', structured_output: 'Strukturert resultat',
}
const reasonLabels: Record<string, string> & Record<ComputeReasonCode, string> = {
  ready: 'Modell, kontotilgang og kvote oppfyller kravene.', binding_disabled: 'Denne kjøreruten er deaktivert.',
  billing_not_allowed: 'Kjøreruten bruker en betalingsform som ikke er valgt for denne oppgaven.',
  access_refresh_required: 'Innlogging og modelltilgang må bekreftes på nytt.', access_stale: 'Bekreftelsen av kontotilgangen er for gammel.',
  model_unverified: 'Modellens egenskaper er ikke bekreftet.', data_scope_mismatch: 'Kjøreruten er ikke godkjent for oppgavens dataskjerming.',
  quota_not_configured: 'Ingen relevant kvote er koblet til denne ruten.', quota_unavailable: 'Den siste kvotekontrollen feilet.',
  identity_unverified: 'Koblingen til denne kontoen er ikke bekreftet.', identity_unknown: 'Vi vet ikke hvilken konto denne kjøreruten bruker.',
  entitlement_unverified: 'Tilgang til modellen er ikke bekreftet for denne kontoen.', entitlement_unknown: 'Modelltilgangen er ukjent.',
  login_required: 'Denne kontoen trenger innlogging.', account_disabled: 'Kontoen er deaktivert.', account_unavailable: 'Kontostatus er utilgjengelig.',
  capability_mismatch: 'Kjøreruten dekker ikke alle behovene i oppgaven.', missing_capabilities: 'En eller flere nødvendige ferdigheter mangler.',
  model_capability_mismatch: 'Modellen dekker ikke alle oppgavekravene.', quota_unknown: 'Gjenstående kvote er ikke målt.',
  quota_exhausted: 'Den relevante kvoten er brukt opp.', quota_stale: 'Kvotemålingen er for gammel.', quota_refresh_required: 'Kvoten må måles på nytt før bruk.',
  refresh_required: 'Det trengs en fersk kvotemåling.', reset_unconfirmed: 'Nullstillingstidspunktet er passert, men ny kvote er ikke bekreftet.',
  below_reserve: 'Denne ruten vil bruke av den avsatte reserven.', reserve_protected: 'Reserven holdes av til prioritert arbeid.',
  not_ready: 'Oppgaven er ikke markert klar for gjennomføring.', not_valuable: 'Oppgaven er ikke markert prioritert.',
  task_not_ready: 'Oppgaven må avklares før den kan startes.', task_not_valuable: 'Oppgaven må prioriteres før kapasitet reserveres.',
  data_class_blocked: 'Kjøreruten passer ikke oppgavens krav til skjerming.', restricted_data: 'Skjermede data krever en godkjent kjørerute.',
  difficulty_mismatch: 'Ruten er ikke vurdert egnet for denne vanskelighetsgraden.', eligible: 'Kravene er oppfylt i den lagrede målingen.',
  sufficient_capacity: 'Den relevante kvoten har kapasitet over reserven.',
}
const card = 'rounded-2xl border border-border bg-card'
const field = 'w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/60'
const dateFormatter = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' })
function date(value: string | null | undefined): string { return value && Number.isFinite(Date.parse(value)) ? dateFormatter.format(new Date(value)) : 'Ikke registrert' }
function percentage(value: number | null | undefined): string { return value == null || !Number.isFinite(value) ? 'Ukjent' : `${value.toLocaleString('nb-NO', { maximumFractionDigits: 1 })} %` }
function label(value: string) { return capabilityLabels[value] || value.replace(/[_-]/g, ' ') }
function runtimeLabel(value: string) { return ({ 'codex-cli': 'Codex', 'zai-claude-code': 'GLM via Claude Code', 'claude-code': 'Claude Code', claude_code: 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw', 'grok-build': 'Grok Build', grok_build: 'Grok Build', ollama: 'Ollama' } as Record<string, string>)[value] || value }
function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'good' | 'warn' | 'neutral' }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${tone === 'good' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' : tone === 'warn' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-secondary text-muted-foreground'}`}>{children}</span>
}
function Source({ source, observedAt }: { source: EvidenceSource | null | undefined; observedAt: string | null | undefined }) {
  const href = source?.evidenceRef && /^https?:\/\//i.test(source.evidenceRef) ? source.evidenceRef : null
  return <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Målt {date(observedAt)} · {href ? <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">{source?.label || 'Kilde'} ↗</a> : source?.label || 'Kilde ikke registrert'}</p>
}
function WindowCard({ window: quota, uncertain }: { window: QuotaWindow; uncertain: boolean }) {
  const known = quota.remainingPercent != null && Number.isFinite(quota.remainingPercent)
  const resetPassed = quota.resetsAt != null && Date.parse(quota.resetsAt) <= Date.now()
  const fresh = quota.freshness === 'fresh' && !uncertain && !resetPassed
  return <div className="rounded-xl border border-border/70 bg-background/60 p-3.5" role="group" aria-label={`Kvote ${quota.label}`}>
    <div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">{quota.label}</span><Chip tone={fresh ? 'good' : 'warn'}>{uncertain ? 'Kontroll mislyktes' : statusLabels[quota.freshness] || 'Ukjent ferskhet'}</Chip></div>
    <div className="mt-3 flex items-end justify-between gap-2"><strong className="text-xl tabular-nums">{known ? `${percentage(quota.remainingPercent)} igjen` : 'Kvote ukjent'}</strong>{known && !fresh && <span className="text-xs text-amber-600 dark:text-amber-300">Sist målt</span>}</div>
    {known ? <div role="progressbar" aria-label={`${quota.label}: gjenstående kvote`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={quota.remainingPercent!} className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary"><div className={`h-full rounded-full ${fresh ? 'bg-cyan-500' : 'bg-amber-500'}`} style={{ width: `${Math.max(0, Math.min(100, quota.remainingPercent!))}%` }} /></div> : <p className="mt-2 text-xs text-muted-foreground">Ingen prosent beregnes uten en måling.</p>}
    {quota.used != null && quota.limit != null && <p className="mt-2 text-xs text-muted-foreground">{quota.used.toLocaleString('nb-NO')} av {quota.limit.toLocaleString('nb-NO')} {quota.unit || 'enheter'} brukt</p>}
    <p className={`mt-2 text-xs ${resetPassed ? 'text-amber-600 dark:text-amber-300' : 'text-muted-foreground'}`}>{resetPassed ? 'Oppgitt nullstilling er passert. Ny kvote må bekreftes.' : quota.resetsAt ? `Nullstilles ${date(quota.resetsAt)}` : 'Nullstillingstidspunkt ukjent'}</p>
    <Source source={quota.source} observedAt={quota.observedAt} />
  </div>
}
function AccountCard({ account }: { account: ComputeAccount }) {
  return <article className={`${card} overflow-hidden`} aria-label={`Konto ${account.label}`}>
    <div className="border-b border-border p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{account.provider}</p><h3 className="mt-1 text-xl font-semibold tracking-tight">{account.label}</h3><p className="mt-1 text-sm text-muted-foreground">{account.plan || 'Abonnement ikke registrert'}</p><p className="mt-1 text-xs text-muted-foreground">{({ subscription: 'Abonnement', api: 'API · betaling per bruk', local: 'Lokal kjøring', unknown: 'Betalingsform ukjent' })[account.billingMode]}{account.monthlyCost != null ? ` · ${account.monthlyCost.toLocaleString('nb-NO')} ${account.currency || ''} per måned` : ''}</p></div><Chip tone={account.status === 'ready' ? 'good' : account.status === 'login_required' || account.status === 'unavailable' ? 'warn' : 'neutral'}>{account.status === 'ready' ? 'Identitet bekreftet' : statusLabels[account.status] || 'Kontostatus ukjent'}</Chip></div><Source source={account.source} observedAt={account.observedAt} /></div>
    <div className="space-y-5 p-5">{account.pools.length ? account.pools.map(pool => <section key={pool.id} aria-label={`Kapasitetspott ${pool.label}`}><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">{pool.label}</h4><Chip tone={pool.status === 'ready' ? 'good' : 'warn'}>{statusLabels[pool.status] || pool.status}</Chip></div>{pool.lastObservationStatus && pool.lastObservationStatus !== 'success' && <p className="mb-3 text-xs text-amber-600 dark:text-amber-300">Siste kontroll lyktes ikke. Eventuelle tall nedenfor er siste kjente måling.{pool.error ? ` ${collectorDetail(pool.error)}` : ''}</p>}{pool.windows.length ? <div className="grid gap-3 sm:grid-cols-2">{pool.windows.map(window => <WindowCard key={window.key} window={window} uncertain={pool.lastObservationStatus != null && pool.lastObservationStatus !== 'success'} />)}</div> : <p className="rounded-xl bg-secondary/50 p-4 text-sm text-muted-foreground">Ingen kvotevinduer er målt for denne potten.</p>}<p className="mt-2 text-xs leading-relaxed text-muted-foreground">Gjelder {pool.modelIds.length ? pool.modelIds.join(', ') : 'alle modeller på tilkoblede kjøreruter'}</p>{pool.effectiveRemainingPercent != null && <p className="mt-1 text-xs text-muted-foreground">{pool.status === 'ready' ? 'Begrensende vindu' : 'Sist kjente begrensende vindu'}: {percentage(pool.effectiveRemainingPercent)} igjen</p>}</section>) : <p className="text-sm leading-relaxed text-muted-foreground">Ingen kvoter er registrert for denne kontoen. Det betyr at kapasiteten er ukjent.</p>}
      {account.resetCredits && <aside className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4" aria-label={`Resetreserve ${account.label}`}><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-semibold">Resetreserve <span className="ml-1 text-xs font-normal text-muted-foreground">{statusLabels[account.resetCredits.freshness]}</span></h4><strong className="tabular-nums">{account.resetCredits.available == null ? 'Antall ukjent' : `${account.resetCredits.available} ${account.resetCredits.freshness === 'fresh' ? 'tilgjengelig' : 'sist registrert'}`}</strong></div><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Lagrede nullstillinger vises separat fra den løpende kvoten. De brukes ikke av denne vurderingen.</p><Source source={account.resetCredits.source} observedAt={account.resetCredits.observedAt} /></aside>}
    </div>
  </article>
}
async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...options })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(response.status === 401 ? 'Logg inn i Mission Control for å se kapasiteten.' : response.status === 403 ? 'Du har ikke tilgang til disse kapasitetstallene.' : data?.error || 'Dataene kunne ikke hentes. Prøv igjen.')
  if (data == null) throw new Error('Datakilden returnerte ikke et gyldig svar.')
  return data as T
}

export function ComputeDashboardPanel() {
  const [snapshot, setSnapshot] = useState<ComputeSnapshot | null>(null)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectError, setProjectError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'accounts' | 'route' | 'analysis' | 'registry'>('accounts')
  const [request, setRequest] = useState<RouteRequest>({ requiredCapabilities: [], difficulty: 'standard', dataClass: 'internal', ready: false, valuable: false, reservePercent: 20, allowedBillingModes: ['subscription', 'local'] })
  const [preview, setPreview] = useState<RoutePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const loadAbort = useRef<AbortController | null>(null)
  const previewAbort = useRef<AbortController | null>(null)
  const load = useCallback(async () => {
    loadAbort.current?.abort()
    const controller = new AbortController()
    loadAbort.current = controller
    previewAbort.current?.abort(); setPreview(null); setPreviewing(false)
    setLoading(true); setError(null)
    const results = await Promise.allSettled([
      fetchJson<ComputeSnapshot>('/api/compute', { signal: controller.signal }),
      fetchJson<{ projects: ProjectOption[] }>('/api/projects', { signal: controller.signal }),
    ])
    if (controller.signal.aborted) return
    if (results[0].status === 'fulfilled' && Array.isArray(results[0].value.accounts) && Array.isArray(results[0].value.bindings)) setSnapshot(results[0].value)
    else setError(results[0].status === 'rejected' ? String(results[0].reason?.message || 'Kapasitet kunne ikke hentes.') : 'Kapasitetskilden mangler konto- eller ruteregister.')
    if (results[1].status === 'fulfilled' && Array.isArray(results[1].value.projects)) { setProjects(results[1].value.projects); setProjectError(null) }
    else setProjectError('Prosjektlisten kunne ikke hentes. Prosjektvalget er utilgjengelig.')
    setLoading(false)
  }, [])
  useEffect(() => { void load(); return () => { loadAbort.current?.abort(); previewAbort.current?.abort() } }, [load])
  function changeRequest(patch: Partial<RouteRequest>) {
    previewAbort.current?.abort(); setPreviewing(false); setPreview(null); setPreviewError(null)
    setRequest(previous => ({ ...previous, ...patch }))
  }
  async function assessRoute() {
    previewAbort.current?.abort()
    const controller = new AbortController()
    previewAbort.current = controller
    setPreviewing(true); setPreviewError(null); setPreview(null)
    try {
      const result = await fetchJson<RoutePreview>('/api/compute/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: controller.signal })
      if (!controller.signal.aborted) {
        if (!Array.isArray(result.candidates)) throw new Error('Vurderingen mangler kjøreruter.')
        setPreview(result)
      }
    } catch (cause) { if (!controller.signal.aborted) setPreviewError(cause instanceof Error ? cause.message : 'Ruten kunne ikke vurderes.') }
    finally { if (!controller.signal.aborted) setPreviewing(false) }
  }
  const bindings = snapshot?.bindings || []
  const accounts = snapshot?.accounts || []
  const activeAccounts = accounts.filter(account => account.enabled)
  const historicalAccounts = accounts.filter(account => !account.enabled)
  const activeBindings = bindings.filter(binding => binding.enabled && activeAccounts.some(account => account.id === binding.accountId))
  const capabilities = [...new Set(activeBindings.flatMap(binding => binding.capabilities))].sort((a, b) => label(a).localeCompare(label(b), 'nb'))
  const refresh = snapshot?.refresh
  const needingAttention = activeAccounts.filter(account => account.status !== 'ready' || !account.pools.length || account.pools.some(pool => pool.status !== 'ready')).length
  return <div className="mx-auto max-w-7xl space-y-6 p-4 pb-12 sm:p-6 lg:p-8">
    <header className="flex flex-col justify-between gap-4 border-b border-border pb-6 sm:flex-row sm:items-end"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-600 dark:text-cyan-300">Arbeidskraft i Mission Control</p><h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Kapasitet</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">Se hva kontoene våre har igjen, og finn en egnet kjørerute for neste oppgave.</p></div><div className="flex shrink-0 items-center gap-3"><Link className="text-xs text-muted-foreground underline underline-offset-4" href="/cost-tracker">Se faktisk bruk</Link><Button variant="outline" onClick={() => { setPreview(null); void load() }} disabled={loading}>{loading ? 'Henter status…' : 'Last inn lagret status'}</Button></div></header>
    {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-300">{error}{snapshot && <p className="mt-1">Viser forrige vellykkede innlasting. Tallene er ikke oppdatert.</p>}</div>}
    {loading && !snapshot && <div role="status" className={`${card} p-10 text-center text-sm text-muted-foreground`}>Henter kontoer, kvotevinduer og kjøreruter…</div>}
    {snapshot && <>
      <div className="grid gap-3 sm:grid-cols-3"><Summary number={activeAccounts.length} label="Aktive kontoer" detail="Hvert abonnement vises for seg" /><Summary number={activeBindings.filter(binding => binding.identityStatus === 'verified' && binding.entitlementStatus === 'verified' && binding.verificationFreshness === 'fresh').length} label="Bekreftede kontokoblinger" detail="Kontoen er bekreftet i verktøyet" /><Summary number={needingAttention} label="Trenger kontroll" detail="Innlogging, kvote eller ferskhet mangler" /></div>
      <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-secondary/30 p-1" role="tablist" aria-label="Kapasitetsvisning">{views.map(item => <button key={item.id} id={`compute-tab-${item.id}`} role="tab" aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onKeyDown={event => { const index = views.findIndex(view => view.id === tab); const next = event.key === 'ArrowRight' ? (index + 1) % views.length : event.key === 'ArrowLeft' ? (index + views.length - 1) % views.length : event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : null; if (next != null) { event.preventDefault(); setTab(views[next].id); document.getElementById(`compute-tab-${views[next].id}`)?.focus() } }} aria-controls={`compute-panel-${item.id}`} onClick={() => setTab(item.id)} className={`rounded-lg px-4 py-2 text-sm transition-colors ${tab === item.id ? 'bg-card font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{item.name}</button>)}</div>
      {snapshot.warnings.length > 0 && <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm"><p className="font-semibold">Dette bør vi være oppmerksomme på</p><ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{snapshot.warnings.map((warning, index) => <li key={index}>{collectorDetail(warning)}</li>)}</ul></div>}
      <section id={`compute-panel-${tab}`} role="tabpanel" aria-labelledby={`compute-tab-${tab}`}>
        {tab === 'accounts' && <><div className="mb-4 flex flex-wrap items-end justify-between gap-2"><h2 className="text-lg font-semibold">Aktive kontoer og abonnementer</h2><p className="text-xs text-muted-foreground">Kvoter fra ulike abonnementer summeres ikke.</p></div>{activeAccounts.length ? <div className="grid items-start gap-5 lg:grid-cols-2" role="region" aria-label="Aktive kontoer og abonnementer">{activeAccounts.map(account => <AccountCard key={account.id} account={account} />)}</div> : <div className={`${card} p-8 text-center`}><h3 className="font-semibold">Ingen aktive kontoer</h3><p className="mt-2 text-sm text-muted-foreground">Kapasitet vises når aktive kontokilder er koblet til og observert.</p></div>}{historicalAccounts.length > 0 && <details className={`${card} mt-5 p-5`}><summary className="cursor-pointer text-sm font-semibold">Historiske kontoer ({historicalAccounts.length})</summary><p className="mt-2 text-sm text-muted-foreground">Deaktiverte kontoer beholdes med tidligere målinger. De inngår ikke i dagens kapasitet eller sammendrag.</p><div className="mt-4 grid items-start gap-5 lg:grid-cols-2">{historicalAccounts.map(account => <AccountCard key={account.id} account={account} />)}</div></details>}</>}
        {tab === 'route' && <div className="grid gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]"><form className={`${card} self-start p-5 sm:p-6`} onSubmit={event => { event.preventDefault(); void assessRoute() }}><h2 className="text-lg font-semibold">Hva trenger oppgaven?</h2><p className="mt-1 text-sm leading-relaxed text-muted-foreground">Vurderingen sammenholder behov, kontotilgang og målt kvote. Den starter ingen oppgave.</p><fieldset disabled={previewing} className="mt-5 space-y-5 disabled:opacity-70"><label className="block space-y-2 text-sm font-medium">Prosjekt<select className={field} aria-label="Prosjekt" value={request.projectId ?? ''} disabled={!!projectError} onChange={event => changeRequest({ projectId: event.target.value ? Number(event.target.value) : undefined })}><option value="">Uten prosjektvalg</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>{projectError && <p role="alert" className="text-xs text-amber-600 dark:text-amber-300">{projectError}</p>}<fieldset><legend className="mb-2 text-sm font-medium">Nødvendige ferdigheter</legend><div className="flex flex-wrap gap-2">{capabilities.map(capability => <label key={capability} className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><input type="checkbox" checked={request.requiredCapabilities.includes(capability)} onChange={event => changeRequest({ requiredCapabilities: event.target.checked ? [...request.requiredCapabilities, capability] : request.requiredCapabilities.filter(value => value !== capability) })} className="accent-cyan-600" />{label(capability)}</label>)}</div>{!capabilities.length && <p className="text-sm text-muted-foreground">Ingen ferdigheter er registrert. En kjørerute må kartlegges før vurdering.</p>}</fieldset><div className="grid gap-4 sm:grid-cols-2"><label className="block space-y-2 text-sm font-medium">Vanskelighetsgrad<select className={field} value={request.difficulty} onChange={event => changeRequest({ difficulty: event.target.value as RouteRequest['difficulty'] })}><option value="routine">Rutine</option><option value="standard">Vanlig oppgave</option><option value="complex">Krevende</option></select></label><label className="block space-y-2 text-sm font-medium">Dataskjerming<select className={field} value={request.dataClass} onChange={event => changeRequest({ dataClass: event.target.value as RouteRequest['dataClass'] })}><option value="public">Offentlig</option><option value="internal">Internt</option><option value="restricted">Skjermet</option></select></label></div><label className="block space-y-2 text-sm font-medium">Hold igjen kvote som reserve<div className="flex items-center gap-3"><input type="number" min={0} max={90} step={1} className={`${field} max-w-24`} value={request.reservePercent} onChange={event => changeRequest({ reservePercent: Math.min(90, Math.max(0, Number(event.target.value))) })} /><span className="text-sm text-muted-foreground">% i den relevante kvoten</span></div></label><div className="space-y-3 rounded-xl bg-secondary/40 p-4"><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 accent-cyan-600" checked={request.ready} onChange={event => changeRequest({ ready: event.target.checked })} />Oppgaven er avklart og klar til gjennomføring</label><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 accent-cyan-600" checked={request.valuable} onChange={event => changeRequest({ valuable: event.target.checked })} />Oppgaven er prioritert og har verdi for prosjektet</label><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 accent-cyan-600" checked={request.allowedBillingModes?.includes('api') || false} onChange={event => changeRequest({ allowedBillingModes: event.target.checked ? ['subscription', 'local', 'api'] : ['subscription', 'local'] })} />Ta med alternativer som betales per API-bruk</label></div><Button type="submit" className="w-full" disabled={!request.requiredCapabilities.length || previewing || !!error}>{previewing ? 'Vurderer kjøreruter…' : 'Vurder kjørerute'}</Button></fieldset></form><div aria-live="polite">{previewError && <div role="alert" className={`${card} border-red-500/30 p-5 text-sm text-red-600 dark:text-red-300`}>{previewError}</div>}{preview ? <RouteResults preview={preview} accounts={activeAccounts} bindings={activeBindings} /> : !previewError && <div className={`${card} flex min-h-64 flex-col justify-center p-8`}><span className="mb-3 text-3xl text-cyan-600 dark:text-cyan-300" aria-hidden="true">↗</span><h2 className="text-xl font-semibold">Et begrunnet forslag før vi starter</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Velg behovene til venstre. Du får se hvilken modell og hvilket verktøy som passer, og hva som eventuelt hindrer bruk.</p><p className="mt-4 text-xs text-muted-foreground">Gamle eller ukjente kvoter må bekreftes før kjøring.</p></div>}</div></div>}
        {tab === 'analysis' && <ComputeAnalysisPanel projects={projects} bindings={bindings} accounts={accounts} />}
        {tab === 'registry' && <div className={`${card} overflow-hidden`}><div className="border-b border-border p-5"><h2 className="text-lg font-semibold">Kontokoblinger, verktøy og modeller</h2><p className="mt-1 text-sm text-muted-foreground">En registrert modell er ikke i seg selv bevis på tilgang eller ledig kvote.</p></div>{bindings.length ? <div className="divide-y divide-border">{bindings.map(binding => <details key={binding.id} className="group p-5"><summary className="cursor-pointer list-none"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{runtimeLabel(binding.runtimeId)}</h3><p className="mt-1 text-sm text-muted-foreground">{accounts.find(account => account.id === binding.accountId)?.label || 'Konto ikke funnet'} · {binding.modelIds.length} modeller</p></div><div className="flex gap-2">{!binding.enabled && <Chip>Deaktivert</Chip>}<Chip tone={binding.identityStatus === 'verified' && binding.verificationFreshness === 'fresh' ? 'good' : 'warn'}>Konto: {statusLabels[binding.identityStatus] || 'Ukjent'}</Chip><Chip tone={binding.entitlementStatus === 'verified' && binding.verificationFreshness === 'fresh' ? 'good' : 'warn'}>Tilgang: {statusLabels[binding.entitlementStatus] || 'Ukjent'}</Chip><span className="text-muted-foreground" aria-hidden="true">⌄</span></div></div></summary><div className="mt-4 space-y-3"><div className="flex flex-wrap gap-2">{binding.capabilities.map(capability => <Chip key={capability}>{label(capability)}</Chip>)}</div><ul className="space-y-2">{binding.modelIds.map(model => <li key={model} className="rounded-lg bg-secondary/40 px-3 py-2 text-sm"><span className="font-medium">{model}</span>{binding.modelCapabilities.find(item => item.modelId === model) ? <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{binding.modelCapabilities.filter(item => item.modelId === model).map(item => <div key={item.modelId}>{({ fast: 'Rask', balanced: 'Balansert', deep: 'Grundig' })[item.tier]} · {item.capabilities.map(label).join(' · ')}{item.notes ? ` · ${item.notes}` : ''}<Source source={{ kind: 'import', label: 'Modellgrunnlag', evidenceRef: item.evidence }} observedAt={item.verifiedAt} /></div>)}</div> : <span className="ml-2 text-xs text-amber-600 dark:text-amber-300">Egenskaper ikke registrert</span>}</li>)}</ul><p className="text-xs text-muted-foreground">Dataskjerming: {binding.dataClasses.map(value => ({ public: 'Offentlig', internal: 'Internt', restricted: 'Skjermet' })[value]).join(', ') || 'Ikke registrert'} · Tilgangskontroll: {statusLabels[binding.verificationFreshness]}</p><Source source={binding.source} observedAt={binding.verifiedAt} /></div></details>)}</div> : <p className="p-8 text-sm text-muted-foreground">Ingen kjøreruter er registrert.</p>}</div>}
      </section>
      <aside className={`${card} p-5`} aria-label="Automatisk oppdatering"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">Automatisk oppdatering</h2><p className="mt-1 text-xs text-muted-foreground">{refresh?.enabled ? `Planlagt kontroll hver ${refresh.intervalHours ?? '?'} time. Målingene over viser faktisk innsamlingstidspunkt.` : 'Ingen aktiv oppdateringsjobb er registrert. Tallene endres først når en ny observasjon er lagret.'}</p></div><Chip tone={refresh?.status === 'failed' ? 'warn' : 'neutral'}>{statusLabels[refresh?.status || 'not_configured'] || refresh?.status}</Chip></div>{refresh && <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3"><div><dt className="text-muted-foreground">Siste forsøk</dt><dd className="mt-1 font-medium">{date(refresh.lastAttemptAt)}</dd></div><div><dt className="text-muted-foreground">Siste vellykkede kontroll</dt><dd className="mt-1 font-medium">{date(refresh.lastSuccessAt)}</dd></div><div><dt className="text-muted-foreground">Neste planlagte kontroll</dt><dd className="mt-1 font-medium">{refresh.enabled ? date(refresh.nextDueAt) : 'Ikke planlagt'}</dd></div></dl>}{refresh?.lastError && <p className="mt-3 text-xs text-amber-600 dark:text-amber-300">{collectorDetail(refresh.lastError)}</p>}</aside><p className="text-xs text-muted-foreground">Visningen hentet {date(snapshot.asOf)}. Alle tider vises i Oslo-tid.</p>
    </>}
  </div>
}
function Summary({ number, label: title, detail }: { number: number; label: string; detail: string }) { return <div className={`${card} p-4`}><div className="text-2xl font-semibold tabular-nums">{number}</div><p className="mt-1 text-sm font-medium">{title}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div> }
function RouteResults({ preview, accounts, bindings }: { preview: RoutePreview; accounts: ComputeAccount[]; bindings: ComputeBinding[] }) {
  const candidates = preview.candidates.filter(candidate => accounts.some(account => account.id === candidate.accountId && account.enabled) && bindings.some(binding => binding.id === candidate.bindingId && binding.accountId === candidate.accountId && binding.enabled))
  const readyCount = candidates.filter(candidate => candidate.executable).length
  const primary = candidates.find(candidate => candidate.executable)
  return <section className="space-y-3" aria-label="Vurderte kjøreruter"><div className={`${card} p-5`}><h2 className="text-lg font-semibold">{readyCount ? `${readyCount} kjørerute${readyCount > 1 ? 'r' : ''} oppfyller kravene` : 'Ingen bekreftet kjørerute ennå'}</h2><p className="mt-1 text-sm text-muted-foreground">{readyCount ? 'Forslagene gjelder behovene og målingene i denne vurderingen. Ingen kjøring er startet.' : 'Se hva som må avklares nedenfor. Ingen kjøring er startet.'}</p><p className="mt-2 text-xs text-muted-foreground">Vurdert {date(preview.asOf)} · {preview.reservePercent} % reserve</p></div>{candidates.length ? candidates.map(candidate => <article key={`${candidate.bindingId}:${candidate.modelId}`} className={`${card} p-5 ${candidate === primary ? 'border-cyan-500/40' : ''}`}><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs text-muted-foreground">{accounts.find(account => account.id === candidate.accountId)?.label || 'Konto ikke funnet'} · {runtimeLabel(candidate.runtimeId)}</p><h3 className="mt-1 font-semibold">{candidate.modelId}</h3></div><Chip tone={candidate.executable ? 'good' : 'warn'}>{candidate.executable ? candidate === primary ? 'Anbefalt' : 'Mulig alternativ' : candidate.refreshRecommended ? 'Må kontrolleres' : 'Kan ikke brukes nå'}</Chip></div><ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">{candidate.reasonCodes.map(reason => <li key={reason} className="flex gap-2"><span aria-hidden="true">{candidate.executable ? '✓' : '·'}</span><span>{reasonLabels[reason] || `Vurderingsgrunn: ${reason.replace(/[_-]/g, ' ')}`}</span></li>)}</ul><p className="mt-3 text-xs text-muted-foreground">Relevant gjenstående kvote: {percentage(candidate.effectiveRemainingPercent)} · {candidate.evidenceObservationIds.length} kildeobservasjoner</p></article>) : <div className={`${card} p-5 text-sm text-muted-foreground`}>Ingen aktive kjøreruter kunne vurderes for denne oppgaven.</div>}</section>
}
