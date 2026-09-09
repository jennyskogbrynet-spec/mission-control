import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { runOpenClaw } from '@/lib/command'
import { compareOpenClawVersions, getLatestOpenClawRelease, getOpenClawUpgradePolicy, parseOpenClawVersion } from '@/lib/openclaw-upgrade-policy'

const headers = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (auth.user.workspace_id !== 1 || auth.user.tenant_id !== 1) {
    return NextResponse.json({ error: 'Local OpenClaw belongs to the primary workspace only' }, { status: 403 })
  }
  let installed: string | null = null
  try {
    installed = parseOpenClawVersion((await runOpenClaw(['--version'], { timeoutMs: 3000 })).stdout)
    if (!installed) throw new Error('Installed version unavailable')
    const release = await getLatestOpenClawRelease()
    const policy = getOpenClawUpgradePolicy(installed, release.latest)
    return NextResponse.json({
      installed, ...release,
      updateAvailable: compareOpenClawVersions(release.latest, installed) > 0,
      updateBlocked: policy.updateBlocked,
      updateBlockedReason: policy.updateBlockedReason,
      updateCommand: policy.updateCommand,
      canUpdate: auth.user.role === 'admin' && !policy.updateBlocked,
    }, { headers })
  } catch {
    return NextResponse.json({ installed, latest: null, updateAvailable: false, canUpdate: false, updateCommand: null }, { headers })
  }
}
