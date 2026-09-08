'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { HQMetricsResponse, HQNote, HQProjectKey, HQSearchResponse, HQSnapshot, HQSourceStatus, HQTask, HQView } from '@/lib/hq-types'
import { panelHref } from '@/lib/navigation'
import { useMissionControl } from '@/store'
import { formatDate, graphData, inProject, kindNames, priorityNames, priorityTasks, projectNames, statusNames, type ProjectFilter } from './hq-data'
import { useDebouncedValue, useHQResource } from './use-hq-resource'
import { HQGraph } from './hq-graph'
import { KnowledgeInspector } from './knowledge-inspector'
import { HQMetrics } from './hq-metrics'
import { TaskComposer } from './task-composer'
import styles from './headquarters.module.css'

const views: { id: HQView; name: string; icon: string }[] = [{ id: 'overview', name: 'Oversikt', icon: '◫' }, { id: 'knowledge', name: 'Kunnskap', icon: '⌘' }, { id: 'decisions', name: 'Beslutninger', icon: '⑂' }, { id: 'analysis', name: 'Analyse', icon: '▥' }]
const introductions: Record<HQView, { title: string; detail: string }> = {
  overview: { title: 'Oversikt. Grunnlag. Neste steg.', detail: 'Et felles arbeidsrom for det vi vet, arbeidet vi gjør og resultatene vi kan dokumentere.' },
  knowledge: { title: 'Kunnskap med forbindelser.', detail: 'Les originalene, følg referansene og se hvilke oppgaver som bygger på kunnskapen.' },
  decisions: { title: 'Gjør innsikt til handling.', detail: 'Prioriter det som betyr noe, og knytt hver oppgave til et grunnlag og et etterprøvbart resultat.' },
  analysis: { title: 'Se arbeidet. Mål virkningen.', detail: 'Produktdata, registrerte resultater og synlige datagap. Aktivitet alene er ikke et effektmål.' },
}
function Sources({ sources }: { sources: HQSourceStatus[] }) {
  return <section className={`${styles.card} ${styles.sources}`} aria-label="Datakildenes tilgjengelighet"><div className={styles.cardHead}><div><span className={styles.overline}>Tilkoblinger og ferskhet</span><h2>Dette bygger arbeidsrommet på</h2></div><span className={styles.tag}>Kildestatus</span></div>{sources.length ? <div className={styles.sourceGrid}>{sources.map(source => <article key={source.id}><div className={styles.metaLine}><strong>{source.name}</strong><span className={source.state === 'available' ? styles.good : styles.warning}>{({ available: 'Tilgjengelig', partial: 'Delvis tilgjengelig', unavailable: 'Utilgjengelig' })[source.state]}</span></div><p>{source.detail}</p><small>Kontrollert {formatDate(source.checkedAt, true)}{typeof source.count === 'number' ? ` · ${source.count.toLocaleString('nb-NO')} registrert` : ''}</small></article>)}</div> : <div className={styles.empty}>Ingen kildestatus er returnert.</div>}</section>
}
function TaskList({ tasks, onSelect, onOpen, heading = 'Prioritert arbeid' }: { tasks: HQTask[]; onSelect: (id: string) => void; onOpen: (task: HQTask) => void; heading?: string }) {
  return <section className={styles.card}><div className={styles.cardHead}><div><span className={styles.overline}>Mission Control</span><h2>{heading}</h2></div><span className={styles.tag}>{tasks.length} i utvalget</span></div>{tasks.length ? <div className={styles.taskList}>{tasks.map(task => <article key={task.id}><button className={styles.taskMain} onClick={() => onSelect(`task:${task.id}`)}><span className={`${styles.priorityDot} ${['urgent', 'critical', 'high'].includes(task.priority) ? styles.priorityHigh : ''}`} /><span><span className={styles.taskEyebrow}>{projectNames[task.projectKey]} · {task.ticketRef || `#${task.id}`} · {priorityNames[task.priority] || task.priority}</span><strong>{task.title}</strong><small>{statusNames[task.status] || task.status} · {task.assignedTo || 'Ikke tildelt'} · {task.sourceIds.length ? `${task.sourceIds.length} kildehenvisninger` : 'Kildegrunnlag mangler'}</small></span></button><button className={styles.iconButton} onClick={() => onOpen(task)} aria-label={`Åpne ${task.title} i MC`}>↗</button></article>)}</div> : <div className={styles.empty}><strong>Ingen oppgaver i dette utvalget</strong><p>Velg en kilde og lag et konkret tiltak når det finnes et behov.</p></div>}</section>
}
export function HeadquartersPanel() {
  const router = useRouter()
  const [view, setView] = useState<HQView>('overview')
  const [project, setProject] = useState<ProjectFilter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [composer, setComposer] = useState<{ note?: HQNote } | null>(null)
  const snapshot = useHQResource<HQSnapshot>('/api/headquarters', refresh, 60_000)
  const delayedQuery = useDebouncedValue(query.trim())
  const searchUrl = delayedQuery ? `/api/headquarters/knowledge?q=${encodeURIComponent(delayedQuery)}${project !== 'all' ? `&project=${project}` : ''}` : null
  const search = useHQResource<HQSearchResponse>(searchUrl, refresh)
  const metrics = useHQResource<HQMetricsResponse>(view === 'analysis' ? `/api/headquarters/metrics${project !== 'all' ? `?project=${project}` : ''}` : null, refresh, 60_000)
  const data = snapshot.data
  const notes = useMemo(() => (data?.notes || []).filter(note => inProject(note, project)), [data, project])
  const tasks = useMemo(() => (data?.tasks || []).filter(task => inProject(task, project)), [data, project])
  const filteredNotes = useMemo(() => {
    if (!query.trim()) return notes
    if (delayedQuery === query.trim() && search.data && !search.error) return search.data.notes.filter(note => inProject(note, project))
    const normalized = query.toLocaleLowerCase('nb-NO').trim()
    return notes.filter(note => [note.title, note.summary, note.path, ...note.tags].join(' ').toLocaleLowerCase('nb-NO').includes(normalized))
  }, [notes, query, delayedQuery, search.data, search.error, project])
  const filteredTasks = useMemo(() => tasks.filter(task => !query.trim() || [task.title, task.description, task.ticketRef].join(' ').toLocaleLowerCase('nb-NO').includes(query.toLocaleLowerCase('nb-NO').trim())), [tasks, query])
  const allGraph = useMemo(() => graphData([...new Map([...notes, ...filteredNotes].map(note => [note.id, note])).values()], tasks, data?.links || []), [notes, filteredNotes, tasks, data])
  const graph = useMemo(() => graphData(filteredNotes, filteredTasks, data?.links || []), [filteredNotes, filteredTasks, data])
  const prioritized = useMemo(() => priorityTasks(filteredTasks), [filteredTasks])
  const selectedItem = allGraph.items.find(item => item.id === selected)
  const linkedCount = tasks.filter(task => task.sourceIds.length).length
  const resultCount = tasks.filter(task => task.evidence.length).length
  const sources = useMemo(() => [...new Map([...(data?.sources || []), ...(metrics.data?.sources || [])].map(source => [source.id, source])).values()], [data, metrics.data])
  useEffect(() => { setSelected(null) }, [project])
  useEffect(() => { if (!selected && notes.length) setSelected(notes[0].id) }, [selected, notes])
  const select = (id: string) => setSelected(id)
  const refreshAll = () => setRefresh(value => value + 1)
  const openTaskId = (id: number) => {
    // The existing task board filters by global activeProject before resolving taskId.
    useMissionControl.getState().setActiveProject(null)
    router.push(`${panelHref('tasks')}?taskId=${id}`, { scroll: false })
  }
  const openTask = (task: HQTask) => openTaskId(task.id)
  const initialProject: HQProjectKey = composer?.note?.projectKey || (project === 'all' ? 'shared' : project)
  return <div className={styles.hq}>
    <header className={styles.header}><div className={styles.brand}><span className={styles.brandGlyph} aria-hidden="true">i</span><div><span className={styles.overline}>Ines · hovedkvarter</span><p>Kunnskap som fører til handling</p></div></div><div className={styles.headerRight}><span className={snapshot.error ? styles.warning : styles.syncStatus}><i />{snapshot.error ? 'Oppdatering feilet' : snapshot.loading ? 'Oppdaterer …' : data ? `Hentet ${formatDate(data.generatedAt, true)}` : 'Venter på datakilder'}</span><button className={styles.secondaryButton} onClick={refreshAll} disabled={snapshot.loading} aria-label="Oppdater hovedkvarteret">↻ <span>Oppdater</span></button></div></header>
    <div className={styles.navigation}><nav aria-label="Hovedkvarterets visninger">{views.map(tab => <button key={tab.id} onClick={() => setView(tab.id)} aria-current={view === tab.id ? 'page' : undefined}><span aria-hidden="true">{tab.icon}</span>{tab.name}</button>)}</nav><label className={styles.projectSelect}><span>Prosjekt</span><select value={project} onChange={event => setProject(event.target.value as ProjectFilter)}>{(['all', 'babyhub', 'babysential', 'brrrr', 'shared'] as const).map(key => <option key={key} value={key}>{projectNames[key]}</option>)}</select></label></div>
    <div className={styles.intro}><div><span className={styles.overline}>{projectNames[project]} · {view === 'analysis' ? 'Resultater og datagrunnlag' : 'Arbeidsrom'}</span><h1>{introductions[view].title}</h1><p>{introductions[view].detail}</p></div><button className={styles.button} onClick={() => setComposer({})}>＋ Ny MC-oppgave</button></div>
    {snapshot.error && <div className={styles.error} role="alert"><strong>Vi kunne ikke oppdatere hovedkvarteret.</strong><p>{snapshot.error}</p>{data && <p>Sist hentede data vises med originalt tidspunkt. De er ikke bekreftet oppdaterte.</p>}<button className={styles.textButton} onClick={refreshAll}>Prøv igjen</button></div>}
    {!data && snapshot.loading ? <div className={`${styles.card} ${styles.empty}`} role="status"><span className={styles.loadingGlyph} aria-hidden="true">◌</span><strong>Samler kilder, oppgaver og drift</strong><p>Arbeidsrommet fylles fra de faktiske datakildene.</p></div> : !data ? <Sources sources={[]} /> : <>
      <div className={styles.summaryGrid}><article><span>Dokumenter i prosjektutvalget</span><strong>{notes.length.toLocaleString('nb-NO')}</strong><small>{data.coverage.truncated ? `Avgrenset indeks · maks ${data.coverage.limit}` : 'Fra den tilgjengelige vault-indeksen'}</small></article><article><span>Åpne oppgaver i utvalget</span><strong>{priorityTasks(tasks).length.toLocaleString('nb-NO')}</strong><small>Prioritert utvalg · maks 200 oppgaver · {linkedCount} med kilder</small></article><article><span>Oppgaver med bevis i utvalget</span><strong>{resultCount.toLocaleString('nb-NO')}</strong><small>Samme prioriterte utvalg · bevis er ikke automatisk målt effekt</small></article></div>
      <div className={styles.searchBar}><label className={styles.search}><span aria-hidden="true">⌕</span><span className={styles.srOnly}>Søk i hovedkvarterets kunnskap og oppgaver</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Finn en kilde, beslutning eller oppgave …" /></label><span className={styles.searchEngine}>{query.trim() ? search.loading || delayedQuery !== query.trim() ? 'Søker · lokale treff vises først' : !search.error && search.data?.engine === 'qmd' ? 'QMD · kunnskapssøk' : 'Lokalt søk i lastet indeks' : 'Kilder og oppgaver · samme arbeidsrom'}</span></div>
      {search.error && query.trim() && <p className={styles.warning} role="status">Kunnskapssøket svarte ikke: {search.error}. Lokale treff vises.</p>}{!search.error && search.data?.detail && query.trim() && <p className={styles.searchDetail}>{search.data.detail}</p>}
      <div className={styles.mainGrid}><div className={styles.mainColumn}>
        {view === 'overview' && <><div className={styles.questions}><button onClick={() => setView('decisions')}><span>01 · PRIORITER</span><strong>Hva bør vi gjøre nå?</strong><small>Velg det neste nyttige tiltaket ↗</small></button><button onClick={() => setView('knowledge')}><span>02 · FORSTÅ</span><strong>Hva bygger vi på?</strong><small>Følg kilden og resonnementet ↗</small></button><button onClick={() => setView('analysis')}><span>03 · LÆR</span><strong>Hva ble resultatet?</strong><small>Se bevis og faktisk måling ↗</small></button></div><HQGraph {...graph} selected={selected} onSelect={select} /><TaskList tasks={prioritized.slice(0, 6)} onSelect={select} onOpen={openTask} /><div className={styles.operationsGrid}><section className={styles.card}><div className={styles.cardHead}><div><span className={styles.overline}>Agenter · drift</span><h2>Hvem er i arbeid?</h2></div><button className={styles.iconButton} onClick={() => router.push(panelHref('agents'))} aria-label="Åpne agentoversikten">↗</button></div>{data.agents.length ? <div className={styles.agentList}>{data.agents.slice(0, 8).map(agent => <article key={agent.name}><span className={styles.agentAvatar}>{agent.name.slice(0, 1).toUpperCase()}</span><div><strong>{agent.name}</strong><small>{agent.role || 'Rolle ikke oppgitt'}</small></div><div><span className={styles.tag}>{agent.status || 'Ukjent'}</span><small>{agent.updatedAt ? formatDate(agent.updatedAt, true) : 'Tidspunkt ukjent'}</small></div></article>)}</div> : <div className={styles.empty}>Ingen agentstatus tilgjengelig.</div>}</section><section className={styles.card}><div className={styles.cardHead}><div><span className={styles.overline}>Arbeidsrommets aktivitet</span><h2>Siste bevegelser</h2></div><span className={styles.tag}>Alle prosjekter</span></div>{data.activity.length ? <ol className={styles.activityList}>{data.activity.slice(0, 6).map(activity => <li key={activity.id}><span className={styles.activityDot} /><div>{activity.taskId ? <button onClick={() => openTaskId(activity.taskId!)}>{activity.description}</button> : <p>{activity.description}</p>}<small>{activity.actor} · {formatDate(activity.createdAt, true)}</small></div></li>)}</ol> : <div className={styles.empty}>Ingen aktivitet returnert.</div>}</section></div></>}
        {view === 'knowledge' && <><HQGraph {...graph} selected={selected} onSelect={select} /><section className={styles.card}><div className={styles.cardHead}><h2>Dokumenter i utvalget</h2><span className={styles.tag}>{filteredNotes.length} treff</span></div><div className={styles.documentList}>{filteredNotes.slice(0, 30).map(note => <button key={note.id} onClick={() => select(note.id)} aria-pressed={selected === note.id}><span className={styles.documentIcon} aria-hidden="true">▤</span><span><strong>{note.title}</strong><small>{kindNames[note.kind]} · {projectNames[note.projectKey]} · {formatDate(note.modifiedAt, true)}</small></span><span aria-hidden="true">↗</span></button>)}{!filteredNotes.length && <p className={styles.empty}>Ingen dokumenter matcher søket i dette prosjektet.</p>}{filteredNotes.length > 30 && <p className={styles.searchDetail}>De første 30 treffene vises her. Bruk grafens liste eller avgrens søket.</p>}</div></section></>}
        {view === 'decisions' && <><section className={styles.card}><div className={styles.cardHead}><div><span className={styles.overline}>Dokumenterte resonnementer</span><h2>Beslutninger og læring</h2></div></div><div className={styles.decisionList}>{filteredNotes.filter(note => ['decision', 'learning'].includes(note.kind)).slice(0, 12).map(note => <article key={note.id}><div className={styles.metaLine}><span>{projectNames[note.projectKey]}</span><span className={styles.tag}>{kindNames[note.kind]}</span></div><h3>{note.title}</h3><p>{note.summary || 'Åpne originalen for å lese resonnementet.'}</p><div><button className={styles.textButton} onClick={() => select(note.id)}>Undersøk grunnlaget ↗</button><button className={styles.secondaryButton} onClick={() => setComposer({ note })}>Lag konkret tiltak</button></div></article>)}{!filteredNotes.some(note => ['decision', 'learning'].includes(note.kind)) && <div className={styles.empty}><strong>Ingen beslutningsnotater i utvalget</strong><p>Registrerte MC-oppgaver vises nedenfor. Les kildene før du lager et nytt tiltak.</p></div>}</div></section><TaskList tasks={prioritized} onSelect={select} onOpen={openTask} heading="Arbeid som venter på handling" /></>}
        {view === 'analysis' && <><HQMetrics data={metrics.data} loading={metrics.loading} error={metrics.error} /><TaskList tasks={filteredTasks.filter(task => task.evidence.length || task.measurementStatus === 'observed')} onSelect={select} onOpen={openTask} heading="Oppgaver med registrert resultat" /><section className={`${styles.card} ${styles.learningLoop}`}><span className={styles.overline}>Lukk sløyfen</span><h2>Et resultat skal endre det vi vet.</h2><p>Velg en oppgave, registrer det som faktisk ble observert, og lagre varig læring i vault. Bevisregistrering endrer ikke automatisk oppgavens ferdigstatus.</p></section></>}
      </div><KnowledgeInspector selected={selected} item={selectedItem} items={allGraph.items} links={allGraph.links} refresh={refresh} onSelect={select} onCreate={note => setComposer({ note })} onOpenTask={openTask} onRefresh={refreshAll} /></div>
      <Sources sources={sources} /><footer className={styles.footer}><span>Vault → kunnskap → MC-oppgave → bevis → læring og måling</span><span>Indeks: {data.coverage.indexed.toLocaleString('nb-NO')} dokumenter{data.coverage.truncated ? ' · avgrenset utvalg' : ''} · automatisk oppdatering hvert minutt når siden er synlig</span></footer>
    </>}
    {composer && <TaskComposer notes={data?.notes || notes} selectedNote={composer.note} initialProject={initialProject} onClose={() => setComposer(null)} onCreated={refreshAll} onOpenTask={openTask} />}
  </div>
}
