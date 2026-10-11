import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { config } from '@/lib/config'
import { readClaimLeaseHours, readActiveNativeWorkerTaskIds, clampLeaseHours } from '@/lib/claim-lease'
import {
  applyClosure,
  applyPrNumberBackfill,
  findClosureCandidates,
  planPrNumberBackfill,
  readPrStateSnapshot,
  sanitizePrStates,
  type ClosureReport,
  type PrStateMap,
} from '@/lib/task-closure'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500
const SNAPSHOT_ENV = 'MC_PR_STATE_SNAPSHOT'

function snapshotPath(): string {
  return process.env[SNAPSHOT_ENV] || path.join(config.dataDir, 'pr-state-snapshot.json')
}

function clampLimit(raw: unknown): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT
}

/** Keep responses bounded: lists are cut at `limit`, totals still count everything. */
function trimReport(report: ClosureReport, limit: number): ClosureReport & { truncated: boolean } {
  const cut = <T,>(list: T[]) => list.slice(0, limit)
  const truncated = [report.candidates, report.awaiting_review, report.failed_but_shipped, report.held].some((l) => l.length > limit)
  return {
    ...report,
    candidates: cut(report.candidates),
    awaiting_review: cut(report.awaiting_review),
    failed_but_shipped: cut(report.failed_but_shipped),
    held: cut(report.held),
    needs_lookup: report.needs_lookup.slice(0, 2000),
    truncated,
  }
}

function snapshotInfo(generatedAt: string | null, prCount: number) {
  const ageMs = generatedAt ? Date.now() - Date.parse(generatedAt) : NaN
  return { generated_at: generatedAt, age_hours: Number.isFinite(ageMs) ? Math.round((ageMs / 3_600_000) * 10) / 10 : null, pr_count: prCount }
}

/**
 * GET /api/tasks/closure-candidates?project=<slug>&limit=200
 *
 * Read-only. Open tasks whose linked PRs are all merged, judged against the PR
 * states in the snapshot file the CLI wrote (`scripts/mc-factory-hygiene.mjs
 * closure --write-snapshot`). This route never calls GitHub: without a snapshot
 * every PR is "unknown", nothing is a candidate, and `needs_lookup` lists what to
 * look up. `claim lease` and native-worker facts are read the same way as in
 * /api/tasks/claim-leases.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const url = new URL(request.url)
    const project = url.searchParams.get('project')?.trim() || null
    const limit = clampLimit(url.searchParams.get('limit'))

    const snapshot = readPrStateSnapshot(snapshotPath())
    const native = readActiveNativeWorkerTaskIds()
    const report = findClosureCandidates(db, {
      workspaceId,
      projectSlug: project,
      prStates: snapshot?.states ?? {},
      leaseHours: readClaimLeaseHours(db),
      activeNativeTaskIds: native.ids,
    })
    return NextResponse.json({
      report: trimReport(report, limit),
      snapshot: snapshot ? snapshotInfo(snapshot.generated_at, Object.keys(snapshot.states).length) : null,
      native_journal: { ok: native.ok, reason: native.reason ?? null },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/closure-candidates error')
    return NextResponse.json({ error: 'Failed to compute closure candidates' }, { status: 500 })
  }
}

/**
 * POST /api/tasks/closure-candidates
 *
 * Body: { project?: string, pr_states?: { "owner/repo#123": { status, merged_at, merge_commit_sha, base_ref } },
 *         apply?: boolean, task_ids?: number[], backfill_pr_numbers?: boolean, lease_hours?: number }
 *
 * DRY RUN unless `apply` is exactly `true`. The server recomputes the candidates
 * from the PR states you supply (or the snapshot file); it never trusts a candidate
 * list from the client. `task_ids` can only narrow the set. Candidates move to
 * `review` (never `done`) with an evidence comment; with `backfill_pr_numbers` the
 * unused `tasks.github_pr_number` column is filled where exactly one PR is linked.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : null
    const apply = body.apply === true
    const backfill = body.backfill_pr_numbers === true
    const limit = clampLimit(body.limit)
    const taskIds = Array.isArray(body.task_ids)
      ? new Set(body.task_ids.filter((n): n is number => Number.isInteger(n)))
      : null

    let states: PrStateMap
    let snapshot: ReturnType<typeof snapshotInfo> | null = null
    if (body.pr_states !== undefined) {
      states = sanitizePrStates(body.pr_states)
    } else {
      const loaded = readPrStateSnapshot(snapshotPath())
      states = loaded?.states ?? {}
      snapshot = loaded ? snapshotInfo(loaded.generated_at, Object.keys(states).length) : null
    }

    const native = readActiveNativeWorkerTaskIds()
    if (apply && !native.ok) {
      return NextResponse.json(
        { error: 'Controller journal unreadable; refusing to apply while a live native worker cannot be ruled out', reason: native.reason },
        { status: 409 },
      )
    }

    const leaseHours = body.lease_hours === undefined ? readClaimLeaseHours(db) : clampLeaseHours(body.lease_hours)
    const opts = { workspaceId, projectSlug: project, prStates: states, leaseHours, activeNativeTaskIds: native.ids }
    const report = findClosureCandidates(db, opts)

    const actor = auth.user.username || 'closure-sweep'
    let applied: ReturnType<typeof applyClosure> | null = null
    if (apply) {
      const selected = taskIds ? report.candidates.filter((c) => taskIds.has(c.task_id)) : report.candidates
      applied = applyClosure(db, selected, { actor, broadcast: (event, payload) => eventBus.broadcast(event, payload) })
    }

    let backfillResult: Record<string, unknown> | null = null
    if (backfill) {
      const plan = planPrNumberBackfill(db, opts)
      const items = taskIds ? plan.items.filter((i) => taskIds.has(i.task_id)) : plan.items
      const written = apply ? applyPrNumberBackfill(db, items) : null
      backfillResult = {
        planned: items.length,
        ambiguous: plan.ambiguous.length,
        ambiguous_tasks: plan.ambiguous.slice(0, limit),
        already_set: plan.already_set,
        no_refs: plan.no_refs,
        items: items.slice(0, limit),
        written,
      }
    }

    if (apply) {
      logger.info(
        { moved: applied?.moved.length ?? 0, skipped: applied?.skipped.length ?? 0, backfilled: (backfillResult?.written as { updated?: number[] } | null)?.updated?.length ?? 0, actor },
        'closure sweep applied',
      )
    }

    return NextResponse.json({
      dry_run: !apply,
      report: trimReport(report, limit),
      snapshot,
      applied,
      backfill: backfillResult,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/closure-candidates error')
    return NextResponse.json({ error: 'Failed to run closure sweep' }, { status: 500 })
  }
}
