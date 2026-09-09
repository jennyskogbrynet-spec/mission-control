import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { runCommand, runOpenClaw } from '@/lib/command'
import { config } from '@/lib/config'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { compareOpenClawVersions, getLatestOpenClawRelease, getOpenClawUpgradePolicy, parseOpenClawVersion } from '@/lib/openclaw-upgrade-policy'

let updating = false

export async function POST(request: Request) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (auth.user.workspace_id !== 1 || auth.user.tenant_id !== 1) {
    return NextResponse.json({ error: 'Local OpenClaw updates belong to the primary workspace only' }, { status: 403 })
  }
  if (updating) return NextResponse.json({ error: 'An OpenClaw update is already running' }, { status: 409 })
  updating = true
  try {
    const installedBefore = parseOpenClawVersion((await runOpenClaw(['--version'], { timeoutMs: 3000 })).stdout)
    if (!installedBefore) return NextResponse.json({ error: 'Installed OpenClaw version is unavailable' }, { status: 503 })
    const { latest } = await getLatestOpenClawRelease()
    const policy = getOpenClawUpgradePolicy(installedBefore, latest)
    if (policy.updateBlocked) {
      return NextResponse.json({ error: 'This update is held for compatibility', detail: policy.updateBlockedReason, updateBlocked: true }, { status: 409 })
    }
    if (compareOpenClawVersions(latest, installedBefore) <= 0) {
      return NextResponse.json({ success: true, previousVersion: installedBefore, newVersion: installedBefore })
    }
    // No SIGKILL timeout: interrupting a backup/install bypasses the wrapper's recovery traps.
    // The wrapper rechecks holds and owns backup, writer quiescence and rollback.
    await runCommand('/bin/bash', [policy.guardPath, latest], {
      cwd: config.openclawStateDir,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/opt/node/bin:/opt/homebrew/bin:${process.env.PATH || '/usr/bin:/bin'}`,
        OC_BACKUP_FULL_SQLITE: '1',
      },
    })
    const installedAfter = parseOpenClawVersion((await runOpenClaw(['--version'], { timeoutMs: 3000 })).stdout)
    if (installedAfter !== latest) throw new Error('The guarded update did not retain the requested version')
    try {
      getDatabase().prepare('INSERT INTO audit_log (action, actor, detail) VALUES (?, ?, ?)').run(
        'openclaw.update', auth.user.username,
        JSON.stringify({ previousVersion: installedBefore, newVersion: installedAfter, guarded: true }),
      )
    } catch { /* non-critical */ }
    return NextResponse.json({ success: true, previousVersion: installedBefore, newVersion: installedAfter })
  } catch (err) {
    logger.error({ err }, 'Guarded OpenClaw update failed')
    return NextResponse.json({ error: 'The guarded OpenClaw update did not complete. Check the local upgrade log before retrying.' }, { status: 500 })
  } finally {
    updating = false
  }
}
