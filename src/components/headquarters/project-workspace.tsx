'use client'
import type { HQAgent, HQMetricsResponse, HQNote, HQProject, HQTask } from '@/lib/hq-types'
import { formatDate, priorityTasks, statusNames, safeExternalUrl } from './hq-data'
import { HQMetrics } from './hq-metrics'
import styles from './headquarters.module.css'

const projectRoleNames = new Map([
  ['coordinator', 'Koordinator'],
  ['content', 'Innhold'],
  ['research', 'Kildesøk'],
  ['reviewer', 'Kvalitetskontroll'],
  ['analyst', 'Analyse'],
  ['implementation', 'Utvikling'],
  ['architecture', 'Arkitektur'],
  ['member', 'Prosjektdeltaker'],
])

function teamRole(project: HQProject, name: string, agent?: HQAgent): string {
  const projectRole = project.assignedAgentRoles && Object.hasOwn(project.assignedAgentRoles, name)
    ? project.assignedAgentRoles[name].trim() : ''
  return projectRole ? projectRoleNames.get(projectRole.toLowerCase()) || projectRole : agent?.role || 'Rolle ikke tilgjengelig'
}

interface ProjectActions {
  onChoose: (project: HQProject) => void
  onManage: (projectId?: number) => void
}
export function ProjectHub({ projects, onChoose, onManage }: { projects: HQProject[] } & ProjectActions) {
  return <section aria-label="Prosjektoversikt" className={styles.projectHub}>
    <div className={styles.sectionHeading}><div><span className={styles.overline}>Ett arbeidsrom per prosjekt</span><h2>Prosjektene våre</h2></div><button className={styles.secondaryButton} onClick={() => onManage()}>＋ Nytt prosjekt / administrer</button></div>
    <div className={styles.projectGrid}>{projects.map(project => <article className={`${styles.card} ${styles.projectCard}`} key={project.id} style={{ '--project-color': project.color } as React.CSSProperties}>
      <div className={styles.metaLine}><span className={styles.projectMark}>{project.name.slice(0, 2)}</span><span>{project.assignedAgents?.length || 0} i teamet</span></div>
      <button className={styles.projectTitle} onClick={() => onChoose(project)}><h3>{project.name}</h3><span aria-hidden="true">↗</span></button>
      <p>{project.description || 'Mål og retning er ikke registrert ennå.'}</p>
      <dl className={styles.projectNumbers}><div><dt>Åpne oppgaver</dt><dd>{project.taskCounts?.open ?? 'Ukjent'}</dd></div><div><dt>Pågår</dt><dd>{project.taskCounts?.inProgress ?? 'Ukjent'}</dd></div><div><dt>Egne dokumenter</dt><dd>{project.key ? project.noteCount : 'Ikke koblet'}</dd></div></dl>
      <div className={styles.metaLine}><span>{project.deadline ? `Frist ${formatDate(project.deadline.slice(0, 10))}` : 'Ingen frist registrert'}</span><button className={styles.textButton} onClick={() => onManage(project.id ?? undefined)} aria-label={`Rediger ${project.name}`}>Team og mål</button></div>
    </article>)}</div>
    {!projects.length && <div className={`${styles.card} ${styles.empty}`}><strong>Ingen aktive prosjekter</strong><p>Opprett et prosjekt for å samle team, oppgaver og resultater.</p></div>}
  </section>
}

