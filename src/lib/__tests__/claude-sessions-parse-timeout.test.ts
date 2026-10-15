// @vitest-environment node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * MC 1728. On 15 Oct the live server held one Claude session file open at its end-of-file
 * since 13 Oct 04:36 UTC: the `for await` over readline never finished, so claude_session_scan
 * (and every session after that file) went stale without a single log line. One file that
 * will not finish must cost that file, not the scan, and the log must name it.
 */
const mock = vi.hoisted(() => ({ root: '', hangOn: '' as string, warn: vi.fn() }))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    createReadStream: (path: string, options?: unknown) =>
      mock.hangOn && String(path).endsWith(mock.hangOn)
        ? new Readable({ read() { /* never pushes, never ends */ } })
        : (actual.createReadStream as any)(path, options),
  }
})
vi.mock('@/lib/config', async () => {
  const { tmpdir } = await import('node:os')
  const { join: pjoin } = await import('node:path')
  return { config: { claudeHome: pjoin(tmpdir(), `mc-claude-sessions-${process.pid}`) } }
})
vi.mock('@/lib/db', () => ({ getDatabase: () => { throw new Error('not used') } }))
vi.mock('@/lib/logger', () => ({ logger: { warn: mock.warn, info: vi.fn(), error: vi.fn() } }))

import { config } from '@/lib/config'
import { scanClaudeSessions } from '../claude-sessions'

const projectDir = join(config.claudeHome as string, 'projects', '-test-project')
const line = (o: object) => JSON.stringify(o)
const sessionFile = (id: string) =>
  [
    line({ type: 'user', sessionId: id, cwd: '/work', timestamp: '2026-10-13T04:00:00.000Z', message: { content: 'hello' } }),
    line({ type: 'assistant', sessionId: id, timestamp: '2026-10-13T04:00:05.000Z', message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 }, content: [] } }),
  ].join('\n') + '\n'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(Date.UTC(2026, 9, 13, 5, 0, 0))
  vi.clearAllMocks()
  rmSync(config.claudeHome as string, { recursive: true, force: true })
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'a-hangs.jsonl'), sessionFile('s-a'))
  writeFileSync(join(projectDir, 'b-fine.jsonl'), sessionFile('s-b'))
  mock.hangOn = ''
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(config.claudeHome as string, { recursive: true, force: true })
})

describe('scanClaudeSessions with a file that never finishes', () => {
  it('control: both files are parsed when nothing hangs', async () => {
    const scan = scanClaudeSessions()
    const sessions = await scan
    expect(sessions.map(s => s.sessionId).sort()).toEqual(['s-a', 's-b'])
  })

  it('skips the hung file after the per-file timeout, names it in the log, and finishes the scan', async () => {
    mock.hangOn = 'a-hangs.jsonl'
    const scan = scanClaudeSessions()
    await vi.advanceTimersByTimeAsync(31_000)
    const sessions = await scan
    expect(sessions.map(s => s.sessionId)).toEqual(['s-b'])
    expect(mock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: expect.stringContaining('a-hangs.jsonl') }),
      expect.stringMatching(/timed out/i),
    )
  })

  it('does not time out a file that is merely slow to start: the timer is per file and cleared on success', async () => {
    const scan = scanClaudeSessions()
    const sessions = await scan
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sessions).toHaveLength(2)
    expect(mock.warn).not.toHaveBeenCalled()
  })
})
