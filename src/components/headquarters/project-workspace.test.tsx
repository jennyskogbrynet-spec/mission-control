import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HQProject, HQNote, HQTask } from '@/lib/hq-types'
import { ProjectHub, ProjectWorkspace } from './project-workspace'
import { ProjectManagerModal } from '@/components/modals/project-manager-modal'
import { inProject } from './hq-data'
import { HeadquartersPanel } from './headquarters-panel'
import { TaskComposer } from './task-composer'

const navigation = vi.hoisted(() => ({ push: vi.fn(), setActiveProject: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: navigation.push }) }))
vi.mock('@/store', () => ({ useMissionControl: { getState: () => ({ setActiveProject: navigation.setActiveProject }) } }))
vi.mock('./hq-graph', () => ({ HQGraph: () => <div>Graf</div> }))

const project: HQProject = { id: 44, key: null, name: 'Nytt prosjekt', description: 'Målbar fremgang', color: '#83b8dc', noteCount: 0, assignedAgents: ['Ines'], taskCounts: { total: 205, open: 200, blocked: 2, inProgress: 3, done: 5 } }
const shared: HQNote = { id: 'shared-note', projectKey: 'shared', title: 'Felles metode', path: '04-resources/learnings/deep-learn/method.md', kind: 'learning', summary: 'Et grunnlag', tags: [], modifiedAt: '2026-09-08T08:00:00Z', sourceDate: null, wordCount: 20, linkCount: 1 }
const task: HQTask = { id: 8, projectId: 44, projectKey: 'shared', projectName: project.name, title: 'Undersøk muligheten', description: 'Kontroller kildegrunnlaget', status: 'inbox', priority: 'high', assignedTo: 'Ines', ticketRef: 'NEW-001', updatedAt: '2026-09-08T09:00:00Z', sourceIds: [shared.id], acceptanceCriteria: ['Et dokumentert svar'], expectedOutcome: 'Et etterprøvbart resultat', evidence: [], measurementStatus: 'unmeasured' }
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn())
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', '') } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('project workspaces', () => {
  it.each([
    ['coordinator', 'Koordinator'], ['Fagansvarlig', 'Fagansvarlig'],
  ])('shows the project membership role %s instead of the general agent role', (role, label) => {
    render(<ProjectWorkspace project={{...project, assignedAgentRoles: {Ines: role}}} notes={[]} tasks={[]} agents={[{name:'Ines',role:'agent',status:'idle',updatedAt:null}]} metrics={{data:null,loading:false,error:null}} onManage={vi.fn()} onSelect={vi.fn()} onOpenTask={vi.fn()} onTasks={vi.fn()} onKnowledge={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.queryByText('agent')).not.toBeInTheDocument()
    expect(screen.getByText('idle')).toBeInTheDocument()
  })
  it.each<HQProject['assignedAgentRoles']>([undefined, {}, {Ines:' '}])('falls back to the agent role only when project membership has no role (%j)', assignedAgentRoles => {
    render(<ProjectWorkspace project={{...project, assignedAgentRoles}} notes={[]} tasks={[]} agents={[{name:'Ines',role:'Generell koordinator',status:'idle',updatedAt:null}]} metrics={{data:null,loading:false,error:null}} onManage={vi.fn()} onSelect={vi.fn()} onOpenTask={vi.fn()} onTasks={vi.fn()} onKnowledge={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getByText('Generell koordinator')).toBeInTheDocument()
  })
  it('shows a membership role even if the general agent record is unavailable', () => {
    render(<ProjectWorkspace project={{...project, assignedAgentRoles:{Ines:'coordinator'}}} notes={[]} tasks={[]} agents={[]} metrics={{data:null,loading:false,error:null}} onManage={vi.fn()} onSelect={vi.fn()} onOpenTask={vi.fn()} onTasks={vi.fn()} onKnowledge={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getByText('Koordinator')).toBeInTheDocument()
    expect(screen.getByText('Status ukjent')).toBeInTheDocument()
  })
  it('opens a new registry project and its management without a hardcoded project key', () => {
    const choose = vi.fn(), manage = vi.fn()
    render(<ProjectHub projects={[project]} onChoose={choose} onManage={manage} />)
    fireEvent.click(screen.getByRole('button', { name: 'Nytt prosjekt' }))
    expect(choose).toHaveBeenCalledWith(project)
    fireEvent.click(screen.getByRole('button', { name: 'Rediger Nytt prosjekt' }))
    expect(manage).toHaveBeenCalledWith(44)
    expect(screen.getByText('200')).toBeInTheDocument()
    expect(screen.getByText('Ikke koblet')).toBeInTheDocument()
  })
  it('never mixes General or another project task into a project even when both use shared knowledge', () => {
    expect(inProject(task, 'project:44', [project])).toBe(true)
    expect(inProject({ ...task, projectId: 3 }, 'project:44', [project])).toBe(false)
    expect(inProject(shared, 'project:44', [project])).toBe(true)
    expect(inProject({ ...shared, projectKey: 'babyhub' }, 'project:44', [project])).toBe(false)
    expect(inProject(task, 'project:999', [project])).toBe(false)
  })
  it('exposes work, team and knowledge actions while distinguishing absent metrics from zero', () => {
    const onTasks = vi.fn(), onSelect = vi.fn(), onManage = vi.fn()
    render(<ProjectWorkspace project={project} notes={[shared]} tasks={[task]} agents={[]} metrics={{ data: null, loading: false, error: null }} onManage={onManage} onSelect={onSelect} onOpenTask={vi.fn()} onTasks={onTasks} onKnowledge={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getByText('Ingen egen kunnskapsmappe er koblet til dette prosjektet ennå.', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Ikke målt')).toBeInTheDocument()
    expect(screen.getByText('Status ukjent')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Hele oppgavebrettet/ }))
    expect(onTasks).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: /NEW-001/ }))
    expect(onSelect).toHaveBeenCalledWith('task:8')
    fireEvent.click(screen.getByRole('button', { name: 'Legg til / fjern agenter' }))
    expect(onManage).toHaveBeenCalledOnce()
  })
  it('sends the selected registry ID with a source-backed task for a new project', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ task, created: true }, 201))
    render(<TaskComposer notes={[shared]} selectedNote={shared} projects={[project]} initialProject="shared" initialProjectId={44} onClose={vi.fn()} onCreated={vi.fn()} onOpenTask={vi.fn()} />)
    expect(screen.getByLabelText('Prosjekt')).toHaveValue('44')
    fireEvent.change(screen.getByLabelText(/Godkjenningskrav/), { target: { value: 'Verifiser resultatet' } })
    fireEvent.change(screen.getByLabelText(/Forventet resultat/), { target: { value: 'Et etterprøvbart svar' } })
    fireEvent.click(screen.getByRole('button', { name: 'Opprett MC-oppgave' }))
    await screen.findByText('Oppgaven er lagret i MC')
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body).toMatchObject({ projectId: 44, projectKey: 'shared', sourceIds: [shared.id] })
  })
})

