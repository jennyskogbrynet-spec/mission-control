// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ghPullToState, lookupPrStates, mapWithConcurrency, parseArgs, runClosure, runIntake, runLeases } from '../../../scripts/mc-factory-hygiene.mjs'

const NOW = () => '2026-10-12T00:00:00.000Z'

describe('parseArgs', () => {
  it('reads the command, valued flags and bare flags', () => {
    expect(parseArgs(['closure', '--project', 'babysential', '--apply', '--backfill', '--task-ids', '1,2'])).toEqual({
      cmd: 'closure',
      flags: { project: 'babysential', apply: true, backfill: true, 'task-ids': '1,2' },
    })
    expect(parseArgs([])).toEqual({ cmd: undefined, flags: {} })
  })
})

describe('ghPullToState', () => {
  it('maps a merged PR with its merge commit and base', () => {
    expect(ghPullToState({ state: 'closed', merged: true, merged_at: '2026-10-01T00:00:00Z', merge_commit_sha: 'abc', base: { ref: 'main' }, title: 'T' }, NOW())).toEqual({
      status: 'merged',
      merged_at: '2026-10-01T00:00:00Z',
      merge_commit_sha: 'abc',
      base_ref: 'main',
      title: 'T',
      checked_at: NOW(),
    })
  })
  it('distinguishes open, closed-unmerged and garbage', () => {
    expect(ghPullToState({ state: 'open', merged: false }).status).toBe('open')
    expect(ghPullToState({ state: 'closed', merged: false, merged_at: null }).status).toBe('closed')
    expect(ghPullToState({}).status).toBe('error')
  })
})

