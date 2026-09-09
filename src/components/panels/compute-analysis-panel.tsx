'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useMissionControl } from '@/store'
import type { ComputeAccount, ComputeBinding } from '@/lib/compute-types'
import type { SubscriptionRun, SubscriptionRunInput } from '@/lib/subscription-runs'

interface Props {
  projects: { id: number; name: string }[]
  bindings: ComputeBinding[]
  accounts: ComputeAccount[]
}
const field = 'w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/60'
const card = 'rounded-2xl border border-border bg-card p-5 sm:p-6'
const states: Record<SubscriptionRun['status'], string> = {
  preflight: 'Kontrollerer tilgang', running: 'Analysen pågår', completed: 'Analysen er fullført',
  failed: 'Analysen feilet', interrupted: 'Analysen er stoppet', unknown: 'Kjøringen må avklares',
}
const active = (run: SubscriptionRun | null) => !!run && ['preflight', 'running'].includes(run.status)
const terminal = (run: SubscriptionRun) => ['completed', 'failed', 'interrupted'].includes(run.status)
const time = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('nb-NO', { timeZone: 'Europe/Oslo', dateStyle: 'short', timeStyle: 'short' }) : 'Ikke registrert'
const validId = (value: string | null): value is string => !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
class ResponseError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init })
  const result = await response.json().catch(() => null)
  if (!response.ok) throw new ResponseError(result?.error || `Forespørselen feilet (${response.status}).`, response.status)
  if (!result) throw new Error('Svaret manglet en gyldig kvittering.')
  return result as T
}
function validateReceipt(run: SubscriptionRun, expected: string): SubscriptionRun {
  if (!run || run.id !== expected || !Object.prototype.hasOwnProperty.call(states, run.status)) throw new Error('Svaret manglet riktig kjøringskvittering.')
  return run
}
function routeChoiceLabel(binding: ComputeBinding, choices: ComputeBinding[], accounts: ComputeAccount[]): string {
  const account = accounts.find(item => item.id === binding.accountId)
  const runtime = binding.runtimeId === 'claude-code' ? 'Claude Code' : `${binding.runtimeId} (ikke støttet her)`
  const base = `${account?.label || 'Ukjent konto'} · ${runtime}`
  const peers = choices.filter(item => item.accountId === binding.accountId && item.runtimeId === binding.runtimeId)
  if (peers.length < 2) return base
  const poolHint = (item: ComputeBinding) => {
    const pools = account?.pools.filter(pool => item.poolIds.includes(pool.id)) || []
    const specific = pools.filter(pool => !peers.every(peer => peer.poolIds.includes(pool.id)))
    return (specific.length ? specific : pools).map(pool => pool.label).join(' + ')
  }
  const modelHint = (item: ComputeBinding) => item.modelIds.join(', ') || 'Ingen modeller registrert'
  const hint = poolHint(binding)
  if (hint && !peers.some(item => item.id !== binding.id && poolHint(item) === hint)) return `${base} · ${hint}`
  const models = modelHint(binding)
  return `${base} · ${models}${peers.some(item => item.id !== binding.id && modelHint(item) === models) ? ` · ${binding.id}` : ''}`
}

export function ComputeAnalysisPanel(props: Props) {
  const currentUser = useMissionControl(state => state.currentUser)
  if (!currentUser || !['admin', 'operator'].includes(currentUser.role)) {
    return <div className={card}><h2 className="text-lg font-semibold">Tekstanalyse</h2><p className="mt-2 text-sm text-muted-foreground">En operatør eller administrator kan sende inn tekst og følge analysekvitteringer her.</p></div>
  }
  if (currentUser.workspace_id !== 1 || currentUser.tenant_id !== 1) {
    return <div className={card}><h2 className="text-lg font-semibold">Tekstanalyse</h2><p className="mt-2 text-sm text-muted-foreground">Lokale abonnementer kan brukes fra hovedarbeidsområdet.</p></div>
  }
  const scope = `${currentUser.tenant_id}:${currentUser.workspace_id}:${currentUser.id}`
  return <AnalysisWorkspace key={scope} {...props} storageKey={`mc-compute-analysis:${scope}`} />
}

