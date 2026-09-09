// @vitest-environment node
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./db', () => ({ getDatabase: vi.fn() }))
import { migrateComputeLedger } from './compute-migration'
import { mutateCompute, readComputeOverview } from './compute-store'
import { recommendCompute } from './compute-recommender'
import type { ComputeBindingDefinition, ComputeObservationInput, ComputeRecommendationInput } from './compute-types'

let db: Database.Database
const now = Date.parse('2026-09-08T12:00:00Z')
const fingerprint = 'a'.repeat(64)
const source = { kind: 'cli' as const, label: 'Verified CLI quota', evidenceRef: 'cli:quota' }
const request: ComputeRecommendationInput = { requiredCapabilities: ['analysis'], difficulty: 'standard', dataClass: 'internal', ready: true, valuable: true }
const binding: ComputeBindingDefinition = { id:'binding',accountId:'account',runtimeId:'codex',profileRef:'default',modelIds:['provider/model'],capabilities:['analysis'],poolIds:['shared'],dataClasses:['public','internal'],enabled:true,modelCapabilities:[{modelId:'provider/model',tier:'balanced',capabilities:['analysis'],notes:'A supported analysis model',verifiedAt:new Date(now).toISOString(),evidence:'Confirmed model catalog'}] }
function write(input: unknown, workspaceId = 1, at = now) { return mutateCompute(input, workspaceId, db, at) }
function observe(payload: Omit<Extract<ComputeObservationInput, {kind:'quota'}>, 'externalId'|'observedAt'|'source'|'status'> | Omit<Extract<ComputeObservationInput, {kind:'access'}>, 'externalId'|'observedAt'|'source'|'status'>, extras: Partial<ComputeObservationInput> = {}, at = now) {
  return write({action:'record_observation',observation:{externalId:randomUUID(),observedAt:new Date(at).toISOString(),source,status:'success',...payload,...extras}},1,at)
}
function quota(poolId = 'shared', used = 25, at = now) {
  return observe({kind:'quota',accountId:'account',poolId,windows:[{key:'session',label:'Session',usedPercent:used,unit:'percent',resetsAt:new Date(at + 3600000).toISOString()},{key:'weekly',label:'Weekly',usedPercent:40,unit:'percent',resetsAt:new Date(at + 86400000).toISOString()}]}, {}, at)
}
function access(at = now) {
  return observe({kind:'access',accountId:'account',bindingId:'binding',identityFingerprint:fingerprint,identityVerified:true,entitlementVerified:true}, {}, at)
}
function seed(workspaceId = 1) {
  write({action:'upsert_account',account:{id:'account',label:'Private account',provider:'provider',plan:'Observed plan',billingMode:'subscription',enabled:true,identityFingerprint:fingerprint}},workspaceId)
  write({action:'upsert_pool',pool:{id:'shared',accountId:'account',key:'shared',label:'Shared capacity',modelIds:[],windowKeys:['session','weekly']}},workspaceId)
  write({action:'upsert_binding',binding},workspaceId)
}
const preview = (at = now, input = request) => recommendCompute(readComputeOverview(1,db,at),input).candidates[0]
beforeEach(() => { db=new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateComputeLedger(db) })
afterEach(() => { db.close() })

