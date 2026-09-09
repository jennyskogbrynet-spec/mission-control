import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/config', () => ({ config: { openclawStateDir: '/nonexistent-mc-upgrade-test' } }))
import { compareOpenClawVersions, findUpgradeHold, getOpenClawUpgradePolicy, parseOpenClawVersion } from '@/lib/openclaw-upgrade-policy'

describe('OpenClaw guarded update policy', () => {
  it('preserves correction and beta suffixes from real CLI version output', () => {
    expect(parseOpenClawVersion('OpenClaw 2026.7.1-2 (0790d9f)')).toBe('2026.7.1-2')
    expect(parseOpenClawVersion('OpenClaw 2026.8.1-beta.2 (abc123)')).toBe('2026.8.1-beta.2')
    expect(parseOpenClawVersion('not installed')).toBeNull()
  })
  it('orders newer versions and prerelease identifiers', () => {
    expect(compareOpenClawVersions('2026.9.2', '2026.7.1-2')).toBeGreaterThan(0)
    expect(compareOpenClawVersions('2026.8.1-beta.10', '2026.8.1-beta.2')).toBeGreaterThan(0)
    expect(compareOpenClawVersions('2026.8.1', '2026.8.1-beta.2')).toBeGreaterThan(0)
  })
  it('holds upgrades both into and across an active incompatible release', () => {
    const value = { holds: [{ version: '2026.9.2', status: 'active', reason: 'Scheduler regression #141633' }] }
    expect(findUpgradeHold(value, '2026.7.1-2', '2026.9.2')).toContain('#141633')
    expect(findUpgradeHold(value, '2026.7.1-2', '2026.9.3')).toContain('#141633')
    expect(findUpgradeHold(value, '2026.7.1-2', '2026.8.2')).toBeNull()
  })
  it('ignores resolved and already-passed holds', () => {
    expect(findUpgradeHold({ holds: [{ version: '2026.5.12', status: 'resolved' }] }, '2026.7.1-2', '2026.9.2')).toBeNull()
    expect(findUpgradeHold({ holds: [{ version: '2026.5.12', status: 'active', reason: 'Historical' }] }, '2026.7.1-2', '2026.9.2')).toBeNull()
  })
  it('fails closed for malformed or unavailable guard policy', () => {
    expect(() => findUpgradeHold({}, '2026.7.1-2', '2026.9.2')).toThrow()
    expect(() => findUpgradeHold({ holds: [{ status: 'active', version: 'unsafe;command' }] }, '2026.7.1-2', '2026.9.2')).toThrow()
    expect(getOpenClawUpgradePolicy('2026.7.1-2', '2026.9.2')).toMatchObject({ updateBlocked: true, updateCommand: null })
  })
})
