/**
 * Work-in-progress cap per intake source.
 *
 * Why: automatic writers file tasks faster than anything closes them. Measured
 * 2026-10-11: feature-audit filed 88 + 56 tasks in 60 days and none was closed
 * by the board; in the QA-signal project 58 feature-audit tasks were open.
 *
 * Contract (chosen so no existing caller can break):
 *  - the cap applies when a task is created with `metadata.source` that has a rule
 *    and the number of OPEN tasks with that source in that project is at or above
 *    the cap. "Open" = status not done/failed, not itself deferred, not exempt.
 *  - `on_cap: 'defer'` (default): the task is still created and still gets an id,
 *    but as `backlog` with `metadata.wip_deferred = true` (and the status the
 *    caller asked for in `wip_requested_status`). The POST answers 201 with an
 *    extra `wip` block. Findings are never lost, and the callers (the poster
 *    `log-bug-to-mc.sh`, `mc-batch-ticket.mjs`) see the same shape as before.
 *    `promoteDeferredIntake` brings the oldest deferred tasks back as room frees up.
 *  - `on_cap: 'reject'`: 409 `intake_wip_cap`, nothing is created. Used for
 *    `feature-audit-ambition`, whose tasks are filed straight into `backlog`
 *    (parked by design), so there is nothing lower to defer to; the writer keeps
 *    its ledger and files again when the board has room.
 *  - exempt: `metadata.wip_exempt === true` or `metadata.kind` in WIP_EXEMPT_KINDS
 *    (`fix-batch` carries the claim the native release gate needs; deferring it
 *    would not make it less necessary).
 *
 * Rules: defaults below, overridden by env `MC_INTAKE_WIP_CAPS` (JSON) and then by
 * the `intake.wip_caps` setting (JSON). A number is shorthand for `{cap, on_cap:
 * 'defer'}`; `0` or `null` removes the cap for that source.
 */
import type Database from 'better-sqlite3'
import type { Env, TaskEventSink } from './claim-lease'

type Db = Database.Database

export type OnCap = 'defer' | 'reject'

export interface WipRule {
  cap: number
  on_cap: OnCap
}
export type WipRules = Record<string, WipRule>

export const WIP_CAPS_SETTING = 'intake.wip_caps'
export const WIP_CAPS_ENV = 'MC_INTAKE_WIP_CAPS'
export const WIP_EXEMPT_KINDS: readonly string[] = ['fix-batch']
export const DEFAULT_WIP_RULES: Readonly<WipRules> = {
  'feature-audit': { cap: 15, on_cap: 'defer' },
  'feature-audit-ambition': { cap: 10, on_cap: 'reject' },
  'seo-radar': { cap: 5, on_cap: 'defer' },
}

const MAX_CAP = 100_000

/** Parse a JSON override. Returns the entries to apply (cap 0 = remove), or null when unparseable. */
export function parseWipOverrides(raw: unknown): Record<string, WipRule | null> | null {
  if (raw === undefined || raw === null || raw === '') return {}
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, WipRule | null> = {}
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    const source = name.trim().toLowerCase()
    if (!source) continue
    if (entry === null) {
      out[source] = null
    } else if (typeof entry === 'number') {
      out[source] = Number.isInteger(entry) && entry > 0 && entry <= MAX_CAP ? { cap: entry, on_cap: 'defer' } : null
    } else if (entry && typeof entry === 'object') {
      const e = entry as { cap?: unknown; on_cap?: unknown }
      const cap = typeof e.cap === 'number' && Number.isInteger(e.cap) && e.cap > 0 && e.cap <= MAX_CAP ? e.cap : 0
      out[source] = cap ? { cap, on_cap: e.on_cap === 'reject' ? 'reject' : 'defer' } : null
    }
  }
  return out
}

/** Defaults < env < setting. An unparseable override is ignored (the defaults stand), never "no caps". */
export function resolveWipRules(db: Db, env: Env = process.env): WipRules {
  const rules: WipRules = { ...DEFAULT_WIP_RULES }
  let setting: unknown
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(WIP_CAPS_SETTING) as { value?: string } | undefined
    setting = row?.value
  } catch {
    setting = undefined
  }
  for (const layer of [env[WIP_CAPS_ENV], setting]) {
    const overrides = parseWipOverrides(layer)
    if (!overrides) continue
    for (const [source, rule] of Object.entries(overrides)) {
      if (rule) rules[source] = rule
      else delete rules[source]
    }
  }
  return rules
}

export function intakeSourceOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const source = (metadata as Record<string, unknown>).source
  if (typeof source !== 'string') return null
  const normalized = source.trim().toLowerCase()
  return normalized || null
}

export function isWipExempt(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
  const m = metadata as Record<string, unknown>
  return m.wip_exempt === true || (typeof m.kind === 'string' && WIP_EXEMPT_KINDS.includes(m.kind))
}

// json_extract on a malformed document raises; guard with json_valid in a CASE (AND order is not guaranteed).
const SRC = "LOWER(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.source') END)"
const KIND = "CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.kind') END"
const DEFERRED = "COALESCE(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.wip_deferred') END, 0)"
const EXEMPT = "COALESCE(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.wip_exempt') END, 0)"