describe('lookupPrStates', () => {
  it('reads each PR once, retries a transient failure once, and records not_found', async () => {
    const calls: string[] = []
    const read = vi.fn(async (repo: string, n: string) => {
      calls.push(`${repo}#${n}`)
      if (n === '1') return { ok: true, doc: { state: 'closed', merged: true, merged_at: 'x', merge_commit_sha: 's', base: { ref: 'main' } } }
      if (n === '2') return { ok: false, notFound: true, detail: 'HTTP 404' }
      if (n === '3' && calls.filter((c) => c === 'o/r#3').length === 1) return { ok: false, notFound: false, detail: 'timeout' }
      return { ok: true, doc: { state: 'open', merged: false } }
    })
    const states: Record<string, any> = await lookupPrStates(['o/r#1', 'o/r#2', 'o/r#3'], { read, concurrency: 2, now: NOW })
    expect(states['o/r#1'].status).toBe('merged')
    expect(states['o/r#2']).toEqual({ status: 'not_found', checked_at: NOW() })
    expect(states['o/r#3'].status).toBe('open')
    expect(calls.filter((c) => c === 'o/r#3')).toHaveLength(2)
    expect(calls.filter((c) => c === 'o/r#2')).toHaveLength(1)
  })

  it('records error after a failed retry', async () => {
    const read = vi.fn(async () => ({ ok: false, notFound: false, detail: 'rate limited' }))
    const states: Record<string, any> = await lookupPrStates(['o/r#9'], { read, now: NOW })
    expect(states['o/r#9']).toEqual({ status: 'error', checked_at: NOW() })
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('mapWithConcurrency', () => {
  it('never runs more than the limit at once and keeps order', async () => {
    let active = 0
    let peak = 0
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n: number) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 2))
      active--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBeLessThanOrEqual(3)
  })
})

describe('commands (MC and GitHub injected)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hygiene-cli-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const report = (over: Record<string, unknown> = {}) => ({
    report: {
      totals: { considered: 3, candidate: 1, awaiting_review: 0, failed_but_shipped: 0, held: 0, no_pr_refs: 0 },
      needs_lookup: ['o/r#1'],
      candidates: [{ task_id: 5, status: 'inbox', title: 'Shipped thing', refs: [{ number: 1 }], stale_claim: false }],
      ...over,
    },
  })
  const read = async () => ({ ok: true, doc: { state: 'closed', merged: true, merged_at: 'x', merge_commit_sha: 's', base: { ref: 'main' } } })

  it('closure without --apply never sends apply:true and says so', async () => {
    const calls: Array<{ path: string; method: string; body?: any }> = []
    const request = vi.fn(async (path: string, method = 'GET', body?: unknown) => {
      calls.push({ path, method, body: body as any })
      return report()
    })
    const lines: string[] = []
    const result = await runClosure({ project: 'babysential' }, { request, read, log: (l: string) => lines.push(l), now: NOW })
    expect(result.exit).toBe(0)
    expect(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual(['GET /api/tasks/closure-candidates', 'POST /api/tasks/closure-candidates'])
    expect(calls[1].body).toMatchObject({ project: 'babysential', apply: false, pr_states: { 'o/r#1': { status: 'merged' } } })
    expect(lines.join('\n')).toContain('DRY RUN')
    expect(lines.join('\n')).toContain('CANDIDATE #5')
  })

  it('closure --apply sends apply:true and the task-id filter, and can write the snapshot', async () => {
    const calls: any[] = []
    const request = vi.fn(async (path: string, method = 'GET', body?: unknown) => {
      calls.push({ path, method, body })
      return { ...report(), applied: { moved: [5], skipped: [] }, backfill: null }
    })
    const snapshot = join(dir, 'snap.json')
    await runClosure({ project: 'babysential', apply: true, 'task-ids': '5,6', 'write-snapshot': snapshot }, { request, read, log: () => {}, now: NOW })
    expect(calls.at(-1).body).toMatchObject({ apply: true, task_ids: [5, 6] })
    const written = JSON.parse(readFileSync(snapshot, 'utf8'))
    expect(written).toMatchObject({ generated_at: NOW(), prs: { 'o/r#1': { status: 'merged' } } })
    expect(existsSync(`${snapshot}.${process.pid}.tmp`)).toBe(false)
  })

  it('closure --no-gh does not call GitHub', async () => {
    const reader = vi.fn(read)
    await runClosure({ 'no-gh': true }, { request: async () => report(), read: reader, log: () => {}, now: NOW })
    expect(reader).not.toHaveBeenCalled()
  })

  it('leases is a dry run by default and --apply is explicit', async () => {
    const lease = { lease_hours: 72, evaluated: 2, within_lease: 1, protected: [], expired: [{ task_id: 9, status: 'review', claimed_by: 'a', idle_hours: 100, last_activity_source: 'task_updated' }], released: [], skipped_changed: [] }
    const request = vi.fn(async () => lease)
    const lines: string[] = []
    await runLeases({}, { request, log: (l: string) => lines.push(l) })
    expect(request).toHaveBeenLastCalledWith('/api/tasks/claim-leases', 'POST', { apply: false })
    expect(lines.join('\n')).toContain('DRY RUN')
    await runLeases({ apply: true, 'lease-hours': '48' }, { request, log: () => {} })
    expect(request).toHaveBeenLastCalledWith('/api/tasks/claim-leases', 'POST', { apply: true, lease_hours: 48 })
  })

  it('intake only reads unless --promote, and promotes as a dry run unless --apply', async () => {
    const request = vi.fn(async (path: string, method = 'GET') =>
      method === 'GET'
        ? { rules: {}, rows: [{ project_slug: 'qa-signal', source: 'feature-audit', open: 20, deferred: 0, cap: 15, on_cap: 'defer', at_or_over_cap: true }] }
        : { plan: { items: [{ task_id: 1 }] }, result: { promoted: [1] } },
    )
    await runIntake({}, { request, log: () => {} })
    expect(request).toHaveBeenCalledTimes(1)
    await runIntake({ promote: true }, { request, log: () => {} })
    expect(request).toHaveBeenLastCalledWith('/api/tasks/intake-wip', 'POST', { apply: false })
    await runIntake({ promote: true, apply: true }, { request, log: () => {} })
    expect(request).toHaveBeenLastCalledWith('/api/tasks/intake-wip', 'POST', { apply: true })
  })
})
