import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDatabase } from './db'
import { computeMutationSchema, type ComputeMutation } from './compute-validation'
import { scanForSecrets } from './secret-scanner'
import type { ComputeAccountDefinition, ComputeBindingDefinition, ComputePoolDefinition, ComputeObservationInput, ComputeOverview, ComputeFreshness, ComputePool, ComputeBinding, ComputeAccount, ComputeWindow, ComputePoolStatus } from './compute-types'

type Table = 'compute_accounts' | 'compute_pools' | 'compute_bindings'
type StoredObservation = ComputeObservationInput & { bindingConfigHash?: string }
export class ComputeInputError extends Error { constructor(message: string, public status = 400) { super(message) } }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const iso = (now: number) => new Date(now).toISOString()
export function computeFreshness(observedAt: string | null, now: number): ComputeFreshness {
  if (!observedAt || !Number.isFinite(Date.parse(observedAt))) return 'unknown'
  const age = now - Date.parse(observedAt)
  return age > 24 * 60 * 60_000 ? 'stale' : age > 15 * 60_000 ? 'refresh_due' : 'fresh'
}
function definition<T>(db: Database.Database, table: Table, workspaceId: number, id: string): T | null {
  const row = db.prepare(`SELECT definition FROM ${table} WHERE workspace_id=? AND id=?`).get(workspaceId, id) as { definition: string } | undefined
  return row ? JSON.parse(row.definition) as T : null
}
function allDefinitions<T>(db: Database.Database, table: Table, workspaceId: number): T[] {
  return (db.prepare(`SELECT definition FROM ${table} WHERE workspace_id=? ORDER BY id`).all(workspaceId) as { definition: string }[]).map(row => JSON.parse(row.definition) as T)
}
function required<T>(db: Database.Database, table: Table, workspaceId: number, id: string): T {
  const result = definition<T>(db, table, workspaceId, id)
  if (!result) throw new ComputeInputError('Referenced capacity record was not found in this workspace', 404)
  return result
}
function observations(db: Database.Database, workspaceId: number, kind: string, subjectId: string): StoredObservation[] {
  // Full history is durable; the projection needs only latest attempt + latest successful snapshot.
  const query = 'SELECT payload FROM compute_observations WHERE workspace_id=? AND kind=? AND subject_id=?'
  const order = ' ORDER BY observed_at DESC,created_at DESC,rowid DESC LIMIT 1'
  const latest = db.prepare(query + order).get(workspaceId, kind, subjectId) as { payload: string } | undefined
  const good = db.prepare(query + " AND json_extract(payload,'$.status')='success'" + order).get(workspaceId, kind, subjectId) as { payload: string } | undefined
  return [latest, good].filter((row): row is { payload: string } => !!row).map(row => JSON.parse(row.payload))
}
function subject(input: ComputeObservationInput): string {
  return input.kind === 'collector' ? 'collector' : input.kind === 'quota' ? input.poolId : input.kind === 'access' ? input.bindingId || `account:${input.accountId}` : input.accountId
}
function poolDefinitionCompatible(before: ComputePoolDefinition, after: ComputePoolDefinition): boolean {
  return before.accountId === after.accountId && canonical(before.modelIds.slice().sort()) === canonical(after.modelIds.slice().sort()) && before.windowKeys.every(key => after.windowKeys.includes(key))
}

