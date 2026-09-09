import { describe, expect, it, vi } from 'vitest'
import { resolveAgentCommandSession, sendAgentCommand, gatewayAccepted } from '@/lib/agent-delivery'
import type { GatewaySession } from '@/lib/sessions'

const gateway = vi.hoisted(() => vi.fn())
vi.mock('@/lib/openclaw-gateway', () => ({ callOpenClawGateway: gateway }))
vi.mock('@/lib/sessions', () => ({ getAllGatewaySessions: vi.fn(() => []) }))
const session = (key: string, agent = 'research') => ({ key, agent } as GatewaySession)
const agent = { name: 'Research Display', config: JSON.stringify({ openclawId: 'research' }) }

describe('agent command routing', () => {
  it('resolves a registered identity without requiring a DB session key', () => {
    expect(resolveAgentCommandSession(agent, [])).toBe('agent:research:mc')
  })
  it('never commandeers the most recent cron or subagent conversation', () => {
    expect(resolveAgentCommandSession(agent, [session('agent:research:cron:secret'), session('agent:research:subagent:busy')])).toBe('agent:research:mc')
  })
  it('prefers dedicated MC then main, with explicit configuration taking precedence', () => {
    const sessions = [session('agent:research:main'), session('agent:research:mc')]
    expect(resolveAgentCommandSession(agent, sessions)).toBe('agent:research:mc')
    expect(resolveAgentCommandSession(agent, sessions.slice(0, 1))).toBe('agent:research:main')
    expect(resolveAgentCommandSession({ ...agent, session_key: 'agent:research:chosen' }, sessions)).toBe('agent:research:chosen')
  })
  it('does not route a registered identity to another agent or invent an unknown gateway agent', () => {
    expect(resolveAgentCommandSession({ ...agent, session_key: 'agent:other:main' }, [])).toBe('agent:research:mc')
    expect(resolveAgentCommandSession({ name: 'Unknown' }, [session('agent:research:main')])).toBeNull()
    expect(resolveAgentCommandSession({ name: 'Unknown', config: '{bad' }, [])).toBeNull()
  })
})

describe('command acknowledgement', () => {
  it('sends one internal gateway RPC and returns acceptance rather than claiming completion', async () => {
    gateway.mockResolvedValueOnce({ status: 'started', runId: 'run-one' })
    expect(await sendAgentCommand('agent:research:mc', 'Small task', 'logical-one')).toEqual({
      status: 'accepted', sessionKey: 'agent:research:mc', runId: 'run-one', idempotencyKey: 'logical-one',
    })
    expect(gateway).toHaveBeenCalledWith('chat.send', {
      sessionKey: 'agent:research:mc', message: 'Small task', idempotencyKey: 'logical-one', deliver: false,
    }, 12000)
  })
  it('does not claim success for empty, rejected or unknown gateway responses', async () => {
    for (const payload of [{}, { status: 'error' }, null, { runId: 'not-proof' }]) {
      expect(gatewayAccepted(payload)).toBe(false)
    }
    gateway.mockResolvedValueOnce({ status: 'rejected' })
    await expect(sendAgentCommand('agent:research:mc', 'Small task')).rejects.toThrow('outcome is unknown')
  })
})
