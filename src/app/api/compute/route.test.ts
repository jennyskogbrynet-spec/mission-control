// @vitest-environment node
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ role:vi.fn(), read:vi.fn(), mutate:vi.fn(), recommend:vi.fn(), project:vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireRole: mock.role }))
vi.mock('@/lib/compute-store', () => ({ readComputeOverview:mock.read,mutateCompute:mock.mutate,ComputeInputError:class extends Error { constructor(message:string,public status=400) { super(message) } } }))
vi.mock('@/lib/compute-recommender', () => ({ recommendCompute:mock.recommend }))
vi.mock('@/lib/rate-limit', () => ({ readLimiter:()=>null,mutationLimiter:()=>null }))
vi.mock('@/lib/db', () => ({ getDatabase:()=>({prepare:()=>({get:mock.project})}) }))
import { GET, POST } from './route'
import { POST as PREVIEW } from './recommend/route'
const body = (value:unknown, path='compute') => new NextRequest(`http://localhost/api/${path}`,{method:'POST',body:JSON.stringify(value)})
const input = {projectId:5,requiredCapabilities:['analysis'],difficulty:'standard',dataClass:'public',ready:true,valuable:true}
beforeEach(() => {
  vi.clearAllMocks()
  mock.role.mockReturnValue({user:{workspace_id:1,tenant_id:1,role:'admin'}})
  mock.read.mockReturnValue({accounts:[],bindings:[]})
  mock.mutate.mockReturnValue({created:true,externalId:'id',status:'success'})
  mock.project.mockReturnValue({id:5})
  mock.recommend.mockReturnValue({candidates:[]})
})
describe('local capacity API boundaries', () => {
  it.each([{workspace_id:2,tenant_id:1},{workspace_id:1,tenant_id:2}])('rejects another host owner before reading or writing (%j)',async user=>{
    mock.role.mockReturnValue({user})
    expect((await GET(new NextRequest('http://localhost/api/compute'))).status).toBe(403)
    expect((await POST(body({}))).status).toBe(403)
    expect((await PREVIEW(body(input,'compute/recommend'))).status).toBe(403)
    expect(mock.read).not.toHaveBeenCalled(); expect(mock.mutate).not.toHaveBeenCalled(); expect(mock.recommend).not.toHaveBeenCalled()
  })
  it('requires admin for imports and preserves authentication failures',async()=>{
    mock.role.mockReturnValue({error:'Requires admin',status:403})
    expect((await POST(body({}))).status).toBe(403)
    expect(mock.role).toHaveBeenCalledWith(expect.anything(),'admin')
    expect(mock.mutate).not.toHaveBeenCalled()
  })
  it('disables caching for the overview and returns created observation receipts',async()=>{
    const overview=await GET(new NextRequest('http://localhost/api/compute'))
    expect(overview.headers.get('cache-control')).toBe('private, no-store')
    const response=await POST(body({action:'record_observation',observation:{externalId:'id'}}))
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({created:true,externalId:'id'})
  })
  it('rejects oversized and malformed JSON before importing observations',async()=>{
    expect((await POST(body('x'.repeat(100001)))).status).toBe(413)
    expect((await POST(new NextRequest('http://localhost/api/compute',{method:'POST',body:'{bad'}))).status).toBe(400)
    expect(mock.mutate).not.toHaveBeenCalled()
  })
  it('validates project ownership and previews without saving or dispatching',async()=>{
    mock.project.mockReturnValueOnce(undefined)
    expect((await PREVIEW(body(input,'compute/recommend'))).status).toBe(404)
    expect(mock.recommend).not.toHaveBeenCalled()
    const response=await PREVIEW(body(input,'compute/recommend'))
    expect(response.status).toBe(200)
    expect(mock.project).toHaveBeenCalledWith(5,1)
    expect(mock.recommend).toHaveBeenCalledWith({accounts:[],bindings:[]},expect.objectContaining({reservePercent:20,allowedBillingModes:['subscription','local']}))
    expect(mock.mutate).not.toHaveBeenCalled()
  })
})
