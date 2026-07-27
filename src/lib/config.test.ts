import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadConfigWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules()

  const original = {
    OPENCLAW_BIN: process.env.OPENCLAW_BIN,
    CLAWDBOT_BIN: process.env.CLAWDBOT_BIN,
    PATH: process.env.PATH,
    MISSION_CONTROL_DATA_DIR: process.env.MISSION_CONTROL_DATA_DIR,
    MISSION_CONTROL_BUILD_DATA_DIR: process.env.MISSION_CONTROL_BUILD_DATA_DIR,
    MISSION_CONTROL_BUILD_DB_PATH: process.env.MISSION_CONTROL_BUILD_DB_PATH,
    MISSION_CONTROL_BUILD_TOKENS_PATH: process.env.MISSION_CONTROL_BUILD_TOKENS_PATH,
    MISSION_CONTROL_DB_PATH: process.env.MISSION_CONTROL_DB_PATH,
    MISSION_CONTROL_TOKENS_PATH: process.env.MISSION_CONTROL_TOKENS_PATH,
    NEXT_PHASE: process.env.NEXT_PHASE,
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  const mod = await import('./config')

  if (original.OPENCLAW_BIN === undefined) delete process.env.OPENCLAW_BIN
  else process.env.OPENCLAW_BIN = original.OPENCLAW_BIN

  if (original.CLAWDBOT_BIN === undefined) delete process.env.CLAWDBOT_BIN
  else process.env.CLAWDBOT_BIN = original.CLAWDBOT_BIN

  if (original.PATH === undefined) delete process.env.PATH
  else process.env.PATH = original.PATH

  if (original.MISSION_CONTROL_DATA_DIR === undefined) delete process.env.MISSION_CONTROL_DATA_DIR
  else process.env.MISSION_CONTROL_DATA_DIR = original.MISSION_CONTROL_DATA_DIR

  if (original.MISSION_CONTROL_BUILD_DATA_DIR === undefined) delete process.env.MISSION_CONTROL_BUILD_DATA_DIR
  else process.env.MISSION_CONTROL_BUILD_DATA_DIR = original.MISSION_CONTROL_BUILD_DATA_DIR

  if (original.MISSION_CONTROL_BUILD_DB_PATH === undefined) delete process.env.MISSION_CONTROL_BUILD_DB_PATH
  else process.env.MISSION_CONTROL_BUILD_DB_PATH = original.MISSION_CONTROL_BUILD_DB_PATH

  if (original.MISSION_CONTROL_BUILD_TOKENS_PATH === undefined) delete process.env.MISSION_CONTROL_BUILD_TOKENS_PATH
  else process.env.MISSION_CONTROL_BUILD_TOKENS_PATH = original.MISSION_CONTROL_BUILD_TOKENS_PATH

  if (original.MISSION_CONTROL_DB_PATH === undefined) delete process.env.MISSION_CONTROL_DB_PATH
  else process.env.MISSION_CONTROL_DB_PATH = original.MISSION_CONTROL_DB_PATH

  if (original.MISSION_CONTROL_TOKENS_PATH === undefined) delete process.env.MISSION_CONTROL_TOKENS_PATH
  else process.env.MISSION_CONTROL_TOKENS_PATH = original.MISSION_CONTROL_TOKENS_PATH

  if (original.NEXT_PHASE === undefined) delete process.env.NEXT_PHASE
  else process.env.NEXT_PHASE = original.NEXT_PHASE

  return mod.config
}

