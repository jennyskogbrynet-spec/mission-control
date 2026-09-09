'use client'
import { useRef, useState } from 'react'

/** One logical check-in survives an uncertain transport response until acceptance. */
export function useAgentWake(onAccepted: () => Promise<void>, onError: (message: string) => void) {
  const attempts = useRef(new Map<string, { sessionKey: string; key: string; message: string }>())
  const inFlight = useRef(new Set<string>())
  const [wakingAgents, setWakingAgents] = useState<Set<string>>(new Set())
  const wakeAgent = async (agentName: string, sessionKey: string) => {
    if (inFlight.current.has(agentName)) return
    inFlight.current.add(agentName)
    setWakingAgents(new Set(inFlight.current))
    let attempt = attempts.current.get(agentName)
    if (!attempt || attempt.sessionKey !== sessionKey) {
      attempt = { sessionKey, key: crypto.randomUUID(), message: `Wake up check-in for ${agentName}. Please review assigned tasks and notifications.` }
      attempts.current.set(agentName, attempt)
    }
    let accepted = false
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}/wake`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key },
        body: JSON.stringify({ message: attempt.message }),
      })
      const data = await response.json()
      if (!response.ok || data.status !== 'accepted') throw new Error(data.error || 'Check-in delivery could not be confirmed. Retry retains the same request identity.')
      accepted = true
      attempts.current.delete(agentName)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Check-in delivery could not be confirmed. Retry retains the same request identity.')
    } finally {
      inFlight.current.delete(agentName)
      setWakingAgents(new Set(inFlight.current))
    }
    if (accepted) {
      try { await onAccepted() }
      catch { onError('Gateway accepted the check-in, but the agent list could not refresh. Follow the session for its result.') }
    }
  }
  return { wakeAgent, wakingAgents }
}