export function mutateCompute(raw: unknown, workspaceId: number, db: Database.Database = getDatabase(), now = Date.now()) {
  const parsed = computeMutationSchema.safeParse(raw)
  if (!parsed.success) throw new ComputeInputError('Invalid capacity payload: ' + parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).slice(0, 3).join('; '))
  if (scanForSecrets(JSON.stringify(raw)).length) throw new ComputeInputError('Remove credentials from capacity evidence', 422)
  const input: ComputeMutation = parsed.data
  return db.transaction(() => {
    if (input.action !== 'record_observation') {
      const item = input.action === 'upsert_account' ? input.account : input.action === 'upsert_pool' ? input.pool : input.binding
      const table: Table = input.action === 'upsert_account' ? 'compute_accounts' : input.action === 'upsert_pool' ? 'compute_pools' : 'compute_bindings'
      const previous = definition<ComputeAccountDefinition & ComputePoolDefinition & ComputeBindingDefinition>(db, table, workspaceId, item.id)
      if ('accountId' in item) {
        required(db, 'compute_accounts', workspaceId, item.accountId)
        if (previous && previous.accountId !== item.accountId) throw new ComputeInputError('A capacity record cannot move to another account', 409)
      }
      if (input.action === 'upsert_account' && previous && previous.identityFingerprint !== input.account.identityFingerprint) {
        const evidence = db.prepare('SELECT 1 FROM compute_observations WHERE workspace_id=? AND account_id=? LIMIT 1').get(workspaceId, item.id)
        if (evidence) throw new ComputeInputError('Create a new account ID for a changed identity after observations exist', 409)
      }
      if (input.action === 'upsert_pool' && previous && !poolDefinitionCompatible(previous, input.pool)) throw new ComputeInputError('Existing quota scopes and required windows cannot be removed; register a new pool explicitly', 409)
      if (input.action === 'upsert_binding') {
        for (const poolId of input.binding.poolIds) {
          const pool = required<ComputePoolDefinition>(db, 'compute_pools', workspaceId, poolId)
          if (pool.accountId !== input.binding.accountId) throw new ComputeInputError('A binding may reference only its own account pools', 409)
        }
        if (input.binding.modelCapabilities.some(model => model.verifiedAt && Date.parse(model.verifiedAt) > now + 60_000)) throw new ComputeInputError('Model verification cannot be in the future')
      }
      if ('accountId' in item) db.prepare(`INSERT INTO ${table}(workspace_id,id,account_id,definition,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET definition=excluded.definition,updated_at=excluded.updated_at`).run(workspaceId, item.id, item.accountId, JSON.stringify(item), now)
      else db.prepare('INSERT INTO compute_accounts(workspace_id,id,definition,updated_at) VALUES(?,?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET definition=excluded.definition,updated_at=excluded.updated_at').run(workspaceId, item.id, JSON.stringify(item), now)
      return { saved: true, id: item.id }
    }
    const observation: StoredObservation = { ...input.observation }
    if (Date.parse(observation.observedAt) > now + 60_000) throw new ComputeInputError('Observations cannot be in the future')
    const bodyHash = hash(input.observation)
    const replay = db.prepare('SELECT body_hash,payload FROM compute_observations WHERE workspace_id=? AND external_id=?').get(workspaceId, observation.externalId) as { body_hash: string; payload: string } | undefined
    if (replay) {
      if (replay.body_hash !== bodyHash) throw new ComputeInputError('Observation ID already contains different evidence', 409)
      return { created: false, externalId: observation.externalId, status: JSON.parse(replay.payload).status }
    }
    if (observation.kind !== 'collector') required(db, 'compute_accounts', workspaceId, observation.accountId)
    if (observation.kind === 'quota') {
      const pool = required<ComputePoolDefinition>(db, 'compute_pools', workspaceId, observation.poolId)
      if (pool.accountId !== observation.accountId) throw new ComputeInputError('Quota observation belongs to another account', 409)
      if (observation.status === 'success' && observation.windows.some(window => !pool.windowKeys.includes(window.key))) throw new ComputeInputError('Register new quota window keys before importing them')
      if (observation.status === 'success' && pool.windowKeys.some(key => !observation.windows.some(window => window.key === key))) {
        observation.status = 'failed'; observation.error = 'Incomplete quota snapshot: required windows are missing'
      }
    }
    if (observation.kind === 'access' && observation.bindingId) {
      const binding = required<ComputeBindingDefinition>(db, 'compute_bindings', workspaceId, observation.bindingId)
      if (binding.accountId !== observation.accountId) throw new ComputeInputError('Access observation belongs to another account', 409)
      observation.bindingConfigHash = hash(binding)
    }
    if (observation.kind === 'collector' && observation.enabled && (!observation.jobRef || !observation.intervalHours || !observation.nextDueAt)) throw new ComputeInputError('An enabled collector requires an actual job reference, interval and next run evidence')
    db.prepare('INSERT INTO compute_observations(workspace_id,external_id,account_id,kind,subject_id,observed_at,created_at,body_hash,payload) VALUES(?,?,?,?,?,?,?,?,?)').run(workspaceId, observation.externalId, observation.kind === 'collector' ? null : observation.accountId, observation.kind, subject(observation), Date.parse(observation.observedAt), now, bodyHash, JSON.stringify(observation))
    return { created: true, externalId: observation.externalId, status: observation.status }
  })()
}