describe('private capacity ledger', () => {
  it('migrates idempotently without seeding accounts or pretending a refresh job exists', () => {
    migrateComputeLedger(db)
    expect(readComputeOverview(1,db,now)).toMatchObject({accounts:[],bindings:[],refresh:{enabled:false,nextDueAt:null,status:'not_configured'}})
  })
  it('keeps observations append-only and idempotent without overwriting changed evidence', () => {
    seed()
    const event = {kind:'quota',externalId:randomUUID(),accountId:'account',poolId:'shared',observedAt:new Date(now).toISOString(),source,status:'failed',windows:[],error:'Quota unavailable'}
    expect(write({action:'record_observation',observation:event})).toMatchObject({created:true})
    expect(write({action:'record_observation',observation:event})).toMatchObject({created:false})
    expect(() => write({action:'record_observation',observation:{...event,error:'Changed evidence'}})).toThrow('different evidence')
    expect(() => db.exec("UPDATE compute_observations SET payload='{}'")).toThrow('append-only')
    expect(() => db.exec('DELETE FROM compute_observations')).toThrow('append-only')
  })
  it('scopes account identity, pool references and observations to the workspace', () => {
    seed(2)
    expect(readComputeOverview(1,db,now).accounts).toEqual([])
    expect(() => quota()).toThrow('not found in this workspace')
    seed(1)
    expect(readComputeOverview(1,db,now).accounts).toHaveLength(1)
    expect(readComputeOverview(2,db,now).accounts).toHaveLength(1)
  })
  it('retains the last complete snapshot but blocks on a new failed or incomplete reading', () => {
    seed(); quota(); access()
    expect(preview().executable).toBe(true)
    expect(observe({kind:'quota',accountId:'account',poolId:'shared',windows:[{key:'session',label:'Session',remainingPercent:99,unit:'percent',resetsAt:null}]}, {}, now+1000)).toMatchObject({status:'failed'})
    const pool=readComputeOverview(1,db,now+1000).accounts[0].pools[0]
    expect(pool).toMatchObject({status:'unavailable',effectiveRemainingPercent:60,lastGoodObservedAt:new Date(now).toISOString()})
    expect(pool.windows).toHaveLength(2)
    expect(preview(now+1000)).toMatchObject({executable:false,reasonCodes:expect.arrayContaining(['quota_unavailable'])})
    quota('shared',10,now-1000)
    expect(preview(now+1000).executable).toBe(false) // Delayed historical import cannot hide latest failure.
  })
  it('does not silently remove quota constraints or move an observed account identity', () => {
    seed(); quota()
    expect(() => write({action:'upsert_pool',pool:{id:'shared',accountId:'account',key:'shared',label:'Shared',modelIds:[],windowKeys:['session']}})).toThrow('cannot be removed')
    expect(() => write({action:'upsert_account',account:{id:'account',label:'Different login',provider:'provider',plan:'Plan',billingMode:'subscription',identityFingerprint:'b'.repeat(64)}})).toThrow('changed identity')
  })
  it('preserves unknown quota values instead of inventing available capacity', () => {
    seed(); access()
    observe({kind:'quota',accountId:'account',poolId:'shared',windows:['session','weekly'].map(key=>({key,label:key,usedPercent:null,remainingPercent:null,limit:null,used:null,unit:'unknown',resetsAt:null}))})
    expect(preview()).toMatchObject({executable:false,effectiveRemainingPercent:null,reasonCodes:expect.arrayContaining(['quota_unknown'])})
  })
  it('recognizes browser-confirmed account identity without verifying or enabling its harness', () => {
    seed(); quota()
    const browserSource = {kind:'browser' as const,label:'Account settings identity and plan'}
    observe({kind:'access',accountId:'account',bindingId:null,identityFingerprint:fingerprint,identityVerified:true,entitlementVerified:false},{source:browserSource})
    const overview=readComputeOverview(1,db,now)
    expect(overview.accounts[0]).toMatchObject({status:'ready',source:browserSource})
    expect(overview.bindings[0]).toMatchObject({identityStatus:'unknown',entitlementStatus:'unknown'})
    expect(preview()).toMatchObject({executable:false,reasonCodes:expect.arrayContaining(['identity_unverified','entitlement_unverified'])})
    observe({kind:'access',accountId:'account',bindingId:'binding',identityFingerprint:fingerprint,identityVerified:true,entitlementVerified:true},{source:browserSource},now+1000)
    expect(readComputeOverview(1,db,now+1000).bindings[0]).toMatchObject({identityStatus:'unverified',entitlementStatus:'unverified'})
    expect(preview(now+1000).executable).toBe(false)
  })
  it('attributes binding-confirmed account identity to the latest verified evidence and retains its age', () => {
    seed(); access(now-2000)
    const recentSource={kind:'provider_api' as const,label:'Verified second runtime identity'}
    write({action:'upsert_binding',binding:{...binding,id:'second'}})
    observe({kind:'access',accountId:'account',bindingId:'second',identityFingerprint:fingerprint,identityVerified:true,entitlementVerified:true},{source:recentSource},now-1000)
    write({action:'upsert_binding',binding:{...binding,id:'unverified'}})
    observe({kind:'access',accountId:'account',bindingId:'unverified',identityFingerprint:'b'.repeat(64),identityVerified:true,entitlementVerified:true})
    expect(readComputeOverview(1,db,now).accounts[0]).toMatchObject({status:'ready',observedAt:new Date(now-1000).toISOString(),source:recentSource})
    expect(readComputeOverview(1,db,now+25*3600000).accounts[0]).toMatchObject({status:'unknown',observedAt:new Date(now-1000).toISOString(),source:recentSource})
  })
  it('does not show a ready account when all identity evidence is stale', () => {
    seed(); access()
    observe({kind:'access',accountId:'account',bindingId:null,identityFingerprint:fingerprint,identityVerified:true,entitlementVerified:false},{source:{kind:'browser',label:'Account settings'}})
    const later=now+25*3600000
    expect(readComputeOverview(1,db,later).accounts[0].status).toBe('unknown')
    access(later)
    expect(readComputeOverview(1,db,later).accounts[0]).toMatchObject({status:'ready',observedAt:new Date(now).toISOString(),source:{kind:'browser',label:'Account settings'}})
  })
  it('reports actual collector failure separately from its last success and requires job evidence', () => {
    const event={kind:'collector',externalId:randomUUID(),observedAt:new Date(now).toISOString(),source,status:'success',enabled:false,intervalHours:null,nextDueAt:null,jobRef:null}
    write({action:'record_observation',observation:event})
    write({action:'record_observation',observation:{...event,externalId:randomUUID(),observedAt:new Date(now+1000).toISOString(),status:'failed',error:'Collection failed'}},1,now+1000)
    expect(readComputeOverview(1,db,now+1000).refresh).toMatchObject({enabled:false,status:'failed',lastSuccessAt:new Date(now).toISOString(),lastAttemptAt:new Date(now+1000).toISOString(),nextDueAt:null})
    expect(() => write({action:'record_observation',observation:{...event,externalId:randomUUID(),enabled:true}})).toThrow('actual job reference')
  })
  it('rejects credentials and executable profile paths before writing data', () => {
    expect(() => write({action:'upsert_account',account:{id:'bad',label:'ghp_'+'A'.repeat(36),provider:'p',plan:'plan',billingMode:'unknown'}})).toThrow('Remove credentials')
    seed()
    expect(() => write({action:'upsert_binding',binding:{...binding,profileRef:'/tmp/shell.sh'}})).toThrow('Invalid capacity payload')
  })
})

