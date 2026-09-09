// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ home: '', db: null as any, audit: vi.fn() }))
vi.mock('node:os', () => ({ homedir: () => mock.home }))
vi.mock('@/lib/config', () => ({ config: {
  get openclawConfigPath() { return path.join(mock.home, 'openclaw.json') },
  get openclawStateDir() { return mock.home },
} }))
vi.mock('@/lib/db', () => ({ getDatabase: () => mock.db, logAuditEvent: mock.audit, db_helpers: {} }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: vi.fn() } }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
import { enrichAgentConfigFromWorkspace, previewSyncDiff, syncAgentsFromConfig } from '@/lib/agent-sync'
import { syncLocalAgents } from '@/lib/local-agent-sync'

function registry(agents: unknown[]) { writeFileSync(path.join(mock.home, 'openclaw.json'), JSON.stringify({ agents: { list: agents } })) }
beforeEach(() => {
  mock.home = mkdtempSync('/tmp/mc-agent-boundaries-')
  mock.db = new Database(':memory:')
  mock.db.exec(`CREATE TABLE agents(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER DEFAULT 1,
    name TEXT, role TEXT, soul_content TEXT, status TEXT, source TEXT, content_hash TEXT, workspace_path TEXT,
    config TEXT, created_at INTEGER, updated_at INTEGER)`)
  mock.audit.mockClear()
  registry([])
})
afterEach(() => { mock.db.close(); rmSync(mock.home, { recursive: true, force: true }) })

describe('primary workspace sync', () => {
  it('does not read, overwrite or list same-name agents from another workspace', async () => {
    mock.db.exec("INSERT INTO agents(workspace_id,name,role,config) VALUES(2,'Research','Private role','{}'),(2,'Private only','Private role','{}')")
    registry([{ id: 'research', name: 'Research', tools: { allow: ['web_search'], deny: ['exec'] } }])
    const result = await syncAgentsFromConfig('operator')
    expect(result).toMatchObject({ created: 1, updated: 0 })
    expect(mock.db.prepare('SELECT role,config FROM agents WHERE workspace_id=2 AND name=?').get('Research')).toEqual({ role: 'Private role', config: '{}' })
    expect(mock.db.prepare('SELECT count(*) AS n FROM agents WHERE workspace_id=1').get()).toEqual({ n: 1 })
    registry([{ id: 'research', name: 'Research', tools: { allow: ['read'], deny: ['exec'] } }])
    expect(await syncAgentsFromConfig('operator')).toMatchObject({ created: 0, updated: 1 })
    expect(mock.db.prepare('SELECT role,config FROM agents WHERE workspace_id=2 AND name=?').get('Research')).toEqual({ role: 'Private role', config: '{}' })
    const diff = await previewSyncDiff()
    expect(diff.inMC).toBe(1)
    expect(diff.onlyInMC).not.toContain('Private only')
  })
  it('keeps local sync and removed-agent status changes inside workspace 1', async () => {
    mkdirSync(path.join(mock.home, '.agents/research'), { recursive: true })
    writeFileSync(path.join(mock.home, '.agents/research/AGENT.md'), 'role: Researcher\nPublic test identity.')
    mock.db.exec("INSERT INTO agents(workspace_id,name,role,source,status,content_hash) VALUES(2,'research','Private role','local','busy','old'),(2,'foreign-only','Private role','local','busy','old')")
    const result = await syncLocalAgents('operator')
    expect(result.ok).toBe(true)
    expect(mock.db.prepare('SELECT name,role,status FROM agents WHERE workspace_id=2 ORDER BY name').all()).toEqual([
      { name: 'foreign-only', role: 'Private role', status: 'busy' }, { name: 'research', role: 'Private role', status: 'busy' },
    ])
    expect(mock.db.prepare('SELECT name,role FROM agents WHERE workspace_id=1').all()).toEqual([{ name: 'research', role: 'Researcher' }])
    expect(mock.audit).toHaveBeenCalledWith(expect.objectContaining({ actor: 'operator' }))
    writeFileSync(path.join(mock.home, '.agents/research/AGENT.md'), 'role: Updated researcher\nPublic revised identity.')
    expect((await syncLocalAgents('operator')).ok).toBe(true)
    expect(mock.db.prepare('SELECT role FROM agents WHERE workspace_id=1').get()).toEqual({ role: 'Updated researcher' })
    mock.db.exec("UPDATE agents SET status='busy' WHERE workspace_id=1")
    rmSync(path.join(mock.home, '.agents/research/AGENT.md'))
    expect((await syncLocalAgents('operator')).ok).toBe(true)
    expect(mock.db.prepare('SELECT status FROM agents WHERE workspace_id=1').get()).toEqual({ status: 'offline' })
    expect(mock.db.prepare('SELECT count(*) AS n FROM agents WHERE workspace_id=2 AND status=?').get('busy')).toEqual({ n: 2 })
  })
})

describe('capabilities come from configuration, not TOOLS.md prose', () => {
  it('does not promote prose, examples or local details into tool permissions or raw capabilities', () => {
    const workspace = path.join(mock.home, 'workspace')
    mkdirSync(workspace)
    writeFileSync(path.join(workspace, 'TOOLS.md'), '# Local Notes\n- Camera names\n- Private device location\n- `exec`\n')
    expect(enrichAgentConfigFromWorkspace({ workspace }).tools).toBeUndefined()
    const configured = { workspace, tools: { allow: ['web_search'], deny: ['exec'] } }
    expect(enrichAgentConfigFromWorkspace(configured).tools).toEqual(configured.tools)
    expect(JSON.stringify(enrichAgentConfigFromWorkspace(configured))).not.toContain('Private device')
  })
  it('repairs legacy prose-derived allowlists from the registered OpenClaw policy', () => {
    registry([{ id: 'research', tools: { profile: 'minimal', allow: ['web_search'], deny: ['exec'] } }])
    const legacy = { openclawId: 'research', tools: { allow: ['Camera names'], raw: 'Private local notes' } }
    expect(enrichAgentConfigFromWorkspace(legacy).tools).toEqual({ profile: 'minimal', allow: ['web_search'], deny: ['exec'] })
    registry([{ id: 'research' }])
    expect(enrichAgentConfigFromWorkspace(legacy).tools).toBeUndefined()
  })
  it('fails closed on a legacy prose policy when canonical config cannot verify it', () => {
    writeFileSync(path.join(mock.home, 'openclaw.json'), '{broken')
    const result = enrichAgentConfigFromWorkspace({ openclawId: 'research', tools: { allow: ['Camera names'], deny: ['exec'], raw: 'Private local notes' } })
    expect(result.tools).toEqual({ deny: ['exec'] })
    expect(JSON.stringify(result)).not.toContain('Private local notes')
  })
})
