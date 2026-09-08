// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { buildHQPostHogQuery, createHQMetricsAdapter } from '@/lib/hq-metrics'

const NOW = Date.parse('2026-09-08T10:30:00Z')
const CONFIG = { HQ_POSTHOG_API_KEY: 'private-test-token', HQ_POSTHOG_PROJECT_ID: '382457', HQ_POSTHOG_HOST: 'https://us.posthog.com' }
const response = (results: unknown = [[1200, 240, 12, 100, 10, 0]], extra = {}) => new Response(JSON.stringify({ results, ...extra }), { headers: { 'content-type': 'application/json' } })

describe('HQ business metrics', () => {
  it('returns scoped aggregate measurements, explicit definitions and the current funnel warning', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(undefined, { persons: ['must-not-leave-server'], secret: 'private-test-token' }))
    const get = createHQMetricsAdapter({ fetch: fetcher, now: () => NOW, env: () => CONFIG })
    const result = await get('babysential')
    expect(result.metrics.map(metric => metric.value)).toEqual([1200, 240, 12, 10])
    expect(result.metrics.every(metric => metric.projectKey === 'babysential')).toBe(true)
    expect(result.metrics[3]).toMatchObject({ status: 'needs_review', steps: [{ name: 'ID-er med fullført popup-vindu', count: 100 }, { name: 'Opt-in innen 24 timer', count: 10 }] })
    expect(result.metrics[3].warning).toContain('newsletter_subscribed')
    expect(result.metrics[3].definition).toContain('Siste døgn')
    expect(result.metrics[0].period).toBe('2026-08-09–2026-09-07 UTC (30 hele døgn)')
    expect(result.metrics[0].sourceUrl).toBe('https://us.posthog.com/project/382457')
    expect(JSON.stringify(result)).not.toMatch(/private-test-token|must-not-leave-server|Authorization|distinct_id":/)
    const [url, request] = fetcher.mock.calls[0]
    expect(url).toBe('https://us.posthog.com/api/projects/382457/query/')
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer private-test-token' } })
    expect(JSON.parse(request!.body as string)).toMatchObject({ refresh: 'blocking', query: { kind: 'HogQLQuery' } })
  })

  it('bounds SQL to completed UTC days with a mature 24-hour popup cohort and one aggregate result', () => {
    const sql = buildHQPostHogQuery(Date.parse('2026-09-08T00:15:00+02:00'))
    expect(sql).toContain("timestamp >= toDateTime('2026-08-08 00:00:00', 'UTC')")
    expect(sql).toContain("timestamp < toDateTime('2026-09-07 00:00:00', 'UTC')")
    expect(sql).toContain(`first_popup < ${Date.parse('2026-09-06T00:00:00Z') / 1000}`)
    expect(sql).toContain('first_popup + 86400')
    expect(sql).toContain('LIMIT 1')
    expect(sql.match(/FROM events/g)).toHaveLength(1)
    expect(sql).not.toMatch(/SELECT \*|OFFSET|properties\.email|person\.properties/)
    // ClickHouse substitutes aliases throughout a SELECT; reusing an input name
    // for its aggregate caused a real illegal_aggregation response from PostHog.
    expect(sql).toContain('sum(browser_events.pageviews) AS total_pageviews')
    expect(sql).toContain('sum(browser_events.legacy_signups) AS total_legacy_signups')
    expect(sql).toContain('countIf(browser_events.pageviews > 0)')
    expect(sql).not.toMatch(/sum\([^)]*\) AS (pageviews|legacy_signups)\b/)
  })

  it('reuses one result for five minutes, deduplicates concurrent callers and protects the cache from caller mutations', async () => {
    let time = NOW
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response())
    const get = createHQMetricsAdapter({ fetch: fetcher, now: () => time, env: () => CONFIG })
    const [first, second] = await Promise.all([get('babysential'), get('babysential')])
    expect(fetcher).toHaveBeenCalledTimes(1)
    first.metrics[0].value = 99999
    second.sources[0].detail = 'changed by caller'
    time += 299_999
    const cached = await get('babysential')
    expect(cached.metrics[0].value).toBe(1200)
    expect(cached.sources[0].detail).not.toBe('changed by caller')
    expect(cached.metrics[0].checkedAt).toBe(new Date(NOW).toISOString())
    time += 2
    await get('babysential')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidates cache when the UTC day or server credential changes', async () => {
    let time = Date.parse('2026-09-08T23:59:59Z')
    let config = { ...CONFIG }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response())
    const get = createHQMetricsAdapter({ fetch: fetcher, now: () => time, env: () => config })
    await get('babysential')
    time += 2000
    await get('babysential')
    config = { ...CONFIG, HQ_POSTHOG_API_KEY: 'replacement-secret' }
    await get('babysential')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('never substitutes Babysential data for another project', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const get = createHQMetricsAdapter({ fetch: fetcher, now: () => NOW, env: () => CONFIG })
    for (const key of ['babyhub', 'brrrr', 'shared'] as const) {
      const result = await get(key)
      expect(result.metrics.every(metric => metric.value === null && metric.status === 'unavailable' && metric.projectKey === key)).toBe(true)
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('returns all projects without mixing provider ownership', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response())
    const get = createHQMetricsAdapter({ fetch: fetcher, now: () => NOW, env: () => CONFIG })
    const result = await get()
    expect(result.metrics).toHaveLength(16)
    expect(result.metrics.filter(metric => metric.value !== null).every(metric => metric.projectKey === 'babysential')).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([{}, { ...CONFIG, HQ_POSTHOG_HOST: 'https://untrusted.example' }, { ...CONFIG, HQ_POSTHOG_PROJECT_ID: '../another' }])('does not send a credential when configuration is missing or unsafe', async env => {
    const fetcher = vi.fn<typeof fetch>()
    const get = createHQMetricsAdapter({ fetch: fetcher, now: () => NOW, env: () => env })
    const result = await get('babysential')
    expect(result.metrics.every(metric => metric.value === null)).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([[], [[null, 1, 1, 1, 1, 0]], [[1, 1, 1]], [[1, 2, 1, 1, 1, 0]], [[5, 2, 1, 1, 2, 0]]].map(rows => ({ rows })))('treats incomplete or inconsistent data as unavailable, never as zero', async ({ rows }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(rows))
    const result = await createHQMetricsAdapter({ fetch: fetcher, now: () => NOW, env: () => CONFIG })('babysential')
    expect(result.metrics.every(metric => metric.value === null && metric.status === 'unavailable')).toBe(true)
  })

  it('preserves measured zero counts but does not invent a rate for an empty cohort', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([[0, 0, 0, 0, 0, 0]]))
    const result = await createHQMetricsAdapter({ fetch: fetcher, now: () => NOW, env: () => CONFIG })('babysential')
    expect(result.metrics.map(metric => metric.value)).toEqual([0, 0, 0, null])
    expect(result.metrics[3].warning).toContain('kan ikke beregnes')
  })

  it.each([401, 403, 429, 500])('returns an explicit sanitized provider failure for HTTP %i', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-test-token and upstream details', { status }))
    const get = createHQMetricsAdapter({ fetch: fetcher, now: () => NOW, env: () => CONFIG })
    const result = await get('babysential')
    expect(result.sources[0].state).toBe('unavailable')
    expect(result.metrics.every(metric => metric.value === null && !!metric.warning)).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/private-test-token|upstream details/)
    await get('babysential')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('aborts a slow provider request even if the fetch implementation never settles', async () => {
    vi.useFakeTimers()
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
      const get = createHQMetricsAdapter({ fetch: fetcher, now: () => NOW, env: () => CONFIG, timeoutMs: 100 })
      const pending = get('babysential')
      await vi.advanceTimersByTimeAsync(101)
      const result = await pending
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
      expect(result.metrics[0].warning).toContain('tidsgrensen')
      expect(result.metrics[0].value).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('marks older provider cache results as snapshots using their source refresh time', async () => {
    const refreshedAt = '2026-09-08T09:00:00Z'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(undefined, { last_refresh: refreshedAt }))
    const result = await createHQMetricsAdapter({ fetch: fetcher, now: () => NOW, env: () => CONFIG })('babysential')
    expect(result.metrics[0]).toMatchObject({ status: 'snapshot', checkedAt: '2026-09-08T09:00:00.000Z' })
  })

  it('rejects a provider refresh timestamp in the future', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(undefined, { last_refresh: '2026-09-09T00:00:00Z' }))
    const result = await createHQMetricsAdapter({ fetch: fetcher, now: () => NOW, env: () => CONFIG })('babysential')
    expect(result.metrics.every(metric => metric.status === 'unavailable' && metric.value === null)).toBe(true)
  })

  it('updates freshness when a provider result ages during the local cache lifetime', async () => {
    let time = NOW
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(undefined, { last_refresh: new Date(NOW - 4 * 60_000).toISOString() }))
    const get = createHQMetricsAdapter({ fetch: fetcher, now: () => time, env: () => CONFIG })
    expect((await get('babysential')).metrics[0].status).toBe('live')
    time += 2 * 60_000
    expect((await get('babysential')).metrics[0].status).toBe('snapshot')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
