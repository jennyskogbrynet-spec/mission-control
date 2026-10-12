import { randomUUID } from 'crypto'
import { getDatabase, db_helpers } from './db'
import { runOpenClaw } from './command'
import { callOpenClawGateway } from './openclaw-gateway'
import { allowsPaidApiFallback, isManagedComputeTask } from './dispatch-billing-policy'
import { eventBus } from './event-bus'
import { logger } from './logger'
import { config } from './config'
import { syncTaskOutbound } from './github-sync-engine'
import { isActiveClaim } from './claim-time'
import {
  APPROVED_MAX_AGE_HOURS,
  APPROVED_ONLY_WIP_MAX,
  DISPATCH_ENABLED_SETTING,
  DISPATCH_HELD_ACTIVITY,
  countInProgress,
  describeHeld,
  isHeldActivityDue,
  resolveDispatchScope,
  type DispatchScopeContext,
} from './dispatch-scope'

/** Timeout for gateway task dispatch CLI calls. Configurable via MC_GATEWAY_TASK_DISPATCH_TIMEOUT_MS env var (default: 600000ms). */
const TASK_DISPATCH_TIMEOUT_MS = parseInt(process.env['MC_GATEWAY_TASK_DISPATCH_TIMEOUT_MS'] ?? '600000', 10)
const RELEASE_ACTIVE_CLAIM_ASSIGNMENTS = `
  claim_state = CASE WHEN claim_state IN ('Claimed', 'Running') THEN 'Released' ELSE claim_state END,
  claimed_by = CASE WHEN claim_state IN ('Claimed', 'Running') THEN NULL ELSE claimed_by END,
  claimed_at = CASE WHEN claim_state IN ('Claimed', 'Running') THEN NULL ELSE claimed_at END
`
const DEFAULT_DISPATCH_RESOURCE_POLICY = {
  lane: 'default',
  timeoutMs: TASK_DISPATCH_TIMEOUT_MS,
  maxRetries: 5,
  staleAfterMinutes: 10,
  rateLimitKey: null as string | null,
  zombieReaper: true,
}

/**
 * Hard ceiling on agent invocations that Mission Control's own schedulers may
 * start in a rolling 24h window.
 *
 * Every per-task retry counter in this file is a LOCAL bound: it stops one task
 * from looping forever, but N tasks each retrying within their own budget still
 * multiply into a runaway. That is exactly how the Aegis review loop drained a
 * codex subscription on 2026-07-28/29 without a single counter being exceeded.
 * This ceiling is the global backstop that no per-task logic can talk its way
 * past. Tune with the `general.agent_invocation_daily_cap` setting.
 */
const AGENT_INVOCATION_DEFAULT_DAILY_CAP = 400
let agentInvocationTableReady = false

