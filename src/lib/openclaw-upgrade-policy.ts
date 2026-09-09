import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from '@/lib/config'

export function parseOpenClawVersion(value: string): string | null {
  return value.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)\b/)?.[1] ?? null
}

export function compareOpenClawVersions(a: string, b: string): number {
  const [aBase, ...aPre] = a.replace(/^v/, '').split('-')
  const [bBase, ...bPre] = b.replace(/^v/, '').split('-')
  const aa = aBase.split('.').map(Number)
  const bb = bBase.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1
  }
  if (!aPre.length || !bPre.length) return aPre.length === bPre.length ? 0 : aPre.length ? -1 : 1
  return aPre.join('-').localeCompare(bPre.join('-'), 'en', { numeric: true })
}

export function findUpgradeHold(value: unknown, installed: string, target: string): string | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { holds?: unknown }).holds)) {
    throw new Error('Invalid upgrade hold policy')
  }
  const reasons: string[] = []
  for (const hold of (value as { holds: unknown[] }).holds) {
    if (!hold || typeof hold !== 'object') throw new Error('Invalid upgrade hold entry')
    const item = hold as { version?: unknown; status?: unknown; reason?: unknown }
    if (item.status !== 'active') continue
    if (typeof item.version !== 'string' || parseOpenClawVersion(item.version) !== item.version || typeof item.reason !== 'string') {
      throw new Error('Invalid active upgrade hold')
    }
    if (compareOpenClawVersions(installed, item.version) < 0 && compareOpenClawVersions(item.version, target) <= 0) {
      reasons.push(`${item.version}: ${item.reason}`)
    }
  }
  return reasons.length ? reasons.join('\n') : null
}

export function getOpenClawUpgradePolicy(installed: string, target: string) {
  const guardPath = path.join(config.openclawStateDir, 'scripts', 'safe-openclaw-update.sh')
  let updateBlockedReason: string | null = null
  try {
    // The canonical wrapper owns ~/.openclaw. Never run it against a different profile.
    if (fs.realpathSync(config.openclawStateDir) !== fs.realpathSync(path.join(os.homedir(), '.openclaw'))) {
      throw new Error('The guarded updater does not manage this OpenClaw profile.')
    }
    fs.accessSync(guardPath, fs.constants.R_OK | fs.constants.X_OK)
    const holdPath = path.join(config.openclawStateDir, 'upgrade-hold.json')
    updateBlockedReason = findUpgradeHold(JSON.parse(fs.readFileSync(holdPath, 'utf8')), installed, target)
  } catch {
    updateBlockedReason = 'The guarded update policy is unavailable. The current installation is kept running.'
  }
  return {
    guardPath,
    updateBlocked: updateBlockedReason !== null,
    updateBlockedReason,
    updateCommand: updateBlockedReason ? null : `OC_BACKUP_FULL_SQLITE=1 bash ~/.openclaw/scripts/safe-openclaw-update.sh ${target}`,
  }
}

export async function getLatestOpenClawRelease() {
  // npm is the installable target; a GitHub tag alone need not be published to npm.
  const registry = await fetch('https://registry.npmjs.org/openclaw/latest', {
    next: { revalidate: 300 }, signal: AbortSignal.timeout(10_000),
  })
  if (!registry.ok) throw new Error('Cannot resolve the published OpenClaw version')
  const npm = await registry.json()
  const latest = typeof npm.version === 'string' ? parseOpenClawVersion(npm.version) : null
  if (!latest || latest !== npm.version) throw new Error('Invalid published OpenClaw version')
  let releaseUrl = `https://github.com/openclaw/openclaw/releases/tag/v${latest}`
  let releaseNotes = ''
  try {
    const response = await fetch(`https://api.github.com/repos/openclaw/openclaw/releases/tags/v${latest}`, {
      headers: { Accept: 'application/vnd.github+json' }, next: { revalidate: 3600 },
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) {
      const release = await response.json()
      releaseUrl = release.html_url || releaseUrl
      releaseNotes = release.body || ''
    }
  } catch { /* The npm version remains authoritative when release notes are unavailable. */ }
  return { latest, releaseUrl, releaseNotes }
}