describe('config data paths', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unmock('node:fs')
  })

  it('derives db and token paths from MISSION_CONTROL_DATA_DIR', async () => {
    const config = await loadConfigWithEnv({
      MISSION_CONTROL_DATA_DIR: '/tmp/mission-control-data',
      MISSION_CONTROL_DB_PATH: undefined,
      MISSION_CONTROL_TOKENS_PATH: undefined,
    })

    expect(config.dataDir).toBe('/tmp/mission-control-data')
    expect(config.dbPath).toBe('/tmp/mission-control-data/mission-control.db')
    expect(config.tokensPath).toBe('/tmp/mission-control-data/mission-control-tokens.json')
  })

  it('respects explicit db and token path overrides', async () => {
    const config = await loadConfigWithEnv({
      MISSION_CONTROL_DATA_DIR: '/tmp/mission-control-data',
      MISSION_CONTROL_DB_PATH: '/tmp/custom.db',
      MISSION_CONTROL_TOKENS_PATH: '/tmp/custom-tokens.json',
    })

    expect(config.dataDir).toBe('/tmp/mission-control-data')
    expect(config.dbPath).toBe('/tmp/custom.db')
    expect(config.tokensPath).toBe('/tmp/custom-tokens.json')
  })

  it('uses a build-scoped worker data dir during next build', async () => {
    const config = await loadConfigWithEnv({
      NEXT_PHASE: 'phase-production-build',
      MISSION_CONTROL_DATA_DIR: '/tmp/runtime-data',
      MISSION_CONTROL_BUILD_DATA_DIR: '/tmp/build-scratch',
      MISSION_CONTROL_DB_PATH: undefined,
      MISSION_CONTROL_TOKENS_PATH: undefined,
    })

    expect(config.dataDir).toMatch(/^\/tmp\/build-scratch\/worker-\d+$/)
    expect(config.dbPath).toMatch(/^\/tmp\/build-scratch\/worker-\d+\/mission-control\.db$/)
    expect(config.tokensPath).toMatch(/^\/tmp\/build-scratch\/worker-\d+\/mission-control-tokens\.json$/)
  })

  it('prefers build-specific db and token overrides during next build', async () => {
    const config = await loadConfigWithEnv({
      NEXT_PHASE: 'phase-production-build',
      MISSION_CONTROL_DATA_DIR: '/tmp/runtime-data',
      MISSION_CONTROL_DB_PATH: '/tmp/runtime.db',
      MISSION_CONTROL_TOKENS_PATH: '/tmp/runtime-tokens.json',
      MISSION_CONTROL_BUILD_DB_PATH: '/tmp/build.db',
      MISSION_CONTROL_BUILD_TOKENS_PATH: '/tmp/build-tokens.json',
    })

    const expectedBuildRoot = path.join(os.tmpdir(), 'mission-control-build')
    expect(config.dataDir).toMatch(new RegExp(`^${expectedBuildRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/worker-\\d+$`))
    expect(config.dbPath).toBe('/tmp/build.db')
    expect(config.tokensPath).toBe('/tmp/build-tokens.json')
  })

  it('uses the absolute Homebrew OpenClaw path when no explicit binary override is set', async () => {
    const config = await loadConfigWithEnv({
      OPENCLAW_BIN: undefined,
      CLAWDBOT_BIN: undefined,
    })

    expect(config.openclawBin).toBe('/opt/homebrew/bin/openclaw')
  })

  it('falls back to PATH lookup when standard absolute binary paths are absent', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      const existsSync = (candidate: string) => candidate === '/tmp/mc-bin/openclaw'
      return {
        ...actual,
        existsSync,
        default: { ...(actual as any), existsSync },
      }
    })

    const config = await loadConfigWithEnv({
      OPENCLAW_BIN: undefined,
      PATH: '/tmp/mc-bin',
    })

    expect(config.openclawBin).toBe('/tmp/mc-bin/openclaw')
  })

  it('respects explicit OpenClaw binary overrides', async () => {
    const config = await loadConfigWithEnv({
      OPENCLAW_BIN: '/custom/bin/openclaw',
      CLAWDBOT_BIN: '/custom/bin/clawdbot',
    })

    expect(config.openclawBin).toBe('/custom/bin/openclaw')
    expect(config.clawdbotBin).toBe('/custom/bin/clawdbot')
  })
})
