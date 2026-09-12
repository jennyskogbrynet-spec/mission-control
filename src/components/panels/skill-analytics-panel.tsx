'use client'

import { useEffect, useMemo, useState } from 'react'
import { filterSortSkills, skillAnalyticsCsv, type AnalyticsSort, type SkillAnalyticsSnapshot } from '@/lib/skill-analytics-types'

const columns: Array<{ key: AnalyticsSort; label: string }> = [
  { key: 'name', label: 'Skill' }, { key: 'lastUse', label: 'Sist observert' },
  { key: 'days7', label: '7 dager' }, { key: 'days30', label: '30 dager' },
  { key: 'days90', label: '90 dager' }, { key: 'sessions', label: 'Sesjoner' }, { key: 'words', label: 'Kontekststørrelse' },
]
const categoryLabels: Record<string, string> = { explicit_invocation: 'Invokasjoner', document_read: 'Skill-dokument lest', script_execution: 'Skriptkjøring', completed_tool_calls: 'Fullførte verktøykall', failed_tool_calls: 'Feilede verktøykall', unknown_outcome: 'Ukjent utfall', supplemental_hook: 'Supplerende hook' }
const observed = (value: number | null) => value === null ? 'Ukjent' : value.toLocaleString()

export function SkillAnalyticsPanel() {
  const [snapshot, setSnapshot] = useState<SkillAnalyticsSnapshot | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<AnalyticsSort>('name')
  const [descending, setDescending] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    fetch('/api/skills/analytics', { cache: 'no-store' }).then(async res => {
      if (!res.ok) throw new Error('Analytics unavailable')
      const data = await res.json()
      if (!cancelled) { setSnapshot(data.snapshot); setState(data.status) }
    }).catch(() => { if (!cancelled) setState('error') })
    return () => { cancelled = true }
  }, [revision])
  const rows = useMemo(() => filterSortSkills(snapshot?.skills || [], query, sort, descending), [snapshot, query, sort, descending])
  const selectSort = (key: AnalyticsSort) => { if (key === sort) setDescending(!descending); else { setSort(key); setDescending(false) } }
  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob(['\ufeff', skillAnalyticsCsv(rows)], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = 'skill-statistikk.csv'; anchor.click()
    URL.revokeObjectURL(url)
  }
  return <section className="space-y-3" aria-label="Skill-statistikk">
    <div className="flex flex-wrap items-center gap-3">
      <input aria-label="Søk i skill-statistikk" value={query} onChange={e => setQuery(e.target.value)} placeholder="Søk etter skill, kilde, kategori eller vurderingsflagg" className="flex-1 min-w-60 rounded-md border border-border bg-card px-3 py-2 text-sm" />
      <button className="rounded-md border border-border px-3 py-2 text-xs" onClick={() => { setState('loading'); setRevision(revision + 1) }}>Oppdater visning</button>
      <button className="rounded-md border border-border px-3 py-2 text-xs" disabled={!snapshot || state !== 'ready'} onClick={exportCsv}>Eksporter synlige rader (CSV)</button>
    </div>
    <p className="text-xs text-muted-foreground">Tallene gjelder dokumenterte observasjoner i innsamlede lokale spor. En omtale beviser ikke kjøring. Ukjent betyr manglende dekning; null betyr ingen observasjon i de dekkede sporene. Kontekststørrelse er ord og byte i SKILL.md, ikke målte tokens.</p>
    {state === 'loading' && <p role="status">Laster statistikk…</p>}
    {state === 'error' && <p role="alert">Kunne ikke laste statistikk. Oppdater for å prøve igjen.</p>}
    {state === 'unavailable' && <p role="status">Ingen gyldig statistikkfil er konfigurert for dette arbeidsområdet.</p>}
    {state === 'ready' && snapshot && <>
      <div className="rounded-lg border border-border p-3 text-xs space-y-1">
        <p>Dekning: <strong>{{ partial: 'Delvis', complete: 'Fullstendig', unavailable: 'Utilgjengelig' }[snapshot.coverage.status]}</strong> · {snapshot.skills.length} skills · Øyeblikksbilde: {new Date(snapshot.generatedAt).toLocaleString()}</p>
        <p>Kilder: {snapshot.coverage.sources.join(', ') || 'Ingen'}</p>
        {snapshot.coverage.limitations.map((note, i) => <p key={i}>{note}</p>)}
        <p>Vurderingsflagg og forslag er heuristikker som krever gjennomgang.</p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs text-left">
          <caption className="sr-only">Skill-observasjoner, dekning og vurderingsforslag</caption>
          <thead className="bg-secondary/50"><tr>
            {columns.map(column => <th key={column.key} className="p-3 whitespace-nowrap" aria-sort={sort === column.key ? descending ? 'descending' : 'ascending' : 'none'}><button onClick={() => selectSort(column.key)}>{column.label}{sort === column.key ? descending ? ' ↓' : ' ↑' : ''}</button></th>)}
            <th className="p-3">Kilde / status</th><th className="p-3">Dokumenterte kategorier</th><th className="p-3">Vurderingsflagg / forslag</th>
          </tr></thead>
          <tbody>{rows.map(row => <tr key={row.id} className="border-t border-border align-top">
            <th scope="row" className="p-3 font-medium">{row.name}</th>
            <td className="p-3 whitespace-nowrap">{row.lastUse ? new Date(row.lastUse).toLocaleDateString() : 'Ukjent'}</td>
            <td className="p-3">{observed(row.days7)}</td><td className="p-3">{observed(row.days30)}</td><td className="p-3">{observed(row.days90)}</td><td className="p-3">{observed(row.sessions)}</td>
            <td className="p-3 whitespace-nowrap">{row.words.toLocaleString()} ord<br />{row.bytes.toLocaleString()} byte</td>
            <td className="p-3">{row.origins.join(', ') || 'Ukjent'}<br />{row.status.join(', ') || 'Ukjent'}</td>
            <td className="p-3">{Object.entries(row.categories).map(([category, count]) => `${categoryLabels[category] || category}: ${count}`).join(', ') || 'Ingen dokumenterte kategorier'}</td>
            <td className="p-3 min-w-48">{row.flags.join(', ') || 'Ingen heuristiske flagg'}<br />{row.proposal}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {rows.length === 0 && <p>{snapshot.skills.length ? 'Ingen skills passer søket.' : 'Statistikkfilen inneholder ingen skills.'}</p>}
    </>}
  </section>
}
