import {describe,expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {loadAccountEditSnapshot} from '@/lib/users/accountEditSnapshot';

const user={id:'sup',name:'Updated Supervisor',email:'test@example.invalid',role:'supervisor',created_at:'2026-01-01T00:00:00Z'};
const worker={id:'sup',active:true,pay_rate:'600.00',pay_rate_type:'daily',contact_number:'—',removed_at:null};
function clientFor(data:{profile?:unknown;worker?:unknown;rows?:unknown;count?:number|null;error?:unknown}={}) {
 const profiles={data:data.profile===undefined?user:data.profile,error:data.error??null};
 const workers={data:data.worker===undefined?worker:data.worker,error:null};
 const projects={data:data.rows===undefined?[{project_id:'a'},{project_id:'b'}]:data.rows,count:data.count===undefined?2:data.count,error:null};
 const from=vi.fn((table:string)=>({select:()=>({eq:()=>table==='project_supervisors'?{limit:async()=>projects}:{maybeSingle:async()=>table==='users'?profiles:workers}})}));
 return {client:{from} as unknown as SupabaseClient,from};
}
describe('targeted team-account edit snapshot',()=>{
 it('loads the current profile, linked worker and all counted assignments',async()=>{
  const {client,from}=clientFor();const result=await loadAccountEditSnapshot(client,'sup');
  expect(result).toEqual({user,worker,assignedProjectIds:['a','b']});expect(from.mock.calls.map(call=>call[0])).toEqual(['users','workers','project_supervisors']);
 });
 it('allows a genuinely missing linked profile',async()=>{
  const {client}=clientFor({worker:null,rows:[],count:0});expect((await loadAccountEditSnapshot(client,'sup')).worker).toBeNull();
 });
 it('fails closed for errors, truncated counts, malformed rows and mismatched identities',async()=>{
  for(const data of [{error:{message:'offline'}},{rows:[{project_id:'a'}],count:2},{count:null},{rows:[{project_id:'a'},{project_id:'a'}]},{profile:{...user,id:'other'}},{worker:{...worker,id:'other'}},{worker:{...worker,active:null}}]){
   await expect(loadAccountEditSnapshot(clientFor(data).client,'sup')).rejects.toThrow();
  }
 });
});
