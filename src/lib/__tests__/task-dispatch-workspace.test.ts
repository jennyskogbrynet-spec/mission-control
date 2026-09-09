// @vitest-environment node
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ db: null as any, runOpenClaw: vi.fn(), logActivity: vi.fn(), broadcast: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDatabase: () => mock.db, db_helpers: { logActivity: mock.logActivity } }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/github-sync-engine', () => ({ syncTaskOutbound: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: mock.broadcast } }))
vi.mock('@/lib/command', () => ({ runOpenClaw: mock.runOpenClaw }))
vi.mock('@/lib/config', () => ({ config: { openclawHome: '/test/openclaw' } }))
import { autoRouteInboxTasks, dispatchAssignedTasks } from '../task-dispatch'
beforeEach(() => {
  vi.clearAllMocks()
  mock.db = new Database(':memory:')
  mock.db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, description TEXT, priority TEXT, tags TEXT, workspace_id INTEGER, metadata TEXT, status TEXT, assigned_to TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT, role TEXT, status TEXT, config TEXT, workspace_id INTEGER, hidden INTEGER DEFAULT 0);`)
})
afterEach(() => mock.db.close())
it('routes within the task workspace, and account-bound inbox tasks do not starve the legacy queue', async () => {
  mock.db.exec(`INSERT INTO agents VALUES (1,'Foreign engineer','engineer','idle',NULL,2,0),(2,'Local reviewer','reviewer','idle',NULL,1,0);`)
  const insert = mock.db.prepare('INSERT INTO tasks VALUES (?, ?, NULL, ?, NULL, 1, ?, ?, NULL, ?, 0)')
  for (let i = 1; i <= 6; i++) insert.run(i, 'Implement feature', 'high', '{"compute_route":{}}', 'inbox', i)
  insert.run(7, 'Review code', 'medium', '{}', 'inbox', 7)
  await autoRouteInboxTasks()
  expect(mock.db.prepare('SELECT assigned_to FROM tasks WHERE id=7').get()).toEqual({ assigned_to: 'Local reviewer' })
  expect(mock.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id<7 AND status='inbox'").get()).toEqual({ n: 6 })
})
it('leaves tasks unassigned if only another workspace has a candidate', async () => {
  mock.db.exec(`INSERT INTO agents VALUES (1,'Foreign engineer','engineer','idle',NULL,2,0);
    INSERT INTO tasks VALUES (1,'Implement feature',NULL,'high',NULL,1,NULL,'inbox',NULL,0,0);`)
  await autoRouteInboxTasks()
  expect(mock.db.prepare('SELECT assigned_to,status FROM tasks WHERE id=1').get()).toEqual({ assigned_to: null, status: 'inbox' })
})

function seedAssignedTasks(metadata: string | null = '{}') {
  mock.db.exec(`
    ALTER TABLE tasks ADD COLUMN project_id INTEGER;
    ALTER TABLE tasks ADD COLUMN project_ticket_no INTEGER;
    ALTER TABLE tasks ADD COLUMN outcome TEXT;
    ALTER TABLE tasks ADD COLUMN resolution TEXT;
    ALTER TABLE tasks ADD COLUMN error_message TEXT;
    ALTER TABLE tasks ADD COLUMN dispatch_attempts INTEGER DEFAULT 0;
    CREATE TABLE projects (id INTEGER PRIMARY KEY, workspace_id INTEGER, ticket_prefix TEXT);
    CREATE TABLE comments (task_id INTEGER, author TEXT, content TEXT, created_at INTEGER, workspace_id INTEGER);
    CREATE TABLE agent_invocations (id INTEGER PRIMARY KEY, ts INTEGER, source TEXT, task_id INTEGER);
    INSERT INTO agents VALUES (1,'Local engineer','engineer','idle',NULL,1,0);
  `)
  const insert = mock.db.prepare(`INSERT INTO tasks
    (id,title,priority,workspace_id,metadata,status,assigned_to,created_at,updated_at)
    VALUES (?,?,'medium',1,?,'assigned','Local engineer',?,0)`)
  insert.run(1, 'First task', '{}', 1)
  insert.run(2, 'Second task', metadata, 2)
}

function deferFirstSend() {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const response = { stdout: JSON.stringify({ payloads: [{ text: 'Completed in test' }] }), stderr: '' }
  mock.runOpenClaw.mockImplementationOnce(async () => {
    await blocked
    return response
  }).mockResolvedValue(response)
  return release
}

it('dispatches each task once when another batch claims a task selected by an earlier batch', async () => {
  seedAssignedTasks()
  const release = deferFirstSend()
  // The first batch selects both rows, then yields while task1 is running.
  const firstBatch = dispatchAssignedTasks()
  expect(mock.runOpenClaw).toHaveBeenCalledTimes(1)
  try {
    // The second batch claims/completes task2 before the first resumes its stale list.
    await dispatchAssignedTasks()
  } finally {
    release()
    await firstBatch
  }
  expect(mock.runOpenClaw).toHaveBeenCalledTimes(2)
  expect(mock.db.prepare('SELECT task_id, COUNT(*) AS n FROM agent_invocations GROUP BY task_id ORDER BY task_id').all())
    .toEqual([{ task_id: 1, n: 1 }, { task_id: 2, n: 1 }])
  expect(mock.db.prepare('SELECT id,status FROM tasks ORDER BY id').all())
    .toEqual([{ id: 1, status: 'review' }, { id: 2, status: 'review' }])
})

it.each(['{"compute_route":{}}', '{"compute_route":null}'])(
  'does not send a selected task that becomes compute-managed before its claim: %s', async metadata => {
    seedAssignedTasks()
    const release = deferFirstSend()
    const batch = dispatchAssignedTasks()
    mock.db.prepare('UPDATE tasks SET metadata=? WHERE id=2').run(metadata)
    release()
    await batch
    expect(mock.runOpenClaw).toHaveBeenCalledTimes(1)
    expect(mock.db.prepare('SELECT status,metadata FROM tasks WHERE id=2').get())
      .toEqual({ status: 'assigned', metadata })
    expect(mock.db.prepare('SELECT COUNT(*) AS n FROM agent_invocations WHERE task_id=2').get()).toEqual({ n: 0 })
    expect(mock.broadcast.mock.calls.filter(([, payload]) => payload.id === 2)).toEqual([])
  },
)

it.each([
  ["UPDATE tasks SET workspace_id=2 WHERE id=2", 'assigned'],
  ["UPDATE tasks SET assigned_to='New engineer' WHERE id=2", 'assigned'],
  ["UPDATE tasks SET status='done' WHERE id=2", 'done'],
  ["UPDATE tasks SET metadata='{\"workflow_contract\":{\"resource_policy\":{\"allow_paid_api_fallback\":false}}}' WHERE id=2", 'assigned'],
])('leaves a changed task untouched instead of dispatching an outdated selection: %s', async (change, status) => {
  seedAssignedTasks('{"workflow_contract":{"resource_policy":{"allow_paid_api_fallback":true}}}')
  const release = deferFirstSend()
  const batch = dispatchAssignedTasks()
  mock.db.exec(change)
  release()
  await batch
  expect(mock.runOpenClaw).toHaveBeenCalledTimes(1)
  expect(mock.db.prepare('SELECT status FROM tasks WHERE id=2').get()).toEqual({ status })
  expect(mock.db.prepare('SELECT COUNT(*) AS n FROM agent_invocations WHERE task_id=2').get()).toEqual({ n: 0 })
})

it.each([null, 'not-json'])('preserves dispatch for unchanged legacy metadata: %s', async metadata => {
  seedAssignedTasks(metadata)
  const release = deferFirstSend()
  const batch = dispatchAssignedTasks()
  release()
  await batch
  expect(mock.runOpenClaw).toHaveBeenCalledTimes(2)
  expect(mock.db.prepare('SELECT status FROM tasks WHERE id=2').get()).toEqual({ status: 'review' })
})