function ensureAgentInvocationTable(db: ReturnType<typeof getDatabase>): void {
  if (agentInvocationTableReady) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      task_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_invocations_ts ON agent_invocations(ts);
  `)
  agentInvocationTableReady = true
}

function getAgentInvocationDailyCap(db: ReturnType<typeof getDatabase>): number {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'general.agent_invocation_daily_cap'")
      .get() as { value: string } | undefined
    const parsed = row ? parseInt(row.value, 10) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : AGENT_INVOCATION_DEFAULT_DAILY_CAP
  } catch {
    return AGENT_INVOCATION_DEFAULT_DAILY_CAP
  }
}

/** Count of scheduler-started agent invocations in the last 24h. */
export function getAgentInvocationBudget(): { used: number; cap: number; exceeded: boolean } {
  const db = getDatabase()
  ensureAgentInvocationTable(db)
  const cap = getAgentInvocationDailyCap(db)
  const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60
  const used = (db.prepare('SELECT COUNT(*) as n FROM agent_invocations WHERE ts >= ?').get(since) as { n: number }).n
  return { used, cap, exceeded: used >= cap }
}

/** The same numbers as getAgentInvocationBudget(), read-only (never creates the table): for the plan. */
function readAgentInvocationBudget(db: ReturnType<typeof getDatabase>): { used: number; cap: number; exceeded: boolean } {
  const cap = getAgentInvocationDailyCap(db)
  let used = 0
  try {
    used = (db.prepare('SELECT COUNT(*) as n FROM agent_invocations WHERE ts >= ?').get(Math.floor(Date.now() / 1000) - 24 * 60 * 60) as { n: number }).n
  } catch { /* no ledger yet: nothing used */ }
  return { used, cap, exceeded: used >= cap }
}

/** Record one scheduler-started agent invocation against the 24h budget. */
function recordAgentInvocation(source: string, taskId: number | null): void {
  const db = getDatabase()
  ensureAgentInvocationTable(db)
  db.prepare('INSERT INTO agent_invocations (ts, source, task_id) VALUES (?, ?, ?)')
    .run(Math.floor(Date.now() / 1000), source, taskId)
  // Keep the table bounded — the budget only ever looks back 24h.
  db.prepare('DELETE FROM agent_invocations WHERE ts < ?')
    .run(Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60)
}

/**
 * Refuse to start another scheduler-driven agent invocation once the rolling
 * 24h ceiling is hit. Returns a message to surface, or null when under budget.
 */
export function assertAgentInvocationBudget(source: string): string | null {
  const { used, cap, exceeded } = getAgentInvocationBudget()
  if (!exceeded) return null
  const message = `Agent invocation budget exhausted: ${used}/${cap} in the last 24h. ${source} paused. Raise general.agent_invocation_daily_cap to override.`
  logger.error({ source, used, cap }, 'Agent invocation budget exhausted — scheduler paused')
  eventBus.broadcast('scheduler.budget_exhausted', { source, used, cap })
  return message
}

/** Sync task to GitHub/GNAP and broadcast escalation if task failed */
function syncAndEscalateIfFailed(task: { id: number; title: string; status: string; priority: string; project_id?: number | null; workspace_id: number; description?: string | null }, newStatus: string, errorMsg?: string, dispatchAttempts?: number): void {
  syncTaskOutbound({ ...task, status: newStatus }, task.workspace_id)
  if (newStatus === 'failed') {
    eventBus.broadcast('task.escalated', {
      id: task.id,
      title: task.title,
      reason: errorMsg?.includes('Aegis rejected') ? 'max_aegis_rejections' : errorMsg?.includes('stuck') ? 'stale_task_max_retries' : 'max_dispatch_retries',
      dispatch_attempts: dispatchAttempts ?? 0,
      error_message: (errorMsg ?? '').substring(0, 500),
      workspace_id: task.workspace_id,
    })
  }
}

interface DispatchableTask {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  assigned_to: string
  workspace_id: number
  agent_name: string
  agent_id: number
  agent_config: string | null
  ticket_prefix: string | null
  project_ticket_no: number | null
  project_id: number | null
  tags?: string[]
  metadata?: string | Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------

/**
 * Return an explicit gateway model override from Mission Control agent config.
 *
 * By default, task dispatch should not inject a model override; the OpenClaw
 * agent should use its own configured default model. A Mission Control agent
 * may still opt into an override via agent.config.dispatchModel.
 */
export function resolveTaskDispatchModelOverride(task: Pick<DispatchableTask, 'agent_config'>): string | null {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.dispatchModel === 'string' && cfg.dispatchModel) return cfg.dispatchModel
    } catch { /* ignore */ }
  }
  return null
}

/** Extract the gateway agent identifier from the agent's config JSON.
 *  Falls back to agent_name (display name) if openclawId is not set. */
function resolveGatewayAgentId(task: DispatchableTask): string {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.openclawId === 'string' && cfg.openclawId) return cfg.openclawId
    } catch { /* ignore */ }
  }
  return task.agent_name
}

function parseTaskMetadata(raw: DispatchableTask['metadata']): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const integer = Math.trunc(value)
  if (integer < min || integer > max) return fallback
  return integer
}

export function resolveDispatchResourcePolicy(rawMetadata: DispatchableTask['metadata']): typeof DEFAULT_DISPATCH_RESOURCE_POLICY {
  const metadata = parseTaskMetadata(rawMetadata)
  const contract = asRecord(metadata.workflow_contract)
  const resourcePolicy = asRecord(contract.resource_policy)
  const timeoutSeconds = boundedInteger(resourcePolicy.run_timeout_seconds, Math.floor(TASK_DISPATCH_TIMEOUT_MS / 1000), 30, 7200)

  return {
    lane: typeof resourcePolicy.lane === 'string' && resourcePolicy.lane.trim()
      ? resourcePolicy.lane.trim()
      : DEFAULT_DISPATCH_RESOURCE_POLICY.lane,
    timeoutMs: timeoutSeconds * 1000,
    maxRetries: boundedInteger(resourcePolicy.max_retries, DEFAULT_DISPATCH_RESOURCE_POLICY.maxRetries, 0, 10),
    staleAfterMinutes: boundedInteger(resourcePolicy.stale_after_minutes, DEFAULT_DISPATCH_RESOURCE_POLICY.staleAfterMinutes, 1, 1440),
    rateLimitKey: typeof resourcePolicy.rate_limit_key === 'string' && resourcePolicy.rate_limit_key.trim()
      ? resourcePolicy.rate_limit_key.trim()
      : null,
    zombieReaper: typeof resourcePolicy.zombie_reaper === 'boolean'
      ? resourcePolicy.zombie_reaper
      : DEFAULT_DISPATCH_RESOURCE_POLICY.zombieReaper,
  }
}

export function resolveDispatchFailureStatus(
  currentAttempts: number,
  resourcePolicy: Pick<typeof DEFAULT_DISPATCH_RESOURCE_POLICY, 'maxRetries'>,
): { newAttempts: number; terminal: boolean } {
  const newAttempts = Math.max(0, Math.trunc(currentAttempts || 0)) + 1
  return {
    newAttempts,
    terminal: newAttempts >= resourcePolicy.maxRetries,
  }
}

/**
 * Pick (or mint) the stable idempotency key for a task's current logical
 * assignment. The key MUST NOT vary across retries — a timestamped key defeats
 * gateway-side deduplication, which is how duplicate task deliveries happened
 * (committee finding P0-1, observed on TASK-806 2026-07-27). The key is only
 * rotated when a fresh delivery is intentional (stale requeue).
 */
export function pickDispatchIdempotencyKey(
  metadata: Record<string, unknown>,
  taskId: number,
  mintUuid: () => string = randomUUID,
): { key: string; minted: boolean } {
  const existing = metadata.dispatch_idempotency_key
  if (typeof existing === 'string' && existing.startsWith(`task-dispatch-${taskId}-`)) {
    return { key: existing, minted: false }
  }
  return { key: `task-dispatch-${taskId}-${mintUuid()}`, minted: true }
}

function resolveDispatchIdempotencyKey(db: ReturnType<typeof getDatabase>, taskId: number): string {
  const row = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(taskId) as { metadata: string | null } | undefined
  const metadata = parseTaskMetadata(row?.metadata ?? null)
  const { key, minted } = pickDispatchIdempotencyKey(metadata, taskId)
  if (minted) {
    metadata.dispatch_idempotency_key = key
    db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), taskId)
  }
  return key
}

function rotateDispatchIdempotencyKey(db: ReturnType<typeof getDatabase>, taskId: number): void {
  const row = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(taskId) as { metadata: string | null } | undefined
  const metadata = parseTaskMetadata(row?.metadata ?? null)
  if (metadata.dispatch_idempotency_key === undefined) return
  delete metadata.dispatch_idempotency_key
  db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), taskId)
}

function formatJsonish(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'object') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatWorkflowContract(metadata: Record<string, unknown>): string[] {
  const contract = metadata.workflow_contract
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return []
  const c = contract as Record<string, unknown>
  const lines = ['', '## Mission Control Workflow Contract']
  const fields: Array<[string, unknown]> = [
    ['Workflow template', c.workflow_template],
    ['Goal', c.goal],
    ['Owner agent', c.owner_agent],
    ['Autonomy level', c.autonomy_level],
    ['Required skills', Array.isArray(c.required_skills) ? c.required_skills.join(', ') : c.required_skills],
    ['Allowed tools', Array.isArray(c.allowed_tools) ? c.allowed_tools.join(', ') : c.allowed_tools],
    ['Context sources', Array.isArray(c.context_pack_sources) ? c.context_pack_sources.join(', ') : c.context_pack_sources],
    ['Self layer sources', Array.isArray(c.self_layer_sources) ? c.self_layer_sources.join(', ') : c.self_layer_sources],
    ['Memory tools', Array.isArray(c.memory_tools) ? c.memory_tools.join(', ') : c.memory_tools],
    ['Memory context types', formatJsonish(c.memory_context_types)],
    ['Capability scopes', formatJsonish(c.capability_scopes)],
    ['Resource policy', formatJsonish(c.resource_policy)],
    ['Verify required', c.verify_required],
    ['Proof expected', c.proof_expected],
    ['Output location', c.output_location],
  ]

  for (const [label, value] of fields) {
    if (value === undefined || value === null || value === '') continue
    lines.push(`- ${label}: ${String(value)}`)
  }
  lines.push('- Stop rule: if autonomy level or tool permissions hit an approval gate, stop and report instead of proceeding.')
  return lines
}

export function buildTaskPrompt(task: DispatchableTask, rejectionFeedback?: string | null): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
    : `TASK-${task.id}`

  const lines = [
    'You have been assigned a task in Mission Control.',
    '',
    `**[${ticket}] ${task.title}**`,
    `Priority: ${task.priority}`,
  ]

  if (task.tags && task.tags.length > 0) {
    lines.push(`Tags: ${task.tags.join(', ')}`)
  }

  if (task.description) {
    lines.push('', task.description)
  }

  lines.push(...formatWorkflowContract(parseTaskMetadata(task.metadata)))

  if (rejectionFeedback) {
    lines.push('', '## Previous Review Feedback', rejectionFeedback, '', 'Please address this feedback in your response.')
  }

  lines.push('', 'Complete this task and provide your response. Be concise and actionable.')
  return lines.join('\n')
}

/** Extract first valid JSON object from raw stdout (handles surrounding text/warnings). */
function parseGatewayJson(raw: string): any | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

interface AgentResponseParsed {
  text: string | null
  sessionId: string | null
}

function parseAgentResponse(stdout: string): AgentResponseParsed {
  try {
    const parsed = JSON.parse(stdout)
    const sessionId: string | null = typeof parsed?.sessionId === 'string' ? parsed.sessionId
      : typeof parsed?.session_id === 'string' ? parsed.session_id
      : null

    // OpenClaw agent --json returns { payloads: [{ text: "..." }] }
    if (parsed?.payloads?.[0]?.text) {
      return { text: parsed.payloads[0].text, sessionId }
    }
    // Fallback: if there's a result or output field
    if (parsed?.result) return { text: String(parsed.result), sessionId }
    if (parsed?.output) return { text: String(parsed.output), sessionId }
    // Last resort: stringify the whole response
    return { text: JSON.stringify(parsed, null, 2), sessionId }
  } catch {
    // Not valid JSON — return raw stdout if non-empty
    return { text: stdout.trim() || null, sessionId: null }
  }
}

// ---------------------------------------------------------------------------
// Direct Claude API dispatch (gateway-free)
// ---------------------------------------------------------------------------

function getAnthropicApiKey(): string | null {
  return (process.env.ANTHROPIC_API_KEY || '').trim() || null
}

function isGatewayAvailable(): boolean {
  // Gateway is available if OpenClaw is installed OR a gateway is registered in the DB
  if (config.openclawHome) return true
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT COUNT(*) as c FROM gateways').get() as { c: number } | undefined
    return (row?.c ?? 0) > 0
  } catch {
    return false
  }
}

export function classifyDirectModel(task: Pick<DispatchableTask, 'id' | 'title' | 'description' | 'priority' | 'agent_config'>): string {
  // Check per-agent config override first
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.dispatchModel === 'string' && cfg.dispatchModel) {
        // Strip gateway prefixes like "9router/cc/" to get bare model ID
        return cfg.dispatchModel.replace(/^.*\//, '')
      }
    } catch { /* ignore */ }
  }

  const text = `${task.title} ${task.description ?? ''}`.toLowerCase()
  const priority = task.priority?.toLowerCase() ?? ''

  // Complex → Opus
  const complexSignals = [
    'debug', 'diagnos', 'architect', 'design system', 'security audit',
    'root cause', 'investigate', 'incident', 'refactor', 'migration',
  ]
  if (priority === 'critical' || complexSignals.some(s => text.includes(s))) {
    return 'claude-opus-4-6'
  }

  // Size heuristics → Opus for large/complex tasks
  const descLength = (task.description ?? '').length
  if (descLength > 2000) return 'claude-opus-4-6'
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT estimated_hours FROM tasks WHERE id = ?').get(task.id) as { estimated_hours: number | null } | undefined
    if (row?.estimated_hours && row.estimated_hours >= 4) return 'claude-opus-4-6'
  } catch { /* ignore */ }

  // Routine tasks used to fall back to Haiku here, but Haiku is not stable for
  // delegated Mission Control work. Keep direct fallback on Sonnet unless an
  // agent explicitly opts into a dispatchModel override above.
  const routineSignals = [
    'status check', 'health check', 'format', 'rename', 'summarize',
    'translate', 'quick ', 'simple ', 'routine ', 'minor ',
  ]
  if (routineSignals.some(s => text.includes(s)) && priority !== 'high' && priority !== 'critical') {
    return 'claude-sonnet-4-6'
  }

  // Default → Sonnet
  return 'claude-sonnet-4-6'
}

function getAgentSoulContent(task: DispatchableTask): string | null {
  try {
    const db = getDatabase()
    const row = db.prepare(
      'SELECT soul_content FROM agents WHERE id = ? AND workspace_id = ?'
    ).get(task.agent_id, task.workspace_id) as { soul_content: string | null } | undefined
    return row?.soul_content || null
  } catch {
    return null
  }
}

/** Persist a future direct-API receipt using the migrated attribution schema. */
export function recordDirectDispatchUsage(
  task: Pick<DispatchableTask, 'id' | 'agent_name' | 'workspace_id'>,
  model: string,
  usage: { input_tokens?: number; output_tokens?: number },
): void {
  try {
    getDatabase().prepare(`
      INSERT INTO token_usage (model, session_id, input_tokens, output_tokens, cost_usd, created_at, workspace_id, agent_name, task_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      model, `task-${task.id}`, usage.input_tokens || 0, usage.output_tokens || 0,
      null, // The response reports tokens, not a billed cost. Unknown is not zero.
      Math.floor(Date.now() / 1000), task.workspace_id, task.agent_name, task.id,
    )
  } catch (err) {
    // Do not retry a paid model invocation because receipt storage failed.
    logger.warn({ err, taskId: task.id }, 'Could not persist direct-dispatch token usage')
  }
}

