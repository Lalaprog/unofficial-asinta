import { beforeEach,describe,expect,it,vi } from 'vitest';
import { NextRequest } from 'next/server';
const mock=vi.hoisted(()=>({ founder:true, service:true, rpc:vi.fn(), create:vi.fn() }));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:()=>({})}));
vi.mock('@/lib/auth/serverRole',()=>({requireFounder:async()=>mock.founder?{ok:true,userId:'00000000-0000-0000-0000-000000000001'}:{ok:false,status:403,error:'Forbidden'}}));
vi.mock('@/lib/supabase/admin',()=>({isServiceRoleConfigured:()=>mock.service,createServiceRoleClient:()=>{mock.create();return {rpc:mock.rpc};}}));
import { POST } from '@/app/api/workers/remove/route';
const w='10000000-0000-0000-0000-000000000001';
const request=(body:unknown)=>new NextRequest('http://localhost/api/workers/remove',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{mock.founder=true;mock.service=true;mock.rpc.mockReset();mock.create.mockReset();});
describe('worker removal endpoint',()=>{
  it('requires Founder and validates action and distinct IDs before constructing an admin client',async()=>{
    mock.founder=false;expect((await POST(request({ids:[w],action:'remove'}))).status).toBe(403);
    mock.founder=true;expect((await POST(request({ids:[w,w],action:'remove'}))).status).toBe(400);
    expect((await POST(request({ids:[w],action:'delete'}))).status).toBe(400);expect(mock.create).not.toHaveBeenCalled();
  });
  it('returns only validated results and does not claim a lost response succeeded',async()=>{
    mock.rpc.mockResolvedValueOnce({data:{results:[{id:w,status:'removed'}]},error:null});
    expect(await (await POST(request({ids:[w],action:'remove'}))).json()).toEqual({ok:true,results:[{id:w,status:'removed'}]});
    expect(mock.rpc).toHaveBeenCalledWith('set_workers_removed_guarded',expect.objectContaining({p_remove:true}));
    mock.rpc.mockRejectedValueOnce(new Error('lost response'));
    const response=await POST(request({ids:[w],action:'restore'}));expect(response.status).toBe(503);expect((await response.json()).error).toMatch(/not confirmed/i);
    mock.rpc.mockResolvedValueOnce({data:{results:[]},error:null});expect((await POST(request({ids:[w],action:'remove'}))).status).toBe(503);
  });
});