export function ProjectWorkspace({ project, notes, tasks, agents, metrics, onManage, onSelect, onOpenTask, onTasks, onKnowledge, onCreate }: {
  project: HQProject; notes: HQNote[]; tasks: HQTask[]; agents: HQAgent[]
  metrics: { data: HQMetricsResponse | null; loading: boolean; error: string | null }
  onManage: () => void; onSelect: (id: string) => void; onOpenTask: (task: HQTask) => void
  onTasks: () => void; onKnowledge: () => void; onCreate: () => void
}) {
  const ownNotes = notes.filter(note => note.projectKey === project.key)
  const sharedNotes = notes.filter(note => note.projectKey === 'shared' && project.key !== 'shared')
  const nextTasks = priorityTasks(tasks).slice(0, 6)
  const results = tasks.filter(task => task.evidence.length).slice(0, 5)
  const githubUrl = project.githubRepo && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(project.githubRepo) ? safeExternalUrl(`https://github.com/${project.githubRepo}`) : undefined
  return <div className={styles.mainColumn}>
    <section className={`${styles.card} ${styles.projectBrief}`}>
      <div className={styles.cardHead}><div><span className={styles.overline}>Mål og retning</span><h2>{project.name}</h2></div><button className={styles.secondaryButton} onClick={onManage}>Rediger prosjekt</button></div>
      <div className={styles.projectBody}><p className={styles.projectGoal}>{project.description || 'Beskriv hva prosjektet skal oppnå og hvordan vi vurderer fremgang.'}</p><div className={styles.metaLine}><span>{project.deadline ? `Frist: ${formatDate(project.deadline.slice(0, 10))}` : 'Frist er ikke satt'}</span>{githubUrl && <a href={githubUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{project.githubRepo} ↗</a>}</div></div>
    </section>
    <div className={styles.summaryGrid}><article><span>Åpne oppgaver</span><strong>{project.taskCounts?.open ?? '—'}</strong><small>Alle oppgaver i dette prosjektet</small></article><article><span>Blokkerte oppgaver</span><strong>{project.taskCounts?.blocked ?? '—'}</strong><small>Krever avklaring eller hjelp</small></article><article><span>Ferdigmarkerte oppgaver</span><strong>{project.taskCounts?.done ?? '—'}</strong><small>Status i MC · effekt må dokumenteres</small></article></div>
    <section className={styles.card}><div className={styles.cardHead}><div><span className={styles.overline}>Prioritert fra prosjektets oppgaver</span><h2>Neste steg</h2></div><button className={styles.textButton} onClick={onTasks}>Hele oppgavebrettet ↗</button></div>
      {nextTasks.length ? <div className={styles.taskList}>{nextTasks.map(task => <article key={task.id}><button className={styles.taskMain} onClick={() => onSelect(`task:${task.id}`)}><span><span className={styles.taskEyebrow}>{task.ticketRef || `#${task.id}`} · {statusNames[task.status] || task.status}</span><strong>{task.title}</strong><small>{task.assignedTo || 'Ikke tildelt'} · {task.sourceIds.length} kilder</small></span></button><button className={styles.iconButton} onClick={() => onOpenTask(task)} aria-label={`Åpne ${task.title} i MC`}>↗</button></article>)}</div> : <div className={styles.empty}>Ingen åpne oppgaver i det hentede utvalget.</div>}
      <div className={styles.projectBody}><p className={styles.muted}>Viser de første seks av inntil 200 prioriterte oppgaver. Opptellingene over gjelder hele prosjektet.</p><button className={styles.textButton} onClick={onCreate}>＋ Lag et tiltak med kildegrunnlag</button></div>
    </section>
    <section className={styles.card}><div className={styles.cardHead}><div><span className={styles.overline}>Registrerte prosjektroller</span><h2>Teamet</h2></div><button className={styles.textButton} onClick={onManage}>Legg til / fjern agenter</button></div>
      {project.assignedAgents?.length ? <div className={styles.agentList}>{project.assignedAgents.map(name => { const agent = agents.find(item => item.name === name); return <article key={name}><span className={styles.agentAvatar}>{name.slice(0, 1).toUpperCase()}</span><div><strong>{name}</strong><small>{teamRole(project, name, agent)}</small></div><div><span className={styles.tag}>{agent?.status || 'Status ukjent'}</span><small>{agent?.updatedAt ? formatDate(agent.updatedAt, true) : 'Tidspunkt ukjent'}</small></div></article> })}</div> : <div className={styles.empty}><strong>Velg et fast team</strong><p>Agenter kan bidra i flere prosjekter. Legg dem til for å gjøre ansvarsfordelingen synlig.</p></div>}
      <p className={`${styles.projectBody} ${styles.muted}`}>Teamtilknytning starter ingen kjøring og gir ingen egen tilgangsgrense. Oppgavens ansvarlige og faktiske kjøringer avgjør hvem som utfører arbeidet.</p>
    </section>
    <section className={styles.card}><div className={styles.cardHead}><div><span className={styles.overline}>Tillatt kunnskapsgrunnlag</span><h2>Kilder og læring</h2></div><button className={styles.textButton} onClick={onKnowledge}>Utforsk kunnskapen ↗</button></div>
      <div className={styles.projectBody}><p>{project.key ? `${ownNotes.length} egne dokumenter er tilgjengelige i vault-indeksen.` : 'Ingen egen kunnskapsmappe er koblet til dette prosjektet ennå.'}{sharedNotes.length > 0 && ` ${sharedNotes.length} felles dokumenter er også tilgjengelige som metodegrunnlag.`}</p><p className={styles.muted}>Et nytt prosjekt åpner ikke automatisk nye mapper. Prosjektets kildeområde må kobles til eksplisitt.</p></div>
      <div className={styles.documentList}>{ownNotes.slice().sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 5).map(note => <button key={note.id} onClick={() => onSelect(note.id)}><span className={styles.documentIcon}>▤</span><span><strong>{note.title}</strong><small>{formatDate(note.modifiedAt, true)}</small></span><span aria-hidden="true">↗</span></button>)}</div>
    </section>
    <section className={styles.card}><div className={styles.cardHead}><div><span className={styles.overline}>Registrert grunnlag for læring</span><h2>Resultater med bevis</h2></div></div>{results.length ? <div className={styles.documentList}>{results.map(task => <button key={task.id} onClick={() => onSelect(`task:${task.id}`)}><span><strong>{task.title}</strong><small>{task.evidence.length} bevis · {task.measurementStatus === 'observed' ? 'Observasjon registrert' : 'Effekt er ikke målt'}</small></span><span aria-hidden="true">↗</span></button>)}</div> : <div className={styles.empty}>Ingen resultatbevis i de inntil 200 oppgavene som er hentet. Hele historikken finnes på oppgavebrettet.</div>}</section>
    <HQMetrics {...metrics} />
  </div>
}
