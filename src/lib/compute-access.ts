import { NextResponse } from 'next/server'
import { requireRole, type User } from './auth'
import { ComputeInputError } from './compute-store'

/** Host accounts are private infrastructure of the primary tenant/workspace. */
export function requireComputeAccess(request: Request, role: User['role'] = 'viewer') {
  const auth = requireRole(request, role)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (auth.user.workspace_id !== 1 || auth.user.tenant_id !== 1) return NextResponse.json({ error: 'Local capacity is available in the primary workspace and tenant only' }, { status: 403 })
  return { user: auth.user, workspaceId: auth.user.workspace_id }
}
export async function readComputeBody(request: Request): Promise<unknown> {
  const raw = await request.text()
  if (raw.length > 100_000) throw new ComputeInputError('Capacity payload is too large', 413)
  try { return JSON.parse(raw) } catch { throw new ComputeInputError('Invalid JSON') }
}
export function computeErrorResponse(error: unknown) {
  return NextResponse.json({ error: error instanceof ComputeInputError ? error.message : 'Capacity operation failed' }, { status: error instanceof ComputeInputError ? error.status : 500 })
}