describe('project creation and team management', () => {
  const registered = { id: 44, name: 'Nytt prosjekt', slug: 'nytt', ticket_prefix: 'NEW', status: 'active', assigned_agents: [] }
  function reads(url: string) {
    if (url.startsWith('/api/projects?')) return json({ projects: [registered] })
    if (url === '/api/projects/44/agents') return json({ assignments: [] })
    if (url === '/api/agents') return json({ agents: [{ id: 1, name: 'Ines', role: 'Koordinator', status: 'idle' }] })
    return json({ success: true })
  }
  it('creates a project through the registry API and refreshes the parent', async () => {
    vi.mocked(fetch).mockImplementation(async url => reads(String(url)))
    const changed = vi.fn()
    render(<ProjectManagerModal onClose={vi.fn()} onChanged={changed} />)
    await screen.findByText('Nytt prosjekt')
    fireEvent.change(screen.getByLabelText('Prosjektnavn'), { target: { value: 'Neste prosjekt' } })
    fireEvent.change(screen.getByLabelText('Oppgaveprefiks'), { target: { value: 'NEXT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Opprett prosjekt' }))
    await waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledWith('/api/projects', expect.objectContaining({ method: 'POST', body: expect.stringContaining('Neste prosjekt') }))
  })
  it('reports assignment failure and retains the draft until the retry succeeds', async () => {
    let rejectAssignment = true
    vi.mocked(fetch).mockImplementation(async (url, options) => String(url) === '/api/projects/44/agents' && options?.method === 'POST' ? json({}, rejectAssignment ? 500 : 201) : reads(String(url)))
    const changed = vi.fn()
    render(<ProjectManagerModal initialProjectId={44} onClose={vi.fn()} onChanged={changed} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ines' }))
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Ines kunne ikke legges til')
    expect(changed).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Ines' })).toHaveAttribute('aria-pressed', 'true')
    rejectAssignment = false
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }))
    await waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('reconciles against the persisted team after a partial save and an edited retry', async () => {
    let persisted: string[] = [], failReidar = true
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      const endpoint = String(url)
      if (endpoint === '/api/agents') return json({ agents: [{ id: 1, name: 'Ines' }, { id: 2, name: 'Reidar' }] })
      if (endpoint === '/api/projects/44/agents' && !options?.method) return json({ assignments: persisted.map(agent_name => ({ agent_name })) })
      if (endpoint === '/api/projects/44/agents' && options?.method === 'POST') {
        const { agent_name } = JSON.parse(String(options.body))
        if (agent_name === 'Reidar' && failReidar) return json({}, 500)
        persisted = [...new Set([...persisted, agent_name])]
        return json({ success: true }, 201)
      }
      if (endpoint.startsWith('/api/projects/44/agents?') && options?.method === 'DELETE') {
        persisted = persisted.filter(name => name !== new URL(endpoint, 'http://localhost').searchParams.get('agent_name'))
        return json({ success: true })
      }
      return reads(endpoint)
    })
    const changed = vi.fn()
    render(<ProjectManagerModal initialProjectId={44} onClose={vi.fn()} onChanged={changed} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ines' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reidar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }))
    await screen.findByRole('alert')
    expect(persisted).toEqual(['Ines'])
    expect(changed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Ines' }))
    failReidar = false
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }))
    await waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(persisted).toEqual(['Reidar'])
  })

})


