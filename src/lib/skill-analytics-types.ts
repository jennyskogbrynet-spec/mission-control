export interface SkillAnalyticsRow {
  id: string
  name: string
  origins: string[]
  status: string[]
  categories: Record<string, number>
  lastUse: string | null
  days7: number | null
  days30: number | null
  days90: number | null
  sessions: number | null
  words: number
  bytes: number
  flags: string[]
  proposal: string
}

export interface SkillAnalyticsSnapshot {
  version: 1
  workspaceId: number
  generatedAt: string
  coverage: { status: 'partial' | 'complete' | 'unavailable'; sources: string[]; limitations: string[] }
  skills: SkillAnalyticsRow[]
}

export const categoryLabels: Record<string, string> = { explicit_invocation: 'Invokasjoner', document_read: 'Skill-dokument lest', script_execution: 'Skriptkjøring', completed_tool_calls: 'Fullførte verktøykall', failed_tool_calls: 'Feilede verktøykall', unknown_outcome: 'Ukjent utfall', supplemental_hook: 'Supplerende hook', direct_tool_invocations: 'Direkte verktøyinvokasjoner', wrapped_command_attempts: 'Innrammede kommandoforsøk', supplemental_loader_counter_total: 'Supplerende kumulative loader-tall' }

export type AnalyticsSort = 'name' | 'days7' | 'days30' | 'days90' | 'sessions' | 'words' | 'lastUse'

export function skillAnalyticsCsv(rows: SkillAnalyticsRow[]): string {
  const escape = (value: unknown) => {
    let text = value === null ? 'Ukjent' : String(value)
    // Neutralize formulas when opened in spreadsheet applications.
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`
    return `"${text.replace(/"/g, '""')}"`
  }
  const header = ['Skill', 'Kilder', 'Status', 'Kategorier', 'Sist observert', '7 dager', '30 dager', '90 dager', 'Sesjoner', 'Ord', 'Byte', 'Flagg', 'Forslag']
  return [header, ...rows.map(row => [row.name, row.origins.join('; '), row.status.join('; '), JSON.stringify(row.categories), row.lastUse, row.days7, row.days30, row.days90, row.sessions, row.words, row.bytes, row.flags.join('; '), row.proposal])].map(row => row.map(escape).join(',')).join('\r\n')
}

export function filterSortSkills(rows: SkillAnalyticsRow[], query: string, sort: AnalyticsSort, descending: boolean) {
  const q = query.trim().toLowerCase()
  return rows.filter(row => `${row.name} ${row.origins.join(' ')} ${row.status.join(' ')} ${row.flags.join(' ')} ${Object.keys(row.categories).map(key => `${key} ${categoryLabels[key] || ''}`).join(' ')} ${row.proposal}`.toLowerCase().includes(q))
    .sort((a, b) => {
      const av = a[sort], bv = b[sort]
      // Unknown values always remain last, regardless of direction.
      if (av === null) return bv === null ? a.name.localeCompare(b.name) : 1
      if (bv === null) return -1
      const comparison = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return (comparison * (descending ? -1 : 1)) || a.name.localeCompare(b.name)
    })
}
