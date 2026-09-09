import { randomUUID } from 'node:crypto'
import { callOpenClawGateway } from './openclaw-gateway'
import { getAllGatewaySessions, type GatewaySession } from './sessions'

type AgentRecord = { name: string; session_key?: string | null; config?: string | Record<string, unknown> | null }

function agentConfig(agent: AgentRecord): Record<string, unknown> {
  if (typeof agent.config === 'object' && agent.config) return agent.config
  try { return JSON.parse(agent.config || '{}') || {} } catch { return {} }
}

/** Never pick a recent cron, subagent, or external conversation just because it is active. */
export function resolveAgentCommandSession(agent: AgentRecord, sessions: GatewaySession[]): string | null {
  const cfg = agentConfig(agent)
  const configuredId = typeof cfg.openclawId === 'string' ? cfg.openclawId.trim() : ''
  const id = configuredId || agent.name.trim().toLowerCase().replace(/\s+/g, '-')
  const explicit = agent.session_key?.trim()
  if (explicit && /^agent:[a-zA-Z0-9_-]+:.+$/.test(explicit)) {
    if (!configuredId || explicit.split(':')[1].toLowerCase() === id.toLowerCase()) return explicit
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null
  const candidates = sessions.filter(session => session.agent.toLowerCase() === id.toLowerCase())
  const dedicated = candidates.find(session => session.key === `agent:${id}:mc`)
  if (dedicated) return dedicated.key
  const main = candidates.find(session => session.key === `agent:${id}:main`)
  if (main) return main.key
  // An explicitly registered gateway identity can start an isolated MC conversation.
  return configuredId ? `agent:${id}:mc` : null
}

export function getAgentCommandSession(agent: AgentRecord, workspaceId: number): string | null {
  // The local gateway session store belongs to the primary workspace only.
  return workspaceId === 1 ? resolveAgentCommandSession(agent, getAllGatewaySessions()) : null
}

export function gatewayAccepted(payload: unknown): payload is { status: string; runId?: string } {
  if (!payload || typeof payload !== 'object') return false
  return ['accepted', 'started', 'ok', 'in_flight'].includes(String((payload as any).status || '').toLowerCase())
}

export async function sendAgentCommand(sessionKey: string, message: string, idempotencyKey: string = randomUUID()) {
  const payload = await callOpenClawGateway('chat.send', {
    sessionKey, message, idempotencyKey, deliver: false,
  }, 12000)
  if (!gatewayAccepted(payload)) throw new Error('Gateway did not acknowledge the command; outcome is unknown. Check the session before retrying.')
  return { status: 'accepted' as const, sessionKey, runId: payload.runId || null, idempotencyKey }
}
