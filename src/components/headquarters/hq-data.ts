import type { HQLink, HQNote, HQProject, HQProjectKey, HQTask } from '@/lib/hq-types'

export type ProjectFilter = HQProjectKey | 'all' | `project:${number}`
export const projectNames: Record<HQProjectKey | 'all', string> = { all: 'Alle prosjekter', babyhub: 'BabyHub', babysential: 'Babysential', brrrr: 'brRRR', shared: 'Felles' }
export const projectColors: Record<HQProjectKey, string> = { babyhub: '#b4e6cf', babysential: '#b8c7f9', brrrr: '#e4c495', shared: '#b6c5d3' }
export const kindNames = { source: 'Kilde', knowledge: 'Kunnskap', decision: 'Beslutning', learning: 'Læring', task: 'MC-oppgave' }
export const relationNames: Record<HQLink['kind'], string> = { wikilink: 'Wikilenke', markdown: 'Dokumentlenke', 'task-source': 'Kilde for oppgave', evidence: 'Resultat / læring' }
export const statusNames: Record<string, string> = { inbox: 'Innboks', assigned: 'Tildelt', in_progress: 'Pågår', review: 'Til gjennomgang', quality_review: 'Kvalitetskontroll', done: 'Ferdig', blocked: 'Blokkert', backlog: 'Planlagt', todo: 'Planlagt', open: 'Åpen', cancelled: 'Avbrutt', failed: 'Mislyktes', wontfix: 'Avsluttet uten tiltak', awaiting_owner: 'Venter på eier' }
export const priorityNames: Record<string, string> = { low: 'Lav', medium: 'Normal', high: 'Høy', urgent: 'Haster', critical: 'Kritisk' }
export function inProject(item: { projectKey: HQProjectKey; projectId?: number | null }, project: ProjectFilter, projects: HQProject[] = []) {
  if (project === 'all') return true
  if (project.startsWith('project:')) {
    const record = projects.find(value => value.id === Number(project.slice(8)))
    if (!record) return false
    if ('projectId' in item) return item.projectId === record.id
    return item.projectKey === 'shared' || item.projectKey === record.key
  }
  return item.projectKey === project || (!('projectId' in item) && item.projectKey === 'shared')
}
export function taskProjectName(task: HQTask) { return task.projectName || projectNames[task.projectKey] }
export function isOpenTask(task: HQTask) { return !['done', 'completed', 'cancelled', 'archived', 'failed', 'wontfix'].includes(task.status) }
export function priorityTasks(tasks: HQTask[]) {
  const rank: Record<string, number> = { critical: 0, urgent: 1, high: 2, medium: 3, low: 4 }
  return tasks.filter(isOpenTask).slice().sort((a, b) => (rank[a.priority] ?? 5) - (rank[b.priority] ?? 5) || b.updatedAt.localeCompare(a.updatedAt))
}
export function formatDate(value?: string | null, short = false) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'Tidspunkt ikke tilgjengelig'
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Intl.DateTimeFormat('nb-NO', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value))
  return new Intl.DateTimeFormat('nb-NO', short ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
export function safeExternalUrl(value?: string): string | undefined {
  if (!value) return undefined
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined } catch { return undefined }
}
export function safeEvidenceUrl(value?: string): string | undefined {
  if (value && /^\/api\/v1\/runs\/[a-zA-Z0-9_-]+\/provenance$/.test(value)) return value
  return safeExternalUrl(value)
}
export interface GraphItem { id: string; title: string; projectKey: HQProjectKey; kind: keyof typeof kindNames; note?: HQNote; task?: HQTask }
export function graphData(notes: HQNote[], tasks: HQTask[], links: HQLink[]) {
  const items: GraphItem[] = [...notes.map(note => ({ id: note.id, title: note.title, projectKey: note.projectKey, kind: note.kind, note })), ...tasks.map(task => ({ id: `task:${task.id}`, title: task.title, projectKey: task.projectKey, kind: 'task' as const, task }))]
  const ids = new Set(items.map(item => item.id))
  const relations = [...links, ...tasks.flatMap(task => [...task.sourceIds.map(source => ({ source, target: `task:${task.id}`, kind: 'task-source' as const })), ...(task.learningNoteIds || []).map(target => ({ source: `task:${task.id}`, target, kind: 'evidence' as const }))])]
  const seen = new Set<string>()
  return { items, links: relations.filter(link => { const key = `${link.source}:${link.target}:${link.kind}`; if (!ids.has(link.source) || !ids.has(link.target) || seen.has(key)) return false; seen.add(key); return true }) }
}
// Keep the selected item's immediate evidence neighborhood in the bounded canvas.
export function graphWindow(items: GraphItem[], links: HQLink[], selected: string | null, limit = 40) {
  const neighbors = new Set(links.filter(link => link.source === selected || link.target === selected).flatMap(link => [link.source, link.target]))
  const ranked = items.slice().sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || Number(neighbors.has(b.id)) - Number(neighbors.has(a.id)))
  const visible = ranked.slice(0, limit)
  const ids = new Set(visible.map(item => item.id))
  return { items: visible, links: links.filter(link => ids.has(link.source) && ids.has(link.target)) }
}
