import { createHash } from 'node:crypto'
import type { HQMetric, HQMetricsResponse, HQProjectKey, HQSourceStatus } from '@/lib/hq-types'

// Server-only adapter. Import from API routes, never from a client component.
const DAY = 86_400_000
const CACHE_TTL = 5 * 60_000
const ERROR_TTL = 30_000
const TIMEOUT = 15_000
const HOSTS = new Set(['https://us.posthog.com', 'https://eu.posthog.com'])
const PROJECT_KEYS: HQProjectKey[] = ['babyhub', 'babysential', 'brrrr', 'shared']
const LABELS: Record<HQProjectKey, string> = {
  babyhub: 'BabyHub', babysential: 'Babysential', brrrr: 'brRRR', shared: 'Felles',
}
const DEFINITIONS = [
  { id: 'pageviews', name: 'Sidevisninger', unit: 'visninger', definition: 'Antall $pageview-hendelser i PostHog-prosjektet i perioden.' },
  { id: 'active-visitors', name: 'Aktive nettleser-ID-er', unit: 'ID-er', definition: 'Antall ulike distinct_id med minst én $pageview i perioden. Dette er sporings-ID-er, ikke et verifisert antall personer.' },
  { id: 'newsletter-opt-ins', name: 'Nyhetsbrev: opt-in-hendelser', unit: 'hendelser', definition: 'Antall newsletter_opt_in-hendelser i perioden. Hendelsen alene bekrefter ikke levering eller en ny abonnent i e-postsystemet.' },
  { id: 'newsletter-conversion', name: 'Popup → opt-in', unit: '%', definition: 'Andel nettleser-ID-er med newsletter_opt_in innen 24 timer etter sin første popup_shown i perioden. Siste døgn med popuper utelates, slik at alle har et fullført 24-timersvindu. Ingen kobling mellom ulike distinct_id.' },
] as const

interface Window { start: Date; end: Date; cohortEnd: Date; period: string }
interface ProviderConfig { key: string; host: string; projectId: string }
type MetricEnvironment = Record<string, string | undefined>
interface AdapterOptions {
  fetch?: typeof fetch
  now?: () => number
  env?: () => MetricEnvironment
  timeoutMs?: number
}
interface Aggregates {
  pageviews: number; visitors: number; optIns: number; popupCohort: number
  conversions: number; legacySignups: number; refreshedAt: string | null
}

export function isHQMetricProject(value: string): value is HQProjectKey {
  return PROJECT_KEYS.includes(value as HQProjectKey)
}

/** Thirty completed UTC days; the current partial day is deliberately excluded. */
function metricWindow(now: number): Window {
  const today = new Date(now)
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const start = new Date(end.getTime() - 30 * DAY)
  return {
    start, end, cohortEnd: new Date(end.getTime() - DAY),
    period: `${start.toISOString().slice(0, 10)}–${new Date(end.getTime() - DAY).toISOString().slice(0, 10)} UTC (30 hele døgn)`,
  }
}

function providerConfig(env: MetricEnvironment): ProviderConfig | null {
  const key = env.HQ_POSTHOG_API_KEY?.trim()
  const projectId = env.HQ_POSTHOG_PROJECT_ID?.trim()
  const host = (env.HQ_POSTHOG_HOST || 'https://us.posthog.com').replace(/\/$/, '')
  // An allowlist prevents a mistaken URL from forwarding the server's credential elsewhere.
  if (!key || !projectId || !/^\d+$/.test(projectId) || !HOSTS.has(host)) return null
  return { key, host, projectId }
}

export function buildHQPostHogQuery(now: number): string {
  const window = metricWindow(now)
  const sqlTime = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ')
  const cohortCutoff = Math.floor(window.cohortEnd.getTime() / 1000)
  const eligible = `browser_events.popups > 0 AND browser_events.first_popup < ${cohortCutoff}`
  // One bounded scan; only six aggregate cells leave PostHog. No person/event rows.
  return `SELECT
  sum(browser_events.pageviews) AS total_pageviews,
  countIf(browser_events.pageviews > 0) AS active_browser_ids,
  sum(browser_events.opt_ins) AS total_newsletter_opt_ins,
  countIf(${eligible}) AS popup_cohort,
  countIf(${eligible} AND arrayExists(t -> t >= browser_events.first_popup AND t <= browser_events.first_popup + 86400, browser_events.opt_in_times)) AS popup_conversions,
  sum(browser_events.legacy_signups) AS total_legacy_signups
FROM (
  SELECT distinct_id,
    countIf(event = '$pageview') AS pageviews,
    countIf(event = 'newsletter_opt_in') AS opt_ins,
    countIf(event = 'popup_shown') AS popups,
    minIf(toUnixTimestamp(timestamp), event = 'popup_shown') AS first_popup,
    groupArrayIf(toUnixTimestamp(timestamp), event = 'newsletter_opt_in') AS opt_in_times,
    countIf(event = 'newsletter_subscribed') AS legacy_signups
  FROM events
  WHERE timestamp >= toDateTime('${sqlTime(window.start)}', 'UTC')
    AND timestamp < toDateTime('${sqlTime(window.end)}', 'UTC')
    AND event IN ('$pageview', 'popup_shown', 'newsletter_opt_in', 'newsletter_subscribed')
  GROUP BY distinct_id
) AS browser_events
LIMIT 1`
}

