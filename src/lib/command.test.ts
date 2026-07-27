import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
}))

vi.mock('./config', () => ({
  config: {
    openclawBin: '/opt/homebrew/bin/openclaw',
    clawdbotBin: 'clawdbot',
    openclawStateDir: '/Users/test/.openclaw',
  },
}))

function createChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }

  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write: vi.fn(), end: vi.fn() }
  child.kill = vi.fn()

  return child
}

describe('runOpenClaw', () => {
  it('uses the resolved binary and preserves a working Homebrew PATH', async () => {
    const child = createChildProcess()
    spawnMock.mockReturnValueOnce(child)

    const { runOpenClaw } = await import('./command')
    const result = runOpenClaw(['--version'], {
      env: {
        NODE_ENV: 'test',
        PATH: '/custom/bin',
        EXTRA_ENV: '1',
      },
    })

    process.nextTick(() => child.emit('close', 0))
    await result

    expect(spawnMock).toHaveBeenCalledWith('/opt/homebrew/bin/openclaw', ['--version'], {
      cwd: '/Users/test/.openclaw',
      shell: false,
      env: expect.objectContaining({
        EXTRA_ENV: '1',
        OPENCLAW_STATE_DIR: '/Users/test/.openclaw',
        PATH: expect.stringMatching(/^\/opt\/homebrew\/opt\/node\/bin:\/opt\/homebrew\/bin:/),
      }),
    })
    expect(spawnMock.mock.calls[0][2].env.PATH).toContain('/custom/bin')
  })
})
