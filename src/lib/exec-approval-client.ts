export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny'

/** Resolve through an acknowledged RPC; a sent WebSocket frame is not a receipt. */
export async function resolveExecutionApproval(id: string, decision: ApprovalDecision): Promise<void> {
  const action = decision === 'deny' ? 'deny' : decision === 'allow-always' ? 'always_allow' : 'approve'
  const response = await fetch('/api/exec-approvals', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok !== true) throw new Error(data.error || 'The gateway did not confirm the decision')
}