function parseAggregates(body: unknown): Aggregates {
  if (!body || typeof body !== 'object') throw new Error('invalid_response')
  const data = body as Record<string, unknown>
  if (!Array.isArray(data.results) || data.results.length !== 1 || !Array.isArray(data.results[0])) throw new Error('invalid_response')
  const values = data.results[0]
  if (values.length !== 6 || values.some(v => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)) throw new Error('invalid_response')
  const [pageviews, visitors, optIns, popupCohort, conversions, legacySignups] = values as number[]
  if (visitors > pageviews || conversions > popupCohort || conversions > optIns) throw new Error('invalid_response')
  const refreshedAt = typeof data.last_refresh === 'string' && Number.isFinite(Date.parse(data.last_refresh)) ? new Date(data.last_refresh).toISOString() : null
  return { pageviews, visitors, optIns, popupCohort, conversions, legacySignups, refreshedAt }
}

async function queryPostHog(config: ProviderConfig, now: number, fetcher: typeof fetch, timeoutMs: number): Promise<Aggregates> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, timeoutMs)
  })
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(`${config.host}/api/projects/${config.projectId}/query/`, {
          method: 'POST', redirect: 'error', cache: 'no-store', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
          body: JSON.stringify({ query: { kind: 'HogQLQuery', query: buildHQPostHogQuery(now) }, refresh: 'blocking', name: 'ines_hq_babysential_30d_metrics_v1' }),
        })
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'authentication' : response.status === 429 ? 'rate_limit' : 'provider_error')
        return parseAggregates(await response.json())
      })(),
      deadline,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function unavailable(projectKey: HQProjectKey, now: number, reason: string): HQMetricsResponse {
  const generatedAt = new Date(now).toISOString()
  const period = metricWindow(now).period
  return {
    generatedAt,
    metrics: DEFINITIONS.map(metric => ({ ...metric, id: `${projectKey}-${metric.id}`, projectKey, provider: projectKey === 'babysential' ? 'PostHog' : 'Ikke tilkoblet', value: null, status: 'unavailable', checkedAt: generatedAt, period, warning: reason })),
    sources: [{ id: `${projectKey}-analytics`, name: `${LABELS[projectKey]} · analyse`, state: 'unavailable', checkedAt: generatedAt, detail: reason }],
  }
}

function failureReason(error: unknown): string {
  // Never expose fetch errors, upstream response bodies, SQL, headers, or credentials.
  const code = error instanceof Error ? error.message : ''
  if (code === 'timeout') return 'PostHog svarte ikke innen tidsgrensen. Målingene er utilgjengelige; ingen nullverdier er erstattet med 0.'
  if (code === 'authentication') return 'PostHog-tilgangen kunne ikke bekreftes. Kontroller serverens nøkkel og Query Read-tilgang.'
  if (code === 'rate_limit') return 'PostHog begrenser forespørslene midlertidig. Prøv igjen senere.'
  if (code === 'invalid_response') return 'PostHog returnerte et ufullstendig eller uventet måleresultat. Tallene vises ikke.'
  return 'PostHog kunne ikke hentes. Ingen tidligere måling presenteres som fersk.'
}

function copyWithFreshness(value: HQMetricsResponse, now: number): HQMetricsResponse {
  const result = structuredClone(value)
  for (const metric of result.metrics) {
    if (metric.status === 'live' && now - Date.parse(metric.checkedAt) > CACHE_TTL) {
      metric.status = 'snapshot'
      metric.warning = 'Kildens siste oppdatering er eldre enn fem minutter. Sjekktidspunktet viser når tallene sist ble beregnet.'
    }
  }
  return result
}

