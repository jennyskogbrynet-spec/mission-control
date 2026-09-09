// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
vi.mock('@/lib/compute-store', () => ({ readComputeOverview: vi.fn() }))
import { SubscriptionRunManager, claudeAnalysisArgs, parseClaudeSubscriptionResult, subscriptionEnvironment, subscriptionRunSchema } from '../subscription-runs'
import type { ComputeOverview } from '../compute-types'

let folder: string
const email = 'fixture@example.test'
const fingerprint = createHash('sha256').update(email).digest('hex')
const now = Date.parse('2026-09-08T12:00:00Z')
const observation = randomUUID()
const binding = { bindingId: 'fixture', accountId: 'account-fixture', runtimeId: 'claude-code' as const, executable: '/fixture/claude', identityFingerprint: fingerprint, modelIds: ['fixture-model'] }
function overview(): ComputeOverview {
  return { asOf: new Date(now).toISOString(), warnings: [], refresh: { enabled: false, intervalHours: null, lastAttemptAt: null, lastSuccessAt: null, nextDueAt: null, status: 'not_configured' },
    accounts: [{ id: 'account-fixture', label: 'Fixture', provider: 'anthropic', plan: 'Max', billingMode: 'subscription', enabled: true, identityFingerprint: fingerprint, status: 'ready', observedAt: new Date(now).toISOString(), source: null, resetCredits: null,
      pools: [{ id: 'pool', accountId: 'account-fixture', key: 'general', label: 'General', modelIds: [], windowKeys: ['weekly'], windows: [], effectiveRemainingPercent: 80, status: 'ready', observedAt: new Date(now).toISOString(), lastGoodObservedAt: null, source: null, observationId: observation, lastObservationStatus: 'success', error: null }] }],
    bindings: [{ id: 'fixture', accountId: 'account-fixture', runtimeId: 'claude-code', profileRef: 'default', modelIds: ['fixture-model'], capabilities: ['analysis'], poolIds: ['pool'], dataClasses: ['public'], enabled: true,
      modelCapabilities: [{ modelId: 'fixture-model', tier: 'fast', capabilities: ['analysis'], notes: '', verifiedAt: new Date(now).toISOString(), evidence: 'fixture' }], identityStatus: 'verified', entitlementStatus: 'verified', verifiedAt: new Date(now).toISOString(), verificationFreshness: 'fresh', source: null, observationId: observation }] }
}
function fixture() {
  const child = Object.assign(new EventEmitter(), { pid: undefined, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) })
  const launch = vi.fn((_command: string, _args: string[]) => child)
  const probe = vi.fn(() => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email }) }))
  const state = overview()
  const deps = { root: folder, overview: () => state, launchBindings: () => [binding], now: () => now, spawn: launch as never, probe: probe as never, alive: () => false }
  const manager = new SubscriptionRunManager(deps)
  const input = { idempotencyKey: randomUUID(), projectId: 2, bindingId: 'fixture', modelId: 'fixture-model', prompt: 'Find a flaw in the supplied plan.', difficulty: 'routine' as const, dataClass: 'public' as const }
  return { child, launch, probe, state, deps, manager, input }
}
beforeEach(() => { folder = mkdtempSync(path.join(tmpdir(), 'mc-runs-test-')) })
afterEach(() => { vi.useRealTimers(); rmSync(folder, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('subscription packet analysis', () => {
  it('uses exact model/session and disables tools, customization and MCP without changing auth', () => {
    const args = claudeAnalysisArgs('fixture-model', randomUUID())
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args).toEqual(expect.arrayContaining(['--safe-mode', '--strict-mcp-config', '--no-chrome', '--disable-slash-commands', '--max-turns', '8']))
    expect(args).not.toContain('--bare')
    vi.stubEnv('ANTHROPIC_API_KEY', 'private'); vi.stubEnv('ANTHROPIC_BASE_URL', 'https://untrusted.example'); vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'private')
    expect(subscriptionEnvironment('fixture-model')).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(subscriptionEnvironment('fixture-model')).not.toHaveProperty('ANTHROPIC_BASE_URL')
    expect(subscriptionEnvironment('fixture-model')).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
    vi.unstubAllEnvs()
  })
  it('pins background requests to the selected model in the actual child environment', () => {
    vi.stubEnv('ANTHROPIC_DEFAULT_HAIKU_MODEL', 'claude-haiku-4-5-20251001')
    vi.stubEnv('ANTHROPIC_SMALL_FAST_MODEL', 'another-inherited-model')
    vi.stubEnv('ANTHROPIC_API_KEY', 'private')
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://untrusted.example')
    const f = fixture()
    const selectedEnvironment = subscriptionEnvironment(f.input.modelId)
    expect(selectedEnvironment.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(f.input.modelId)
    expect(selectedEnvironment).not.toHaveProperty('ANTHROPIC_SMALL_FAST_MODEL')
    expect(selectedEnvironment).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(selectedEnvironment).not.toHaveProperty('ANTHROPIC_BASE_URL')
    f.manager.start(f.input, 1)
    expect(f.probe).toHaveBeenCalledWith(binding.executable, expect.any(Array), expect.objectContaining({ env: selectedEnvironment }))
    expect(f.launch).toHaveBeenCalledWith(binding.executable, expect.any(Array), expect.objectContaining({ env: selectedEnvironment }))
    expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001')
    expect(process.env.ANTHROPIC_SMALL_FAST_MODEL).toBe('another-inherited-model')
    // A later CLI regression must still fail honestly even when only the
    // auxiliary request used an unexpected model; never hide that usage row.
    const run = f.manager.get(f.input.idempotencyKey, 1)!
    f.child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: run.sessionId,
      result: 'Report', modelUsage: { 'fixture-model': {}, 'claude-haiku-4-5-20251001': {} } }))
    f.child.emit('close', 0)
    expect(f.manager.get(run.id, 1)).toMatchObject({ status: 'failed', observedModel: null,
      observedModels: ['fixture-model', 'claude-haiku-4-5-20251001'], error: expect.stringContaining('differs') })
  })
  it('rejects arbitrary commands, paths, restricted data and oversized prompts', () => {
    const { input } = fixture()
    for (const extra of [{ cwd: '/etc' }, { executable: '/bin/sh' }, { environment: {} }, { dataClass: 'restricted' }, { prompt: 'x'.repeat(12_001) }]) {
      expect(subscriptionRunSchema.safeParse({ ...input, ...extra }).success).toBe(false)
    }
  })
  it('persists identity before launch and completes only from an exact terminal session receipt', () => {
    const f = fixture()
    f.launch.mockImplementationOnce(() => {
      expect(JSON.parse(readFileSync(path.join(folder, `${f.input.idempotencyKey}.json`), 'utf8')).status).toBe('running')
      return f.child
    })
    const started = f.manager.start(f.input, 1)
    expect(started.status).toBe('running'); expect(started).not.toHaveProperty('ownerPid')
    expect(f.launch.mock.calls[0][1]).not.toContain(f.input.prompt)
    f.child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: started.sessionId, result: 'A concrete flaw.', modelUsage: { 'fixture-model': {} }, total_cost_usd: 0.01 }))
    f.child.emit('close', 0)
    const result = f.manager.get(started.id, 1)!
    expect(result).toMatchObject({ status: 'completed', reply: 'A concrete flaw.', observedModel: 'fixture-model', estimatedCostUsd: 0.01, billedCostUsd: null })
    expect(result.evidenceObservationIds).toEqual([observation])
  })
  it('replays one UUID, conflicts on changed payload, and excludes another process', () => {
    const f = fixture(); const run = f.manager.start(f.input, 1)
    expect(f.manager.start(f.input, 1).id).toBe(run.id)
    expect(() => f.manager.start({ ...f.input, prompt: 'Different' }, 1)).toThrow('different request')
    const other = new SubscriptionRunManager(f.deps)
    expect(() => other.start({ ...f.input, idempotencyKey: randomUUID() }, 1)).toThrow('running or needs reconciliation')
    expect(f.launch).toHaveBeenCalledTimes(1)
    f.child.emit('close', 1)
  })
  it('rejects stale or insufficient quota and unsupported runtime before probing', () => {
    const f = fixture(); f.state.bindings[0].verificationFreshness = 'refresh_due'
    expect(() => f.manager.start(f.input, 1)).toThrow('fresh verified access')
    f.state.bindings[0].verificationFreshness = 'fresh'; f.state.accounts[0].pools[0].effectiveRemainingPercent = 20
    expect(() => f.manager.start(f.input, 1)).toThrow('fresh verified access')
    f.state.accounts[0].pools[0].effectiveRemainingPercent = 80
    f.state.bindings[0].runtimeId = 'codex-cli'
    const manager = new SubscriptionRunManager({ ...f.deps, launchBindings: () => [{ ...binding, runtimeId: 'codex-cli' }] })
    expect(() => manager.start(f.input, 1)).toThrow('Claude Code only')
    expect(f.probe).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled()
  })
  it('checks account and credential method immediately before any model request', () => {
    const f = fixture(); f.probe.mockReturnValue({ status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'api-key', apiProvider: 'firstParty', subscriptionType: 'max', email }) })
    expect(f.manager.start(f.input, 1)).toMatchObject({ status: 'failed', error: expect.stringContaining('not signed in') })
    expect(f.launch).not.toHaveBeenCalled()
    expect(f.manager.start(f.input, 1).status).toBe('failed'); expect(f.probe).toHaveBeenCalledTimes(1)
  })
  it('re-evaluates evidence after identity preflight', () => {
    const f = fixture(); f.probe.mockImplementationOnce(() => {
      f.state.accounts[0].pools[0].status = 'reset_unconfirmed'
      return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email }) }
    })
    expect(f.manager.start(f.input, 1).status).toBe('failed'); expect(f.launch).not.toHaveBeenCalled()
  })
  it('fails empty, failed, wrong-session, denied and secret-bearing results', () => {
    const id = randomUUID(); const good = { type: 'result', subtype: 'success', session_id: id, result: 'Report' }
    for (const bad of [{ ...good, result: '' }, { ...good, subtype: 'error_max_turns' }, { ...good, session_id: randomUUID() }, { ...good, permission_denials: [{}] }, { ...good, result: 'ghp_' + 'a'.repeat(36) }]) {
      expect(() => parseClaudeSubscriptionResult(JSON.stringify(bad), id)).toThrow()
    }
    expect(parseClaudeSubscriptionResult(JSON.stringify(good), id).observedModel).toBeNull()
  })
  it('does not silently accept an unexpected observed model', () => {
    const f = fixture(); const run = f.manager.start(f.input, 1)
    f.child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: run.sessionId, result: 'Report', modelUsage: { 'another-model': {} } }))
    f.child.emit('close', 0)
    expect(f.manager.get(run.id, 1)).toMatchObject({ status: 'failed', observedModel: 'another-model', error: expect.stringContaining('differs') })
  })
  it('preserves and rejects mixed requested and unexpected observed model identities', () => {
    const f = fixture(); const run = f.manager.start(f.input, 1)
    f.child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: run.sessionId, result: 'Report', modelUsage: { 'fixture-model': {}, 'another-model': {} } }))
    f.child.emit('close', 0)
    expect(f.manager.get(run.id, 1)).toMatchObject({ status: 'failed', observedModel: null, observedModels: ['fixture-model', 'another-model'], error: expect.stringContaining('differs') })
  })
  it('cancels only its owned child and retains interrupted receipts', () => {
    const f = fixture(); const run = f.manager.start(f.input, 1)
    expect(f.manager.cancel(run.id, 2)).toBe(false)
    expect(f.manager.cancel(run.id, 1)).toBe(true)
    f.child.emit('close', null)
    expect(f.manager.get(run.id, 1)?.status).toBe('interrupted')
  })
  it('stops on output overflow without treating a partial response as completed', () => {
    const f = fixture(); const run = f.manager.start(f.input, 1)
    f.child.stderr.write(Buffer.alloc(2_000_001)); f.child.emit('close', 0)
    expect(f.child.kill).toHaveBeenCalled(); expect(f.manager.get(run.id, 1)?.status).toBe('interrupted')
  })
  it('enforces the total ten-minute time bound', () => {
    vi.useFakeTimers()
    const f = fixture(); const run = f.manager.start(f.input, 1)
    vi.advanceTimersByTime(600_000)
    expect(f.child.kill).toHaveBeenCalledTimes(1)
    f.child.emit('close', null)
    expect(f.manager.get(run.id, 1)?.status).toBe('interrupted')
  })
  it('keeps the lock and stops a child if saving its receipt fails after spawn', () => {
    const f = fixture()
    f.launch.mockImplementationOnce(() => {
      const filename = path.join(folder, `${f.input.idempotencyKey}.json`)
      unlinkSync(filename); mkdirSync(filename)
      return f.child
    })
    expect(() => f.manager.start(f.input, 1)).toThrow('after launch')
    expect(f.child.kill).toHaveBeenCalled()
    expect(existsSync(path.join(folder, 'active.lock'))).toBe(true)
    expect(() => f.child.emit('error', new Error('asynchronous spawn failure'))).not.toThrow()
    expect(() => f.child.stdin.emit('error', new Error('closed input'))).not.toThrow()
  })
  it('requires confirmed process death before reconciling a crash, then does not retry', () => {
    const f = fixture(); const run = f.manager.start(f.input, 1)
    const record = JSON.parse(readFileSync(path.join(folder, `${run.id}.json`), 'utf8')); record.ownerPid = 999999; record.childPid = 999998
    writeFileSync(path.join(folder, `${run.id}.json`), JSON.stringify(record))
    const blocked = new SubscriptionRunManager({ ...f.deps, alive: () => true })
    expect(() => blocked.reconcile(run.id, 1)).toThrow('process may still own')
    const restarted = new SubscriptionRunManager(f.deps)
    expect(restarted.get(run.id, 1)?.status).toBe('unknown')
    expect(restarted.reconcile(run.id, 1).status).toBe('interrupted')
    expect(restarted.start(f.input, 1).status).toBe('interrupted'); expect(f.launch).toHaveBeenCalledTimes(1)
    f.child.emit('close', 1)
  })
  it('does not unlock an orphan when the child identity may have been lost during spawn', () => {
    const f = fixture(); const run = f.manager.start(f.input, 1)
    const restarted = new SubscriptionRunManager(f.deps)
    expect(() => restarted.reconcile(run.id, 1)).toThrow('child identity was not persisted')
    expect(existsSync(path.join(folder, 'active.lock'))).toBe(true)
    f.child.emit('close', 1)
  })
  it('fails closed on corrupted existing evidence and workspace mismatch', () => {
    const f = fixture(); writeFileSync(path.join(folder, `${f.input.idempotencyKey}.json`), '{')
    expect(() => f.manager.start(f.input, 1)).toThrow('unreadable')
    expect(() => f.manager.start(f.input, 2)).toThrow('Primary workspace')
    expect(f.manager.list(2)).toEqual([]); expect(f.launch).not.toHaveBeenCalled()
  })
})
