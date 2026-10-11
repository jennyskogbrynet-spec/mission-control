/**
 * Closure candidates: open tasks whose linked pull requests are ALL merged.
 *
 * Why: work ships and the ticket stays open. Measured 2026-10-11: 22 open
 * Babysential tasks had every linked PR merged, the `github_pr_number` column was
 * unused (0 of ~1.6k), and PR links lived in `metadata` in a dozen shapes.
 *
 * This module decides and applies; it never talks to GitHub. Callers pass PR
 * states they looked up themselves (`scripts/mc-factory-hygiene.mjs` uses
 * `gh api`). A PR with no state in the map is "unknown" and blocks closure.
 *
 * What a candidate is moved to: `review`, never `done`. `done` needs an approved
 * quality review from a reviewer other than the working agent
 * (`PUT /api/tasks/:id`, `/api/quality-review`); a sweep is not that reviewer.
 * `review` is the status the rest of MC and its skills use for "work delivered,
 * waiting for a reviewer".
 */
import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { evaluateClaimLeases, DEFAULT_CLAIM_LEASE_HOURS, type TaskEventSink } from './claim-lease'
import { extractPrRefs, prKey, type PrRef } from './pr-links'

type Db = Database.Database

export type PrStatus = 'merged' | 'open' | 'closed' | 'not_found' | 'error'

export interface PrState {
  status: PrStatus
  merged_at?: string | null
  merge_commit_sha?: string | null
  /** Branch the PR merged into (`base.ref`). */
  base_ref?: string | null
  title?: string | null
  checked_at?: string | null
}

/** Keyed `owner/repo#123` (lower-case repo), see `prKey`. */
export type PrStateMap = Record<string, PrState>

export interface PrStateSnapshot {
  generated_at: string | null
  states: PrStateMap
}

export const CLOSURE_TARGET_STATUS = 'review'
export const CLOSURE_ACTOR = 'closure-sweep'

/**
 * Statuses a candidate may be moved out of. `review`/`quality_review` already wait for
 * a reviewer. `awaiting_owner` is NOT movable: it is a gate for a human decision, and a
 * merged PR does not answer it (measured 2026-10-12: MC 1442, whose PR 481 merged, is
 * still waiting for the owner's call on the scope of an accepted exposure).
 */
const MOVABLE_STATUSES = new Set(['backlog', 'inbox', 'assigned', 'in_progress'])
const AWAITING_REVIEW_STATUSES = new Set(['review', 'quality_review'])
const MAX_PRS_IN_COMMENT = 25

export type ClosureVerdict = 'candidate' | 'awaiting_review' | 'failed_but_shipped' | 'held' | 'no_pr_refs'

export interface ClosureRef {
  key: string | null
  repo: string | null
  number: number
  state: PrStatus | 'unknown'
  merged_at: string | null
  merge_commit_sha: string | null
  base_ref: string | null
  sources: string[]
}

export interface ClosureEvaluation {
  task_id: number
  workspace_id: number
  project_slug: string | null
  title: string
  status: string
  updated_at: number
  claim_state: string
  claimed_by: string | null
  /** The task holds a claim whose lease has expired; applying also releases it. */
  stale_claim: boolean
  refs: ClosureRef[]
  verdict: ClosureVerdict
  reasons: string[]
}

export interface ClosureOptions {
  workspaceId: number
  /** Project slug; omit for every project in the workspace. */
  projectSlug?: string | null
  prStates?: PrStateMap
  /** Repo for bare PR numbers. Otherwise inferred per project from the PR URLs it carries. */
  defaultRepo?: string | null
  /** Branches a PR must have merged into. Default: main/master. */
  baseBranches?: string[]
  leaseHours?: number
  nowMs?: number
  activeNativeTaskIds?: ReadonlySet<number>
}

export interface ClosureReport {
  generated_at: string
  project: string | null
  default_repos: Record<string, string>
  totals: Record<ClosureVerdict | 'done_skipped' | 'considered', number>
  candidates: ClosureEvaluation[]
  awaiting_review: ClosureEvaluation[]
  failed_but_shipped: ClosureEvaluation[]
  held: ClosureEvaluation[]
  /** PR keys that still need a lookup (repo known, no state supplied). */
  needs_lookup: string[]
  /** Tasks with a bare PR number and no repo to resolve it against. */
  unresolved_repo_tasks: number[]
}

interface TaskRow {
  id: number
  workspace_id: number
  project_id: number | null
  project_slug: string | null
  title: string
  status: string
  claim_state: string
  claimed_by: string | null
  claimed_at: string | number | null
  updated_at: number
  github_pr_number: number | null
  github_repo: string | null
  github_pr_state: string | null
  metadata: string | null
}

