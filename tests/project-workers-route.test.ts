import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const state = vi.hoisted(()=>({allowed:true,assured:true,signedIn:true,service:vi.fn(),rpc:vi.fn(),ids:['20000000-0000-0000-0000-000000000001'], countOverride:null as number | null, details:[{id:'20000000-0000-0000-0000-000000000001',name:'Mara',position:'Mason'}], detailsCount:null as number | null, detailBatches:[] as string[][], detailsError:false}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:()=>({
  auth:{getUser:async()=>({data:{user:state.signedIn?{id:'00000000-0000-0000-0000-000000000002'}:null},error:null})},
  rpc:(name:string)=>name==='session_assurance_satisfied'?Promise.resolve({data:state.assured,error:null}):{eq:()=>({maybeSingle:async()=>({data:state.allowed?{id:'p'}:null,error:null})})},
  from:(table:string)=>table==='workers'?({select:()=>({in:(_column:string, batch:string[])=>({eq:async()=>{state.detailBatches.push(batch);const data=state.details.filter(w=>batch.includes(w.id));return {data,error:state.detailsError?{message:'failure'}:null,count:state.detailsCount ?? data.length};}})})}):({select:()=>({eq:()=>({eq:async()=>({data:state.ids.map(worker_id=>({worker_id})),error:null,count:state.countOverride ?? state.ids.length})})})}),
})}));
vi.mock('@/lib/supabase/admin',()=>({isServiceRoleConfigured:()=>true,createServiceRoleClient:()=>{state.service();return {rpc:state.rpc};}}));
import { GET, POST } from '@/app/api/projects/[id]/workers/route';
const p='10000000-0000-0000-0000-000000000001', w='20000000-0000-0000-0000-000000000001';
const request=(body:unknown)=>new NextRequest(`http://localhost/api/projects/${p}/workers`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();state.allowed=true;state.assured=true;state.signedIn=true;state.ids=[w];state.countOverride=null;state.details=[{id:w,name:'Mara',position:'Mason'}];state.detailsCount=null;state.detailBatches=[];state.detailsError=false;state.rpc.mockResolvedValue({data:[{id:w,name:'Mara',position:'Mason',contact_number:'—'}],error:null});});
describe('project workers endpoint',()=>{
  it('does not create a service client without verified project access and MFA',async()=>{
    state.allowed=false;expect((await POST(request({action:'assign',workerId:w}),{params:{id:p}})).status).toBe(404);
    state.allowed=true;state.assured=false;expect((await POST(request({action:'assign',workerId:w}),{params:{id:p}})).status).toBe(403);
    state.assured=true;state.signedIn=false;expect((await GET(new NextRequest('http://localhost'),{params:{id:p}})).status).toBe(401);
    expect(state.service).not.toHaveBeenCalled();
  });
  it('reads the team under RLS without returning available workers or creating a service client',async()=>{
    const response=await GET(new NextRequest('http://localhost'),{params:{id:p}});
    const body=await response.json();expect(body.workerIds).toEqual([w]);expect(body.availableWorkers).toBeUndefined();expect(state.service).not.toHaveBeenCalled();
  });
  it('reads only selected site worker details with caller RLS and no service client',async()=>{
    const response=await GET(new NextRequest('http://localhost/?view=bale'),{params:{id:p}});
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({workers:[{id:w,name:'Mara',position:'Mason'}],someDetailsUnavailable:false});
    expect(state.detailBatches).toEqual([[w]]);expect(state.service).not.toHaveBeenCalled();
    state.allowed=false;state.detailBatches=[];
    expect((await GET(new NextRequest('http://localhost/?view=bale'),{params:{id:p}})).status).toBe(404);
    expect(state.detailBatches).toEqual([]);expect(state.service).not.toHaveBeenCalled();
  });
  it('warns for unavailable details and fails closed on truncation, error, duplicate assignment or oversize',async()=>{
    state.details=[];
    expect(await (await GET(new NextRequest('http://localhost/?view=bale'),{params:{id:p}})).json()).toEqual({workers:[],someDetailsUnavailable:true});
    state.detailsCount=1;expect((await GET(new NextRequest('http://localhost/?view=bale'),{params:{id:p}})).status).toBe(503);
    state.detailsCount=null;state.detailsError=true;expect((await GET(new NextRequest('http://localhost/?view=bale'),{params:{id:p}})).status).toBe(503);
    state.detailsError=false;state.ids=[w,w];expect((await GET(new NextRequest('http://localhost/?view=bale'),{params:{id:p}})).status).toBe(503);
    state.ids=Array.from({length:1001},(_,i)=>`20000000-0000-0000-0000-${String(i).padStart(12,'0')}`);
    expect((await GET(new NextRequest('http://localhost/?view=bale'),{params:{id:p}})).status).toBe(503);
  });
  it('batches a larger team without depending on the shared worker cache',async()=>{
    state.ids=Array.from({length:101},(_,i)=>`20000000-0000-0000-0000-${String(i).padStart(12,'0')}`);
    state.details=state.ids.map(id=>({id,name:'Worker',position:'Mason'}));
    const response=await GET(new NextRequest('http://localhost/?view=bale'),{params:{id:p}});
    expect(response.status).toBe(200);const body=await response.json();expect(body.workers).toHaveLength(101);
    expect(body.someDetailsUnavailable).toBe(false);expect(state.detailBatches.map(b=>b.length)).toEqual([100,1]);
  });
  it('returns available workers only on the explicit authorized add-worker request',async()=>{
    const response=await GET(new NextRequest('http://localhost/?view=available'),{params:{id:p}});
    const body=await response.json();expect(body.availableWorkers).toEqual([{id:w,name:'Mara',position:'Mason',contact_number:'—'}]);expect(body.workerIds).toBeUndefined();expect(state.rpc).toHaveBeenCalledWith('available_project_workers_guarded',{p_actor:'00000000-0000-0000-0000-000000000002',p_project:p});
    state.allowed=false;state.service.mockClear();expect((await GET(new NextRequest('http://localhost/?view=available'),{params:{id:p}})).status).toBe(404);expect(state.service).not.toHaveBeenCalled();
  });
  it('does not return a silently truncated project team',async()=>{
    state.countOverride=2;
    const response=await GET(new NextRequest('http://localhost'),{params:{id:p}});
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/complete project team/);
  });
  it('validates registration and passes verified actor and site into the guarded RPC',async()=>{
    const create={action:'create',requestId:w,name:'Mara',position:'Mason',contact:'',rate:'850',rateType:'daily'};
    expect((await POST(request({...create,rate:'1.001'}),{params:{id:p}})).status).toBe(422);expect(state.rpc).not.toHaveBeenCalled();
    state.rpc.mockResolvedValue({data:{worker_id:w},error:null});
    expect((await POST(request(create),{params:{id:p}})).status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith('create_project_worker_guarded',expect.objectContaining({p_actor:'00000000-0000-0000-0000-000000000002',p_project:p,p_request:w,p_rate:'850'}));
  });
  it('reports a definite cross-site conflict without claiming a change',async()=>{
    state.rpc.mockResolvedValue({data:null,error:{code:'P1003'}});
    const response=await POST(request({action:'assign',workerId:w}),{params:{id:p}});
    expect(response.status).toBe(409);expect((await response.json()).error).toMatch(/already assigned/);
  });
  it('fails closed when availability could not be verified',async()=>{
    state.rpc.mockResolvedValue({data:null,error:{code:'XX000'}});
    expect((await GET(new NextRequest('http://localhost/?view=available'),{params:{id:p}})).status).toBe(503);
  });
  it('does not claim success on an unconfirmed assignment',async()=>{
    state.rpc.mockRejectedValue(new Error('lost response'));
    const response=await POST(request({action:'assign',workerId:w}),{params:{id:p}});
    expect(response.status).toBe(503);expect((await response.json()).error).toMatch(/not confirmed/i);
  });
});
