// Opt-in only: creates a synthetic schema in an EMPTY local disposable DB.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
const url=process.env.WEEKLY_BALE_SCHEDULE_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const [founder,supervisor,worker,site]=[1,2,3,4].map(id);
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
let admin:Client,first:Client,second:Client;
const submit=async(c:Client)=>(await c.query('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,100.25,$3) RETURNING id',[worker,site,supervisor])).rows[0].id as string;
const approve=(c:Client,request:string)=>c.query("SELECT public.review_advance_request($1,'approve')",[request]);
const release=(c:Client,request:string)=>c.query('SELECT public.record_weekly_bale_release($1) result',[request]);
suite('weekly Bale schedule on disposable PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw new Error('Use an empty local disposable asinta_test_* database without URL options.');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const existing=(await admin.query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects, (SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas`)).rows[0];if(existing.objects||existing.schemas)throw new Error('Use an empty disposable database.');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;
   CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE TABLE public.users(id uuid primary key,name text,email text,role text); CREATE TABLE public.workers(id uuid primary key,name text,active boolean);
   CREATE TABLE public.projects(id uuid primary key,name text); CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid,primary key(project_id,supervisor_id));
   CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean,primary key(project_id,worker_id));
   CREATE TABLE public.advances(id uuid primary key default gen_random_uuid(),worker_id uuid,project_id uuid,amount numeric(10,2),amount_deducted numeric(10,2),reason text,date date,status text);
   CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,status text);
   CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
   CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
   CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT role FROM public.users WHERE id=auth.uid()$$;
   CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND public.current_user_role()='founder'$$;
   CREATE FUNCTION public.is_supervisor_assigned(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.project_supervisors WHERE project_id=p AND supervisor_id=auth.uid())$$;
   GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role; GRANT SELECT ON public.workers TO authenticated;
   INSERT INTO public.users VALUES ('${founder}','Founder','f@example.invalid','founder'),('${supervisor}','Supervisor','s@example.invalid','supervisor');
   INSERT INTO public.workers VALUES ('${worker}','Worker',true); INSERT INTO public.projects VALUES ('${site}','Site');
   INSERT INTO public.project_supervisors VALUES ('${site}','${supervisor}'); INSERT INTO public.project_worker_assignments VALUES ('${site}','${worker}',true);`);
  for(const path of ['supabase/migrations/20261013000000_advance_requests.sql','supabase/migrations/20261013000001_advance_request_notifications.sql','supabase/migrations/20261113000004_bale_request_site_guard.sql'])await admin.query(readFileSync(path,'utf8'));
  const guard=readFileSync('supabase/drafts/guard_legacy_bale_payment.sql','utf8');await admin.query(guard.slice(guard.indexOf('CREATE FUNCTION public.guard_new_advance_finalized_payroll()'),guard.indexOf('-- Keep the atomic implementation')));
  await admin.query(readFileSync('supabase/drafts/weekly_bale_schedule.sql','utf8'));
  await admin.query(readFileSync('supabase/drafts/weekly_bale_expiration.sql','utf8'));
  await admin.query(readFileSync('supabase/drafts/weekly_bale_release_list.sql','utf8'));
  await admin.query(readFileSync('supabase/drafts/weekly_bale_status_batch.sql','utf8'));
  await admin.query(readFileSync('supabase/drafts/weekly_bale_scheduler.sql','utf8'));
  await admin.query(`CREATE OR REPLACE FUNCTION public.weekly_bale_clock() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path='' AS $$SELECT current_setting('test.clock')::timestamptz$$;`);
  await Promise.all([first.query(`SET ROLE authenticated; SET test.uid='${supervisor}'; SET test.assurance='yes'; SET test.clock='2026-11-15T04:00:00Z'; SET lock_timeout='4s'`),second.query(`SET ROLE authenticated; SET test.uid='${supervisor}'; SET test.assurance='yes'; SET test.clock='2026-11-18T04:00:00Z'; SET lock_timeout='4s'`)]);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('serializes concurrent release retries without duplicating advance, audit or notification',async()=>{
  const request=await submit(first);await first.query(`SET test.uid='${founder}'`);await approve(first,request);await first.query(`SET test.clock='2026-11-18T04:00:00Z'`);
  await first.query('BEGIN');await second.query('BEGIN');try{
   const issued=(await release(first,request)).rows[0].result;expect(issued.outcome).toBe('updated');let finished=false;
   const retry=release(second,request).finally(()=>{finished=true});await pause();expect(finished).toBe(false);await first.query('COMMIT');
   expect((await retry).rows[0].result).toEqual({...issued,outcome:'already_recorded'});await second.query('COMMIT');
   expect((await admin.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(1);
   expect((await admin.query<{n:number}>("SELECT count(*)::int n FROM public.audit_log WHERE table_name='advances'")).rows[0].n).toBe(1);
   expect((await admin.query<{n:number}>("SELECT count(*)::int n FROM public.user_notifications WHERE event_type='advance_request_issued'")).rows[0].n).toBe(1);
   expect((await second.query("SELECT public.weekly_bale_release_list('2026-11-15') result")).rows[0].result.items).toMatchObject([{request_id:request,status:'issued',issued_advance_id:issued.advance_id}]);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('waits for an in-flight approval, then records a Wednesday release',async()=>{
  await first.query(`SET test.uid='${supervisor}'; SET test.clock='2026-11-17T15:59:59Z'`);const request=await submit(first);
  await first.query(`SET test.uid='${founder}'`);await first.query('BEGIN');await second.query('BEGIN');try{
   await approve(first,request);let finished=false;const pending=release(second,request).finally(()=>{finished=true});await pause();expect(finished).toBe(false);
   await first.query('COMMIT');expect((await pending).rows[0].result.outcome).toBe('updated');await second.query('COMMIT');
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes with a finalized-payroll writer and rejects the late release',async()=>{
  await first.query(`SET test.uid='${supervisor}'; SET test.clock='2026-11-15T04:00:00Z'`);const request=await submit(first);
  await first.query(`SET test.uid='${founder}'`);await approve(first,request);
  await admin.query('BEGIN');await second.query('BEGIN');try{
   await admin.query('SELECT id FROM public.workers WHERE id=$1 FOR UPDATE',[worker]);
   await admin.query("INSERT INTO public.payroll VALUES($1,$2,'2026-11-15','2026-11-21','approved')",[id(90),worker]);
   let finished=false;const attempt=release(second,request).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{finished=true});
   await pause();expect(finished).toBe(false);await admin.query('COMMIT');expect((await attempt).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query<{n:number}>("SELECT count(*)::int n FROM public.advance_requests WHERE id=$1 AND status='approved_pending_payment'",[request])).rows[0].n).toBe(1);
  }finally{await admin.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('waits for a worker move and denies the old site Supervisor a new release',async()=>{
  // Remove only the synthetic finalized voucher left by the preceding test.
  await admin.query('DELETE FROM public.payroll WHERE id=$1',[id(90)]);
  await first.query(`SET ROLE authenticated; SET test.uid='${supervisor}'; SET test.clock='2026-11-15T04:00:00Z'`);const request=await submit(first);
  await first.query(`SET test.uid='${founder}'`);await approve(first,request);
  await admin.query('INSERT INTO public.projects(id,name) VALUES($1,$2)',[id(91),'Other site']);
  await second.query(`SET ROLE authenticated; SET test.uid='${supervisor}'; SET test.assurance='yes'; SET test.clock='2026-11-18T04:00:00Z'`);
  await admin.query('BEGIN');await second.query('BEGIN');try{
   // Model the reviewed assignment writer: lock the worker before changing sites.
   await admin.query('SELECT id FROM public.workers WHERE id=$1 FOR UPDATE',[worker]);
   await admin.query('UPDATE public.project_worker_assignments SET active=false WHERE worker_id=$1 AND project_id=$2',[worker,site]);
   await admin.query('INSERT INTO public.project_worker_assignments VALUES($1,$2,true)',[id(91),worker]);
   let finished=false;const pending=release(second,request).then(()=>({message:'success'}),(e:Error)=>({message:e.message})).finally(()=>{finished=true});
   await pause();expect(finished).toBe(false);await admin.query('COMMIT');
   expect((await pending).message).toMatch(/no longer uniquely assigned/);await second.query('ROLLBACK');
   expect((await admin.query('SELECT status FROM public.advance_requests WHERE id=$1',[request])).rows).toEqual([{status:'approved_pending_payment'}]);
   expect((await admin.query('SELECT count(*)::int n FROM public.advances WHERE id=(SELECT issued_advance_id FROM public.advance_requests WHERE id=$1)',[request])).rows[0].n).toBe(0);
   await first.query(`SET test.uid='${founder}'; SET test.clock='2026-11-18T04:00:00Z'`);
   expect((await release(first,request)).rows[0].result.outcome).toBe('updated');
  }finally{
   await admin.query('ROLLBACK');await second.query('ROLLBACK');
   await admin.query('UPDATE public.project_worker_assignments SET active=false WHERE worker_id=$1 AND project_id=$2',[worker,id(91)]);
   await admin.query('UPDATE public.project_worker_assignments SET active=true WHERE worker_id=$1 AND project_id=$2',[worker,site]);
  }
 },15000);
 it('does not run two scheduler executions concurrently',async()=>{
  await first.query("RESET ROLE; SET test.uid=''; SET test.clock='2026-11-18T04:00:00Z'");await second.query("RESET ROLE; SET test.uid=''; SET test.clock='2026-11-18T04:00:00Z'");
  await first.query('BEGIN');try{
   expect((await first.query('SELECT public.run_weekly_bale_expiry_job() result')).rows[0].result.outcome).toBe('completed');
   expect((await second.query('SELECT public.run_weekly_bale_expiry_job() result')).rows[0].result).toEqual({outcome:'already_running'});
  }finally{await first.query('COMMIT');}
 },15000);
 it('rolls back the whole expiry batch and its heartbeat on failure, then catches up once repaired',async()=>{
  await first.query(`SET ROLE authenticated; SET test.uid='${supervisor}'; SET test.assurance='yes'; SET test.clock='2026-11-15T04:00:00Z'`);
  const one=await submit(first),two=await submit(first),[firstId,lastId]=[one,two].sort();
  await admin.query(`CREATE FUNCTION public.test_fail_expiry() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.id='${lastId}'::uuid AND NEW.auto_expired THEN IF NOT EXISTS(SELECT 1 FROM public.advance_requests WHERE id='${firstId}'::uuid AND auto_expired) THEN RAISE EXCEPTION 'fixture order unexpected'; END IF; RAISE EXCEPTION 'synthetic expiry failure'; END IF; RETURN NEW; END$$;
   CREATE TRIGGER test_fail_expiry BEFORE UPDATE ON public.advance_requests FOR EACH ROW EXECUTE FUNCTION public.test_fail_expiry();`);
  const heartbeat=(await admin.query('SELECT last_success,processed,remaining_due FROM public.weekly_bale_expiry_health')).rows;
  try{
   await second.query("RESET ROLE; SET test.uid=''; SET test.clock='2026-11-18T04:00:00Z'");
   await expect(second.query('SELECT public.run_weekly_bale_expiry_job()')).rejects.toThrow(/synthetic expiry failure/);
   expect((await admin.query('SELECT id,status,auto_expired FROM public.advance_requests WHERE id=ANY($1::uuid[]) ORDER BY id',[[one,two]])).rows.every(r=>r.status==='pending_approval'&&!r.auto_expired)).toBe(true);
   expect((await admin.query('SELECT last_success,processed,remaining_due FROM public.weekly_bale_expiry_health')).rows).toEqual(heartbeat);
   expect((await admin.query("SELECT count(*)::int n FROM public.user_notifications WHERE advance_request_id=ANY($1::uuid[]) AND event_type='advance_request_rejected'",[[one,two]])).rows[0].n).toBe(0);
   await admin.query('DROP TRIGGER test_fail_expiry ON public.advance_requests; DROP FUNCTION public.test_fail_expiry()');
   expect((await second.query('SELECT public.run_weekly_bale_expiry_job() result')).rows[0].result).toEqual({outcome:'completed',processed:2,remaining_due:0});
   expect((await second.query('SELECT public.run_weekly_bale_expiry_job() result')).rows[0].result).toEqual({outcome:'completed',processed:0,remaining_due:0});
   expect((await admin.query("SELECT count(*)::int n FROM public.user_notifications WHERE advance_request_id=ANY($1::uuid[]) AND event_type='advance_request_rejected'",[[one,two]])).rows[0].n).toBe(2);
  }finally{await admin.query('DROP TRIGGER IF EXISTS test_fail_expiry ON public.advance_requests; DROP FUNCTION IF EXISTS public.test_fail_expiry()');}
 },15000);
 it('skips an in-flight request and materializes it only once after the lock clears',async()=>{
  await first.query(`SET test.uid='${supervisor}'; SET test.clock='2026-11-15T04:00:00Z'`);const request=await submit(first);
  await first.query("RESET ROLE; SET test.uid=''; SET test.clock='2026-11-18T04:00:00Z'");await second.query("RESET ROLE; SET test.uid=''; SET test.clock='2026-11-18T04:00:00Z'");
  await first.query('BEGIN');try{
   await first.query('SELECT id FROM public.advance_requests WHERE id=$1 FOR UPDATE',[request]);
   expect((await second.query('SELECT public.run_weekly_bale_expiry_job() result')).rows[0].result).toEqual({outcome:'completed',processed:0,remaining_due:1});
   await first.query('COMMIT');expect((await second.query('SELECT public.run_weekly_bale_expiry_job() result')).rows[0].result).toEqual({outcome:'completed',processed:1,remaining_due:0});
   expect((await second.query('SELECT public.run_weekly_bale_expiry_job() result')).rows[0].result).toEqual({outcome:'completed',processed:0,remaining_due:0});
   expect((await admin.query('SELECT status,auto_expired,rejected_by FROM public.advance_requests WHERE id=$1',[request])).rows).toEqual([{status:'rejected',auto_expired:true,rejected_by:null}]);
   await first.query(`SET ROLE authenticated; SET test.uid='${supervisor}'; SET test.assurance='yes'`);
   expect((await first.query('SELECT public.weekly_bale_status_batch($1::uuid[]) result',[[request]])).rows[0].result.items).toMatchObject([{id:request,stored_status:'rejected',effective_status:'rejected',auto_expired:true,can_review:false}]);
   expect((await admin.query("SELECT actor_id FROM public.audit_log WHERE record_id=$1 AND action='update'",[request])).rows).toEqual([{actor_id:null}]);
  }finally{await first.query('ROLLBACK');}
 },15000);
});
