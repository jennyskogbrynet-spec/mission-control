import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { readSkillAnalytics } from '@/lib/skill-analytics'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  return NextResponse.json(await readSkillAnalytics(auth.user.workspace_id), {
    headers: { 'Cache-Control': 'private, no-store' },
  })
}

export const dynamic = 'force-dynamic'