function AnalysisWorkspace({ projects, bindings, accounts, storageKey }: Props & { storageKey: string }) {
  const [projectId, setProjectId] = useState('')
  const [bindingId, setBindingId] = useState('')
  const [modelId, setModelId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [difficulty, setDifficulty] = useState<SubscriptionRunInput['difficulty']>('standard')
  const [dataClass, setDataClass] = useState<SubscriptionRunInput['dataClass']>('internal')
  const [run, setRun] = useState<SubscriptionRun | null>(null)
  const [receiptId, setReceiptId] = useState<string | null>(null)
  const [attempt, setAttempt] = useState<SubscriptionRunInput | null>(null)
  const [history, setHistory] = useState<SubscriptionRun[]>([])
  const [historyReady, setHistoryReady] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [stopRequested, setStopRequested] = useState(false)
  const mounted = useRef(false)
  const selectedId = useRef<string | null>(null)
  const latestRead = useRef(0)
  const mutationBusy = useRef(false)
  const unresolved = !!receiptId && (!run || !terminal(run))
  const running = active(run)
  const activeBindings = bindings.filter(item => item.enabled && accounts.some(account => account.id === item.accountId && account.enabled))
  const binding = activeBindings.find(item => item.id === bindingId)
  const account = accounts.find(item => item.id === binding?.accountId)
  const supported = binding?.runtimeId === 'claude-code' && account?.billingMode === 'subscription'
  const models = binding?.modelIds || []

  const accept = useCallback((next: SubscriptionRun) => {
    if (!mounted.current || selectedId.current !== next.id) return
    setRun(next); setError(null)
    setHistory(previous => [next, ...previous.filter(item => item.id !== next.id)].slice(0, 50))
    if (terminal(next)) {
      try { sessionStorage.removeItem(storageKey) } catch { /* A saved UUID remains safe to recover. */ }
      setStopRequested(false)
    }
  }, [storageKey])

  const readReceipt = useCallback(async (id: string) => {
    const sequence = ++latestRead.current
    try {
      const result = await request<{ run: SubscriptionRun }>(`/api/compute/runs?id=${encodeURIComponent(id)}`)
      if (sequence === latestRead.current) accept(validateReceipt(result.run, id))
    } catch (cause) {
      if (mounted.current && selectedId.current === id && sequence === latestRead.current) setError(cause instanceof ResponseError && cause.status === 404
        ? 'Ingen kvittering ble funnet ennå. Innsendingen er ikke startet på nytt. Behold denne referansen til utfallet er avklart.'
        : `Status kunne ikke hentes. Siste kjente status beholdes. ${cause instanceof Error ? cause.message : ''}`)
    }
  }, [accept])

  const readHistory = useCallback(async () => {
    try {
      const result = await request<{ runs: SubscriptionRun[] }>('/api/compute/runs')
      if (!Array.isArray(result.runs)) throw new Error('Kjøringslisten manglet i svaret.')
      if (!mounted.current) return
      setHistory(result.runs); setHistoryReady(true); setHistoryError(null)
      const unfinished = result.runs.find(item => !terminal(item))
      if (!selectedId.current && unfinished) {
        selectedId.current = unfinished.id; setReceiptId(unfinished.id); accept(unfinished)
        try { sessionStorage.setItem(storageKey, unfinished.id) } catch { /* Existing server evidence is still available. */ }
      }
    } catch (cause) {
      if (mounted.current) setHistoryError(`Kjøringslisten kunne ikke hentes. ${cause instanceof Error ? cause.message : ''}`)
    }
  }, [accept, storageKey])

  useEffect(() => {
    mounted.current = true
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (validId(saved)) { selectedId.current = saved; setReceiptId(saved); void readReceipt(saved) }
    } catch { /* Starting requires a successfully persisted UUID below. */ }
    void readHistory()
    return () => { mounted.current = false }
  }, [readHistory, readReceipt, storageKey])

  useEffect(() => {
    if (!receiptId || !running) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await readReceipt(receiptId)
      if (!stopped) timer = setTimeout(poll, 5000)
    }
    timer = setTimeout(poll, 5000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [receiptId, running, readReceipt]) // The last known active receipt remains cancellable after a read failure.

  async function submit(input: SubscriptionRunInput) {
    if (mutationBusy.current) return
    mutationBusy.current = true; setBusy('start'); setError(null)
    try {
      // Persist only the UUID before dispatch. Private task text stays out of browser storage.
      sessionStorage.setItem(storageKey, input.idempotencyKey)
    } catch {
      setError('Nettleseren kunne ikke lagre kjøringsreferansen. Ingen innsending er sendt.'); setBusy(null); mutationBusy.current = false
      return
    }
    selectedId.current = input.idempotencyKey; setReceiptId(input.idempotencyKey); setAttempt(input); setRun(null)
    try {
      const result = await request<{ run: SubscriptionRun }>('/api/compute/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      })
      accept(validateReceipt(result.run, input.idempotencyKey))
    } catch (cause) {
      if (!mounted.current || selectedId.current !== input.idempotencyKey) return
      // A conflict may carry an existing/uncertain receipt. Read it before allowing another UUID.
      if (cause instanceof ResponseError && cause.status >= 400 && cause.status < 500) {
        let rejected = cause.status !== 409
        if (cause.status === 409) {
          try {
            const result = await request<{ run: SubscriptionRun }>(`/api/compute/runs?id=${input.idempotencyKey}`)
            accept(validateReceipt(result.run, input.idempotencyKey))
          } catch (lookup) { rejected = lookup instanceof ResponseError && lookup.status === 404 }
        }
        if (rejected) {
          selectedId.current = null; setReceiptId(null); setAttempt(null)
          try { sessionStorage.removeItem(storageKey) } catch { /* No model dispatch was accepted. */ }
        }
        setError(`Innsendingen ble ikke bekreftet. ${cause.message}`)
        void readHistory()
      } else setError('Startsvaret mangler. Kjøringen kan ha startet. Hent kvitteringen før du gjør noe mer; ingenting sendes på nytt automatisk.')
    } finally {
      mutationBusy.current = false
      if (mounted.current) setBusy(null)
    }
  }

  async function control(action: 'stop' | 'reconcile') {
    if (!receiptId || mutationBusy.current) return
    mutationBusy.current = true; setBusy(action); setError(null)
    const id = receiptId
    try {
      if (action === 'stop') {
        const result = await request<{ status: string }>(`/api/compute/runs?id=${id}`, { method: 'DELETE' })
        if (result.status !== 'stopping') throw new Error('Stoppforespørselen manglet kvittering.')
        if (mounted.current && selectedId.current === id) setStopRequested(true)
        await readReceipt(id)
      } else {
        const result = await request<{ run: SubscriptionRun }>('/api/compute/runs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: 'reconcile' }) })
        accept(validateReceipt(result.run, id))
      }
    } catch (cause) {
      if (mounted.current && selectedId.current === id) setError(`${action === 'stop' ? 'Stopp er ikke bekreftet.' : 'Kjøringen kunne ikke avklares.'} ${cause instanceof Error ? cause.message : ''}`)
    } finally { mutationBusy.current = false; if (mounted.current) setBusy(null) }
  }

  function selectReceipt(item: SubscriptionRun) {
    selectedId.current = item.id; setReceiptId(item.id); setAttempt(null); setRun(item); setError(null)
    void readReceipt(item.id)
  }

  return <div className="space-y-5">
    <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-5">
      <h2 className="text-lg font-semibold">Få en analyse av teksten du sender inn</h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">Modellen leser bare teksten i skjemaet. Den åpner ingen prosjektfiler, søker ikke på nettet og endrer ingen kode eller oppgavestatus. For research og gjennomføring bruker vi prosjektets vanlige arbeidsflyt.</p>
      <p className="mt-2 text-xs text-muted-foreground">Bruker valgt abonnement. Serveren kontrollerer innlogging, modelltilgang og fersk kvote med 20 % reserve før start. Foreløpig støttes bare Claude Code her.</p>
    </div>
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <form className={card} onSubmit={event => { event.preventDefault(); if (!unresolved && !busy && supported && projectId && modelId && prompt.trim() && historyReady && !historyError) void submit({ idempotencyKey: crypto.randomUUID(), projectId: Number(projectId), bindingId, modelId, prompt: prompt.trim(), difficulty, dataClass }) }}>
        <h3 className="font-semibold">Ny tekstanalyse</h3>
        <fieldset disabled={unresolved || !!busy} className="mt-4 space-y-4 disabled:opacity-60">
          <label className="block space-y-2 text-sm font-medium">Prosjekt for analysen<select className={field} required value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Velg prosjekt</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label className="block space-y-2 text-sm font-medium">Konto og verktøy<select className={field} required value={bindingId} onChange={event => { setBindingId(event.target.value); setModelId('') }}><option value="">Velg kjørerute</option>{activeBindings.map(item => <option key={item.id} value={item.id}>{routeChoiceLabel(item, activeBindings, accounts)}</option>)}</select></label>
          {binding && !supported && <p role="status" className="text-sm text-amber-600 dark:text-amber-300">Denne kjøreruten kan vurderes i kapasitetsoversikten, men kan ikke starte tekstanalyse her. Denne funksjonen krever Claude Code med abonnement.</p>}
          {binding && <label className="block space-y-2 text-sm font-medium">Modell for analysen<select className={field} required value={modelId} onChange={event => setModelId(event.target.value)}><option value="">Velg modell</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</select></label>}
          <div className="grid gap-4 sm:grid-cols-2"><label className="block space-y-2 text-sm font-medium">Vanskelighetsgrad for analysen<select className={field} value={difficulty} onChange={event => setDifficulty(event.target.value as typeof difficulty)}><option value="routine">Rutine</option><option value="standard">Vanlig oppgave</option><option value="complex">Krevende</option></select></label><label className="block space-y-2 text-sm font-medium">Dataskjerming for analysen<select className={field} value={dataClass} onChange={event => setDataClass(event.target.value as typeof dataClass)}><option value="public">Offentlig</option><option value="internal">Internt</option></select></label></div>
          <label className="block space-y-2 text-sm font-medium">Tekst og spørsmål<textarea className={`${field} min-h-52 resize-y font-normal leading-relaxed`} required maxLength={12000} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Beskriv spørsmålet, legg ved relevant tekst og si hva analysen skal gi svar på." /></label>
          <p className="text-xs text-muted-foreground">{prompt.length.toLocaleString('nb-NO')} / 12 000 tegn · Teksten og svaret lagres i den lokale kjøringskvitteringen. Skjermede data og innloggingsopplysninger skal ikke sendes her.</p>
          <Button type="submit" className="w-full" disabled={!supported || !projectId || !modelId || !prompt.trim() || !historyReady || !!historyError || !!busy || unresolved}>{busy === 'start' ? 'Sender inn…' : 'Start tekstanalyse'}</Button>
        </fieldset>
        {unresolved && <p className="mt-3 text-xs text-muted-foreground">Den forrige kjøringen må fullføres eller avklares før en ny analyse kan startes.</p>}
      </form>
      <section className={`${card} space-y-4`} aria-label="Analysekvittering" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{run ? states[run.status] : receiptId ? 'Venter på kjøringskvittering' : 'Resultat og kjøringsstatus'}</h3>{receiptId && <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void readReceipt(receiptId)}>Hent kvittering</Button>}</div>
        {error && <p role="alert" className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">{error}</p>}
        {!receiptId && !error && <p className="text-sm leading-relaxed text-muted-foreground">Her vises faktisk status og svar etter innsending. Et mottatt startkall betyr at kjøringen er tatt imot; fullført vises først når resultatet er bekreftet.</p>}
        {receiptId && <p className="break-all text-xs text-muted-foreground">Kjøringsreferanse: {receiptId}</p>}
        {receiptId && !run && attempt && !busy && <Button variant="outline" size="sm" onClick={() => void submit(attempt)}>Send samme innsending på nytt med samme referanse</Button>}
        {run && <>
          <dl className="grid gap-3 text-xs sm:grid-cols-2"><div><dt className="text-muted-foreground">Prosjekt</dt><dd className="mt-1">{projects.find(item => item.id === run.projectId)?.name || `Prosjekt ${run.projectId}`}</dd></div><div><dt className="text-muted-foreground">Konto</dt><dd className="mt-1">{accounts.find(item => item.id === run.accountId)?.label || 'Ikke i gjeldende register'}</dd></div><div><dt className="text-muted-foreground">Valgt modell</dt><dd className="mt-1 break-words">{run.requestedModel}</dd></div><div><dt className="text-muted-foreground">Rapportert modell</dt><dd className="mt-1 break-words">{run.observedModels?.length ? run.observedModels.join(', ') : run.observedModel || 'Ikke rapportert'}</dd></div><div><dt className="text-muted-foreground">Startet</dt><dd className="mt-1">{time(run.startedAt)}</dd></div><div><dt className="text-muted-foreground">Avsluttet</dt><dd className="mt-1">{time(run.finishedAt)}</dd></div></dl>
          {run.error && <p className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">{run.error}</p>}
          {stopRequested && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">Stopp er forespurt. Venter på bekreftet avslutning.</p>}
          {active(run) && <Button variant="outline" disabled={!!busy || stopRequested} onClick={() => void control('stop')}>Stopp analysen</Button>}
          {run.status === 'unknown' && <Button variant="outline" disabled={!!busy} onClick={() => void control('reconcile')}>Avklar kjøringen</Button>}
          {run.reply && <div><h4 className="mb-2 text-sm font-semibold">{run.status === 'completed' ? 'Analysens svar' : 'Foreløpig svar'}</h4><pre className="max-h-[38rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-secondary/30 p-4 font-sans text-sm leading-relaxed">{run.reply}</pre></div>}
          <p className="text-xs leading-relaxed text-muted-foreground">{run.estimatedCostUsd == null ? 'Verktøyet har ikke rapportert et prisestimat.' : `Verktøyets prisestimat: ${run.estimatedCostUsd.toLocaleString('nb-NO', { maximumFractionDigits: 8 })} USD. Dette er ikke en faktura.`} Faktisk fakturert beløp er ikke rapportert. {run.evidenceObservationIds.length} kildeobservasjoner ligger bak tilgangskontrollen.</p>
          {!!run.limitations.length && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Avgrensninger fra kjøringen</summary><ul className="mt-2 list-disc space-y-1 pl-4">{run.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
          {terminal(run) && <Button variant="outline" onClick={() => { selectedId.current = null; setReceiptId(null); setRun(null); setAttempt(null); setError(null); setPrompt(''); void readHistory() }}>Ny analyse</Button>}
        </>}
      </section>
    </div>
    <section className={card} aria-label="Tidligere tekstanalyser"><div className="flex items-center justify-between gap-3"><h3 className="font-semibold">Tidligere tekstanalyser</h3><Button variant="ghost" size="sm" onClick={() => void readHistory()}>Oppdater kjøringslisten</Button></div>{historyError && <p role="alert" className="mt-3 text-sm text-amber-600 dark:text-amber-300">{historyError}</p>}{!historyReady && !historyError && <p className="mt-3 text-sm text-muted-foreground">Henter tidligere kjøringer…</p>}{historyReady && !history.length && <p className="mt-3 text-sm text-muted-foreground">Ingen tekstanalyser er registrert.</p>}<div className="mt-3 divide-y divide-border">{history.map(item => <button type="button" key={item.id} disabled={!!busy || (unresolved && item.id !== receiptId)} onClick={() => selectReceipt(item)} className="flex w-full flex-wrap items-center justify-between gap-2 py-3 text-left text-sm disabled:opacity-50"><span>{projects.find(project => project.id === item.projectId)?.name || `Prosjekt ${item.projectId}`} · {item.requestedModel}<span className="mt-1 block text-xs text-muted-foreground">{time(item.startedAt)}</span></span><span className="text-xs">{states[item.status]}</span></button>)}</div></section>
  </div>
}