function loadRows(db: Db, workspaceId: number, projectSlug?: string | null): TaskRow[] {
  const params: unknown[] = [workspaceId]
  let where = 't.workspace_id = ?'
  if (projectSlug) {
    where += ' AND p.slug = ?'
    params.push(projectSlug)
  }
  return db
    .prepare(
      `
      SELECT t.id, t.workspace_id, t.project_id, p.slug AS project_slug, t.title, t.status, t.claim_state,
             t.claimed_by, t.claimed_at, t.updated_at, t.github_pr_number, t.github_repo, t.github_pr_state, t.metadata
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      WHERE ${where}
      ORDER BY t.id
      `,
    )
    .all(...params) as TaskRow[]
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Most common explicit repo among the PR URLs each project's tasks carry (and one global fallback). */
export function inferDefaultRepos(rows: TaskRow[]): { byProject: Map<string, string>; global: string | null } {
  const perProject = new Map<string, Map<string, number>>()
  const overall = new Map<string, number>()
  for (const row of rows) {
    for (const ref of extractPrRefs(row, null)) {
      if (!ref.repo) continue
      const slug = row.project_slug ?? ''
      const counts = perProject.get(slug) ?? new Map<string, number>()
      counts.set(ref.repo, (counts.get(ref.repo) ?? 0) + 1)
      perProject.set(slug, counts)
      overall.set(ref.repo, (overall.get(ref.repo) ?? 0) + 1)
    }
  }
  const top = (m: Map<string, number>): string | null => {
    let best: string | null = null
    let bestN = 0
    for (const [repo, n] of m) {
      if (n > bestN) {
        best = repo
        bestN = n
      }
    }
    return best
  }
  const byProject = new Map<string, string>()
  for (const [slug, counts] of perProject) {
    const repo = top(counts)
    if (repo) byProject.set(slug, repo)
  }
  return { byProject, global: top(overall) }
}

function resolveRefs(row: TaskRow, defaultRepo: string | null, states: PrStateMap): ClosureRef[] {
  return extractPrRefs(row, defaultRepo).map((ref: PrRef) => {
    const key = ref.repo ? prKey(ref.repo, ref.number) : null
    const state = key ? states[key] : undefined
    return {
      key,
      repo: ref.repo,
      number: ref.number,
      state: state ? state.status : 'unknown',
      merged_at: state?.merged_at ?? null,
      merge_commit_sha: state?.merge_commit_sha ?? null,
      base_ref: state?.base_ref ?? null,
      sources: ref.sources,
    }
  })
}

/** Read-only: classify every non-done task in scope. */
export function findClosureCandidates(db: Db, opts: ClosureOptions): ClosureReport {
  const states = opts.prStates ?? {}
  const baseBranches = new Set((opts.baseBranches ?? ['main', 'master']).map((b) => b.toLowerCase()))
  const rows = loadRows(db, opts.workspaceId, opts.projectSlug)
  const inferred = inferDefaultRepos(rows)

  const leases = new Map(
    evaluateClaimLeases(db, {
      workspaceId: opts.workspaceId,
      leaseHours: opts.leaseHours ?? DEFAULT_CLAIM_LEASE_HOURS,
      nowMs: opts.nowMs,
      activeNativeTaskIds: opts.activeNativeTaskIds,
    }).map((ev) => [ev.task_id, ev]),
  )

  const report: ClosureReport = {
    generated_at: new Date(opts.nowMs ?? Date.now()).toISOString(),
    project: opts.projectSlug ?? null,
    default_repos: Object.fromEntries(inferred.byProject),
    totals: { candidate: 0, awaiting_review: 0, failed_but_shipped: 0, held: 0, no_pr_refs: 0, done_skipped: 0, considered: 0 },
    candidates: [],
    awaiting_review: [],
    failed_but_shipped: [],
    held: [],
    needs_lookup: [],
    unresolved_repo_tasks: [],
  }
  const needsLookup = new Set<string>()

  for (const row of rows) {
    if (row.status === 'done') {
      report.totals.done_skipped++
      continue
    }
    report.totals.considered++
    const defaultRepo = opts.defaultRepo ?? inferred.byProject.get(row.project_slug ?? '') ?? inferred.global
    const refs = resolveRefs(row, defaultRepo, states)
    if (refs.length === 0) {
      report.totals.no_pr_refs++
      continue
    }

    const reasons: string[] = []
    let allMerged = true
    let unresolved = false
    for (const ref of refs) {
      const label = ref.key ?? `#${ref.number}`
      if (!ref.key) {
        allMerged = false
        unresolved = true
        reasons.push(`repo_unresolved:${label}`)
        continue
      }
      if (ref.state === 'unknown') {
        allMerged = false
        needsLookup.add(ref.key)
        reasons.push(`pr_state_unknown:${ref.key}`)
      } else if (ref.state === 'open') {
        allMerged = false
        reasons.push(`pr_open:${ref.key}`)
      } else if (ref.state === 'closed') {
        allMerged = false
        reasons.push(`pr_closed_unmerged:${ref.key}`)
      } else if (ref.state === 'not_found' || ref.state === 'error') {
        allMerged = false
        reasons.push(`pr_lookup_failed:${ref.key}`)
      } else if (ref.base_ref && !baseBranches.has(ref.base_ref.toLowerCase())) {
        allMerged = false
        reasons.push(`merged_into_${ref.base_ref}:${ref.key}`)
      }
    }
    if (unresolved) report.unresolved_repo_tasks.push(row.id)

    const meta = parseMeta(row.metadata)
    const lease = leases.get(row.id)
    const claimed = row.claim_state === 'Claimed' || row.claim_state === 'Running'
    const staleClaim = claimed && lease?.verdict === 'expired'

    const evaluation: ClosureEvaluation = {
      task_id: row.id,
      workspace_id: row.workspace_id,
      project_slug: row.project_slug,
      title: row.title,
      status: row.status,
      updated_at: row.updated_at,
      claim_state: row.claim_state,
      claimed_by: row.claimed_by,
      stale_claim: staleClaim,
      refs,
      verdict: 'held',
      reasons,
    }

    if (!allMerged) {
      report.held.push(evaluation)
      report.totals.held++
      continue
    }
    if (row.status === 'failed') {
      evaluation.verdict = 'failed_but_shipped'
      report.failed_but_shipped.push(evaluation)
      report.totals.failed_but_shipped++
      continue
    }
    if (AWAITING_REVIEW_STATUSES.has(row.status)) {
      evaluation.verdict = 'awaiting_review'
      report.awaiting_review.push(evaluation)
      report.totals.awaiting_review++
      continue
    }
    if (!MOVABLE_STATUSES.has(row.status)) {
      evaluation.reasons.push(row.status === 'awaiting_owner' ? 'awaiting_owner_decision' : `status_not_movable:${row.status}`)
      report.held.push(evaluation)
      report.totals.held++
      continue
    }

    // Structural guards: tasks that carry PRs without being "the work of one PR".
    if (meta.kind === 'fix-batch') evaluation.reasons.push('release_carrier')
    if (Array.isArray(meta.finding_ids) && meta.finding_ids.length > 1) evaluation.reasons.push('multi_finding_digest')
    if (claimed && !staleClaim) evaluation.reasons.push('active_claim')

    if (evaluation.reasons.length > 0) {
      report.held.push(evaluation)
      report.totals.held++
    } else {
      evaluation.verdict = 'candidate'
      report.candidates.push(evaluation)
      report.totals.candidate++
    }
  }

  report.needs_lookup = [...needsLookup].sort()
  return report
}

function evidenceComment(c: ClosureEvaluation, actor: string, releasedStaleClaim: boolean): string {
  const shown = c.refs.slice(0, MAX_PRS_IN_COMMENT).map((r) => {
    const sha = r.merge_commit_sha ? r.merge_commit_sha.slice(0, 8) : 'unknown sha'
    return `PR #${r.number} (${r.repo}) merged ${r.merged_at ?? 'at unknown time'} as ${sha}${r.base_ref ? ` on ${r.base_ref}` : ''}`
  })
  const more = c.refs.length > shown.length ? `; +${c.refs.length - shown.length} more` : ''
  return [
    `Moved from ${c.status} to review by ${actor}: every pull request linked to this task is merged.`,
    `${shown.join('; ')}${more}.`,
    releasedStaleClaim ? `The expired claim held by "${c.claimed_by ?? 'unknown'}" was released with it.` : '',
    'This is not a close: a reviewer other than the working agent decides whether the task is done (POST /api/quality-review).',
  ]
    .filter(Boolean)
    .join(' ')
}

export interface ApplyClosureOptions {
  actor?: string
  nowSec?: number
  broadcast?: TaskEventSink
}

export interface ApplyClosureResult {
  moved: number[]
  skipped: Array<{ task_id: number; reason: string }>
}

/**
 * Move candidates to `review`. Each move is a compare-and-set on (status,
 * updated_at) as evaluated, so a task touched since the report is skipped, not
 * overwritten. Only `candidate` evaluations are accepted.
 */
export function applyClosure(db: Db, candidates: ClosureEvaluation[], opts: ApplyClosureOptions = {}): ApplyClosureResult {
  const actor = opts.actor ?? CLOSURE_ACTOR
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const result: ApplyClosureResult = { moved: [], skipped: [] }

  for (const c of candidates) {
    if (c.verdict !== 'candidate') {
      result.skipped.push({ task_id: c.task_id, reason: `not_a_candidate:${c.verdict}` })
      continue
    }
    const ok = db.transaction(() => {
      const row = db
        .prepare('SELECT status, updated_at, metadata, claim_state, claimed_by, claimed_at FROM tasks WHERE id = ? AND workspace_id = ?')
        .get(c.task_id, c.workspace_id) as
        | { status: string; updated_at: number; metadata: string | null; claim_state: string; claimed_by: string | null; claimed_at: string | number | null }
        | undefined
      if (!row) return 'task_missing'
      if (row.status !== c.status || row.updated_at !== c.updated_at) return 'changed_since_evaluation'

      const releaseClaim = c.stale_claim && (row.claim_state === 'Claimed' || row.claim_state === 'Running')
      const meta = parseMeta(row.metadata)
      meta.pr_closure = {
        at: new Date(nowSec * 1000).toISOString(),
        by: actor,
        previous_status: c.status,
        prs: c.refs.slice(0, MAX_PRS_IN_COMMENT).map((r) => ({
          repo: r.repo,
          number: r.number,
          merged_at: r.merged_at,
          merge_commit_sha: r.merge_commit_sha,
          base_ref: r.base_ref,
        })),
      }
      const claimSql = releaseClaim ? ", claim_state = 'Unclaimed', claimed_by = NULL, claimed_at = NULL" : ''
      const changes = db
        .prepare(
          `UPDATE tasks SET status = ?, updated_at = ?, metadata = ?${claimSql}
           WHERE id = ? AND workspace_id = ? AND status = ? AND updated_at = ?`,
        )
        .run(CLOSURE_TARGET_STATUS, nowSec, JSON.stringify(meta), c.task_id, c.workspace_id, c.status, c.updated_at).changes
      if (changes !== 1) return 'changed_since_evaluation'

      db.prepare('INSERT INTO comments (task_id, author, content, created_at, workspace_id) VALUES (?, ?, ?, ?, ?)').run(
        c.task_id,
        actor,
        evidenceComment(c, actor, releaseClaim),
        nowSec,
        c.workspace_id,
      )
      db.prepare(
        'INSERT INTO activities (type, entity_type, entity_id, actor, description, data, created_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'task_updated',
        'task',
        c.task_id,
        actor,
        `Task moved from ${c.status} to ${CLOSURE_TARGET_STATUS}: all linked PRs merged`,
        JSON.stringify({ oldStatus: c.status, newStatus: CLOSURE_TARGET_STATUS, prs: c.refs.map((r) => r.key) }),
        nowSec,
        c.workspace_id,
      )
      return 'ok'
    })()
    if (ok === 'ok') {
      result.moved.push(c.task_id)
      opts.broadcast?.('task.status_changed', {
        id: c.task_id,
        status: CLOSURE_TARGET_STATUS,
        previous_status: c.status,
        updated_at: nowSec,
        reason: 'all_linked_prs_merged',
      })
    } else {
      result.skipped.push({ task_id: c.task_id, reason: ok })
    }
  }
  return result
}

// ── github_pr_number backfill ────────────────────────────────────────────────

export interface BackfillItem {
  task_id: number
  workspace_id: number
  project_slug: string | null
  status: string
  github_pr_number: number
  repo: string | null
  /** `merged`/`open`/`closed` when the supplied states know it, else null. */
  github_pr_state: string | null
}

export interface BackfillPlan {
  items: BackfillItem[]
  /** Tasks with more than one distinct PR number: the column holds one, so they are left for a human. */
  ambiguous: Array<{ task_id: number; numbers: number[] }>
  already_set: number
  no_refs: number
}

export function planPrNumberBackfill(db: Db, opts: ClosureOptions): BackfillPlan {
  const states = opts.prStates ?? {}
  const rows = loadRows(db, opts.workspaceId, opts.projectSlug)
  const inferred = inferDefaultRepos(rows)
  const plan: BackfillPlan = { items: [], ambiguous: [], already_set: 0, no_refs: 0 }
  for (const row of rows) {
    if (row.github_pr_number) {
      plan.already_set++
      continue
    }
    const defaultRepo = opts.defaultRepo ?? inferred.byProject.get(row.project_slug ?? '') ?? inferred.global
    const refs = extractPrRefs(row, defaultRepo)
    if (refs.length === 0) {
      plan.no_refs++
      continue
    }
    const numbers = [...new Set(refs.map((r) => r.number))]
    if (numbers.length > 1) {
      plan.ambiguous.push({ task_id: row.id, numbers })
      continue
    }
    const ref = refs[0]
    const known = ref.repo ? states[prKey(ref.repo, ref.number)] : undefined
    const prState = known ? (known.status === 'merged' || known.status === 'open' || known.status === 'closed' ? known.status : null) : null
    plan.items.push({
      task_id: row.id,
      workspace_id: row.workspace_id,
      project_slug: row.project_slug,
      status: row.status,
      github_pr_number: ref.number,
      repo: ref.repo,
      github_pr_state: prState,
    })
  }
  return plan
}

/**
 * Write the column only. `updated_at` is deliberately NOT touched: quality review
 * and resume-review bind to the revision (`expected_updated_at`), and a bulk
 * bookkeeping write must not invalidate a review somebody is in the middle of.
 * `github_repo` is not written either: `pushTaskToGitHub` prefers the task's
 * `github_repo` over the project's, so setting it could start an issue sync.
 */
export function applyPrNumberBackfill(db: Db, items: BackfillItem[]): { updated: number[]; skipped: number[] } {
  const out = { updated: [] as number[], skipped: [] as number[] }
  const stmt = db.prepare(
    'UPDATE tasks SET github_pr_number = ?, github_pr_state = COALESCE(?, github_pr_state) WHERE id = ? AND workspace_id = ? AND github_pr_number IS NULL',
  )
  db.transaction(() => {
    for (const item of items) {
      const changes = stmt.run(item.github_pr_number, item.github_pr_state, item.task_id, item.workspace_id).changes
      if (changes === 1) out.updated.push(item.task_id)
      else out.skipped.push(item.task_id)
    }
  })()
  return out
}

// ── PR-state snapshot file ───────────────────────────────────────────────────

/**
 * Read the snapshot the CLI wrote (`{ generated_at, prs: { "owner/repo#1": {status, ...} } }`).
 * Returns null when the file is missing or malformed; the route then reports every
 * PR as unknown instead of guessing.
 */
export function readPrStateSnapshot(file: string): PrStateSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { generated_at?: unknown; prs?: unknown }
    if (!parsed || typeof parsed !== 'object' || !parsed.prs || typeof parsed.prs !== 'object') return null
    const states: PrStateMap = {}
    for (const [key, value] of Object.entries(parsed.prs as Record<string, unknown>)) {
      const v = value as Partial<PrState> | null
      if (!v || typeof v !== 'object') continue
      if (!['merged', 'open', 'closed', 'not_found', 'error'].includes(String(v.status))) continue
      states[key.toLowerCase()] = {
        status: v.status as PrStatus,
        merged_at: typeof v.merged_at === 'string' ? v.merged_at : null,
        merge_commit_sha: typeof v.merge_commit_sha === 'string' ? v.merge_commit_sha : null,
        base_ref: typeof v.base_ref === 'string' ? v.base_ref : null,
        title: typeof v.title === 'string' ? v.title : null,
        checked_at: typeof v.checked_at === 'string' ? v.checked_at : null,
      }
    }
    return { generated_at: typeof parsed.generated_at === 'string' ? parsed.generated_at : null, states }
  } catch {
    return null
  }
}

/** Validate PR states posted by a client: same shape as the snapshot's `prs`. */
export function sanitizePrStates(input: unknown, maxEntries = 2000): PrStateMap {
  const out: PrStateMap = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  let n = 0
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (n++ >= maxEntries) break
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+#\d{1,7}$/i.test(key)) continue
    const v = value as Partial<PrState> | null
    if (!v || typeof v !== 'object' || !['merged', 'open', 'closed', 'not_found', 'error'].includes(String(v.status))) continue
    const str = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : null)
    out[key.toLowerCase()] = {
      status: v.status as PrStatus,
      merged_at: str(v.merged_at, 40),
      merge_commit_sha: str(v.merge_commit_sha, 64),
      base_ref: str(v.base_ref, 200),
      title: str(v.title, 300),
      checked_at: str(v.checked_at, 40),
    }
  }
  return out
}
