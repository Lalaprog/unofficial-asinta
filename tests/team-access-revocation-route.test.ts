import {beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const state=vi.hoisted(()=>({founder:{ok:true,status:200,userId:'00000000-0000-4000-8000-000000000001'},service:vi.fn(),rpc:vi.fn(),ban:vi.fn(),lookup:vi.fn(),configured:true}));
vi.mock('@/lib/auth/serverRole',()=>({requireFounder:async()=>state.founder}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:()=>({})}));
vi.mock('@/lib/supabase/admin',()=>({isServiceRoleConfigured:()=>state.configured,createServiceRoleClient:()=>{state.service();return {rpc:state.rpc,auth:{admin:{updateUserById:state.ban,getUserById:state.lookup}}};}}));
import {GET,POST} from '@/app/api/users/deactivation/route';
const target='00000000-0000-4000-8000-000000000002';
const post=(body:unknown)=>new NextRequest('http://localhost/api/users/deactivation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const get=()=>new NextRequest(`http://localhost/api/users/deactivation?id=${target}`);
beforeEach(()=>{vi.clearAllMocks();state.founder={ok:true,status:200,userId:'00000000-0000-4000-8000-000000000001'};state.configured=true;delete process.env.TEAM_DEACTIVATION_ENABLED;});
describe('Supervisor deactivation endpoint',()=>{
  it('fails closed when disabled and does not make a service-role call',async()=>{expect((await GET(get())).status).toBe(503);expect((await POST(post({userId:target,confirmation:'DEACTIVATE'}))).status).toBe(503);expect(state.service).not.toHaveBeenCalled();});
  it('requires an authenticated Founder before using the service role',async()=>{process.env.TEAM_DEACTIVATION_ENABLED='true';state.founder={ok:false,status:403,userId:''};expect((await POST(post({userId:target,confirmation:'DEACTIVATE'}))).status).toBe(403);expect(state.service).not.toHaveBeenCalled();});
  it('requires explicit confirmation and passes only the verified actor to the database',async()=>{process.env.TEAM_DEACTIVATION_ENABLED='true';expect((await POST(post({userId:target}))).status).toBe(400);expect(state.rpc).not.toHaveBeenCalled();state.rpc.mockResolvedValue({data:true,error:null});state.ban.mockResolvedValue({data:{user:{id:target,banned_until:'2126-12-01T00:00:00Z'}},error:null});const response=await POST(post({userId:target,confirmation:'DEACTIVATE',actorId:target}));expect(response.status).toBe(200);expect(state.rpc).toHaveBeenCalledWith('revoke_supervisor_access_guarded',{p_actor:state.founder.userId,p_target:target});expect(response.headers.get('cache-control')).toContain('no-store');});
  it('reports partial Auth outcomes without undoing the restriction',async()=>{process.env.TEAM_DEACTIVATION_ENABLED='true';state.rpc.mockResolvedValue({data:true,error:null});state.ban.mockRejectedValue(Error('network'));const body=await (await POST(post({userId:target,confirmation:'DEACTIVATE'}))).json();expect(body).toMatchObject({ok:true,authBanConfirmed:false,warning:expect.stringMatching(/not confirmed/)});});
  it('lets a Founder check the ban without changing Auth',async()=>{process.env.TEAM_DEACTIVATION_ENABLED='true';state.rpc.mockResolvedValue({data:'revoked',error:null});state.lookup.mockResolvedValue({data:{user:{id:target,banned_until:'2126-12-01T00:00:00Z'}},error:null});expect(await (await GET(get())).json()).toMatchObject({state:'revoked',authBan:'confirmed'});expect(state.ban).not.toHaveBeenCalled();});
});
