// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
vi.mock('@/lib/db',()=>({getDatabase:vi.fn()}))
import { createHQTask, getHQTask, readHQOperations } from './hq-operations'
import { recordHQEvidence } from './hq-evidence'
import { getHQKnowledgeIndex, getHQNote, getHQNoteId, invalidateHQKnowledgeCache } from './hq-knowledge'
import type { HQNote, HQTaskCreateInput } from './hq-types'

let db:Database.Database
let root:string
let note:HQNote
function database() {
  const d=new Database(':memory:')
  d.exec(`
    CREATE TABLE projects(id INTEGER PRIMARY KEY,workspace_id INTEGER,name TEXT,slug TEXT,status TEXT,description TEXT,color TEXT,ticket_prefix TEXT,ticket_counter INTEGER DEFAULT 0,updated_at INTEGER);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id INTEGER,title TEXT,description TEXT,status TEXT,priority TEXT,project_id INTEGER,project_ticket_no INTEGER,assigned_to TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER,tags TEXT,metadata TEXT,resolution TEXT,completed_at INTEGER);
    CREATE TABLE activities(id INTEGER PRIMARY KEY,workspace_id INTEGER,type TEXT,entity_type TEXT,entity_id INTEGER,actor TEXT,description TEXT,data TEXT,created_at INTEGER);
    CREATE TABLE agents(id INTEGER PRIMARY KEY,workspace_id INTEGER,name TEXT,role TEXT,status TEXT,last_seen INTEGER,updated_at INTEGER);
    CREATE TABLE runs(id TEXT PRIMARY KEY,workspace_id INTEGER,task_id TEXT,status TEXT,outcome TEXT,ended_at TEXT,started_at TEXT,created_at INTEGER);
    INSERT INTO projects(id,workspace_id,name,slug,status,ticket_prefix) VALUES
      (1,1,'BabyHub','babyhub','active','BABY'),(2,1,'Babysential','babysential','active','BABYS'),
      (3,1,'General','general','active','TASK'),(4,2,'BabyHub','babyhub','active','BABY'),
      (5,1,'Unrelated','unrelated','active','OTHER');
  `)
  return d
}
const input=():HQTaskCreateInput=>({title:'Undersøk kildegrunnlaget',description:'Avgrenset intern oppgave',projectKey:'babyhub',sourceIds:[note.id],acceptanceCriteria:['Kilden kan etterprøves'],expectedOutcome:'Et dokumentert beslutningsgrunnlag',priority:'high',idempotencyKey:'hq-test-1234567890'})
beforeEach(async()=>{
  db=database()
  root=await mkdtemp(path.join(os.tmpdir(),'ines-hq-operations-'))
  await mkdir(path.join(root,'02-projects/babyhub'),{recursive:true})
  await writeFile(path.join(root,'02-projects/babyhub/source.md'),'---\ntitle: Norsk kilde\n---\n# Norsk kilde\nEt faktisk kildegrunnlag.')
  process.env.HQ_VAULT_ROOT=root
  invalidateHQKnowledgeCache()
  note=(await getHQKnowledgeIndex()).notes[0]
})
afterEach(async()=>{
  db.close()
  delete process.env.HQ_VAULT_ROOT
  invalidateHQKnowledgeCache()
  await rm(root,{recursive:true,force:true})
})

describe('HQ tasks use the existing record of work',()=>{
  it('persists source context and criteria and allocates one existing project ticket',()=>{
    const result=createHQTask(input(),1,'operator',[note],db)
    expect(result.created).toBe(true)
    expect(result.task).toMatchObject({status:'inbox',assignedTo:null,projectKey:'babyhub',ticketRef:'BABY-001',sourceIds:[note.id],measurementStatus:'unmeasured'})
    const row=db.prepare('SELECT metadata FROM tasks').get() as {metadata:string}
    const metadata=JSON.parse(row.metadata)
    expect(metadata.workflow_contract.context_pack_sources).toContain('vault/'+note.path)
    expect(metadata.hq.acceptance_criteria).toEqual(input().acceptanceCriteria)
    expect(db.prepare('SELECT COUNT(*) AS n FROM activities').get()).toEqual({n:1})
  })
  it('deduplicates retries atomically and rejects key reuse with a changed proposal',()=>{
    const first=createHQTask(input(),1,'operator',[note],db)
    const retry=createHQTask(input(),1,'operator',[note],db)
    expect(retry).toMatchObject({created:false,task:{id:first.task.id}})
    expect(()=>createHQTask({...input(),title:'Et endret forslag'},1,'operator',[note],db)).toThrow('Forslaget er endret')
    expect(db.prepare('SELECT ticket_counter FROM projects WHERE id=1').get()).toEqual({ticket_counter:1})
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({n:1})
  })
  it('rejects unknown and cross-project sources before changing the database',()=>{
    expect(()=>createHQTask({...input(),sourceIds:['unknown']},1,'operator',[note],db)).toThrow('En kilde mangler')
    expect(()=>createHQTask({...input(),projectKey:'babysential'},1,'operator',[note],db)).toThrow('annet prosjekt')
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({n:0})
  })
  it('scopes task identity and idempotency by workspace',()=>{
    const first=createHQTask(input(),1,'operator',[note],db)
    const second=createHQTask(input(),2,'operator',[note],db)
    expect(second.task.id).not.toBe(first.task.id)
    expect(getHQTask(first.task.id,2,db)).toBeNull()
  })
  it('does not map unrelated or general legacy tasks into project decisions',()=>{
    db.exec(`INSERT INTO tasks(workspace_id,title,status,project_id,metadata,updated_at) VALUES
      (1,'Unrelated task','inbox',5,'{}',1),(1,'General legacy task','inbox',3,'{}',1),(2,'Other workspace','inbox',4,'{}',1)`)
    const created=createHQTask(input(),1,'operator',[note],db)
    const result=readHQOperations(1,[note],db)
    expect(result.tasks.map(t=>t.id)).toEqual([created.task.id])
  })
})