/** Open, non-deferred, non-exempt tasks with this source in this project. */
export function countOpenForSource(db: Db, workspaceId: number, projectId: number, source: string): number {
  const placeholders = WIP_EXEMPT_KINDS.map(() => '?').join(',')
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS n FROM tasks
      WHERE workspace_id = ? AND project_id = ?
        AND status NOT IN ('done', 'failed')
        AND ${SRC} = ?
        AND ${DEFERRED} = 0
        AND ${EXEMPT} = 0
        AND COALESCE(${KIND}, '') NOT IN (${placeholders})
      `,
    )
    .get(workspaceId, projectId, source, ...WIP_EXEMPT_KINDS) as { n: number }
  return row.n
}

export type IntakeAction = 'allow' | 'defer' | 'reject'

export interface IntakeDecision {
  action: IntakeAction
  source: string | null
  /** Why `allow`: no source, no rule, exempt, or below the cap. */
  reason: 'no_source' | 'no_rule' | 'exempt' | 'below_cap' | 'at_cap'
  rule: WipRule | null
  open: number
  requested_status: string
  final_status: string
}

export function decideIntake(
  db: Db,
  input: { workspaceId: number; projectId: number; status: string; metadata: unknown; rules?: WipRules },
): IntakeDecision {
  const base = { requested_status: input.status, final_status: input.status, open: 0, rule: null as WipRule | null }
  const source = intakeSourceOf(input.metadata)
  if (!source) return { ...base, action: 'allow', source: null, reason: 'no_source' }
  const rule = (input.rules ?? resolveWipRules(db))[source]
  if (!rule) return { ...base, action: 'allow', source, reason: 'no_rule' }
  // A task created already closed is not work in progress; an exempt one is not counted.
  if (input.status === 'done' || input.status === 'failed' || isWipExempt(input.metadata)) {
    return { ...base, rule, action: 'allow', source, reason: 'exempt' }
  }
  const open = countOpenForSource(db, input.workspaceId, input.projectId, source)
  if (open < rule.cap) return { ...base, rule, open, action: 'allow', source, reason: 'below_cap' }
  if (rule.on_cap === 'reject') return { ...base, rule, open, action: 'reject', source, reason: 'at_cap' }
  return { ...base, rule, open, action: 'defer', source, reason: 'at_cap', final_status: 'backlog' }
}

/** Metadata keys the server owns; stripped from incoming metadata so a caller cannot pre-flag itself as deferred. */
export const WIP_OWNED_KEYS = ['wip_deferred', 'wip_deferred_at', 'wip_requested_status', 'wip_cap', 'wip_promoted_at'] as const

export function stripWipOwnedKeys(metadata: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...metadata }
  for (const key of WIP_OWNED_KEYS) delete copy[key]
  return copy
}

export function deferredMetadata(decision: IntakeDecision, nowIso: string): Record<string, unknown> {
  return {
    wip_deferred: true,
    wip_deferred_at: nowIso,
    wip_requested_status: decision.requested_status,
    wip_cap: { source: decision.source, open: decision.open, cap: decision.rule?.cap ?? null },
  }
}

export function rejectionMessage(decision: IntakeDecision, projectId: number): string {
  return (
    `Intake cap reached for source "${decision.source}" in project ${projectId}: ${decision.open} open, cap ${decision.rule?.cap}. ` +
    'Triage or close some of them before filing more; the writer should keep its ledger and file again later.'
  )
}

// ── reporting and promotion ──────────────────────────────────────────────────

export interface IntakeRow {
  project_id: number | null
  project_slug: string | null
  source: string
  open: number
  deferred: number
  cap: number | null
  on_cap: OnCap | null
  at_or_over_cap: boolean
  by_status: Record<string, number>
}

/** Open counts per (project, source), with the rule that applies. Read-only. */
export function intakeReport(db: Db, workspaceId: number, rules: WipRules = resolveWipRules(db)): IntakeRow[] {
  const rows = db
    .prepare(
      `
      SELECT t.project_id AS project_id, p.slug AS project_slug, ${SRC.replace(/metadata/g, 't.metadata')} AS source,
             t.status AS status, ${DEFERRED.replace(/metadata/g, 't.metadata')} AS deferred,
             ${EXEMPT.replace(/metadata/g, 't.metadata')} AS exempt,
             COALESCE(${KIND.replace(/metadata/g, 't.metadata')}, '') AS kind, COUNT(*) AS n
      FROM tasks t LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      WHERE t.workspace_id = ? AND t.status NOT IN ('done', 'failed')
      GROUP BY 1, 2, 3, 4, 5, 6, 7
      `,
    )
    .all(workspaceId) as Array<{
    project_id: number | null
    project_slug: string | null
    source: string | null
    status: string
    deferred: number
    exempt: number
    kind: string
    n: number
  }>

  const grouped = new Map<string, IntakeRow>()
  for (const r of rows) {
    if (!r.source) continue
    const key = `${r.project_id}|${r.source}`
    let row = grouped.get(key)
    if (!row) {
      const rule = rules[r.source] ?? null
      row = {
        project_id: r.project_id,
        project_slug: r.project_slug,
        source: r.source,
        open: 0,
        deferred: 0,
        cap: rule?.cap ?? null,
        on_cap: rule?.on_cap ?? null,
        at_or_over_cap: false,
        by_status: {},
      }
      grouped.set(key, row)
    }
    if (r.deferred) {
      row.deferred += r.n
      continue
    }
    if (r.exempt || WIP_EXEMPT_KINDS.includes(r.kind)) continue
    row.open += r.n
    row.by_status[r.status] = (row.by_status[r.status] ?? 0) + r.n
  }
  const out = [...grouped.values()]
  for (const row of out) row.at_or_over_cap = row.cap !== null && row.open >= row.cap
  return out.sort((a, b) => b.open - a.open || a.source.localeCompare(b.source))
}

export interface PromotionItem {
  task_id: number
  project_id: number
  source: string
  to_status: string
}

export interface PromotionPlan {
  items: PromotionItem[]
  /** Per (project, source): room left under the cap at planning time. */
  headroom: Array<{ project_id: number; source: string; open: number; cap: number; promoted: number }>
}

/** Oldest-first plan: deferred tasks that fit under the cap. Read-only. */
export function planDeferredPromotion(
  db: Db,
  opts: { workspaceId: number; projectId?: number; rules?: WipRules; limit?: number },
): PromotionPlan {
  const rules = opts.rules ?? resolveWipRules(db)
  const limit = opts.limit ?? 50
  const deferred = db
    .prepare(
      `
      SELECT id, project_id, ${SRC} AS source,
             CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.wip_requested_status') END AS requested
      FROM tasks
      WHERE workspace_id = ? AND status = 'backlog' AND ${DEFERRED} = 1
        ${opts.projectId === undefined ? '' : 'AND project_id = ?'}
      ORDER BY created_at ASC, id ASC
      `,
    )
    .all(...(opts.projectId === undefined ? [opts.workspaceId] : [opts.workspaceId, opts.projectId])) as Array<{
    id: number
    project_id: number
    source: string | null
    requested: string | null
  }>

  const plan: PromotionPlan = { items: [], headroom: [] }
  const room = new Map<string, { project_id: number; source: string; open: number; cap: number; promoted: number }>()
  for (const d of deferred) {
    if (plan.items.length >= limit) break
    if (!d.source || !rules[d.source]) continue
    const key = `${d.project_id}|${d.source}`
    let slot = room.get(key)
    if (!slot) {
      slot = { project_id: d.project_id, source: d.source, open: countOpenForSource(db, opts.workspaceId, d.project_id, d.source), cap: rules[d.source].cap, promoted: 0 }
      room.set(key, slot)
    }
    if (slot.open + slot.promoted >= slot.cap) continue
    slot.promoted++
    const requested = d.requested && d.requested !== 'backlog' ? d.requested : 'inbox'
    plan.items.push({ task_id: d.id, project_id: d.project_id, source: d.source, to_status: requested })
  }
  plan.headroom = [...room.values()]
  return plan
}

export function applyDeferredPromotion(
  db: Db,
  workspaceId: number,
  items: PromotionItem[],
  deps: { actor?: string; nowSec?: number; broadcast?: TaskEventSink } = {},
): { promoted: number[]; skipped: number[] } {
  const actor = deps.actor ?? 'intake-wip'
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000)
  const out = { promoted: [] as number[], skipped: [] as number[] }
  for (const item of items) {
    const ok = db.transaction(() => {
      const row = db
        .prepare("SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ? AND status = 'backlog'")
        .get(item.task_id, workspaceId) as { metadata: string | null } | undefined
      if (!row) return false
      let meta: Record<string, unknown> = {}
      try {
        meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {}
      } catch {
        return false
      }
      if (meta.wip_deferred !== true) return false
      meta.wip_deferred = false
      meta.wip_promoted_at = new Date(nowSec * 1000).toISOString()
      const changes = db
        .prepare("UPDATE tasks SET status = ?, metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'backlog'")
        .run(item.to_status, JSON.stringify(meta), nowSec, item.task_id, workspaceId).changes
      if (changes !== 1) return false
      db.prepare('INSERT INTO comments (task_id, author, content, created_at, workspace_id) VALUES (?, ?, ?, ?, ?)').run(
        item.task_id,
        actor,
        `Promoted from backlog to ${item.to_status}: the "${item.source}" intake is back under its cap.`,
        nowSec,
        workspaceId,
      )
      return true
    })()
    if (ok) {
      out.promoted.push(item.task_id)
      deps.broadcast?.('task.status_changed', { id: item.task_id, status: item.to_status, previous_status: 'backlog', updated_at: nowSec, reason: 'wip_promoted' })
    } else {
      out.skipped.push(item.task_id)
    }
  }
  return out
}
