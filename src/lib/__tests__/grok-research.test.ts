// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ spawn: vi.fn(), dataDir: '', staleFirstReadId: '', staleReadConsumed: false }))
mock.dataDir = mkdtempSync(path.join(tmpdir(), 'mc-grok-test-'))
vi.mock('@/lib/config', () => ({ config: { get dataDir() { return mock.dataDir } } }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (mock.staleFirstReadId && String(args[0]).endsWith(mock.staleFirstReadId + '.json') && !mock.staleReadConsumed) {
      mock.staleReadConsumed = true
      throw new Error('Simulated absent request before another process completed it')
    }
    return actual.readFileSync(...args)
  } }
})
vi.mock('node:child_process', () => ({ spawn: mock.spawn, spawnSync: vi.fn() }))
import { cancelGrokResearch, getGrokResearchRun, grokResearchArgs, parseGrokResearchResult, startGrokResearch } from '@/lib/grok-research'

const key = '12345678-1234-4234-a234-123456789012'
function child() {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
}

describe('bounded Grok research', () => {
  beforeEach(() => { mock.spawn.mockReset(); mock.staleFirstReadId = ''; mock.staleReadConsumed = false })
  afterAll(() => rmSync(mock.dataDir, { recursive: true, force: true }))
  it('uses a new limited web-only run without resuming or spawning subagents', () => {
    const args = grokResearchArgs('public question', 'grok-4.6', key)
    expect(args).toContain('web_search,web_fetch')
    expect(args).toContain('MCPTool')
    expect(args).toContain('dontAsk')
    expect(args).toContain('--no-subagents')
    expect(args).not.toContain('--always-approve')
    expect(args).not.toContain('--resume')
    expect(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2)).toEqual(['--max-turns', '6'])
    const rules = args[args.indexOf('--rules') + 1]
    expect(rules).toContain('only one final structured Markdown report')
    expect(rules).toContain('Do not emit interim commentary, progress updates')
  })
  it('separates completion, partial output and unreported cost', () => {
    expect(parseGrokResearchResult(JSON.stringify({ text: 'Result', stopReason: 'end_turn', sessionId: 'one' }))).toMatchObject({ status: 'completed', reply: 'Result', costUsd: null })
    expect(parseGrokResearchResult(JSON.stringify({ text: 'Partial', stopReason: 'max_tokens', total_cost_usd: 0.02, cost_is_partial: true }))).toMatchObject({ status: 'partial', costUsd: null })
    expect(() => parseGrokResearchResult('{"status":"ok"}')).toThrow('no research text')
  })
  it('preserves supplied research text without cutting apparent commentary or markdown', () => {
    const reply = 'I checked the sources.\n\n## Findings\n\nKeep **all** evidence, including `<example>`.\n\n[Source](https://example.com/docs)'
    expect(parseGrokResearchResult(JSON.stringify({ text: reply, stopReason: 'end_turn' })).reply).toBe(reply)
  })
  it('enforces workspace, prompt and key constraints before launching any process', () => {
    expect(() => startGrokResearch('task', 2, key)).toThrow('primary workspace')
    expect(() => startGrokResearch('task', 1, '../../outside')).toThrow('UUID')
    expect(() => startGrokResearch('', 1, key)).toThrow('1–6000')
    expect(mock.spawn).not.toHaveBeenCalled()
  })
  it('isolates config, persists results, deduplicates the same request and rejects concurrent launches', () => {
    const proc = child()
    mock.spawn.mockReturnValueOnce(proc)
    const run = startGrokResearch('Find official public docs', 1, key)
    const options = mock.spawn.mock.calls[0][2]
    expect(options.cwd).not.toContain(mock.dataDir)
    expect(options.env.GROK_HOME).toBe(path.join(options.cwd, '.grok'))
    expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(readFileSync(path.join(options.env.GROK_HOME, 'config.toml'), 'utf8')).toContain('mcps = false')
    expect(startGrokResearch('Find official public docs', 1, key).id).toBe(key)
    expect(() => startGrokResearch('Different task', 1, key)).toThrow('another prompt')
    expect(() => startGrokResearch('Second task', 1)).toThrow('Another Grok run')
    expect(mock.spawn).toHaveBeenCalledTimes(1)
    expect(getGrokResearchRun(key, 2)).toBeNull()
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ text: 'Official source found', stopReason: 'end_turn', sessionId: run.sessionId })))
    proc.emit('close', 0)
    expect(getGrokResearchRun(key, 1)).toMatchObject({ status: 'completed', reply: 'Official source found' })
  })
  it('rechecks a stale pre-lock read before launching or overwriting a completed request', () => {
    const firstProc = child()
    mock.spawn.mockReturnValueOnce(firstProc)
    const initial = startGrokResearch('Concurrent request', 1)
    firstProc.stdout.emit('data', Buffer.from(JSON.stringify({ text: 'Existing answer', stopReason: 'end_turn' })))
    firstProc.emit('close', 0)
    mock.spawn.mockReset()
    const before = getGrokResearchRun(initial.id, 1)
    expect(before?.status).toBe('completed')
    mock.staleFirstReadId = initial.id
    const result = startGrokResearch('Concurrent request', 1, initial.id)
    expect(result).toEqual(before)
    expect(mock.staleReadConsumed).toBe(true)
    expect(mock.spawn).not.toHaveBeenCalled()
    expect(getGrokResearchRun(initial.id, 1)).toEqual(before)
    // Returning an existing request also releases the lock for independent work.
    const proc = child()
    mock.spawn.mockReturnValueOnce(proc)
    const subsequent = startGrokResearch('Independent question after reconciliation', 1)
    proc.emit('close', 1)
    expect(subsequent.status).toBe('failed')
  })
  it('reports runtime failure without exposing raw error logs', () => {
    const proc = child()
    mock.spawn.mockReturnValueOnce(proc)
    const run = startGrokResearch('New public question', 1)
    proc.stderr.emit('data', Buffer.from('secret-bearing debug output'))
    proc.emit('close', 1)
    const saved = getGrokResearchRun(run.id, 1)
    expect(saved?.status).toBe('failed')
    expect(JSON.stringify(saved)).not.toContain('secret-bearing')
  })
  it('cancels only an owned run and records interruption instead of completion', () => {
    const proc = child()
    mock.spawn.mockReturnValueOnce(proc)
    const run = startGrokResearch('Cancelable public question', 1)
    expect(cancelGrokResearch(run.id, 2)).toBe(false)
    expect(cancelGrokResearch(run.id, 1)).toBe(true)
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    proc.emit('close', null)
    expect(getGrokResearchRun(run.id, 1)).toMatchObject({ status: 'interrupted' })
    expect(cancelGrokResearch(run.id, 1)).toBe(false)
  })
  it('terminates after the time budget without retrying', () => {
    vi.useFakeTimers()
    try {
      const proc = child()
      mock.spawn.mockReturnValueOnce(proc)
      const run = startGrokResearch('Time bounded question', 1)
      vi.advanceTimersByTime(180_000)
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
      proc.emit('close', null)
      expect(getGrokResearchRun(run.id, 1)?.error).toContain('3-minute limit')
      expect(mock.spawn).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
})