describe('HQ project wiring', () => {
  it('loads a chosen project independently of the global task limit and opens its actual project board', async () => {
    const snapshot = { generatedAt: '2026-09-08T09:00:00Z', projects: [project], notes: [], links: [], tasks: [], agents: [], activity: [], sources: [], coverage: { indexed: 0, limit: 2000, truncated: false, excluded: 0 } }
    vi.mocked(fetch).mockImplementation(async url => {
      if (String(url) === '/api/headquarters?projectId=44') return json({ ...snapshot, tasks: [task] })
      if (String(url).startsWith('/api/headquarters/metrics')) return json({ metrics: [], sources: [] })
      return json(snapshot)
    })
    render(<HeadquartersPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Nytt prosjekt' }))
    expect(await screen.findByRole('heading', { name: 'Nytt prosjekt. Mål, team og fremdrift.' })).toBeInTheDocument()
    expect(await screen.findByText('Undersøk muligheten')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/headquarters?projectId=44', expect.objectContaining({ cache: 'no-store' }))
    fireEvent.click(screen.getByRole('button', { name: /Hele oppgavebrettet/ }))
    expect(navigation.setActiveProject).toHaveBeenCalledWith(expect.objectContaining({ id: 44, name: 'Nytt prosjekt' }))
    expect(navigation.push).toHaveBeenCalledWith('/tasks', { scroll: false })
  })
})
