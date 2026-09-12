import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseSkillAnalytics, readSkillAnalytics } from '../skill-analytics'
import { filterSortSkills, skillAnalyticsCsv, type SkillAnalyticsRow } from '../skill-analytics-types'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const row: SkillAnalyticsRow = { id: '1234567890abcdef', name: 'alpha', origins: ['local'], status: ['installed_local'], categories: { document_read: 1 }, lastUse: null, days7: 0, days30: 1, days90: 1, sessions: 1, words: 100, bytes: 700, flags: [], proposal: 'Review' }
const snapshot = { version: 1, workspaceId: 1, generatedAt: '2026-09-12T20:00:00Z', coverage: { status: 'partial', sources: ['codex'], limitations: ['Local only'] }, skills: [row] }
afterEach(() => vi.unstubAllEnvs())

describe('skill analytics privacy and coverage', () => {
  it('strips private fields and rejects mismatched bindings or invalid data', () => {
    const parsed = parseSkillAnalytics({ ...snapshot, canonical_path: '/private', skills: [{ ...row, content: 'secret', canonical_path: '/private' }] }, 1)
    expect(JSON.stringify(parsed)).not.toContain('private')
    expect(JSON.stringify(parsed)).not.toContain('secret')
    expect(parseSkillAnalytics(snapshot, 2)).toBeNull()
    expect(parseSkillAnalytics({ ...snapshot, version: 2 }, 1)).toBeNull()
    expect(parseSkillAnalytics({ ...snapshot, skills: [{ ...row, days7: -1 }] }, 1)).toBeNull()
  })

  it('returns unavailable on missing snapshot and refuses other workspaces even with spoofed owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-skill-test-'))
    try {
      vi.stubEnv('MC_SKILL_ANALYTICS_SNAPSHOT', join(dir, 'snapshot.json'))
      expect(await readSkillAnalytics(1)).toEqual({ status: 'unavailable', snapshot: null })
      await writeFile(join(dir, 'snapshot.json'), JSON.stringify({ ...snapshot, workspaceId: 2 }))
      expect(await readSkillAnalytics(2)).toEqual({ status: 'unavailable', snapshot: null })
      expect(await readSkillAnalytics(1)).toEqual({ status: 'unavailable', snapshot: null })
      await writeFile(join(dir, 'snapshot.json'), JSON.stringify(snapshot))
      expect((await readSkillAnalytics(1)).snapshot?.coverage.status).toBe('partial')
    } finally { await rm(dir, { recursive: true }) }
  })

  it('preserves documented zero versus unknown and sorts unknown last', () => {
    const rows = [row, { ...row, id: '2234567890abcdef', name: 'unknown', days7: null }, { ...row, id: '3234567890abcdef', name: 'beta', days7: 3 }]
    expect(filterSortSkills(rows, '', 'days7', false).map(r => r.days7)).toEqual([0, 3, null])
    expect(filterSortSkills(rows, '', 'days7', true).map(r => r.days7)).toEqual([3, 0, null])
    expect(filterSortSkills(rows, 'DOCUMENT_READ', 'name', false)).toHaveLength(3)
    expect(filterSortSkills(rows, 'beta', 'name', false)).toHaveLength(1)
    expect(rows[0].name).toBe('alpha')
  })

  it('exports quoted CSV with unknown values and safe spreadsheet cells', () => {
    const csv = skillAnalyticsCsv([{ ...row, name: '=SUM(1,2)', days7: null, proposal: 'Review "later"' }])
    expect(csv).toContain('"\'=SUM(1,2)"')
    expect(csv).toContain('"Ukjent"')
    expect(csv).toContain('"Review ""later"""')
  })
})