async function callClaudeDirectly(
  task: DispatchableTask,
  prompt: string,
  timeoutMs = TASK_DISPATCH_TIMEOUT_MS,
): Promise<AgentResponseParsed> {
  const apiKey = getAnthropicApiKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set — cannot dispatch without gateway')

  const model = classifyDirectModel(task)
  const soul = getAgentSoulContent(task)

  const messages: Array<{ role: string; content: string }> = [
    { role: 'user', content: prompt },
  ]

  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages,
  }

  if (soul) {
    body.system = soul
  }

  logger.info({ taskId: task.id, model, agent: task.agent_name }, 'Dispatching task via direct Claude API')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Claude API dispatch timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '')
    throw new Error(`Claude API ${res.status}: ${errorBody.substring(0, 500)}`)
  }

  const data = await res.json() as {
    content: Array<{ type: string; text?: string }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }

  const text = data.content
    ?.filter((b: { type: string }) => b.type === 'text')
    .map((b: { text?: string }) => b.text || '')
    .join('\n') || null

  // Record token usage
  if (data.usage) {
    recordDirectDispatchUsage(task, model, data.usage)
  }

  return { text, sessionId: null }
}

interface ReviewableTask {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  resolution: string | null
  assigned_to: string | null
  agent_config: string | null
  workspace_id: number
  project_id: number | null
  ticket_prefix: string | null
  project_ticket_no: number | null
  claim_state: string | null
  claimed_at: string | number | null
  claimed_by: string | null
  updated_at: number | null
}

/**
 * Identities that did (or claimed) the work on a task, normalized for
 * comparison against a candidate reviewer agent ID. Used to enforce
 * separation of duties in the automated Aegis path.
 */
export function collectImplementerAgentIds(
  task: Pick<ReviewableTask, 'assigned_to' | 'claimed_by' | 'agent_config'>,
): Set<string> {
  const ids = new Set<string>()
  for (const value of [task.assigned_to, task.claimed_by]) {
    const normalized = normalizeGatewayAgentId(value)
    if (normalized) ids.add(normalized)
  }
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.openclawId === 'string') {
        const normalized = normalizeGatewayAgentId(cfg.openclawId)
        if (normalized) ids.add(normalized)
      }
    } catch { /* ignore */ }
  }
  return ids
}

export function resolveGatewayAgentIdForReview(
  task: Pick<ReviewableTask, 'agent_config' | 'assigned_to'>,
  configuredFallbackAgentId?: string | null,
): string {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.openclawId === 'string' && cfg.openclawId) return cfg.openclawId
    } catch { /* ignore */ }
  }
  return task.assigned_to || configuredFallbackAgentId?.trim() || 'main'
}

function normalizeGatewayAgentId(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-')
}

// REMOVED 2026-07-31: runAegisReviews() — the automated LLM quality-review loop.
//
// It selected tasks in 'review' status every 60s and sent each one's full
// resolution to a gateway agent for an approve/reject verdict. On any reviewer
// error it reverted the task to 'review', so a broken reviewer became an
// unbounded retry loop: ~30 tasks re-reviewed every ~65s, ~305k input tokens
// per call, ~1.14B input tokens over 2026-07-28/29, which drained the codex
// 20x subscription. Nothing caught it — the usage tracker had been blind since
// the 2026-07-14 OpenClaw migration and only ever watched cron runs, never
// Mission Control's own scheduler.
//
// Tasks now stay in 'review' for human triage. If an automated reviewer is ever
// reintroduced it MUST go through assertAgentInvocationBudget() below and carry
// a bounded per-task error counter.

/**
 * Requeue stale tasks stuck in 'in_progress' whose assigned agent is offline.
 * Prevents tasks from being permanently stuck when agents crash or disconnect.
 *
 * Under `approved_only` (F2) this housekeeping only touches tasks the current morning
 * meeting approved (listed or `outcome_task_id` children); with no fresh list it touches
 * nothing. It moves tasks to `assigned` or `failed`, so it must not reach past the brake.
 */
