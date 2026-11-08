import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const state = vi.hoisted(()=>({allowed:true,assured:true,signedIn:true,service:vi.fn(),rpc:vi.fn(),ids:['20000000-0000-0000-0000-000000000001'], countOverride:null as number | null}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:()=>({
  auth:{getUser:async()=>({data:{user:state.signedIn?{id:'00000000-0000-0000-0000-000000000002'}:null},error:null})},
  rpc:(name:string)=>name==='session_assurance_satisfied'?Promise.resolve({data:state.assured,error:null}):{eq:()=>({maybeSingle:async()=>({data:state.allowed?{id:'p'}:null,error:null})})},
  from:()=>({select:()=>({eq:()=>({eq:async()=>({data:state.ids.map(worker_id=>({worker_id})),error:null,count:state.countOverride ?? state.ids.length})})})}),
})}));
vi.mock('@/lib/supabase/admin',()=>({isServiceRoleConfigured:()=>true,createServiceRoleClient:()=>{state.service();return {rpc:state.rpc};}}));
import { GET, POST } from '@/app/api/projects/[id]/workers/route';
const p='10000000-0000-0000-0000-000000000001', w='20000000-0000-0000-0000-000000000001';
const request=(body:unknown)=>new NextRequest(`http://localhost/api/projects/${p}/workers`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();state.allowed=true;state.assured=true;state.signedIn=true;state.countOverride=null;});
describe('project workers endpoint',()=>{
  it('does not create a service client without verified project access and MFA',async()=>{
    state.allowed=false;expect((await POST(request({action:'assign',workerId:w}),{params:{id:p}})).status).toBe(404);
    state.allowed=true;state.assured=false;expect((await POST(request({action:'assign',workerId:w}),{params:{id:p}})).status).toBe(403);
    state.assured=true;state.signedIn=false;expect((await GET(new NextRequest('http://localhost'),{params:{id:p}})).status).toBe(401);
    expect(state.service).not.toHaveBeenCalled();
  });
  it('reads via user-scoped RLS, not the service client',async()=>{
    const response=await GET(new NextRequest('http://localhost'),{params:{id:p}});
    expect((await response.json()).workerIds).toEqual([w]);expect(state.service).not.toHaveBeenCalled();
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
  it('does not claim success on an unconfirmed assignment',async()=>{
    state.rpc.mockRejectedValue(new Error('lost response'));
    const response=await POST(request({action:'assign',workerId:w}),{params:{id:p}});
    expect(response.status).toBe(503);expect((await response.json()).error).toMatch(/not confirmed/i);
  });
});
