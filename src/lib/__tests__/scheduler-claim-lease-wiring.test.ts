// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * scheduler.ts picks a task's setting key and runner through if-chains that fall through to
 * `general.agent_heartbeat` and `runCleanup()`. A task id missing from one chain would silently
 * run the wrong thing, so the wiring of `claim_lease_sweep` is pinned here at source level
 * (the scheduler itself needs the whole runtime to start).
 */
const source = readFileSync(join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8')

describe('claim_lease_sweep wiring in scheduler.ts', () => {
  it('is registered once', () => {
    expect(source.match(/tasks\.set\('claim_lease_sweep'/g)).toHaveLength(1)
  })

  it('maps to its own setting in both lookups (tick and status)', () => {
    expect(source.match(/id === 'claim_lease_sweep' \? CLAIM_LEASE_SWEEP_SETTING/g)).toHaveLength(2)
  })

  it('runs its own runner before the cleanup fallback, and can be triggered by hand', () => {
    const run = source.indexOf("id === 'claim_lease_sweep' ? await runClaimLeaseSweep()")
    const fallback = source.indexOf(': await runCleanup()')
    expect(run).toBeGreaterThan(-1)
    expect(run).toBeLessThan(fallback)
    expect(source).toContain("if (taskId === 'claim_lease_sweep') return runClaimLeaseSweep()")
  })

  it('is off by default: it is not in either defaultEnabled list', () => {
    const lists = source.match(/const defaultEnabled = [^\n]+/g) ?? []
    expect(lists).toHaveLength(2)
    for (const list of lists) expect(list).not.toContain('claim_lease_sweep')
  })

  it('the setting it reads is the documented one', async () => {
    const { CLAIM_LEASE_SWEEP_SETTING } = await import('@/lib/claim-lease')
    expect(CLAIM_LEASE_SWEEP_SETTING).toBe('general.claim_lease_sweep')
  })
})
