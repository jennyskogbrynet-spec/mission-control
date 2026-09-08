import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { getDatabase } from '@/lib/db'
import { asObject, getHQTask, HQInputError, safeEvidenceUrl } from '@/lib/hq-operations'
import { getHQNoteId, invalidateHQKnowledgeCache } from '@/lib/hq-knowledge'
import type { HQTask, HQProjectKey } from '@/lib/hq-types'

export interface HQEvidenceInput { label:string; detail:string; url?:string; saveLearning?:boolean }
type LearningContext = { title:string; status:string; sources:string[]; projectKey:HQProjectKey }
type SavedEvidence = { id:string; label:string; detail:string; url?:string; createdAt:string; actor:string; learning?:LearningContext }
function sameContent(a:SavedEvidence,b:HQEvidenceInput) { return a.label===b.label && a.detail===b.detail && (a.url||'')===(b.url||'') }

/** Stores user-supplied evidence, never invents a pass or advances task status. */
export async function recordHQEvidence(taskId:number,workspaceId:number,actor:string,input:HQEvidenceInput,db:Database.Database=getDatabase()):Promise<{task:HQTask;learningNoteId?:string}> {
  const url = input.url ? safeEvidenceUrl(input.url) : undefined
  if (input.url && !url) throw new HQInputError('Bevislenken må være en gyldig http- eller https-adresse.')
  const canonical = {label:input.label,detail:input.detail,url}
  const evidenceId = createHash('sha256').update(JSON.stringify([workspaceId,taskId,canonical])).digest('hex').slice(0,24)
  const stored = db.transaction(() => {
    const task = getHQTask(taskId,workspaceId,db)
    if (!task) throw new HQInputError('Oppgaven finnes ikke i dette prosjektområdet.',404)
    const row = db.prepare('SELECT metadata FROM tasks WHERE id=? AND workspace_id=?').get(taskId,workspaceId) as {metadata:string}
    const metadata=asObject(row.metadata)
    const agentic=asObject(metadata.agentic_os)
    const evidence=Array.isArray(agentic.evidence)?agentic.evidence:[]
    const existingIndex = evidence.findIndex(item => asObject(item).id===evidenceId || sameContent(asObject(item) as unknown as SavedEvidence,canonical))
    const oldEntry = existingIndex < 0 ? {} : asObject(evidence[existingIndex])
    const recordedAt = typeof oldEntry.createdAt==='string' && Number.isFinite(Date.parse(oldEntry.createdAt)) ? oldEntry.createdAt : new Date().toISOString()
    const entry:SavedEvidence = {...oldEntry,id:typeof oldEntry.id==='string'?oldEntry.id:evidenceId,...canonical,createdAt:recordedAt,actor:typeof oldEntry.actor==='string'?oldEntry.actor:actor}
    if (input.saveLearning) {
      const oldLearning=asObject(oldEntry.learning)
      const sourcePaths=asObject(metadata.hq).source_paths
      entry.learning=typeof oldLearning.title==='string' && typeof oldLearning.status==='string' && Array.isArray(oldLearning.sources) && ['babyhub','babysential','brrrr','shared'].includes(String(oldLearning.projectKey))
        ? oldLearning as unknown as LearningContext
        : {title:task.title,status:task.status,projectKey:task.projectKey,sources:Array.isArray(sourcePaths)?sourcePaths.filter((x):x is string=>typeof x==='string'):[]}
    }
    if (existingIndex < 0) {
      if(evidence.length>=200) throw new HQInputError('Oppgaven har mange bevis. Bruk den eksisterende oppgavevisningen for videre oppfølging.',409)
      agentic.evidence=[...evidence,entry]
      db.prepare(`INSERT INTO activities(type,entity_type,entity_id,actor,description,data,created_at,workspace_id) VALUES('task_updated','task',?,?,?,?,unixepoch(),?)`).run(taskId,actor,'Registrert resultat: '+input.label,JSON.stringify({origin:'headquarters',evidence_id:evidenceId}),workspaceId)
    } else {
      agentic.evidence=evidence.map((item,index)=>index===existingIndex?entry:item)
    }
    metadata.agentic_os=agentic
    if(existingIndex<0 || JSON.stringify(oldEntry)!==JSON.stringify(entry)) db.prepare('UPDATE tasks SET metadata=?,updated_at=unixepoch() WHERE id=? AND workspace_id=?').run(JSON.stringify(metadata),taskId,workspaceId)
    return {task,entry}
  })()
  let learningNoteId:string|undefined
  if (input.saveLearning) {
    const root=path.resolve(process.env.HQ_VAULT_ROOT || path.join(os.homedir(),'.openclaw/workspace/vault'))
    const rootStat=await lstat(root)
    if(rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new HQInputError('Vault-roten er ikke en vanlig mappe.',409)
    const prefix=stored.entry.learning!.projectKey==='shared' ? '04-resources/learnings/deep-learn' : '02-projects/'+stored.entry.learning!.projectKey+'/decisions'
    const day=stored.entry.createdAt.slice(0,10)
    const relative=prefix+'/'+day+'-hq-task-'+taskId+'-'+evidenceId.slice(0,10)+'.md'
    learningNoteId=getHQNoteId(relative)
    let directory=root
    for(const component of prefix.split('/')) {
      directory=path.join(directory,component)
      try { await mkdir(directory,{mode:0o700}) } catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error }
      const stat=await lstat(directory)
      if(stat.isSymbolicLink() || !stat.isDirectory())throw new HQInputError('Læringen kan ikke lagres i denne mappen.',409)
    }
    if(!(await realpath(directory)).startsWith((await realpath(root))+path.sep))throw new HQInputError('Læringen ligger utenfor vaulten.',409)
    const learning=stored.entry.learning!
    const sources=learning.sources
    const title=input.label.replace(/[\r\n]/g,' ')
    const body=[
      '---','created: '+day,'source_date: '+day,'tags: [learning, headquarters, decision]','source: Mission Control',
      'task_id: '+taskId,'evidence_id: '+evidenceId,'---','','# '+title,'',
      '## Arbeidet','',learning.title,'',
      '## Registrert resultat','',input.detail,'',
      '## Grunnlag','',...(sources.length?sources.map(source=>'[['+source.replace(/\.md$/i,'')+']]'):['Ingen kildehenvisning er registrert.']),
      ...(url?['','Bevis: ['+input.label.replace(/[\[\]\r\n]/g,' ')+']('+url+')']:[]),'',
      '## Status','',
      'Dette er et registrert resultatnotat. Oppgavens status ved registrering var '+learning.status+'. Produkteffekt er ikke dokumentert av at notatet er lagret.','',
      'MC-oppgave: '+taskId+'. Registrert '+stored.entry.createdAt+'.','',
    ].join('\n')
    const filename=path.join(root,relative)
    try {
      const handle=await open(filename,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
      try {await handle.writeFile(body,'utf8')}finally{await handle.close()}
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error
      if((await lstat(filename)).isSymbolicLink() || await readFile(filename,'utf8')!==body)throw new HQInputError('Et endret læringsnotat finnes allerede. Det blir ikke overskrevet.',409)
    }
    db.transaction(()=>{
      const row=db.prepare('SELECT metadata FROM tasks WHERE id=? AND workspace_id=?').get(taskId,workspaceId) as {metadata:string}
      const metadata=asObject(row.metadata), latestHQ=asObject(metadata.hq)
      const previous=Array.isArray(latestHQ.learning_paths)?latestHQ.learning_paths:[]
      latestHQ.learning_paths=[...new Set([...previous,relative])]
      const previousIds=Array.isArray(latestHQ.learning_note_ids)?latestHQ.learning_note_ids:[]
      latestHQ.learning_note_ids=[...new Set([...previousIds,learningNoteId])]
      metadata.hq=latestHQ
      db.prepare('UPDATE tasks SET metadata=?,updated_at=unixepoch() WHERE id=? AND workspace_id=?').run(JSON.stringify(metadata),taskId,workspaceId)
    })()
    invalidateHQKnowledgeCache()
  }
  return {task:getHQTask(taskId,workspaceId,db)!,...(learningNoteId?{learningNoteId}:{})}
}