export function createHQMetricsAdapter(options: AdapterOptions = {}) {
  const now = options.now || Date.now
  const env = options.env || (() => process.env)
  const fetcher = options.fetch || fetch
  const timeoutMs = options.timeoutMs || TIMEOUT
  let cache: { key: string; expiresAt: number; value: HQMetricsResponse } | null = null
  let pending: { key: string; promise: Promise<HQMetricsResponse> } | null = null

  async function babysential(): Promise<HQMetricsResponse> {
    const startedAt = now()
    const config = providerConfig(env())
    if (!config) return unavailable('babysential', startedAt, 'Babysentials PostHog-kilde er ikke konfigurert med gyldig vert, prosjekt-ID og servernøkkel.')
    const window = metricWindow(startedAt)
    const key = createHash('sha256').update(`${config.host}:${config.projectId}:${config.key}:${window.end.toISOString()}`).digest('hex')
    if (cache?.key === key && cache.expiresAt > startedAt) return copyWithFreshness(cache.value, startedAt)
    if (pending?.key === key) return copyWithFreshness(await pending.promise, now())
    const promise = (async () => {
      try {
        const aggregate = await queryPostHog(config, startedAt, fetcher, timeoutMs)
        const fetchedAt = now()
        const generatedAt = new Date(fetchedAt).toISOString()
        const checkedAt = aggregate.refreshedAt || generatedAt
        if (Date.parse(checkedAt) > fetchedAt + 60_000) throw new Error('invalid_response')
        const stale = fetchedAt - Date.parse(checkedAt) > CACHE_TTL
        const status = stale ? 'snapshot' as const : 'live' as const
        const sourceUrl = `${config.host}/project/${config.projectId}`
        const values = [aggregate.pageviews, aggregate.visitors, aggregate.optIns, aggregate.popupCohort > 0 ? Math.round(aggregate.conversions / aggregate.popupCohort * 10_000) / 100 : null]
        const driftWarning = `Tidligere lagret funnel bruker newsletter_subscribed; denne bruker newsletter_opt_in. Definisjonene må sammenlignes før historisk trendtolkning. Registrerte newsletter_subscribed i perioden: ${aggregate.legacySignups}.`
        const metrics: HQMetric[] = DEFINITIONS.map((metric, i) => ({
          ...metric, id: `babysential-${metric.id}`, projectKey: 'babysential', provider: 'PostHog', value: values[i], status: i === 3 ? 'needs_review' : status,
          checkedAt, period: window.period, sourceUrl,
          ...(i === 3 ? {
            warning: `${aggregate.popupCohort === 0 ? 'Ingen kvalifiserte popup-ID-er; konverteringsandel kan ikke beregnes. ' : ''}${driftWarning}`,
            steps: [{ name: 'ID-er med fullført popup-vindu', count: aggregate.popupCohort }, { name: 'Opt-in innen 24 timer', count: aggregate.conversions }],
          } : stale ? { warning: 'PostHog leverte et eldre mellomlagret resultat. Sjekktidspunktet viser kildens siste oppdatering.' } : {}),
        }))
        const sources: HQSourceStatus[] = [{ id: 'babysential-posthog', name: 'Babysential · PostHog', state: 'partial', checkedAt: generatedAt, count: metrics.length, detail: `Fire aggregerte målinger for 30 hele UTC-døgn. Kildedata oppdatert ${checkedAt}; hentes normalt hvert femte minutt. Nyhetsbrevdefinisjonen trenger gjennomgang. Kildelenken åpner PostHog-prosjektet; målingene beregnes av InesHQ. Ingen personlister eller råhendelser hentes.` }]
        const value = { generatedAt, metrics, sources }
        cache = { key, expiresAt: fetchedAt + CACHE_TTL, value }
        return value
      } catch (error) {
        const value = unavailable('babysential', now(), failureReason(error))
        cache = { key, expiresAt: now() + ERROR_TTL, value }
        return value
      }
    })()
    pending = { key, promise }
    try { return copyWithFreshness(await promise, now()) }
    finally { if (pending?.promise === promise) pending = null }
  }

  return async (projectKey?: HQProjectKey): Promise<HQMetricsResponse> => {
    if (projectKey && !isHQMetricProject(projectKey)) throw new Error('invalid_project')
    const keys = projectKey ? [projectKey] : PROJECT_KEYS
    const results = await Promise.all(keys.map(key => key === 'babysential' ? babysential() : unavailable(key, now(), `${LABELS[key]} har ingen verifisert analysekilde tilkoblet her. Tall fra Babysential brukes ikke som erstatning.`)))
    return { generatedAt: new Date(now()).toISOString(), metrics: results.flatMap(result => result.metrics), sources: results.flatMap(result => result.sources) }
  }
}

export const getHQMetrics = createHQMetricsAdapter()
