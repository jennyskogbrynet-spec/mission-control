import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const runCommandMock = vi.fn()
const runOpenClawMock = vi.fn()
const runClawdbotMock = vi.fn()
const getDatabaseMock = vi.fn()
const loggerErrorMock = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(() => ({ user: { role: 'viewer', workspace_id: 1 } })),
}))

vi.mock('@/lib/command', () => ({
  runCommand: runCommandMock,
  runOpenClaw: runOpenClawMock,
  runClawdbot: runClawdbotMock,
}))

vi.mock('@/lib/config', () => ({
  config: {
    gatewayHost: '127.0.0.1',
    gatewayPort: 8080,
    dbPath: '/tmp/mission-control.db',
    dataDir: '/tmp',
  },
}))

vi.mock('@/lib/db', () => ({ getDatabase: getDatabaseMock }))
vi.mock('@/lib/sessions', () => ({ getAllGatewaySessions: vi.fn(() => []), getAgentLiveStatuses: vi.fn(() => []) }))
vi.mock('@/lib/provider-subscriptions', () => ({
  detectProviderSubscriptions: vi.fn(() => ({})),
  getPrimarySubscription: vi.fn(() => null),
}))
vi.mock('@/lib/version', () => ({ APP_VERSION: 'test' }))
vi.mock('@/lib/hermes-sessions', () => ({ isHermesInstalled: vi.fn(() => false), scanHermesSessions: vi.fn(() => []) }))
vi.mock('@/lib/gateway-runtime', () => ({ registerMcAsDashboard: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerErrorMock, info: vi.fn(), warn: vi.fn() } }))
vi.mock('@/lib/models', () => ({
  MODEL_CATALOG: [
    {
      alias: 'gpt-4.1-mini',
      name: 'openai/gpt-4.1-mini',
      provider: 'openai',
      description: 'baseline',
      costPer1k: 0.001,
    },
  ],
}))

describe('status route Ollama model discovery', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 100 * 1024 * 1024,
      heapTotal: 50 * 1024 * 1024,
      heapUsed: 25 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('uses Ollama HTTP API instead of spawning ollama CLI', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'qwen2.5-coder:14b', size: 123456 },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await import('@/app/api/status/route')
    const request = new NextRequest('http://localhost/api/status?action=models')

    const response = await GET(request)
    expect(response.status).toBe(200)

    const payload = await response.json() as { models: Array<{ name: string }> }
    expect(payload.models.some((m) => m.name === 'ollama/qwen2.5-coder:14b')).toBe(true)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(runCommandMock).not.toHaveBeenCalledWith('ollama', ['list'], expect.anything())
  })

  it('falls back to catalog models when Ollama API is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')))

    const { GET } = await import('@/app/api/status/route')
    const request = new NextRequest('http://localhost/api/status?action=models')
    const response = await GET(request)
    const payload = await response.json() as { models: Array<{ name: string }> }

    expect(response.status).toBe(200)
    expect(payload.models.some((m) => m.name === 'openai/gpt-4.1-mini')).toBe(true)
    expect(loggerErrorMock).toHaveBeenCalled()
  })

  it('keeps the public health probe in-process', async () => {
    const dbGet = vi.fn(() => ({ ok: 1 }))
    getDatabaseMock.mockReturnValue({
      prepare: vi.fn(() => ({ get: dbGet })),
    })

    const { GET } = await import('@/app/api/status/route')
    const response = await GET(new NextRequest('http://localhost/api/status?action=health'))
    const payload = await response.json() as { status: string; checks: Array<{ name: string }> }

    expect(response.status).toBe(200)
    expect(payload.status).toBe('healthy')
    expect(payload.checks.map((check) => check.name)).toEqual(['Database', 'Process Memory'])
    expect(dbGet).toHaveBeenCalledOnce()
    expect(runCommandMock).not.toHaveBeenCalled()
    expect(runOpenClawMock).not.toHaveBeenCalled()
    expect(runClawdbotMock).not.toHaveBeenCalled()
  })

  it('reports unhealthy when the liveness database check fails', async () => {
    getDatabaseMock.mockImplementation(() => {
      throw new Error('database unavailable')
    })

    const { GET } = await import('@/app/api/status/route')
    const response = await GET(new NextRequest('http://localhost/api/status?action=health'))
    const payload = await response.json() as {
      status: string
      checks: Array<{ name: string; status: string }>
    }

    expect(response.status).toBe(200)
    expect(payload.status).toBe('unhealthy')
    expect(payload.checks).toContainEqual(expect.objectContaining({
      name: 'Database',
      status: 'unhealthy',
    }))
    expect(runCommandMock).not.toHaveBeenCalled()
    expect(runOpenClawMock).not.toHaveBeenCalled()
    expect(runClawdbotMock).not.toHaveBeenCalled()
  })
})