describe('evidence-based route preview', () => {
  beforeEach(() => { seed(); quota(); access() })
  it('uses the tightest session/weekly/model constraint while keeping unrelated pools separate', () => {
    write({action:'upsert_pool',pool:{id:'model',accountId:'account',key:'model',label:'Model allowance',modelIds:['provider/model'],windowKeys:['session','weekly']}})
    write({action:'upsert_pool',pool:{id:'spark',accountId:'account',key:'spark',label:'Different model pool',modelIds:['provider/spark'],windowKeys:['session','weekly']}})
    write({action:'upsert_binding',binding:{...binding,poolIds:['shared','model','spark']}})
    quota('model',85); quota('spark',100); access()
    expect(preview()).toMatchObject({effectiveRemainingPercent:15,executable:false,reasonCodes:['reserve_protected']})
  })
  it('requires fresh preflight after 15 minutes and hard-blocks observations older than 24 hours', () => {
    expect(preview(now+16*60000)).toMatchObject({executable:false,refreshRecommended:true,reasonCodes:expect.arrayContaining(['access_refresh_required','quota_refresh_required'])})
    // Keep reset beyond the stale point to test age independently.
    observe({kind:'quota',accountId:'account',poolId:'shared',windows:['session','weekly'].map(key=>({key,label:key,remainingPercent:70,unit:'percent',resetsAt:null}))})
    expect(preview(now+25*3600000).reasonCodes).toEqual(expect.arrayContaining(['access_stale','quota_stale']))
  })
  it('never refills a passed reset or converts reset credits into quota', () => {
    const at=now+3600001
    access(at)
    write({action:'record_observation',observation:{kind:'reset',accountId:'account',externalId:randomUUID(),observedAt:new Date(at).toISOString(),source,status:'success',available:3,event:'availability'}},1,at)
    expect(preview(at)).toMatchObject({executable:false,effectiveRemainingPercent:60,reasonCodes:expect.arrayContaining(['reset_unconfirmed'])})
    quota('shared',10,at)
    expect(preview(at).executable).toBe(true)
  })
  it('requires a matching account identity and current concrete harness entitlement', () => {
    observe({kind:'access',accountId:'account',bindingId:'binding',identityFingerprint:'b'.repeat(64),identityVerified:true,entitlementVerified:true}, {}, now+1000)
    expect(preview(now+1000).reasonCodes).toContain('identity_unverified')
    access(now+2000)
    expect(preview(now+2000).executable).toBe(true)
    write({action:'upsert_binding',binding:{...binding,profileRef:'different-profile'}})
    expect(preview(now+2000).reasonCodes).toContain('identity_unverified')
  })
  it('does not treat account-only or manual observations as verified harness access', () => {
    observe({kind:'access',accountId:'account',bindingId:'binding',identityFingerprint:fingerprint,identityVerified:true,entitlementVerified:true}, {source:{kind:'manual',label:'User claim'}},now+1000)
    observe({kind:'access',accountId:'account',bindingId:null,identityFingerprint:fingerprint,identityVerified:true,entitlementVerified:true}, {},now+2000)
    expect(preview(now+2000).executable).toBe(false)
  })
  it.each(['login_required','failed'] as const)('preserves account %s evidence even after a newer verified harness check', status => {
    const failedSource={kind:'browser' as const,label:'Account login check'}
    observe({kind:'access',accountId:'account',bindingId:null,identityFingerprint:null,identityVerified:false,entitlementVerified:false}, {status,source:failedSource},now+1000)
    access(now+2000)
    expect(readComputeOverview(1,db,now+2000).accounts[0]).toMatchObject({status:status==='failed'?'unavailable':'login_required',observedAt:new Date(now+1000).toISOString(),source:failedSource})
    expect(preview(now+2000).executable).toBe(false)
  })
  it('honors capability, difficulty and data restrictions and never creates work to burn expiring quota', () => {
    expect(preview(now,{...request,requiredCapabilities:['code-edit'],difficulty:'complex',dataClass:'restricted',valuable:false}).reasonCodes).toEqual(expect.arrayContaining(['capability_mismatch','difficulty_mismatch','data_scope_mismatch','task_not_valuable']))
    expect(preview(now,{...request,ready:false})).toMatchObject({executable:false,score:0})
    expect(preview(now,{...request,valuable:false})).toMatchObject({executable:false,score:0})
  })
  it('does not imply paid API access from a subscription account', () => {
    write({action:'upsert_account',account:{id:'account',label:'Explicit API account',provider:'provider',plan:'API',billingMode:'api',enabled:true,identityFingerprint:fingerprint}})
    expect(preview().reasonCodes).toContain('billing_not_allowed')
  })
})
