import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const s=vi.hoisted(()=>({assured:true,configured:true,rpc:vi.fn(),direct:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:()=>({auth:{getUser:async()=>({data:{user:{id:'actor'}},error:null})},rpc:async()=>({data:s.assured,error:null}),from:(table:string)=>table==='users'?{select:()=>({eq:()=>({maybeSingle:async()=>({data:{id:'actor',role:'supervisor'},error:null})})})}:({insert:()=>({select:()=>({single:s.direct})})})})}));
vi.mock('@/lib/supabase/admin',()=>({isServiceRoleConfigured:()=>s.configured,createServiceRoleClient:()=>({rpc:s.rpc,from:()=>({insert:()=>({select:()=>({single:s.direct})})})})}));
import {POST} from '@/app/api/workers/route';
const req=()=>new NextRequest('http://localhost/api/workers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'00000000-0000-4000-8000-000000000001',name:'Worker',position:'Mason',pay_rate:800})});
beforeEach(()=>{process.env.TEAM_DEACTIVATION_ENABLED='true';s.assured=true;s.configured=true;vi.clearAllMocks();s.rpc.mockResolvedValue({data:{id:'00000000-0000-4000-8000-000000000001'},error:null});});afterEach(()=>delete process.env.TEAM_DEACTIVATION_ENABLED);
describe('global worker registration with access restriction',()=>{
 it('uses the guarded service RPC rather than a direct insert',async()=>{expect((await POST(req())).status).toBe(201);expect(s.rpc).toHaveBeenCalledWith('create_global_worker_guarded',expect.objectContaining({p_actor:'actor'}));expect(s.direct).not.toHaveBeenCalled();});
 it('does not fall back to direct writes on missing configuration or unconfirmed authorization',async()=>{s.configured=false;expect((await POST(req())).status).toBe(503);expect(s.direct).not.toHaveBeenCalled();s.configured=true;s.assured=false;expect((await POST(req())).status).toBe(403);expect(s.rpc).not.toHaveBeenCalled();});
 it('reports an unconfirmed result without retrying',async()=>{s.rpc.mockRejectedValue(Error('lost'));const response=await POST(req());expect(response.status).toBe(503);expect((await response.json()).error).toMatch(/not confirmed/);expect(s.direct).not.toHaveBeenCalled();});
});