export async function requeueStaleTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const earliestPolicyThreshold = now - 1 * 60
  const scope = resolveDispatchScope(db, now)
  if (scope.eligible_ids !== null && scope.eligible_ids.size === 0) {
    return { ok: true, message: scope.held_reason ? `Stale requeue held: ${scope.held_reason}` : 'No approved tasks to requeue' }
  }

  const staleTasks = db.prepare(`
    SELECT t.id, t.title, t.assigned_to, t.dispatch_attempts, t.workspace_id,
           t.updated_at, t.metadata,
           a.status as agent_status, a.last_seen as agent_last_seen
    FROM tasks t
    LEFT JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    WHERE t.status = 'in_progress'
      AND t.updated_at < ?
  `).all(earliestPolicyThreshold) as Array<{
    id: number; title: string; assigned_to: string | null; dispatch_attempts: number
    workspace_id: number; updated_at: number; metadata: string | Record<string, unknown> | null
    agent_status: string | null; agent_last_seen: number | null
  }>

  if (staleTasks.length === 0) {
    return { ok: true, message: 'No stale tasks found' }
  }

  let requeued = 0
  let failed = 0

  for (const task of staleTasks) {
    if (scope.eligible_ids !== null && !scope.eligible_ids.has(task.id)) continue
    const resourcePolicy = resolveDispatchResourcePolicy(task.metadata)
    if (!resourcePolicy.zombieReaper) continue
    const staleThreshold = now - resourcePolicy.staleAfterMinutes * 60
    if (Number(task.updated_at ?? 0) >= staleThreshold) continue

    // Only requeue if the agent is offline or unknown
    const agentOffline = !task.agent_status || task.agent_status === 'offline'
    if (!agentOffline) continue

    const newAttempts = (task.dispatch_attempts ?? 0) + 1

    if (newAttempts >= resourcePolicy.maxRetries) {
      db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
        .run('failed', `Task stuck in_progress ${newAttempts} times in lane "${resourcePolicy.lane}" — agent "${task.assigned_to}" offline. Moved to failed.`, newAttempts, now, task.id)

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'failed',
        previous_status: 'in_progress',
        error_message: `Stale task — agent offline after ${newAttempts} attempts`,
        reason: 'stale_task_max_retries',
      })

      syncAndEscalateIfFailed(task as any, 'failed', `Task stuck in_progress ${newAttempts} times`, newAttempts)
      failed++
    } else {
      db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
        .run('assigned', `Requeued: agent "${task.assigned_to}" went offline while task was in_progress in lane "${resourcePolicy.lane}"`, newAttempts, now, task.id)

      // A requeue is an intentional fresh delivery — rotate the idempotency key
      // so the gateway does not dedupe the new dispatch against the dead one.
      rotateDispatchIdempotencyKey(db, task.id)

      // Add a comment explaining the requeue
      db.prepare(`
        INSERT INTO comments (task_id, author, content, created_at, workspace_id)
        VALUES (?, 'scheduler', ?, ?, ?)
      `).run(task.id, `Task requeued (attempt ${newAttempts}/${resourcePolicy.maxRetries}, lane ${resourcePolicy.lane}): agent "${task.assigned_to}" went offline while task was in_progress.`, now, task.workspace_id)

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'assigned',
        previous_status: 'in_progress',
        error_message: `Agent "${task.assigned_to}" went offline`,
        reason: 'stale_task_requeue',
      })
      syncAndEscalateIfFailed(task as any, 'assigned')

      requeued++
    }
  }

  const total = requeued + failed
  return {
    ok: true,
    message: total === 0
      ? `Found ${staleTasks.length} stale task(s) but agents still online`
      : `Requeued ${requeued}, failed ${failed} of ${staleTasks.length} stale task(s)`,
  }
}

// ---------------------------------------------------------------------------
// Dispatch scope (F2): the selection both the scheduler and the plan use
// ---------------------------------------------------------------------------

const DISPATCH_OFF_MESSAGE = `Task dispatch is off (${DISPATCH_ENABLED_SETTING} is not "true"); nothing moved`
/** Per tick, as before F2. */
const DISPATCH_BATCH_LIMIT = 3
const ROUTE_BATCH_LIMIT = 5

type SelectedForDispatch = DispatchableTask & { tags?: string; created_at?: number; via?: 'assigned' | 'routed_this_tick' }
export interface DispatchSkip { id: number; reason: string; detail?: string }
/** `in_progress` counts the eligible set under approved_only (the cap), `in_progress_total` every lane. */
export interface DispatchWip { in_progress: number; in_progress_total: number; max: number | null; free: number | null }

const ASSIGNED_SELECT = `
    SELECT t.*, a.name as agent_name, a.id as agent_id, a.config as agent_config,
           p.ticket_prefix, t.project_ticket_no
    FROM tasks t
    JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.status = 'assigned'
      AND t.assigned_to IS NOT NULL
      AND CASE WHEN json_valid(t.metadata) THEN json_type(t.metadata, '$.compute_route') IS NULL ELSE 1 END`
const PRIORITY_ORDER_SQL = `
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
      t.created_at ASC, t.id ASC`

function priorityRank(priority: string | null | undefined): number {
  return priority === 'critical' ? 0 : priority === 'high' ? 1 : priority === 'medium' ? 2 : 3
}

function compareDispatchOrder(a: SelectedForDispatch, b: SelectedForDispatch): number {
  return priorityRank(a.priority) - priorityRank(b.priority)
    || Number(a.created_at ?? 0) - Number(b.created_at ?? 0)
    || a.id - b.id
}

/**
 * Which `assigned` tasks the next dispatch would move to `in_progress`.
 *
 * `all`: the legacy query (top 3 by priority, then age). `approved_only`: only eligible ids,
 * a listed task only when it is assigned to its approved owner, and no more than the free
 * WIP slots (3 minus everything already `in_progress`). `routed` adds the tasks the same
 * tick would route first (plan mode), as if already assigned.
 */
export function selectAssignedForDispatch(
  db: ReturnType<typeof getDatabase>,
  ctx: DispatchScopeContext,
  routed: Array<{ id: number; agent: string }> = [],
): { tasks: SelectedForDispatch[]; skipped: DispatchSkip[]; wip: DispatchWip } {
  const skipped: DispatchSkip[] = []
  if (ctx.held_reason || (ctx.eligible_ids && ctx.eligible_ids.size === 0)) {
    return { tasks: [], skipped, wip: { in_progress: 0, in_progress_total: countInProgress(db), max: APPROVED_ONLY_WIP_MAX, free: 0 } }
  }

  let rows: SelectedForDispatch[]
  if (ctx.eligible_ids === null) {
    rows = db.prepare(`${ASSIGNED_SELECT}${PRIORITY_ORDER_SQL} LIMIT ${DISPATCH_BATCH_LIMIT}`).all() as SelectedForDispatch[]
  } else {
    rows = db.prepare(`${ASSIGNED_SELECT} AND t.id IN (SELECT value FROM json_each(?))${PRIORITY_ORDER_SQL}`)
      .all(JSON.stringify([...ctx.eligible_ids])) as SelectedForDispatch[]
  }
  for (const row of rows) row.via = 'assigned'

  for (const r of routed) {
    const row = db.prepare(`
      SELECT t.*, a.name as agent_name, a.id as agent_id, a.config as agent_config,
             p.ticket_prefix, t.project_ticket_no
      FROM tasks t
      JOIN agents a ON a.name = ? AND a.workspace_id = t.workspace_id
      LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      WHERE t.id = ?
    `).get(r.agent, r.id) as SelectedForDispatch | undefined
    if (!row) continue
    rows.push({ ...row, status: 'assigned', assigned_to: r.agent, via: 'routed_this_tick' })
  }
  rows.sort(compareDispatchOrder)

  const eligible: SelectedForDispatch[] = []
  for (const row of rows) {
    if (isManagedComputeTask(row.metadata)) {
      skipped.push({ id: row.id, reason: 'managed_compute' })
      continue
    }
    const owner = ctx.listed_owners.get(row.id)
    if (owner !== undefined && row.assigned_to !== owner) {
      skipped.push({ id: row.id, reason: 'owner_mismatch', detail: `assigned to ${row.assigned_to}, approved owner ${owner}` })
      continue
    }
    eligible.push(row)
  }

  const total = countInProgress(db)
  if (ctx.eligible_ids === null) {
    return { tasks: eligible.slice(0, DISPATCH_BATCH_LIMIT), skipped, wip: { in_progress: total, in_progress_total: total, max: null, free: null } }
  }
  const inProgress = countInProgress(db, ctx.eligible_ids)
  const free = Math.max(0, APPROVED_ONLY_WIP_MAX - inProgress)
  const take = Math.min(free, DISPATCH_BATCH_LIMIT)
  for (const row of eligible.slice(take)) skipped.push({ id: row.id, reason: free === 0 ? 'wip_cap' : 'batch_limit' })
  return { tasks: eligible.slice(0, take), skipped, wip: { in_progress: inProgress, in_progress_total: total, max: APPROVED_ONLY_WIP_MAX, free } }
}