function normalizeWindow(window: Extract<ComputeObservationInput, { kind: 'quota' }>['windows'][number], observation: ComputeObservationInput, now: number): ComputeWindow {
  const usedPercent = window.usedPercent ?? (window.remainingPercent != null ? 100 - window.remainingPercent : window.limit && window.used != null ? Math.min(100, window.used / window.limit * 100) : null)
  return { ...window, usedPercent, remainingPercent: usedPercent == null ? null : Math.max(0, 100 - usedPercent), limit: window.limit ?? null, used: window.used ?? null, observedAt: observation.observedAt, source: observation.source, freshness: computeFreshness(observation.observedAt, now) }
}
function projectPool(pool: ComputePoolDefinition, history: StoredObservation[], now: number): ComputePool {
  const latest = history[0]
  const good = history.find(row => row.status === 'success' && row.kind === 'quota' && pool.windowKeys.every(key => row.windows.some(window => window.key === key)))
  const windows = good?.kind === 'quota' ? good.windows.map(window => normalizeWindow(window, good, now)) : []
  const remaining = windows.length && windows.every(window => window.remainingPercent !== null) ? Math.min(...windows.map(window => window.remainingPercent!)) : null
  const freshness = computeFreshness(latest?.observedAt || null, now)
  let status: ComputePoolStatus = !latest ? 'unknown' : latest.status !== 'success' ? 'unavailable' : !good || remaining == null ? 'unknown'
    : windows.some(window => window.resetsAt && Date.parse(window.resetsAt) <= now) ? 'reset_unconfirmed'
    : freshness === 'stale' ? 'stale' : freshness !== 'fresh' ? 'refresh_required' : remaining <= 0 ? 'exhausted' : 'ready'
  if (latest?.kind === 'quota' && pool.windowKeys.some(key => !latest.windows.some(window => window.key === key))) status = 'unavailable'
  return { ...pool, windows, effectiveRemainingPercent: remaining, status, observedAt: latest?.observedAt || null, lastGoodObservedAt: good?.observedAt || null, source: latest?.source || null,
    observationId: latest?.externalId || null, lastObservationStatus: latest?.status || null, error: latest?.error || null }
}
function verifiedIdentity(account: ComputeAccountDefinition, row?: StoredObservation, allowBrowserAccount = false): boolean {
  if (row?.kind !== 'access') return false
  const trustedSource = ['provider_api', 'cli'].includes(row.source.kind)
    || (allowBrowserAccount && !row.bindingId && row.source.kind === 'browser')
  return !!(row.status === 'success' && trustedSource && row.identityVerified && account.identityFingerprint && row.identityFingerprint === account.identityFingerprint)
}
export function readComputeOverview(workspaceId: number, db: Database.Database = getDatabase(), now = Date.now()): ComputeOverview {
  const accountDefinitions = allDefinitions<ComputeAccountDefinition>(db, 'compute_accounts', workspaceId)
  const poolDefinitions = allDefinitions<ComputePoolDefinition>(db, 'compute_pools', workspaceId)
  const bindingDefinitions = allDefinitions<ComputeBindingDefinition>(db, 'compute_bindings', workspaceId)
  const pools = poolDefinitions.map(pool => projectPool(pool, observations(db, workspaceId, 'quota', pool.id), now))
  const bindings: ComputeBinding[] = bindingDefinitions.map(binding => {
    const latest = observations(db, workspaceId, 'access', binding.id)[0]
    const account = accountDefinitions.find(item => item.id === binding.accountId)!
    const matches = latest?.bindingConfigHash === hash(binding)
    const identity = matches && verifiedIdentity(account, latest)
    return { ...binding, identityStatus: !latest ? 'unknown' : identity ? 'verified' : 'unverified',
      entitlementStatus: !latest ? 'unknown' : identity && latest.kind === 'access' && latest.entitlementVerified ? 'verified' : 'unverified',
      verifiedAt: latest?.observedAt || null, verificationFreshness: computeFreshness(latest?.observedAt || null, now), source: latest?.source || null, observationId: latest?.externalId || null }
  })
  const accounts: ComputeAccount[] = accountDefinitions.map(account => {
    const latest = observations(db, workspaceId, 'access', `account:${account.id}`)[0]
    const accountBindings = bindings.filter(binding => binding.accountId === account.id)
    const reset = observations(db, workspaceId, 'reset', account.id)[0]
    // Account identity may be confirmed in a browser; executable harness access still requires its own CLI/API evidence.
    const identityCurrent = verifiedIdentity(account, latest, true) && computeFreshness(latest?.observedAt || null, now) !== 'stale'
    const bindingIdentityCurrent = accountBindings.some(binding => binding.identityStatus === 'verified' && ['fresh', 'refresh_due'].includes(binding.verificationFreshness))
    const bindingEvidence = accountBindings.filter(binding => binding.identityStatus === 'verified' && binding.verifiedAt)
      .sort((a, b) => Date.parse(b.verifiedAt!) - Date.parse(a.verifiedAt!))[0]
    return { ...account, pools: pools.filter(pool => pool.accountId === account.id),
      status: !account.enabled ? 'disabled' : latest?.status === 'login_required' ? 'login_required' : latest?.status === 'failed' ? 'unavailable' : identityCurrent || bindingIdentityCurrent ? 'ready' : 'unknown',
      observedAt: latest ? latest.observedAt : bindingEvidence?.verifiedAt || null, source: latest ? latest.source : bindingEvidence?.source || null,
      resetCredits: reset?.kind === 'reset' ? { available: reset.status === 'success' && reset.event === 'availability' ? reset.available : null, observedAt: reset.observedAt, source: reset.source, freshness: computeFreshness(reset.observedAt, now), event: reset.event } : null }
  })
  const collectorHistory = observations(db, workspaceId, 'collector', 'collector')
  const collector = collectorHistory[0]
  return { asOf: iso(now), accounts, bindings, warnings: accounts.length ? [] : ['No private capacity accounts have been registered.'],
    refresh: collector?.kind === 'collector' ? { enabled: collector.enabled, intervalHours: collector.intervalHours, lastAttemptAt: collector.observedAt, lastSuccessAt: collectorHistory.find(row => row.status === 'success')?.observedAt || null,
      nextDueAt: collector.enabled ? collector.nextDueAt : null, status: collector.status, ...(collector.error ? { lastError: collector.error } : {}) }
      : { enabled: false, intervalHours: null, lastAttemptAt: null, lastSuccessAt: null, nextDueAt: null, status: 'not_configured' } }
}