describe('Evidence and durable learning',()=>{
  it('preserves the task status and records one result across a repeated request',async()=>{
    const {task}=createHQTask(input(),1,'operator',[note],db)
    const evidence={label:'Kontroll utført',detail:'Kilden stemmer med de undersøkte avsnittene.'}
    await recordHQEvidence(task.id,1,'operator',evidence,db)
    const retry=await recordHQEvidence(task.id,1,'operator',evidence,db)
    expect(retry.task.status).toBe('inbox')
    expect(retry.task.measurementStatus).toBe('unmeasured')
    expect(retry.task.evidence).toHaveLength(1)
  })
  it('writes one immutable learning with source backlinks and a resolvable note identity',async()=>{
    const {task}=createHQTask(input(),1,'operator',[note],db)
    const evidence={label:'Resultat fra kildekontroll',detail:'Undersøkelsen har et avgrenset resultat.',saveLearning:true}
    const first=await recordHQEvidence(task.id,1,'operator',evidence,db)
    const retry=await recordHQEvidence(task.id,1,'operator',evidence,db)
    expect(retry.learningNoteId).toBe(first.learningNoteId)
    expect(retry.task.sourceIds).toEqual([note.id])
    expect(retry.task.learningNoteIds).toEqual([first.learningNoteId])
    const learning=await getHQNote(first.learningNoteId!)
    expect(learning).not.toBeNull()
    expect(learning!.content).toContain('[[02-projects/babyhub/source]]')
    expect(learning!.content).toContain('Produkteffekt er ikke dokumentert')
    expect(getHQNoteId(learning!.note.path)).toBe(first.learningNoteId)
    expect((await getHQKnowledgeIndex()).links.some(link=>link.source===first.learningNoteId&&link.target===note.id)).toBe(true)
    expect(await readFile(path.join(root,note.path),'utf8')).toContain('Et faktisk kildegrunnlag.')
    await writeFile(path.join(root,learning!.note.path),'Manual revision by owner')
    await expect(recordHQEvidence(task.id,1,'operator',evidence,db)).rejects.toThrow('ikke overskrevet')
    expect(await readFile(path.join(root,learning!.note.path),'utf8')).toBe('Manual revision by owner')
  })
  it('rejects a symlinked learning destination and a task from another workspace',async()=>{
    const {task}=createHQTask(input(),1,'operator',[note],db)
    await mkdir(path.join(root,'outside'))
    await symlink(path.join(root,'outside'),path.join(root,'02-projects/babyhub/decisions'))
    await expect(recordHQEvidence(task.id,1,'operator',{label:'Verifisert avsnitt',detail:'Et konkret resultat.',saveLearning:true},db)).rejects.toThrow('denne mappen')
    await expect(recordHQEvidence(task.id,2,'operator',{label:'Et resultat',detail:'Skal avvises'},db)).rejects.toThrow('finnes ikke')
  })
  it('keeps a learning retry stable when the task title, status and source context later change',async()=>{
    const {task}=createHQTask(input(),1,'operator',[note],db)
    const evidence={label:'Varig resultat',detail:'Et etterprøvbart resultat.',saveLearning:true}
    const first=await recordHQEvidence(task.id,1,'operator',evidence,db)
    db.prepare("UPDATE tasks SET title='Ny tittel',status='review',project_id=2 WHERE id=?").run(task.id)
    const row=db.prepare('SELECT metadata FROM tasks WHERE id=?').get(task.id) as {metadata:string}
    const metadata=JSON.parse(row.metadata)
    metadata.hq.source_paths=[]
    db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify(metadata),task.id)
    const retry=await recordHQEvidence(task.id,1,'operator',evidence,db)
    expect(retry.learningNoteId).toBe(first.learningNoteId)
    expect(retry.task.status).toBe('review')
    const content=(await getHQNote(first.learningNoteId!))!.content
    expect(content).toContain(task.title)
    expect(content).toContain('ved registrering var inbox')
    expect(content).toContain('[[02-projects/babyhub/source]]')
  })
  it('normalizes matching legacy evidence without a date before writing a learning',async()=>{
    const {task}=createHQTask(input(),1,'operator',[note],db)
    const row=db.prepare('SELECT metadata FROM tasks WHERE id=?').get(task.id) as {metadata:string}
    const metadata=JSON.parse(row.metadata)
    metadata.agentic_os.evidence=[{label:'Tidligere bevis',detail:'En eksisterende resultattekst.'}]
    db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify(metadata),task.id)
    const result=await recordHQEvidence(task.id,1,'operator',{label:'Tidligere bevis',detail:'En eksisterende resultattekst.',saveLearning:true},db)
    expect(result.learningNoteId).toBeTruthy()
    expect(result.task.evidence).toHaveLength(1)
    expect((await getHQNote(result.learningNoteId!))!.content).toContain('En eksisterende resultattekst.')
  })
  it('rejects active or credential-bearing evidence URLs',async()=>{
    const {task}=createHQTask(input(),1,'operator',[note],db)
    for(const url of ['javascript:alert(1)','https://user:secret@example.com']){
      await expect(recordHQEvidence(task.id,1,'operator',{label:'Lenkebevis',detail:'Kontrollert referanse',url},db)).rejects.toThrow('gyldig')
    }
  })
})