/**
 * Write the held line at most once per hour per reason (see dispatch-scope.ts).
 * Returns whether a line was written.
 */
function noteDispatchHeld(db: ReturnType<typeof getDatabase>, ctx: DispatchScopeContext): boolean {
  if (!ctx.held_reason || !isHeldActivityDue(db, ctx.held_reason, ctx.now)) return false
  db_helpers.logActivity(DISPATCH_HELD_ACTIVITY, 'system', 0, 'scheduler', describeHeld(ctx), {
    reason: ctx.held_reason,
    approved_state: ctx.approved.state,
    approved_date: ctx.approved.list?.date ?? null,
    approved_age_hours: ctx.approved.age_hours,
    max_age_hours: APPROVED_MAX_AGE_HOURS,
    problem: ctx.approved.problem,
  }, 1)
  return true
}

/** Is this task still dispatchable right now? Re-read before every claim (kill switch, list, WIP). */
function stillAllowed(
  db: ReturnType<typeof getDatabase>,
  taskId: number,
  opts: { wip: boolean; assignedTo?: string | null } = { wip: true },
): { ok: true } | { ok: false; stop: boolean; message: string } {
  const live = resolveDispatchScope(db)
  if (!live.enabled) return { ok: false, stop: true, message: DISPATCH_OFF_MESSAGE }
  if (live.held_reason) {
    noteDispatchHeld(db, live)
    return { ok: false, stop: true, message: describeHeld(live) }
  }
  if (live.eligible_ids !== null) {
    if (!live.eligible_ids.has(taskId)) return { ok: false, stop: false, message: `task ${taskId} is no longer approved` }
    const owner = live.listed_owners.get(taskId)
    if (opts.assignedTo !== undefined && owner !== undefined && opts.assignedTo !== owner) {
      return { ok: false, stop: false, message: `task ${taskId} is approved for ${owner}, not ${opts.assignedTo}` }
    }
    if (opts.wip && countInProgress(db, live.eligible_ids) >= APPROVED_ONLY_WIP_MAX) return { ok: false, stop: true, message: `WIP cap ${APPROVED_ONLY_WIP_MAX} reached` }
  }
  return { ok: true }
}

