/**
 * Read-only measurement of the three factory-hygiene problems against a Mission
 * Control database, without a running server and without writing anything:
 *
 *   node <vite-node>/vite-node.mjs scripts/measure-factory-hygiene.mts \
 *        --db ~/mission-control/.data/mission-control.db [--out report.json] [--no-gh]
 *
 * (<vite-node> is the vite-node package vitest already installs under node_modules/.pnpm.)
 *
 * The database is opened `readonly`. GitHub is read with `gh api` (REST, read-only).
 * Used before a release to show what the closure sweep, the claim lease and the
 * intake caps WOULD do to the live board; after the release the same numbers come
 * from the API (`scripts/mc-factory-hygiene.mjs measure`).
 */
import { writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { evaluateClaimLeases, readActiveNativeWorkerTaskIds, readClaimLeaseHours } from '../src/lib/claim-lease'
import { intakeReport, resolveWipRules } from '../src/lib/intake-wip'
import { findClosureCandidates, planPrNumberBackfill } from '../src/lib/task-closure'
import { lookupPrStates } from './mc-factory-hygiene.mjs'

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

async function main() {
  const dbPath = arg('db')
  if (!dbPath) throw new Error('--db is required')
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  const workspaceId = 1
  const native = readActiveNativeWorkerTaskIds()
  const leaseHours = readClaimLeaseHours(db)
  const base = { workspaceId, leaseHours, activeNativeTaskIds: native.ids }

  // 1. Which PRs need a lookup, then look them up on GitHub.
  const first = findClosureCandidates(db, { ...base, projectSlug: null, prStates: {} })
  const keys = first.needs_lookup
  const states = process.argv.includes('--no-gh') ? {} : await lookupPrStates(keys, { concurrency: 6 })
  const byStatus: Record<string, number> = {}
  for (const s of Object.values(states) as Array<{ status: string }>) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1

  const summarize = (slug: string | null) => {
    const r = findClosureCandidates(db, { ...base, projectSlug: slug, prStates: states })
    const brief = (c: (typeof r.candidates)[number]) => ({ id: c.task_id, status: c.status, prs: c.refs.map((x) => x.number), stale_claim: c.stale_claim, title: c.title.slice(0, 70) })
    return {
      project: slug ?? 'all',
      totals: r.totals,
      default_repos: r.default_repos,
      candidates: r.candidates.map(brief),
      awaiting_review_ids: r.awaiting_review.map((c) => c.task_id),
      failed_but_shipped_ids: r.failed_but_shipped.map((c) => c.task_id),
      held_by_reason: r.held.reduce<Record<string, number>>((acc, h) => {
        for (const reason of h.reasons) {
          const kind = reason.split(':')[0]
          acc[kind] = (acc[kind] ?? 0) + 1
        }
        return acc
      }, {}),
      needs_lookup_left: r.needs_lookup.length,
      unresolved_repo_tasks: r.unresolved_repo_tasks.length,
    }
  }
  const closure = [summarize('babysential'), summarize('general'), summarize(null)]

  const backfillPlan = (slug: string | null) => {
    const p = planPrNumberBackfill(db, { workspaceId, projectSlug: slug, prStates: states })
    return { project: slug ?? 'all', would_write: p.items.length, ambiguous: p.ambiguous.length, already_set: p.already_set, no_refs: p.no_refs, with_known_state: p.items.filter((i) => i.github_pr_state).length }
  }
  const backfill = [backfillPlan('babysential'), backfillPlan(null)]

  // 2. Claim leases at several lengths.
  const leaseAt = (hours: number) => {
    const ev = evaluateClaimLeases(db, { workspaceId, leaseHours: hours, activeNativeTaskIds: native.ids })
    return {
      lease_hours: hours,
      held: ev.length,
      expired: ev.filter((e) => e.verdict === 'expired').length,
      within_lease: ev.filter((e) => e.verdict === 'within_lease').length,
      protected: ev.filter((e) => e.verdict.startsWith('protected')).length,
    }
  }
  const leases = { default_hours: leaseHours, sensitivity: [24, 72, 168, 336].map(leaseAt) }
  const detail = evaluateClaimLeases(db, { workspaceId, leaseHours, activeNativeTaskIds: native.ids })
  const expired = detail.filter((e) => e.verdict === 'expired')
  const byStatus2 = expired.reduce<Record<string, number>>((a, e) => ((a[e.status] = (a[e.status] ?? 0) + 1), a), {})
  const byOwner = expired.reduce<Record<string, number>>((a, e) => {
    const k = String(e.claimed_by).slice(0, 40)
    a[k] = (a[k] ?? 0) + 1
    return a
  }, {})
  const kept = detail.filter((e) => e.verdict !== 'expired').map((e) => ({ id: e.task_id, status: e.status, claimed_by: String(e.claimed_by).slice(0, 40), idle_hours: e.idle_hours, last: e.last_activity_source, verdict: e.verdict }))
  const idleDist = expired.map((e) => e.idle_hours).sort((a, b) => a - b)
  const leasesDetail = {
    expired_by_status: byStatus2,
    expired_by_owner: byOwner,
    idle_hours_min_median_max: idleDist.length ? [idleDist[0], idleDist[Math.floor(idleDist.length / 2)], idleDist[idleDist.length - 1]] : [],
    kept,
    native_journal: { ok: native.ok, scanned: native.scanned, active_task_ids: [...native.ids], reason: native.reason ?? null },
  }

  // 3. Intake per source.
  const rules = resolveWipRules(db)
  const intake = intakeReport(db, workspaceId, rules).map((r) => ({ project: r.project_slug, source: r.source, open: r.open, deferred: r.deferred, cap: r.cap, on_cap: r.on_cap, at_or_over: r.at_or_over_cap, by_status: r.by_status }))

  const out = { generated_at: new Date().toISOString(), github: { looked_up: keys.length, by_status: byStatus }, closure, backfill, leases, leasesDetail, rules, intake }
  const text = JSON.stringify(out, null, 1)
  const file = arg('out')
  if (file) writeFileSync(file, text)
  console.log(text)
  db.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
