import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {roleCheck} from '../scripts/check-weekly-bale-expiry.mjs';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const [founder,supervisor,outsider,worker,site,other]=[1,2,3,4,5,6].map(id);
const sql=(path:string)=>readFileSync(path,'utf8');
async function fixture(withExpiration=false){
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
  CREATE TABLE public.users(id uuid primary key,name text,email text,role text);
  CREATE TABLE public.workers(id uuid primary key,name text,active boolean);
  CREATE TABLE public.projects(id uuid primary key,name text);
  CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid,primary key(project_id,supervisor_id));
  CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean,primary key(project_id,worker_id));
  CREATE TABLE public.advances(id uuid primary key default gen_random_uuid(),worker_id uuid,project_id uuid,amount numeric(10,2),amount_deducted numeric(10,2),reason text,date date,status text);
  CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,status text);
  CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
  CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
  CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT role FROM public.users WHERE id=auth.uid()$$;
  CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND public.current_user_role()='founder'$$;
  CREATE FUNCTION public.is_supervisor_assigned(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.project_supervisors WHERE project_id=p AND supervisor_id=auth.uid())$$;
  GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role; GRANT SELECT ON public.workers TO authenticated;
  INSERT INTO public.users VALUES ('${founder}','Founder','f@example.invalid','founder'),('${supervisor}','Supervisor','s@example.invalid','supervisor'),('${outsider}','Other','o@example.invalid','supervisor');
  INSERT INTO public.workers VALUES ('${worker}','Worker',true); INSERT INTO public.projects VALUES ('${site}','Site'),('${other}','Other site');
  INSERT INTO public.project_supervisors VALUES ('${site}','${supervisor}'),('${other}','${outsider}'); INSERT INTO public.project_worker_assignments VALUES ('${site}','${worker}',true);`);
 await db.exec(sql('supabase/migrations/20261013000000_advance_requests.sql'));
 await db.exec(sql('supabase/migrations/20261013000001_advance_request_notifications.sql'));
 // A pre-cutover pending request must not be retroactively classified/expired.
 await db.query('INSERT INTO public.advance_requests(id,worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,$3,50,$4)',[id(90),worker,site,supervisor]);
 await db.exec(sql('supabase/migrations/20261113000004_bale_request_site_guard.sql'));
 const guard=sql('supabase/drafts/guard_legacy_bale_payment.sql');
 await db.exec(guard.slice(guard.indexOf('CREATE FUNCTION public.guard_new_advance_finalized_payroll()'),guard.indexOf('-- Keep the atomic implementation')));
 await db.exec(sql('supabase/drafts/weekly_bale_schedule.sql'));
 if(withExpiration){await db.exec(sql('supabase/drafts/weekly_bale_expiration.sql'));await db.exec(sql('supabase/drafts/weekly_bale_release_list.sql'));await db.exec(sql('supabase/drafts/weekly_bale_status_batch.sql'));await db.exec(sql('supabase/drafts/weekly_bale_scheduler.sql'));}
 // Test-only replacement by owner. Production clock accepts no user argument.
 await db.exec(`CREATE OR REPLACE FUNCTION public.weekly_bale_clock() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path='' AS $$SELECT current_setting('test.clock')::timestamptz$$;
  SET test.clock='2026-11-15T04:00:00Z'; SET test.uid='${supervisor}'; SET test.assurance='yes'; SET ROLE authenticated;`);
 return db;
}
const time=(db:PGlite,value:string)=>db.exec(`SET test.clock='${value}'`);
const role=(db:PGlite,value:string)=>db.exec(`SET test.uid='${value}'`);
const submit=async(db:PGlite)=> (await db.query<{id:string}>('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,100.25,$3) RETURNING id',[worker,site,supervisor])).rows[0].id;
const status=(db:PGlite,request:string)=>db.query<{result:{effective_status:string;stored_status:string;period_start:string;release_date:string}}>('SELECT public.weekly_bale_effective_status($1) result',[request]);
const release=(db:PGlite,request:string)=>db.query<{result:{outcome:string;advance_id:string}}>('SELECT public.record_weekly_bale_release($1) result',[request]);
describe('legacy Bale anonymous RPC ACL candidate (not deployed)',()=>{
 const candidate=()=>sql('supabase/drafts/legacy_bale_request_anon_acl.sql');
 const grantLegacy=`GRANT EXECUTE ON FUNCTION public.review_advance_request(uuid,text),public.approve_advance_requests(uuid[]),public.issue_advance_request(uuid) TO anon,service_role;`;
 it('removes anonymous grants while retaining Founder review, weekly guard and replacement release',async()=>{
  const db=await fixture(true);try{
   await db.exec(`RESET ROLE;${grantLegacy}`);
   // This models the observed explicit ACL, not a hosted mutation.
   expect((await db.query("SELECT has_function_privilege('anon','public.review_advance_request(uuid,text)','EXECUTE') allowed")).rows[0]).toEqual({allowed:true});
   await db.exec("SET ROLE anon; SET test.uid=''; SET test.assurance='no'");
   await expect(db.query("SELECT public.review_advance_request($1,'approve')",[id(99)])).rejects.toThrow(/Founder access is required/);
   await db.exec('RESET ROLE');
   await db.exec(`BEGIN;${candidate()} COMMIT;`);
   for(const signature of ['public.review_advance_request(uuid,text)','public.approve_advance_requests(uuid[])','public.issue_advance_request(uuid)']){
    const result=await db.query<{anon:boolean;authenticated:boolean;service:boolean}>(`SELECT has_function_privilege('anon',$1,'EXECUTE') anon,has_function_privilege('authenticated',$1,'EXECUTE') authenticated,has_function_privilege('service_role',$1,'EXECUTE') service`,[signature]);
    expect(result.rows[0]).toEqual({anon:false,authenticated:true,service:true});
   }
   await db.exec("SET ROLE anon; SET test.uid=''; SET test.assurance='no'");
   await expect(db.query("SELECT public.review_advance_request($1,'approve')",[id(99)])).rejects.toThrow(/permission denied/);
   await db.exec(`SET ROLE authenticated;SET test.uid='${supervisor}';SET test.assurance='yes'`);
   const request=await submit(db);await role(db,founder);await time(db,'2026-11-17T15:59:59Z');await db.query("SELECT public.review_advance_request($1,'approve')",[request]);
   await time(db,'2026-11-18T04:00:00Z');
   await expect(db.query('SELECT public.issue_advance_request($1)',[request])).rejects.toThrow(/controlled Wednesday external-release action/);
   await role(db,supervisor);expect((await release(db,request)).rows[0].result.outcome).toBe('updated');
  }finally{await db.close();}
 },30000);
 it('rolls back direct revokes when anon inherits EXECUTE',async()=>{
  const db=await fixture();try{
   await db.exec(`RESET ROLE;${grantLegacy} CREATE ROLE legacy_rpc_inherited; GRANT EXECUTE ON FUNCTION public.review_advance_request(uuid,text) TO legacy_rpc_inherited; GRANT legacy_rpc_inherited TO anon;`);
   await expect(db.exec(`BEGIN;${candidate()} COMMIT;`)).rejects.toThrow(/Unexpected inherited anon access/);await db.exec('ROLLBACK');
   expect((await db.query("SELECT has_function_privilege('anon','public.issue_advance_request(uuid)','EXECUTE') allowed")).rows[0]).toEqual({allowed:true});
  }finally{await db.close();}
 },30000);
 it('fails without changing grants when authenticated access is missing',async()=>{
  const db=await fixture();try{
   await db.exec(`RESET ROLE;${grantLegacy} REVOKE EXECUTE ON FUNCTION public.issue_advance_request(uuid) FROM authenticated;`);
   await expect(db.exec(`BEGIN;${candidate()} COMMIT;`)).rejects.toThrow(/missing or inaccessible/);await db.exec('ROLLBACK');
   expect((await db.query("SELECT has_function_privilege('anon','public.review_advance_request(uuid,text)','EXECUTE') allowed")).rows[0]).toEqual({allowed:true});
  }finally{await db.close();}
 },30000);
 it('rolls back when authenticated access depends only on PUBLIC',async()=>{
  const db=await fixture();try{
   await db.exec(`RESET ROLE;${grantLegacy} REVOKE EXECUTE ON FUNCTION public.issue_advance_request(uuid) FROM authenticated; GRANT EXECUTE ON FUNCTION public.issue_advance_request(uuid) TO PUBLIC;`);
   await expect(db.exec(`BEGIN;${candidate()} COMMIT;`)).rejects.toThrow(/lost authenticated legacy Bale access/);await db.exec('ROLLBACK');
   expect((await db.query("SELECT has_function_privilege('anon','public.review_advance_request(uuid,text)','EXECUTE') anon,has_function_privilege('authenticated','public.issue_advance_request(uuid)','EXECUTE') authenticated")).rows[0]).toEqual({anon:true,authenticated:true});
  }finally{await db.close();}
 },30000);
 it('fails safely if a required legacy function is absent',async()=>{
  const db=await fixture();try{
   await db.exec(`RESET ROLE;${grantLegacy} DROP FUNCTION public.issue_advance_request(uuid);`);
   await expect(db.exec(`BEGIN;${candidate()} COMMIT;`)).rejects.toThrow(/missing or inaccessible/);await db.exec('ROLLBACK');
   expect((await db.query("SELECT has_function_privilege('anon','public.review_advance_request(uuid,text)','EXECUTE') allowed")).rows[0]).toEqual({allowed:true});
  }finally{await db.close();}
 },30000);
});
describe('experimental weekly Bale schedule (not deployed)',()=>{
 it('uses Manila time at Sunday/Tuesday/Wednesday boundaries and projects expiration without mutating history',async()=>{
  const db=await fixture();try{
   await time(db,'2026-11-14T15:59:59Z');await expect(submit(db)).rejects.toThrow(/Sunday through Tuesday/);
   await time(db,'2026-11-14T16:00:00Z');const request=await submit(db);
   expect((await status(db,request)).rows[0].result).toEqual({request_id:request,period_start:'2026-11-15',stored_status:'pending_approval',effective_status:'pending_approval',release_date:'2026-11-18'});
   await time(db,'2026-11-17T15:59:59Z');expect((await status(db,request)).rows[0].result.effective_status).toBe('pending_approval');
   await time(db,'2026-11-17T16:00:00Z');expect((await status(db,request)).rows[0].result).toMatchObject({stored_status:'pending_approval',effective_status:'expired_unapproved'});
   await expect(submit(db)).rejects.toThrow(/Sunday through Tuesday/);await role(db,founder);
   await expect(db.query("SELECT public.review_advance_request($1,'approve')",[request])).rejects.toThrow(/expired after Tuesday/);
   await expect(db.query('SELECT public.approve_advance_requests($1::uuid[])',[[request]])).rejects.toThrow(/expired after Tuesday/);
   await expect(status(db,id(90))).rejects.toThrow(/Legacy request/);
   await db.exec('RESET ROLE');expect((await db.query('SELECT status FROM public.advance_requests WHERE id=$1',[id(90)])).rows).toEqual([{status:'pending_approval'}]);
   expect((await db.query('SELECT status FROM public.advance_requests WHERE id=$1',[request])).rows).toEqual([{status:'pending_approval'}]);
  }finally{await db.close();}
 },30000);
 it('permits Founder review through Tuesday and authorized Supervisor release on Wednesday exactly once',async()=>{
  const db=await fixture();try{
   const request=await submit(db);await role(db,founder);await time(db,'2026-11-17T15:59:59Z');await db.query("SELECT public.review_advance_request($1,'approve')",[request]);
   await expect(release(db,request)).rejects.toThrow(/Wednesday/);
   await time(db,'2026-11-17T16:00:00Z');await expect(db.query('SELECT public.issue_advance_request($1)',[request])).rejects.toThrow(/controlled Wednesday.*refresh the page.*do not pay again/);
   await role(db,outsider);await expect(release(db,request)).rejects.toThrow(/Site authorization/);
   await role(db,supervisor);const issued=(await release(db,request)).rows[0].result;expect(issued.outcome).toBe('updated');expect((await release(db,request)).rows[0].result).toEqual({...issued,outcome:'already_recorded'});
   expect((await status(db,request)).rows[0].result.effective_status).toBe('issued');
   await db.exec('RESET ROLE');expect((await db.query('SELECT amount::text,date::text,status,amount_deducted::text FROM public.advances')).rows).toEqual([{amount:'100.25',date:'2026-11-18',status:'active',amount_deducted:'0.00'}]);
   expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.audit_log WHERE table_name='advances'")).rows[0].n).toBe(1);
   expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.user_notifications WHERE advance_request_id=$1 AND event_type='advance_request_issued'",[request])).rows[0].n).toBe(1);
  }finally{await db.close();}
 },30000);
 it('requires Founder review when a worker moves or is archived after approval, while preserving release replay',async()=>{
  const db=await fixture(true);try{
   const request=await submit(db);await role(db,founder);await db.query("SELECT public.review_advance_request($1,'approve')",[request]);
   await time(db,'2026-11-18T04:00:00Z');await db.exec('RESET ROLE');
   await db.query('UPDATE public.project_worker_assignments SET active=false WHERE worker_id=$1 AND project_id=$2',[worker,site]);
   await db.query('INSERT INTO public.project_worker_assignments VALUES($1,$2,true)',[other,worker]);
   await db.exec(`SET ROLE authenticated; SET test.uid='${supervisor}'`);
   expect((await db.query<{result:{items:{assignment_review_required:boolean}[]}}>("SELECT public.weekly_bale_release_list('2026-11-15') result")).rows[0].result.items[0].assignment_review_required).toBe(true);
   await expect(release(db,request)).rejects.toThrow(/no longer uniquely assigned/);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(0);
   await db.query('UPDATE public.project_worker_assignments SET active=false WHERE worker_id=$1 AND project_id=$2',[worker,other]);
   await db.query('UPDATE public.project_worker_assignments SET active=true WHERE worker_id=$1 AND project_id=$2',[worker,site]);
   await db.query('UPDATE public.workers SET active=false WHERE id=$1',[worker]);
   await db.exec(`SET ROLE authenticated; SET test.uid='${supervisor}'`);
   await expect(release(db,request)).rejects.toThrow(/no longer uniquely assigned/);
   await db.exec('RESET ROLE');await db.query('UPDATE public.workers SET active=true WHERE id=$1',[worker]);
   await db.query("INSERT INTO public.users(id,name,email,role) VALUES($1,'Linked account','linked@example.invalid','supervisor')",[worker]);
   await db.exec(`SET ROLE authenticated; SET test.uid='${supervisor}'`);
   expect((await db.query<{result:{items:{assignment_review_required:boolean}[]}}>("SELECT public.weekly_bale_release_list('2026-11-15') result")).rows[0].result.items[0].assignment_review_required).toBe(true);
   await expect(release(db,request)).rejects.toThrow(/is a Supervisor/);
   await role(db,founder);const issued=(await release(db,request)).rows[0].result;expect(issued.outcome).toBe('updated');
   await role(db,supervisor);expect((await release(db,request)).rows[0].result).toEqual({...issued,outcome:'already_recorded'});
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(1);
  }finally{await db.close();}
 },30000);
 it('supports same-site batch approval and Founder release, while hiding status from unrelated sites',async()=>{
  const db=await fixture();try{
   const request=await submit(db);const second=await submit(db);
   await role(db,outsider);await expect(status(db,request)).rejects.toThrow(/Request unavailable/);
   await role(db,founder);await db.query('SELECT public.approve_advance_requests($1::uuid[])',[[request,second]]);
   await time(db,'2026-11-18T04:00:00Z');expect((await release(db,request)).rows[0].result.outcome).toBe('updated');
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.advances WHERE date='2026-11-18'")).rows[0].n).toBe(1);
  }finally{await db.close();}
 },30000);
 it('blocks release after Wednesday or into approved payroll, and denies lost assurance',async()=>{
  const db=await fixture();try{
   const request=await submit(db);await role(db,founder);await db.query("SELECT public.review_advance_request($1,'approve')",[request]);
   await time(db,'2026-11-18T16:00:00Z');await expect(release(db,request)).rejects.toThrow(/Wednesday/);
   await time(db,'2026-11-18T04:00:00Z');await db.exec(`RESET ROLE; INSERT INTO public.payroll VALUES ('${id(80)}','${worker}','2026-11-15','2026-11-21','approved'); SET ROLE authenticated;`);
   await expect(release(db,request)).rejects.toThrow(/Finalized payroll/);await db.exec('SET test.assurance=\'no\'');await expect(release(db,request)).rejects.toThrow(/Authorized access/);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('materializes overdue requests as system rejections with audit and notification exactly once',async()=>{
  const db=await fixture(true);try{
   const overdue=await submit(db),approved=await submit(db);await role(db,founder);await db.query("SELECT public.review_advance_request($1,'approve')",[approved]);
   await expect(db.query('SELECT public.materialize_weekly_bale_expiry(100)')).rejects.toThrow(/permission denied/);
   await db.exec("RESET ROLE; SET test.uid=''; SET test.clock='2026-11-17T15:59:59Z'");
   expect((await db.query<{n:number}>('SELECT public.materialize_weekly_bale_expiry(100) n')).rows[0].n).toBe(0);
   await time(db,'2026-11-17T16:00:00Z');expect((await db.query<{n:number}>('SELECT public.materialize_weekly_bale_expiry(100) n')).rows[0].n).toBe(1);
   expect((await db.query<{n:number}>('SELECT public.materialize_weekly_bale_expiry(100) n')).rows[0].n).toBe(0);
   expect((await db.query('SELECT status,auto_expired,rejected_by FROM public.advance_requests WHERE id=$1',[overdue])).rows).toEqual([{status:'rejected',auto_expired:true,rejected_by:null}]);
   expect((await db.query('SELECT status,auto_expired FROM public.advance_requests WHERE id=$1',[approved])).rows).toEqual([{status:'approved_pending_payment',auto_expired:false}]);
   expect((await db.query('SELECT status,auto_expired FROM public.advance_requests WHERE id=$1',[id(90)])).rows).toEqual([{status:'pending_approval',auto_expired:false}]);
   expect((await db.query("SELECT actor_id,actor_email FROM public.audit_log WHERE record_id=$1 AND action='update'",[overdue])).rows).toEqual([{actor_id:null,actor_email:null}]);
   expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.user_notifications WHERE advance_request_id=$1 AND event_type='advance_request_rejected'",[overdue])).rows[0].n).toBe(1);
   expect((await db.query('SELECT expiry_xid FROM public.weekly_bale_requests WHERE request_id=$1',[overdue])).rows).toEqual([{expiry_xid:null}]);
  }finally{await db.close();}
 },30000);
 it('returns bounded authorized status for projected expiry, recorded expiry and legacy rows',async()=>{
  const db=await fixture(true);try{
   const request=await submit(db);const get=()=>db.query<{data:{items:{id:string;kind:string;effective_status:string;auto_expired:boolean;can_review:boolean}[]}}>('SELECT public.weekly_bale_status_batch($1::uuid[]) data',[[request,id(90)]]);
   let items=(await get()).rows[0].data.items;expect(items.find(i=>i.id===request)).toMatchObject({kind:'weekly',effective_status:'pending_approval',can_review:true,auto_expired:false});expect(items.find(i=>i.id===id(90))).toMatchObject({kind:'legacy',can_review:false});
   await time(db,'2026-11-17T16:00:00Z');items=(await get()).rows[0].data.items;expect(items.find(i=>i.id===request)).toMatchObject({effective_status:'expired_unapproved',can_review:false,auto_expired:false});
   await role(db,outsider);await expect(get()).rejects.toThrow(/unavailable/);
   await role(db,supervisor);await expect(db.query('SELECT public.weekly_bale_status_batch($1::uuid[])',[[request,request]])).rejects.toThrow(/Invalid request ID/);
   await db.exec("RESET ROLE; SET test.uid=''");await db.query('SELECT public.materialize_weekly_bale_expiry(100)');await db.exec(`SET ROLE authenticated; SET test.uid='${supervisor}'`);
   items=(await get()).rows[0].data.items;expect(items.find(i=>i.id===request)).toMatchObject({effective_status:'rejected',can_review:false,auto_expired:true});
  }finally{await db.close();}
 },30000);
 it('lists approved and issued requests only to the Founder or a currently assigned Supervisor',async()=>{
  const db=await fixture(true);try{
   const request=await submit(db);await role(db,founder);await db.query("SELECT public.review_advance_request($1,'approve')",[request]);
   const get=()=>db.query<{result:{items:{request_id:string;status:string;amount:string;project_name:string}[]}}>("SELECT public.weekly_bale_release_list('2026-11-15') result");
   expect((await get()).rows[0].result.items).toEqual([{request_id:request,worker_id:worker,worker_name:'Worker',project_id:site,project_name:'Site',amount:'100.25',status:'approved_pending_payment',release_date:'2026-11-18',issued_advance_id:null,assignment_review_required:false}]);
   await role(db,supervisor);expect((await get()).rows[0].result.items).toHaveLength(1);
   await role(db,outsider);expect((await get()).rows[0].result.items).toHaveLength(0);
   await db.exec("SET test.assurance='no'");await expect(get()).rejects.toThrow(/Authorized access/);
  }finally{await db.close();}
 },30000);
 it('runs bounded catch-up and reports stale heartbeat and a new overdue backlog',async()=>{
  const db=await fixture(true);try{
   const request=await submit(db);await role(db,founder);
   const health=()=>db.query<{data:{healthy:boolean;last_success:string|null;current_remaining_due:number;last_processed:number|null}}>('SELECT public.weekly_bale_expiry_health_status() data');
   expect((await health()).rows[0].data).toMatchObject({healthy:false,last_success:null,current_remaining_due:0});
   await expect(db.query('SELECT public.run_weekly_bale_expiry_job()')).rejects.toThrow(/permission denied/);
   await db.exec("RESET ROLE; SET test.uid=''; SET test.clock='2026-11-18T04:00:00Z'");
   expect((await db.query<{data:object}>('SELECT public.run_weekly_bale_expiry_job() data')).rows[0].data).toEqual({outcome:'completed',processed:1,remaining_due:0});
   await db.exec(`SET ROLE authenticated; SET test.uid='${founder}'`);expect((await health()).rows[0].data).toMatchObject({healthy:true,current_remaining_due:0,last_processed:1});
   await time(db,'2026-11-18T04:03:01Z');expect((await health()).rows[0].data.healthy).toBe(false);
   await role(db,supervisor);await expect(health()).rejects.toThrow(/Founder access/);
   await db.exec('RESET ROLE');expect((await db.query('SELECT status,auto_expired FROM public.advance_requests WHERE id=$1',[request])).rows).toEqual([{status:'rejected',auto_expired:true}]);
  }finally{await db.close();}
 },30000);
 it('gives a separate restricted monitor only a fail-closed expiry signal',async()=>{
  const db=await fixture(true);try{
   const request=await submit(db);await db.exec("RESET ROLE; SET test.uid=''; CREATE ROLE bale_monitor; GRANT USAGE ON SCHEMA public TO bale_monitor;");
   await db.exec(sql('supabase/drafts/weekly_bale_external_monitor.sql'));
   for(const name of ['anon','authenticated','service_role']){
    expect((await db.query<{allowed:boolean}>("SELECT has_function_privilege($1,'public.weekly_bale_external_monitor_healthy()','EXECUTE') allowed",[name])).rows[0].allowed).toBe(false);
   }
   await db.exec('GRANT EXECUTE ON FUNCTION public.weekly_bale_external_monitor_healthy() TO bale_monitor; SET ROLE bale_monitor');
   const health=()=>db.query<{healthy:boolean}>('SELECT public.weekly_bale_external_monitor_healthy() healthy');
   const roleReport=(await db.query<Record<string,unknown>>(roleCheck)).rows[0];
   expect(roleReport).toMatchObject({role_name:'bale_monitor',superuser:false,bypass_rls:false,create_role:false,create_db:false,replication:false,elevated_membership:false,schema_create:false,owns_monitor:false,can_run_job:false,table_access:false});
   expect((await health()).rows[0].healthy).toBe(false); // No heartbeat yet.
   await expect(db.query('SELECT * FROM public.weekly_bale_expiry_health')).rejects.toThrow(/permission denied/);
   await expect(db.query('SELECT public.run_weekly_bale_expiry_job()')).rejects.toThrow(/permission denied/);
   await db.exec("RESET ROLE; SET test.clock='2026-11-18T04:00:00Z'");
   // Overdue work is unhealthy even if the heartbeat was just written.
   await db.exec("INSERT INTO public.weekly_bale_expiry_health VALUES(true,'2026-11-18T04:00:00Z',0,0); SET ROLE bale_monitor");
   expect((await health()).rows[0].healthy).toBe(false);
   await db.exec("RESET ROLE; DELETE FROM public.weekly_bale_expiry_health; SELECT public.run_weekly_bale_expiry_job(); SET ROLE bale_monitor");
   expect((await health()).rows[0].healthy).toBe(true);
   await time(db,'2026-11-18T04:03:01Z');expect((await health()).rows[0].healthy).toBe(false);
   await time(db,'2026-11-18T03:59:59Z');expect((await health()).rows[0].healthy).toBe(false); // Future heartbeat.
   await role(db,founder);await expect(health()).rejects.toThrow(/must not use a user session/);
   await db.exec('RESET ROLE');expect((await db.query('SELECT status FROM public.advance_requests WHERE id=$1',[request])).rows).toEqual([{status:'rejected'}]);
  }finally{await db.close();}
 },30000);
 it('limits each catch-up transaction to 500 and drains the remaining backlog on retry',async()=>{
  const db=await fixture(true);try{
   await db.query('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) SELECT $1,$2,10,$3 FROM generate_series(1,501)',[worker,site,supervisor]);
   await db.exec("RESET ROLE; SET test.uid=''; SET test.clock='2026-11-18T04:00:00Z'");
   expect((await db.query<{data:object}>('SELECT public.run_weekly_bale_expiry_job() data')).rows[0].data).toEqual({outcome:'completed',processed:500,remaining_due:1});
   await db.exec(`SET ROLE authenticated; SET test.uid='${founder}'`);
   expect((await db.query<{data:object}>('SELECT public.weekly_bale_expiry_health_status() data')).rows[0].data).toMatchObject({healthy:false,current_remaining_due:1});
   await db.exec("RESET ROLE; SET test.uid=''");expect((await db.query<{data:object}>('SELECT public.run_weekly_bale_expiry_job() data')).rows[0].data).toEqual({outcome:'completed',processed:1,remaining_due:0});
   expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.advance_requests WHERE auto_expired")).rows[0].n).toBe(501);
  }finally{await db.close();}
 },30000);
 it('rolls back expiry and notification when audit fails and preserves manual Founder attribution',async()=>{
  const db=await fixture(true);try{
   const overdue=await submit(db),manual=await submit(db);await role(db,founder);await db.query("SELECT public.review_advance_request($1,'reject')",[manual]);
   await db.exec("RESET ROLE; SET test.uid=''; SET test.clock='2026-11-18T04:00:00Z'; CREATE FUNCTION public.fail_expiry_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='update' AND NEW.actor_id IS NULL THEN RAISE EXCEPTION 'expiry audit failed'; END IF; RETURN NEW; END$$; CREATE TRIGGER fail_expiry_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.fail_expiry_audit();");
   await expect(db.query('SELECT public.run_weekly_bale_expiry_job()')).rejects.toThrow(/expiry audit failed/);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_bale_expiry_health')).rows[0].n).toBe(0);
   expect((await db.query('SELECT status,auto_expired FROM public.advance_requests WHERE id=$1',[overdue])).rows).toEqual([{status:'pending_approval',auto_expired:false}]);
   expect((await db.query('SELECT status,auto_expired,rejected_by FROM public.advance_requests WHERE id=$1',[manual])).rows).toEqual([{status:'rejected',auto_expired:false,rejected_by:founder}]);
   expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.user_notifications WHERE advance_request_id=$1 AND event_type='advance_request_rejected'",[overdue])).rows[0].n).toBe(0);
   expect((await db.query('SELECT expiry_xid,expired_at FROM public.weekly_bale_requests WHERE request_id=$1',[overdue])).rows).toEqual([{expiry_xid:null,expired_at:null}]);
  }finally{await db.close();}
 },30000);
 it('rolls back release and private marker if audit fails, and prevents direct client writes',async()=>{
  const db=await fixture();try{
   const request=await submit(db);await role(db,founder);await db.query("SELECT public.review_advance_request($1,'approve')",[request]);await time(db,'2026-11-18T04:00:00Z');
   await expect(db.query('UPDATE public.weekly_bale_requests SET release_xid=txid_current(),release_actor=$1 WHERE request_id=$2',[founder,request])).rejects.toThrow(/permission denied/);
   await db.exec("RESET ROLE; CREATE FUNCTION public.reject_bale_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.table_name='advances' THEN RAISE EXCEPTION 'audit failed'; END IF; RETURN NEW; END$$; CREATE TRIGGER reject_bale_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.reject_bale_audit(); SET ROLE authenticated;");
   await expect(release(db,request)).rejects.toThrow(/audit failed/);
   await db.exec('RESET ROLE');expect((await db.query('SELECT status FROM public.advance_requests WHERE id=$1',[request])).rows).toEqual([{status:'approved_pending_payment'}]);
   expect((await db.query('SELECT release_xid,release_actor FROM public.weekly_bale_requests WHERE request_id=$1',[request])).rows).toEqual([{release_xid:null,release_actor:null}]);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
});

describe('held idempotent weekly Bale request candidate',()=>{
 const candidate=()=>sql('supabase/drafts/weekly_bale_idempotent_submission.sql');
 const call=(db:PGlite,request:string,amount='100.25',w=worker,p=site)=>db.query<{result:{replayed:boolean;request:{id:string;status:string}}}>("SELECT public.submit_weekly_bale_request($1,$2,$3,$4,'2026-11-15') result",[request,w,p,amount]);
 async function installed(){const db=await fixture(true);await db.exec(`RESET ROLE;BEGIN;SET LOCAL app.weekly_bale_idempotent_submission_reviewed='yes';${candidate()} COMMIT;SET ROLE authenticated`);return db;}
 it('holds by default and refuses a disabled site guard without installing',async()=>{
  const db=await fixture();try{await db.exec('RESET ROLE');await expect(db.exec(`BEGIN;${candidate()} COMMIT;`)).rejects.toThrow(/held pending/);await db.exec('ROLLBACK');
   await db.exec('ALTER TABLE public.advance_requests DISABLE TRIGGER guard_advance_request_site');await expect(db.exec(`BEGIN;SET LOCAL app.weekly_bale_idempotent_submission_reviewed='yes';${candidate()} COMMIT;`)).rejects.toThrow(/missing or disabled/);await db.exec('ROLLBACK');
   expect((await db.query("SELECT to_regprocedure('public.submit_weekly_bale_request(uuid,uuid,uuid,numeric,date)') IS NULL absent")).rows[0]).toEqual({absent:true});
  }finally{await db.close();}
 },30000);
 it('creates one request, audit and notification and replays exact details after the window closes',async()=>{
  const db=await installed();try{
   const first=(await call(db,id(301))).rows[0].result;expect(first).toMatchObject({replayed:false,request:{id:id(301),status:'pending_approval'}});
   await time(db,'2026-11-18T04:00:00Z');expect((await call(db,id(301))).rows[0].result).toMatchObject({replayed:true,request:{id:id(301)}});
   await expect(call(db,id(302))).rejects.toThrow(/open Sunday through Tuesday/);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advance_requests WHERE id=$1',[id(301)])).rows[0].n).toBe(1);
   expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.audit_log WHERE table_name='advance_requests' AND record_id=$1",[id(301)])).rows[0].n).toBe(1);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.user_notifications WHERE advance_request_id=$1',[id(301)])).rows[0].n).toBe(1);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_bale_requests WHERE request_id=$1',[id(301)])).rows[0].n).toBe(1);
  }finally{await db.close();}
 },30000);
 it('never turns an unsaved old-week request into a new-week request',async()=>{
  const db=await installed();try{
   await time(db,'2026-11-22T04:00:00Z');
   await expect(call(db,id(306))).rejects.toThrow(/week changed/);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advance_requests WHERE id=$1',[id(306)])).rows[0].n).toBe(0);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.user_notifications WHERE advance_request_id=$1',[id(306)])).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('rolls the request and weekly marker back if audit insertion fails',async()=>{
  const db=await installed();try{
   await db.exec("RESET ROLE; CREATE FUNCTION public.test_reject_request_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.record_id='00000000-0000-0000-0000-000000000307'::uuid THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END$$; CREATE TRIGGER test_reject_request_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.test_reject_request_audit(); SET ROLE authenticated");
   await expect(call(db,id(307))).rejects.toThrow(/synthetic audit failure/);await db.exec('RESET ROLE');
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advance_requests WHERE id=$1',[id(307)])).rows[0].n).toBe(0);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_bale_requests WHERE request_id=$1',[id(307)])).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('rejects changed details, another actor, unauthorized site and malformed amounts',async()=>{
  const db=await installed();try{
   await call(db,id(303));await expect(call(db,id(303),'100.26')).rejects.toThrow(/unavailable or details differ/);
   await role(db,outsider);await expect(call(db,id(303))).rejects.toThrow(/unavailable or details differ/);await expect(call(db,id(304))).rejects.toThrow(/Project access required/);
   await role(db,founder);await expect(call(db,id(303))).rejects.toThrow(/Supervisor access required/);await role(db,supervisor);
   for(const amount of ['0','-1','1.001','100000000','NaN'])await expect(call(db,id(305),amount)).rejects.toThrow(/Invalid Bale request/);
   await db.exec("SET test.assurance='no'");await expect(call(db,id(303))).rejects.toThrow(/Supervisor access required/);
  }finally{await db.close();}
 },30000);
 it('keeps anon and service roles out of the RPC and preserves the legacy insert path',async()=>{
  const db=await installed();try{await db.exec('RESET ROLE');expect((await db.query("SELECT has_function_privilege('anon','public.submit_weekly_bale_request(uuid,uuid,uuid,numeric,date)','EXECUTE') anon,has_function_privilege('authenticated','public.submit_weekly_bale_request(uuid,uuid,uuid,numeric,date)','EXECUTE') auth,has_function_privilege('service_role','public.submit_weekly_bale_request(uuid,uuid,uuid,numeric,date)','EXECUTE') service")).rows[0]).toEqual({anon:false,auth:true,service:false});await db.exec('SET ROLE authenticated');expect(await submit(db)).toBeTruthy();
  }finally{await db.close();}
 },30000);
});
