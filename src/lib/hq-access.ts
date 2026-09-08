import { NextResponse } from 'next/server'
import { requireRole, type User } from '@/lib/auth'

/** The family/project vault belongs to one explicitly selected MC workspace. */
export function requireHQAccess(request: Request, role: User['role'] = 'viewer'): NextResponse | { user: User; workspaceId: number } {
  const auth = requireRole(request, role)
  if (!auth.user) return NextResponse.json({ error: auth.error || 'Authentication required' }, { status: auth.status || 401 })
  const workspaceId = Number(process.env.HQ_WORKSPACE_ID || '1')
  const tenantId = Number(process.env.HQ_TENANT_ID || '1')
  if (!Number.isSafeInteger(workspaceId) || !Number.isSafeInteger(tenantId) ||
      auth.user.workspace_id !== workspaceId || auth.user.tenant_id !== tenantId) {
    return NextResponse.json({ error: 'Hovedkvarteret er ikke tilgjengelig i dette arbeidsområdet.' }, { status: 403 })
  }
  return { user: auth.user, workspaceId }
}
