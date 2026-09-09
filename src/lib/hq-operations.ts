import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDatabase } from '@/lib/db'
import { normalizeTaskMetadata } from '@/lib/mc-agentic-os'
import type { HQProject, HQProjectKey, HQTask, HQNote, HQEvidence, HQAgent, HQActivity, HQTaskCreateInput } from '@/lib/hq-types'

type Row = Record<string, unknown>
export function asObject(value: unknown): Row {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row
  try { const parsed = JSON.parse(String(value || '{}')); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} } catch { return {} }
}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
const text = (value: unknown) => typeof value === 'string' ? value : ''
const date = (value: unknown): string => {
  const parsed = typeof value === 'number' ? new Date(value * 1000)
    : typeof value === 'string' ? new Date(value) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : ''
}
export function projectKeyFor(name: unknown, slug?: unknown): HQProjectKey | null {
  for (const candidate of [slug, name]) {
    const normalized = String(candidate || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '')
    if (normalized === 'babyhub' || normalized === 'babysential' || normalized === 'brrrr') return normalized
  }
  return null
}
export function safeEvidenceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  if (/^\/api\/v1\/runs\/[a-zA-Z0-9_-]+\/provenance$/.test(value)) return value
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined } catch { return undefined }
}
function evidenceFrom(value: unknown): HQEvidence[] {
  if (!Array.isArray(value)) return []
  return value.slice(-30).flatMap(item => {
    if (typeof item === 'string') return [{ label: 'Registrert bevis', detail: item.slice(0, 4000) }]
    const entry = asObject(item)
    const label = text(entry.label || entry.title || entry.type).slice(0, 160)
    const detail = text(entry.detail || entry.summary || entry.description || entry.path).slice(0, 4000)
    const url = safeEvidenceUrl(entry.url || entry.href)
    return label || detail || url ? [{ label: label || 'Registrert bevis', detail, url, createdAt: date(entry.createdAt || entry.created_at) || undefined }] : []
  })
}
export function mapHQTask(row: Row, notes: HQNote[] = []): HQTask {
  const metadata = asObject(row.metadata)
  const hq = asObject(metadata.hq)
  const contract = asObject(metadata.workflow_contract)
  const agentic = asObject(metadata.agentic_os)
  const known = new Set(notes.map(note => note.id))
  const explicitIds = strings(hq.source_ids).filter(id => !notes.length || known.has(id))
  const contextPaths = new Set([...strings(contract.context_pack_sources), ...strings(hq.source_paths)])
  const sourceIds = [...new Set([...explicitIds, ...notes.filter(note => contextPaths.has(note.path) || contextPaths.has('vault/' + note.path)).map(note => note.id)])]
  const evidence = evidenceFrom(agentic.evidence)
  if (text(row.resolution)) evidence.push({ label: 'Registrert resultat', detail: text(row.resolution).slice(0, 4000), createdAt: date(row.completed_at || row.updated_at) })
  const key = projectKeyFor(row.project_name, row.project_slug) || (['babyhub','babysential','brrrr','shared'].includes(text(hq.project_key)) ? text(hq.project_key) as HQProjectKey : 'shared')
  return {
    id: Number(row.id), title: text(row.title), description: text(row.description), status: text(row.status), priority: text(row.priority),
    projectName: text(row.project_name) || undefined,
    projectId: typeof row.project_id === 'number' ? row.project_id : null, projectKey: key,
    assignedTo: text(row.assigned_to) || null, ticketRef: row.project_prefix && row.project_ticket_no ? String(row.project_prefix) + '-' + String(row.project_ticket_no).padStart(3,'0') : null,
    updatedAt: date(row.updated_at), sourceIds, learningNoteIds: strings(hq.learning_note_ids), acceptanceCriteria: strings(hq.acceptance_criteria),
    expectedOutcome: text(hq.expected_outcome) || null, evidence,
    measurementStatus: asObject(hq.measurement).observed_at ? 'observed' : 'unmeasured',
  }
}
export function readHQOperations(workspaceId: number, notes: HQNote[], db: Database.Database = getDatabase(), focusedProjectId?: number) {
  // Project IDs define work membership. Knowledge keys only map the existing approved vault roots.
  const rows = db.prepare(`SELECT p.id,p.name,p.slug,p.description,p.color,p.github_repo,p.deadline,p.ticket_prefix,
    COUNT(t.id) AS total,
    SUM(CASE WHEN t.id IS NOT NULL AND t.status NOT IN ('done','completed','cancelled','archived','failed','wontfix') THEN 1 ELSE 0 END) AS open,
    SUM(CASE WHEN t.status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
    SUM(CASE WHEN t.status='blocked' THEN 1 ELSE 0 END) AS blocked,
    SUM(CASE WHEN t.status IN ('done','completed') THEN 1 ELSE 0 END) AS done
    FROM projects p LEFT JOIN tasks t ON t.project_id=p.id AND t.workspace_id=p.workspace_id
    WHERE p.workspace_id=? AND p.status='active' GROUP BY p.id ORDER BY p.name COLLATE NOCASE`).all(workspaceId) as Row[]
  const assignments = db.prepare(`SELECT paa.project_id,paa.agent_name,paa.role FROM project_agent_assignments paa
    JOIN projects p ON p.id=paa.project_id WHERE p.workspace_id=? AND p.status='active' ORDER BY paa.agent_name`).all(workspaceId) as Row[]
  const projects: HQProject[] = rows.map(row => {
    const key = projectKeyFor(row.name, row.slug) || (row.slug === 'general' ? 'shared' : null)
    const projectAssignments = assignments.filter(assignment => assignment.project_id === row.id)
    return { id: Number(row.id), key, name: text(row.name), slug: text(row.slug), ticketPrefix: text(row.ticket_prefix), description: text(row.description),
      color: /^#[a-f0-9]{6}$/i.test(text(row.color)) ? text(row.color) : '#83b8dc',
      noteCount: key ? notes.filter(note => note.projectKey === key).length : 0,
      assignedAgents: projectAssignments.map(assignment => text(assignment.agent_name)),
      assignedAgentRoles: Object.fromEntries(projectAssignments.filter(assignment => text(assignment.role).trim()).map(assignment => [text(assignment.agent_name), text(assignment.role).trim()])),
      githubRepo: text(row.github_repo) || null, deadline: date(row.deadline) || null,
      taskCounts: { total: Number(row.total), open: Number(row.open), inProgress: Number(row.in_progress), blocked: Number(row.blocked), done: Number(row.done) },
    }
  })
  if (focusedProjectId !== undefined && !projects.some(project => project.id === focusedProjectId)) throw new HQInputError('Prosjektet finnes ikke i dette arbeidsområdet.', 404)
  const taskRows = db.prepare(`SELECT t.*,p.name AS project_name,p.slug AS project_slug,p.ticket_prefix AS project_prefix
    FROM tasks t JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id
    WHERE t.workspace_id=? AND p.status='active' ${focusedProjectId !== undefined ? 'AND p.id=?' : ''}
    ORDER BY CASE WHEN t.status IN ('in_progress','review','quality_review') THEN 0 WHEN t.status IN ('done','completed','cancelled','archived','failed','wontfix') THEN 2 ELSE 1 END,
    CASE t.priority WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,t.updated_at DESC LIMIT 200`).all(workspaceId,...(focusedProjectId !== undefined ? [focusedProjectId] : [])) as Row[]
  const tasks = taskRows.map(row => mapHQTask(row,notes))
  const taskIds = tasks.map(t => t.id)
  let activity: HQActivity[] = []
  if (taskIds.length) {
    const params = taskIds.map(() => '?').join(',')
    const runs = db.prepare(`SELECT id,task_id,status,outcome,ended_at,started_at FROM runs WHERE workspace_id=? AND CAST(task_id AS INTEGER) IN (${params}) ORDER BY created_at DESC LIMIT 100`).all(workspaceId,...taskIds) as Row[]
    for (const run of runs) {
      const task = tasks.find(task => task.id === Number(run.task_id))
      if (task && task.evidence.length < 35) task.evidence.push({ label: 'Kjøring: ' + text(run.status), detail: text(run.outcome) || 'Utførelseslogg; produkteffekt er ikke målt her.', url: '/api/v1/runs/' + encodeURIComponent(String(run.id)) + '/provenance', createdAt: date(run.ended_at || run.started_at) })
    }
    activity = (db.prepare(`SELECT id,description,actor,created_at,entity_id FROM activities WHERE workspace_id=? AND entity_type='task' AND entity_id IN (${params}) ORDER BY created_at DESC LIMIT 15`).all(workspaceId,...taskIds) as Row[]).map(row => ({ id:Number(row.id),description:text(row.description),actor:text(row.actor),createdAt:date(row.created_at),taskId:Number(row.entity_id) }))
  }
  const agents: HQAgent[] = (db.prepare('SELECT name,role,status,last_seen,updated_at FROM agents WHERE workspace_id=? ORDER BY name LIMIT 40').all(workspaceId) as Row[]).map(row => ({
    name:text(row.name),role:text(row.role),status:text(row.status),updatedAt:date(row.last_seen || row.updated_at) || null,
  }))
  return { projects,tasks,agents,activity }
}
export function getHQTask(id: number, workspaceId: number, db: Database.Database = getDatabase()): HQTask | null {
  const row = db.prepare(`SELECT t.*,p.name AS project_name,p.slug AS project_slug,p.ticket_prefix AS project_prefix
    FROM tasks t LEFT JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id WHERE t.id=? AND t.workspace_id=?`).get(id,workspaceId) as Row | undefined
  if (!row || (!row.project_name && asObject(asObject(row.metadata).hq).origin !== 'headquarters')) return null
  return mapHQTask(row)
}
export class HQInputError extends Error { constructor(message: string, public status=400) { super(message) } }
export function createHQTask(input: HQTaskCreateInput, workspaceId: number, actor: string, notes: HQNote[], db: Database.Database = getDatabase()): { task: HQTask; created: boolean } {
  const noteMap = new Map(notes.map(note => [note.id,note]))
  const sourceNotes = input.sourceIds.map(id => noteMap.get(id))
  if (sourceNotes.some(note => !note || (note.projectKey !== 'shared' && note.projectKey !== input.projectKey))) throw new HQInputError('En kilde mangler eller tilhører et annet prosjekt.')
  const bodyHash = createHash('sha256').update(JSON.stringify({ ...input, sourceIds:[...input.sourceIds].sort(),idempotencyKey:undefined })).digest('hex')
  const result = db.transaction(() => {
    const existing = db.prepare(`SELECT id,metadata FROM tasks WHERE workspace_id=? AND json_valid(metadata) AND json_extract(metadata,'$.hq.idempotency_key')=? LIMIT 1`).get(workspaceId,input.idempotencyKey) as Row | undefined
    if (existing) {
      if (asObject(asObject(existing.metadata).hq).body_hash !== bodyHash) throw new HQInputError('Forslaget er endret. Opprett en ny forespørsel.',409)
      return { id:Number(existing.id),created:false }
    }
    const rows = db.prepare('SELECT id,name,slug FROM projects WHERE workspace_id=? AND status=\'active\' ORDER BY id').all(workspaceId) as Row[]
    const project = rows.find(row => input.projectId !== undefined ? row.id === input.projectId : input.projectKey === 'shared' ? row.slug === 'general' : projectKeyFor(row.name,row.slug) === input.projectKey)
    if (!project) throw new HQInputError('Prosjektet er ikke koblet til MC. Opprett prosjektet i prosjektvelgeren først.',409)
    const knowledgeKey = projectKeyFor(project.name, project.slug) || 'shared'
    if (input.projectKey !== knowledgeKey) throw new HQInputError('Kildeprosjektet stemmer ikke med valgt MC-prosjekt.')
    const now = Math.floor(Date.now()/1000)
    db.prepare('UPDATE projects SET ticket_counter=ticket_counter+1,updated_at=? WHERE id=? AND workspace_id=?').run(now,project.id,workspaceId)
    const counter = db.prepare('SELECT ticket_counter FROM projects WHERE id=? AND workspace_id=?').get(project.id,workspaceId) as {ticket_counter:number}
    const metadata = normalizeTaskMetadata({
      hq:{origin:'headquarters',project_key:input.projectKey,idempotency_key:input.idempotencyKey,body_hash:bodyHash,source_ids:input.sourceIds,source_paths:sourceNotes.map(note => note!.path),acceptance_criteria:input.acceptanceCriteria,expected_outcome:input.expectedOutcome,created_at:new Date().toISOString()},
      workflow_contract:{context_pack_sources:sourceNotes.map(note => 'vault/'+note!.path),proof_expected:input.acceptanceCriteria.join('\n'),verify_required:true},
    },{title:input.title,description:input.description,priority:input.priority,status:'inbox',tags:['headquarters']})
    const insert = db.prepare(`INSERT INTO tasks(title,description,status,priority,project_id,project_ticket_no,assigned_to,created_by,created_at,updated_at,tags,metadata,workspace_id) VALUES(?,?,'inbox',?,?,?,NULL,?,?,?,?,?,?)`).run(
      input.title,input.description,input.priority,project.id,counter.ticket_counter,actor,now,now,JSON.stringify(['headquarters']),JSON.stringify(metadata),workspaceId,
    )
    const id = Number(insert.lastInsertRowid)
    db.prepare(`INSERT INTO activities(type,entity_type,entity_id,actor,description,data,created_at,workspace_id) VALUES('task_created','task',?,?,?,?,?,?)`).run(id,actor,'Opprettet fra hovedkvarteret: '+input.title,JSON.stringify({origin:'headquarters',source_count:sourceNotes.length}),now,workspaceId)
    return { id,created:true }
  })()
  const task = getHQTask(result.id,workspaceId,db)
  if (!task) throw new Error('Created task could not be read back')
  return {task,created:result.created}
}