export async function dispatchAssignedTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const ctx = resolveDispatchScope(db)
  if (!ctx.enabled) return { ok: true, message: DISPATCH_OFF_MESSAGE }
  if (ctx.held_reason) {
    noteDispatchHeld(db, ctx)
    return { ok: true, message: describeHeld(ctx) }
  }

  const selection = selectAssignedForDispatch(db, ctx)
  const tasks = selection.tasks

  if (tasks.length === 0) {
    return {
      ok: true,
      message: selection.wip.free === 0 ? `WIP cap ${APPROVED_ONLY_WIP_MAX} reached; nothing dispatched` : 'No assigned tasks to dispatch',
    }
  }

  // Global backstop — leave the tasks in 'assigned' and stop rather than keep
  // spending once the 24h invocation ceiling is reached.
  const budgetBlock = assertAgentInvocationBudget('task_dispatch')
  if (budgetBlock) {
    return { ok: false, message: budgetBlock }
  }

  // Parse JSON tags column
  for (const task of tasks) {
    if (typeof task.tags === 'string') {
      try { task.tags = JSON.parse(task.tags as string) } catch { task.tags = undefined }
    }
  }

  const results: Array<{ id: number; success: boolean; error?: string }> = []
  const now = Math.floor(Date.now() / 1000)
  let stoppedBy: string | null = null

  for (const task of tasks) {
    // Account-bound work belongs to the capacity preflight and subscription runner.
    if (isManagedComputeTask(task.metadata)) continue
    // An earlier task in this batch may have run for minutes. The kill switch, the
    // approved list and the WIP cap are re-read right before every claim.
    const allowed = stillAllowed(db, task.id, { wip: true, assignedTo: task.assigned_to })
    if (!allowed.ok) {
      if (allowed.stop) { stoppedBy = allowed.message; break }
      continue
    }
    const resourcePolicy = resolveDispatchResourcePolicy(task.metadata)
    // Set once the task prompt may have reached the agent. From that point a
    // failure is AMBIGUOUS (the agent may be working) and must not auto-retry.
    let deliveryAttempted = false
    // Another dispatcher or editor may have changed this row while an earlier
    // task in our batch was running. Only the successful claimant may send or
    // record an invocation; use the same assignee and billing/routing metadata
    // that were selected, and recheck the compute boundary atomically.
    const claimed = db.prepare(`
      UPDATE tasks SET status = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status = ? AND assigned_to = ?
        AND metadata IS ?
        AND CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.compute_route') IS NULL ELSE 1 END
    `).run('in_progress', now, task.id, task.workspace_id, 'assigned', task.assigned_to,
      typeof task.metadata === 'object' && task.metadata !== null ? JSON.stringify(task.metadata) : task.metadata ?? null).changes
    if (!claimed) continue

    eventBus.broadcast('task.status_changed', {
      id: task.id,
      status: 'in_progress',
      previous_status: 'assigned',
    })

    db_helpers.logActivity(
      'task_dispatched',
      'task',
      task.id,
      'scheduler',
      `Dispatching task "${task.title}" to agent ${task.agent_name} in lane ${resourcePolicy.lane}`,
      {
        agent: task.agent_name,
        priority: task.priority,
        lane: resourcePolicy.lane,
        timeoutMs: resourcePolicy.timeoutMs,
        rateLimitKey: resourcePolicy.rateLimitKey,
      },
      task.workspace_id
    )

    recordAgentInvocation('task_dispatch', task.id)

    try {
      // Check for previous Aegis rejection feedback
      const rejectionRow = db.prepare(`
        SELECT content FROM comments
        WHERE task_id = ? AND author = 'aegis' AND content LIKE 'Quality Review Rejected:%'
        ORDER BY created_at DESC LIMIT 1
      `).get(task.id) as { content: string } | undefined
      const rejectionFeedback = rejectionRow?.content?.replace(/^Quality Review Rejected:\n?/, '') || null

      const prompt = buildTaskPrompt(task, rejectionFeedback)

      // Check if task has a target session specified in metadata
      const taskMeta = (() => {
        try {
          const row = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(task.id) as { metadata: string } | undefined
          return row?.metadata ? JSON.parse(row.metadata) : {}
        } catch { return {} }
      })()
      const targetSession: string | null = typeof taskMeta?.target_session === 'string' && taskMeta.target_session
        ? taskMeta.target_session
        : null

      let agentResponse: AgentResponseParsed
      const useDirectApi = !isGatewayAvailable() && getAnthropicApiKey()
        && allowsPaidApiFallback(task.metadata, process.env.MC_ALLOW_PAID_API_FALLBACK)
      const dispatchIdempotencyKey = resolveDispatchIdempotencyKey(db, task.id)

      if (useDirectApi && !targetSession) {
        // Direct Claude API dispatch — no gateway needed
        deliveryAttempted = true
        agentResponse = await callClaudeDirectly(task, prompt, resourcePolicy.timeoutMs)
      } else if (targetSession) {
        // Dispatch to a specific existing session via chat.send
        logger.info({ taskId: task.id, targetSession, agent: task.agent_name }, 'Dispatching task to targeted session')
        deliveryAttempted = true
        const sendResult = await callOpenClawGateway<any>(
          'chat.send',
          {
            sessionKey: targetSession,
            message: prompt,
            idempotencyKey: dispatchIdempotencyKey,
            deliver: false,
          },
          resourcePolicy.timeoutMs + 5_000,
        )
        const status = String(sendResult?.status || '').toLowerCase()
        if (status !== 'started' && status !== 'ok' && status !== 'in_flight') {
          throw new Error(`chat.send to session ${targetSession} returned status: ${status}`)
        }
        // chat.send is fire-and-forget; we record the session but won't get inline response text
        agentResponse = {
          text: `Task dispatched to existing session ${targetSession}. The agent will process it within that session context.`,
          sessionId: sendResult?.runId || targetSession,
        }
      } else {
        // Step 1: Invoke via gateway (new session)
        const gatewayAgentId = resolveGatewayAgentId(task)
        const dispatchModel = resolveTaskDispatchModelOverride(task)
        const invokeParams: Record<string, unknown> = {
          message: prompt,
          agentId: gatewayAgentId,
          idempotencyKey: dispatchIdempotencyKey,
          deliver: false,
        }
        // Route to appropriate model tier based on task complexity.
        // null = no override, agent uses its own configured default model.
        if (dispatchModel) invokeParams.model = dispatchModel

        // Use --expect-final to block until the agent completes and returns the full
        // response payload (result.payloads[0].text). The two-step agent → agent.wait
        // pattern only returns lifecycle metadata and never includes the agent's text.
        deliveryAttempted = true
        const finalResult = await runOpenClaw(
          ['gateway', 'call', 'agent', '--expect-final', '--timeout', String(resourcePolicy.timeoutMs), '--params', JSON.stringify(invokeParams), '--json'],
          { timeoutMs: resourcePolicy.timeoutMs + 5_000 }
        )
        const finalPayload = parseGatewayJson(finalResult.stdout)
          ?? parseGatewayJson(String((finalResult as any)?.stderr || ''))

        agentResponse = parseAgentResponse(
          finalPayload?.result ? JSON.stringify(finalPayload.result) : finalResult.stdout
        )
        if (!agentResponse.sessionId && finalPayload?.result?.meta?.agentMeta?.sessionId) {
          agentResponse.sessionId = finalPayload.result.meta.agentMeta.sessionId
        }
      } // end else (new session dispatch)

      if (!agentResponse.text) {
        throw new Error('Agent returned empty response')
      }

      const truncated = agentResponse.text.length > 10_000
        ? agentResponse.text.substring(0, 10_000) + '\n\n[Response truncated at 10,000 characters]'
        : agentResponse.text

      // Merge dispatch_session_id into existing metadata
      const existingMeta = (() => {
        try {
          const row = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(task.id) as { metadata: string } | undefined
          return row?.metadata ? JSON.parse(row.metadata) : {}
        } catch { return {} }
      })()
      if (agentResponse.sessionId) {
        existingMeta.dispatch_session_id = agentResponse.sessionId
      }

      // Update task: status → review, set outcome
      db.prepare(`
        UPDATE tasks SET status = ?, outcome = ?, resolution = ?, metadata = ?, updated_at = ? WHERE id = ?
      `).run('review', 'success', truncated, JSON.stringify(existingMeta), Math.floor(Date.now() / 1000), task.id)

      // Add a comment from the agent with the full response
      db.prepare(`
        INSERT INTO comments (task_id, author, content, created_at, workspace_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.agent_name,
        truncated,
        Math.floor(Date.now() / 1000),
        task.workspace_id
      )

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'review',
        previous_status: 'in_progress',
      })

      eventBus.broadcast('task.updated', {
        id: task.id,
        status: 'review',
        outcome: 'success',
        assigned_to: task.assigned_to,
        dispatch_session_id: agentResponse.sessionId,
      })
      syncAndEscalateIfFailed(task, 'review')

      db_helpers.logActivity(
        'task_agent_completed',
        'task',
        task.id,
        task.agent_name,
        `Agent completed task "${task.title}" — awaiting review`,
        { response_length: agentResponse.text.length, dispatch_session_id: agentResponse.sessionId },
        task.workspace_id
      )

      results.push({ id: task.id, success: true })
      logger.info({ taskId: task.id, agent: task.agent_name }, 'Task dispatched and completed')
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error'
      logger.error({ taskId: task.id, agent: task.agent_name, err }, 'Task dispatch failed')

      if (deliveryAttempted) {
        // AMBIGUOUS failure: the prompt may already have reached the agent
        // (timeout waiting for the final response, parse failure, empty
        // response). Auto-retrying here is what produced duplicate task
        // deliveries (P0-1). Park in awaiting_owner for triage instead.
        const nowTs = Math.floor(Date.now() / 1000)
        db.prepare('UPDATE tasks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
          .run('awaiting_owner', `Ambiguous dispatch failure (delivery attempted, outcome unknown): ${errorMsg.substring(0, 4000)}`, nowTs, task.id)
        db.prepare(`
          INSERT INTO comments (task_id, author, content, created_at, workspace_id)
          VALUES (?, 'scheduler', ?, ?, ?)
        `).run(task.id, `Dispatch outcome unknown after delivery attempt (lane ${resourcePolicy.lane}): ${errorMsg.substring(0, 500)}. Not auto-retried to avoid duplicate delivery — verify the agent session before requeueing.`, nowTs, task.workspace_id)
        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'awaiting_owner',
          previous_status: 'in_progress',
          error_message: errorMsg.substring(0, 500),
          reason: 'ambiguous_dispatch_failure',
        })
        syncAndEscalateIfFailed(task, 'awaiting_owner')
        db_helpers.logActivity(
          'task_dispatch_ambiguous',
          'task',
          task.id,
          'scheduler',
          `Ambiguous dispatch failure for "${task.title}" — parked in awaiting_owner: ${errorMsg.substring(0, 200)}`,
          { error: errorMsg.substring(0, 1000), lane: resourcePolicy.lane },
          task.workspace_id
        )
        results.push({ id: task.id, success: false, error: errorMsg.substring(0, 100) })
        continue
      }

      // Increment dispatch_attempts and decide next status
      const currentAttempts = (db.prepare('SELECT dispatch_attempts FROM tasks WHERE id = ?').get(task.id) as { dispatch_attempts: number } | undefined)?.dispatch_attempts ?? 0
      const { newAttempts, terminal } = resolveDispatchFailureStatus(currentAttempts, resourcePolicy)

      if (terminal) {
        // Too many failures — move to failed
        db.prepare(`UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ?, ${RELEASE_ACTIVE_CLAIM_ASSIGNMENTS} WHERE id = ?`)
          .run('failed', `Dispatch failed ${newAttempts} times. Last: ${errorMsg.substring(0, 5000)}`, newAttempts, Math.floor(Date.now() / 1000), task.id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'failed',
          previous_status: 'in_progress',
          error_message: `Dispatch failed ${newAttempts} times`,
          reason: 'max_dispatch_retries_exceeded',
        })
        syncAndEscalateIfFailed(task, 'failed', `Dispatch failed ${newAttempts} times`, newAttempts)
      } else {
        // Revert to assigned so it can be retried on the next tick
        db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
          .run('assigned', errorMsg.substring(0, 5000), newAttempts, Math.floor(Date.now() / 1000), task.id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'assigned',
          previous_status: 'in_progress',
          error_message: errorMsg.substring(0, 500),
          reason: 'dispatch_failed',
        })
        syncAndEscalateIfFailed(task, 'assigned')
      }

      db_helpers.logActivity(
        'task_dispatch_failed',
        'task',
        task.id,
        'scheduler',
        `Task dispatch failed for "${task.title}": ${errorMsg.substring(0, 200)}`,
        { error: errorMsg.substring(0, 1000) },
        task.workspace_id
      )

      results.push({ id: task.id, success: false, error: errorMsg.substring(0, 100) })
    }
  }

  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success)
  const failSummary = failed.length > 0
    ? ` (${failed.length} failed: ${failed.map(f => f.error).join('; ')})`
    : ''

  return {
    ok: failed.length === 0,
    message: `Dispatched ${succeeded}/${tasks.length} tasks${failSummary}${stoppedBy ? ` (stopped: ${stoppedBy})` : ''}`,
  }
}

// ---------------------------------------------------------------------------
// Auto-routing: assign inbox tasks to available agents
// ---------------------------------------------------------------------------

/** Role affinity mapping — which task keywords match which agent roles. */
const ROLE_AFFINITY: Record<string, string[]> = {
  coder: ['code', 'implement', 'build', 'fix', 'bug', 'test', 'unit test', 'refactor', 'feature', 'api', 'endpoint', 'function', 'class', 'module', 'component', 'deploy', 'ci', 'pipeline'],
  researcher: ['research', 'investigate', 'analyze', 'compare', 'find', 'discover', 'audit', 'review', 'survey', 'benchmark', 'evaluate', 'assess', 'competitor', 'market', 'trend'],
  reviewer: ['review', 'audit', 'check', 'verify', 'validate', 'quality', 'security', 'compliance', 'approve'],
  tester: ['test', 'qa', 'e2e', 'integration test', 'regression', 'coverage', 'verify', 'validate'],
  devops: ['deploy', 'infrastructure', 'ci', 'cd', 'docker', 'kubernetes', 'monitoring', 'pipeline', 'server', 'nginx', 'ssl'],
  assistant: ['write', 'draft', 'summarize', 'translate', 'format', 'document', 'docs', 'readme', 'email', 'message', 'report'],
  agent: [], // generic fallback
}

function scoreAgentForTask(
  agent: { name: string; role: string; status: string; config: string | null },
  taskText: string,
): number {
  // Offline agents can't take work
  if (agent.status === 'offline' || agent.status === 'error' || agent.status === 'sleeping') return -1

  const text = taskText.toLowerCase()
  const keywords = ROLE_AFFINITY[agent.role] || []

  let score = 0
  // Role keyword match
  for (const kw of keywords) {
    if (text.includes(kw)) score += 10
  }

  // Idle agents get a bonus (prefer agents not currently busy)
  if (agent.status === 'idle') score += 5

  // Check agent capabilities from config
  if (agent.config) {
    try {
      const cfg = JSON.parse(agent.config)
      const caps = Array.isArray(cfg.capabilities) ? cfg.capabilities : []
      for (const cap of caps) {
        if (typeof cap === 'string' && text.includes(cap.toLowerCase())) score += 15
      }
    } catch { /* ignore */ }
  }

  // Any non-offline agent gets at least 1 (can be a fallback)
  return Math.max(score, 1)
}

type InboxRow = { id: number; title: string; description: string | null; priority: string; tags: string | null; workspace_id: number; metadata: string | null }
type RoutableAgent = { id: number; name: string; role: string; status: string; config: string | null; workspace_id: number }
export interface RouteDecision { task: InboxRow; agent: RoutableAgent; score: number; via: 'owner' | 'score' | 'score_alternate' }

const AGENT_IN_PROGRESS_CAP = 3

/**
 * Which inbox tasks the next tick would route, and to whom. Pure read, shared by
 * autoRouteInboxTasks() and the plan. A task the morning meeting listed goes to its
 * approved owner or nowhere; every other eligible task (scope `all`, or an
 * `outcome_task_id` child) is scored as before F2.
 */
export function planInboxRouting(
  db: ReturnType<typeof getDatabase>,
  ctx: DispatchScopeContext,
): { inbox: InboxRow[]; agentsAvailable: number; decisions: RouteDecision[]; skipped: DispatchSkip[] } {
  const skipped: DispatchSkip[] = []
  if (ctx.held_reason || (ctx.eligible_ids && ctx.eligible_ids.size === 0)) {
    return { inbox: [], agentsAvailable: 0, decisions: [], skipped }
  }

  const scoped = ctx.eligible_ids !== null
  const inboxTasks = db.prepare(`
    SELECT id, title, description, priority, tags, workspace_id, metadata
    FROM tasks
    WHERE status = 'inbox' AND assigned_to IS NULL
      AND CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.compute_route') IS NULL ELSE 1 END
      ${scoped ? 'AND id IN (SELECT value FROM json_each(?))' : ''}
    ORDER BY
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
      created_at ASC, id ASC
    ${scoped ? '' : `LIMIT ${ROUTE_BATCH_LIMIT}`}
  `).all(...(scoped ? [JSON.stringify([...ctx.eligible_ids!])] : [])) as InboxRow[]

  if (inboxTasks.length === 0) return { inbox: [], agentsAvailable: 0, decisions: [], skipped }

  // Get all non-hidden, non-offline agents
  const agents = db.prepare(`
    SELECT id, name, role, status, config, workspace_id
    FROM agents
    WHERE hidden = 0 AND status NOT IN ('offline', 'error')
  `).all() as RoutableAgent[]

  if (agents.length === 0) {
    for (const t of inboxTasks) skipped.push({ id: t.id, reason: 'no_available_agents' })
    return { inbox: inboxTasks, agentsAvailable: 0, decisions: [], skipped }
  }

  const inProgressOf = (name: string, workspaceId: number) => (db.prepare(
    'SELECT COUNT(*) as c FROM tasks WHERE assigned_to = ? AND status = \'in_progress\' AND workspace_id = ?'
  ).get(name, workspaceId) as { c: number }).c

  const decisions: RouteDecision[] = []
  for (const task of inboxTasks) {
    if (isManagedComputeTask(task.metadata)) {
      skipped.push({ id: task.id, reason: 'managed_compute' })
      continue
    }
    const taskText = `${task.title} ${task.description || ''}`
    let parsedTags: string[] = []
    if (task.tags) {
      try { parsedTags = JSON.parse(task.tags) } catch { /* ignore */ }
    }
    const fullText = `${taskText} ${parsedTags.join(' ')}`

    const owner = ctx.listed_owners.get(task.id)
    if (owner !== undefined) {
      const agent = agents.find(a => a.name === owner && a.workspace_id === task.workspace_id)
      const score = agent ? scoreAgentForTask(agent, fullText) : -1
      if (!agent || score <= 0) {
        skipped.push({ id: task.id, reason: 'owner_not_available', detail: `approved owner ${owner} is not an available MC agent in this workspace` })
        continue
      }
      if (inProgressOf(agent.name, task.workspace_id) >= AGENT_IN_PROGRESS_CAP) {
        skipped.push({ id: task.id, reason: 'owner_at_capacity', detail: owner })
        continue
      }
      decisions.push({ task, agent, score, via: 'owner' })
      continue
    }

    // Score each agent
    const scored = agents
      .filter(a => a.workspace_id === task.workspace_id)
      .map(a => ({ agent: a, score: scoreAgentForTask(a, fullText) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    if (scored.length === 0) {
      skipped.push({ id: task.id, reason: 'no_suitable_agent' })
      continue
    }

    // Check capacity — skip agents with 3+ in-progress tasks
    if (inProgressOf(scored[0].agent.name, task.workspace_id) >= AGENT_IN_PROGRESS_CAP) {
      // Try next best agent
      const alt = scored.find(s => inProgressOf(s.agent.name, task.workspace_id) < AGENT_IN_PROGRESS_CAP)
      if (!alt) {
        skipped.push({ id: task.id, reason: 'agents_at_capacity' })
        continue
      }
      decisions.push({ task, agent: alt.agent, score: alt.score, via: 'score_alternate' })
      continue
    }
    decisions.push({ task, agent: scored[0].agent, score: scored[0].score, via: 'score' })
  }
  // Under approved_only every eligible inbox task is read (the set is small), so an
  // unroutable child cannot hold a slot; the per-tick limit applies to the decisions.
  if (scoped && decisions.length > ROUTE_BATCH_LIMIT) {
    for (const d of decisions.splice(ROUTE_BATCH_LIMIT)) skipped.push({ id: d.task.id, reason: 'route_batch_limit' })
  }
  return { inbox: inboxTasks, agentsAvailable: agents.length, decisions, skipped }
}

/**
 * Auto-route inbox tasks to the best available agent.
 * Runs before dispatch — moves tasks from inbox → assigned.
 * Under `approved_only` only approved tasks move, and a listed one only to its owner.
 */
export async function autoRouteInboxTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const ctx = resolveDispatchScope(db)
  if (!ctx.enabled) return { ok: true, message: DISPATCH_OFF_MESSAGE }
  if (ctx.held_reason) {
    noteDispatchHeld(db, ctx)
    return { ok: true, message: describeHeld(ctx) }
  }

  const plan = planInboxRouting(db, ctx)
  const inboxCount = plan.inbox.length

  if (inboxCount === 0) {
    return { ok: true, message: 'No inbox tasks to route' }
  }

  if (plan.agentsAvailable === 0) {
    return { ok: true, message: `${inboxCount} inbox task(s) but no available agents` }
  }

  let routed = 0
  const now = Math.floor(Date.now() / 1000)

  for (const { task, agent, score, via } of plan.decisions) {
    const allowed = stillAllowed(db, task.id, { wip: false, assignedTo: via === 'owner' ? agent.name : undefined })
    if (!allowed.ok) {
      if (allowed.stop) break
      continue
    }
    const changed = db.prepare('UPDATE tasks SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = ? AND assigned_to IS NULL')
      .run('assigned', agent.name, now, task.id, task.workspace_id, 'inbox').changes
    if (!changed) continue

    db_helpers.logActivity('task_auto_routed', 'task', task.id, 'scheduler',
      via === 'owner'
        ? `Auto-assigned "${task.title}" to ${agent.name}, the owner approved by the morning meeting`
        : `Auto-assigned "${task.title}" to ${agent.name} (${agent.role}, score: ${score})`,
      { agent: agent.name, role: agent.role, score, via },
      task.workspace_id)

    eventBus.broadcast('task.status_changed', { id: task.id, status: 'assigned', previous_status: 'inbox', assigned_to: agent.name })
    syncAndEscalateIfFailed(task as any, 'assigned')
    routed++
  }

  return {
    ok: true,
    message: routed > 0
      ? `Auto-routed ${routed}/${inboxCount} inbox task(s)`
      : `${inboxCount} inbox task(s), no suitable agents found`,
  }
}

// ---------------------------------------------------------------------------
// Plan mode: what the next tick would do, without doing it
// ---------------------------------------------------------------------------

export interface DispatchPlan {
  generated_at: number
  dispatch_enabled: boolean
  scope: DispatchScopeContext['scope']
  scope_setting: string | null
  approved: {
    state: DispatchScopeContext['approved']['state']
    date: string | null
    approved_at: number | null
    age_hours: number | null
    max_age_hours: number
    problem: string | null
    outcomes: Array<{ task_id: number; owner: string; outcome: string }>
    children: Array<{ task_id: number; outcome_task_id: number }>
    capped_children: number[]
  }
  held_reason: DispatchScopeContext['held_reason']
  /** The activity line a held tick writes, and whether the next tick would write it (rate limit). */
  held_activity: { type: string; description: string; due: boolean } | null
  wip: DispatchWip
  /** The 24 h agent-invocation ceiling dispatch also obeys. */
  budget: { used: number; cap: number; exceeded: boolean }
  route: Array<{ id: number; title: string; priority: string; to: string; via: RouteDecision['via'] }>
  dispatch: Array<{ id: number; title: string; priority: string; assigned_to: string; via: string }>
  not_selected: DispatchSkip[]
  next_tick: { runs: boolean; would_route: number; would_dispatch: number }
}

/** Read-only: no row, setting or activity is written. */
export function planDispatch(db: ReturnType<typeof getDatabase> = getDatabase()): DispatchPlan {
  const ctx = resolveDispatchScope(db)
  const routing = planInboxRouting(db, ctx)
  const dispatch = selectAssignedForDispatch(db, ctx, routing.decisions.map(d => ({ id: d.task.id, agent: d.agent.name })))

  const notSelected: DispatchSkip[] = [...routing.skipped, ...dispatch.skipped]
  const accounted = new Set<number>([
    ...routing.decisions.map(d => d.task.id),
    ...dispatch.tasks.map(t => t.id),
    ...notSelected.map(s => s.id),
  ])
  if (ctx.eligible_ids) {
    for (const id of ctx.eligible_ids) {
      if (accounted.has(id)) continue
      const row = db.prepare(`
        SELECT t.status, t.assigned_to, a.name AS agent
        FROM tasks t LEFT JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
        WHERE t.id = ?`).get(id) as { status: string; assigned_to: string | null; agent: string | null } | undefined
      if (!row) notSelected.push({ id, reason: 'task_not_found' })
      else if (isManagedComputeTask((db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(id) as { metadata: string | null }).metadata)) notSelected.push({ id, reason: 'managed_compute' })
      else if (row.status === 'inbox' && row.assigned_to) notSelected.push({ id, reason: 'inbox_already_assigned', detail: `assigned to ${row.assigned_to}; set status=assigned for MC dispatch` })
      else if (row.status === 'assigned' && !row.agent) notSelected.push({ id, reason: 'assignee_not_an_mc_agent', detail: row.assigned_to ?? '' })
      else if (row.status === 'inbox') notSelected.push({ id, reason: 'route_batch_limit' })
      else if (row.status !== 'assigned') notSelected.push({ id, reason: `status_${row.status}` })
      else notSelected.push({ id, reason: 'not_selected' })
    }
  }

  const runs = ctx.enabled && !ctx.held_reason
  const list = ctx.approved.list
  const budget = readAgentInvocationBudget(db)
  return {
    generated_at: ctx.now,
    dispatch_enabled: ctx.enabled,
    scope: ctx.scope,
    scope_setting: ctx.scope_setting,
    approved: {
      state: ctx.approved.state,
      date: list?.date ?? null,
      approved_at: list?.approved_at ?? null,
      age_hours: ctx.approved.age_hours,
      max_age_hours: APPROVED_MAX_AGE_HOURS,
      problem: ctx.approved.problem,
      outcomes: list?.outcomes ?? [],
      children: [...ctx.children].map(([task_id, outcome_task_id]) => ({ task_id, outcome_task_id })),
      capped_children: ctx.capped_children,
    },
    held_reason: ctx.held_reason,
    held_activity: ctx.held_reason
      ? { type: DISPATCH_HELD_ACTIVITY, description: describeHeld(ctx), due: ctx.enabled && isHeldActivityDue(db, ctx.held_reason, ctx.now) }
      : null,
    wip: dispatch.wip,
    budget,
    route: routing.decisions.map(d => ({ id: d.task.id, title: d.task.title, priority: d.task.priority, to: d.agent.name, via: d.via })),
    dispatch: dispatch.tasks.map(t => ({ id: t.id, title: t.title, priority: t.priority, assigned_to: t.assigned_to, via: t.via ?? 'assigned' })),
    not_selected: notSelected,
    next_tick: { runs, would_route: runs ? routing.decisions.length : 0, would_dispatch: runs && !budget.exceeded ? dispatch.tasks.length : 0 },
  }
}
