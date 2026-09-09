// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ database: vi.fn(), role: vi.fn(), access: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDatabase: mocks.database }))
vi.mock('@/lib/auth', () => ({ requireRole: mocks.role }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/workspaces', () => ({ ensureTenantWorkspaceAccess: mocks.access, ForbiddenError: class extends Error {} }))
import { GET, PATCH } from '@/app/api/projects/[id]/route'
import { POST as createProject } from '@/app/api/projects/route'
import { POST as assign, DELETE as unassign } from '@/app/api/projects/[id]/agents/route'
let db: Database.Database
const request = (id: string, body: unknown) => new NextRequest(`http://localhost/api/projects/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const params = (id: string) => ({ params: Promise.resolve({ id }) })
beforeEach(() => {
  vi.clearAllMocks()
  db = new Database(':memory:')
  db.exec(`CREATE TABLE workspaces(id INTEGER,tenant_id INTEGER); INSERT INTO workspaces VALUES(1,1),(2,2);
    CREATE TABLE projects(id INTEGER,workspace_id INTEGER,name TEXT,slug TEXT,description TEXT,ticket_prefix TEXT,ticket_counter INTEGER,status TEXT,github_repo TEXT,deadline INTEGER,color TEXT,github_sync_enabled INTEGER,github_labels_initialized INTEGER,github_default_branch TEXT,created_at INTEGER,updated_at INTEGER);
    INSERT INTO projects(id,workspace_id,name,slug,status) VALUES(1,1,'General','general','active'),(2,2,'Other','other','active');
    CREATE TABLE tasks(id INTEGER,workspace_id INTEGER,project_id INTEGER);
    CREATE TABLE agents(id INTEGER,workspace_id INTEGER,name TEXT); INSERT INTO agents VALUES(1,1,'Ines'),(2,2,'Foreign');
    CREATE TABLE project_agent_assignments(project_id INTEGER,agent_name TEXT,role TEXT,UNIQUE(project_id,agent_name));`)
  mocks.database.mockReturnValue(db)
  mocks.role.mockReturnValue({ user: { id: 1, username: 'operator', workspace_id: 1, tenant_id: 1 } })
})
afterEach(() => db.close())
describe('project editing and team API', () => {
  it.each([1e20, -1e20, 123.5, '2026-09-08', {}])('rejects invalid deadlines %s on update and creation without writes', async deadline => {
    const before = db.prepare('SELECT count(*) AS n FROM projects').get()
    expect((await PATCH(request('1', { deadline }), params('1'))).status).toBe(400)
    expect((await createProject(request('', { name: 'Date test', ticket_prefix: 'DATE', deadline }))).status).toBe(400)
    expect(db.prepare('SELECT deadline FROM projects WHERE id=1').get()).toEqual({ deadline: null })
    expect(db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual(before)
  })
  it('accepts a valid deadline and explicit clearing', async () => {
    const deadline = Date.parse('2026-09-30T00:00:00Z') / 1000
    expect((await PATCH(request('1', { deadline }), params('1'))).status).toBe(200)
    expect(db.prepare('SELECT deadline FROM projects WHERE id=1').get()).toEqual({ deadline })
    expect((await PATCH(request('1', { deadline: null }), params('1'))).status).toBe(200)
    expect(db.prepare('SELECT deadline FROM projects WHERE id=1').get()).toEqual({ deadline: null })
  })
  it('excludes a mismatched-workspace task from project totals', async () => {
    db.exec('INSERT INTO tasks VALUES(1,1,1),(2,2,1)')
    const response = await GET(new NextRequest('http://localhost/api/projects/1'), params('1'))
    expect(response.status).toBe(200)
    expect((await response.json()).project.task_count).toBe(1)
  })
  it('edits General using one body read while still refusing to archive it', async () => {
    const response = await PATCH(request('1', { description: 'Et felles mål' }), params('1'))
    expect(response.status).toBe(200)
    expect(db.prepare('SELECT description FROM projects WHERE id=1').get()).toEqual({ description: 'Et felles mål' })
    expect((await PATCH(request('1', { status: 'archived' }), params('1'))).status).toBe(400)
  })
  it('assigns only an existing agent in the project workspace and supports removing it', async () => {
    expect((await assign(request('1', { agent_name: 'Foreign' }), params('1'))).status).toBe(404)
    expect((await assign(request('1', { agent_name: 'Unknown' }), params('1'))).status).toBe(404)
    expect((await assign(request('2', { agent_name: 'Ines' }), params('2'))).status).toBe(404)
    expect((await assign(request('1', { agent_name: 'Ines' }), params('1'))).status).toBe(201)
    expect((await assign(request('1', { agent_name: 'Ines' }), params('1'))).status).toBe(201)
    expect(db.prepare('SELECT count(*) AS n FROM project_agent_assignments').get()).toEqual({ n: 1 })
    const removed = await unassign(new NextRequest('http://localhost/api/projects/1/agents?agent_name=Ines', { method: 'DELETE' }), params('1'))
    expect(removed.status).toBe(200)
    expect(db.prepare('SELECT count(*) AS n FROM project_agent_assignments').get()).toEqual({ n: 0 })
  })
  it.each(['1suffix','0','-1','9007199254740993'])('rejects malformed project identity %s before a mutation', async id => {
    expect((await PATCH(request(id, { description: 'Unexpected' }), params(id))).status).toBe(400)
    expect((await assign(request(id, { agent_name: 'Ines' }), params(id))).status).toBe(400)
  })
  it('requires role authorization before touching storage', async () => {
    mocks.role.mockReturnValue({ error: 'Forbidden', status: 403 })
    expect((await assign(request('1', { agent_name: 'Ines' }), params('1'))).status).toBe(403)
    expect(mocks.database).not.toHaveBeenCalled()
  })
})
