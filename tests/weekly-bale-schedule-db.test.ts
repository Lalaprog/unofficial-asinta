import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const [founder,supervisor,outsider,worker,site,other]=[1,2,3,4,5,6].map(id);
const sql=(path:string)=>readFileSync(path,'utf8');
async function fixture(){
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
   await time(db,'2026-11-17T16:00:00Z');await expect(db.query('SELECT public.issue_advance_request($1)',[request])).rejects.toThrow(/controlled Wednesday/);
   await role(db,outsider);await expect(release(db,request)).rejects.toThrow(/Site authorization/);
   await role(db,supervisor);const issued=(await release(db,request)).rows[0].result;expect(issued.outcome).toBe('updated');expect((await release(db,request)).rows[0].result).toEqual({...issued,outcome:'already_recorded'});
   expect((await status(db,request)).rows[0].result.effective_status).toBe('issued');
   await db.exec('RESET ROLE');expect((await db.query('SELECT amount::text,date::text,status,amount_deducted::text FROM public.advances')).rows).toEqual([{amount:'100.25',date:'2026-11-18',status:'active',amount_deducted:'0.00'}]);
   expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.audit_log WHERE table_name='advances'")).rows[0].n).toBe(1);
   expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.user_notifications WHERE advance_request_id=$1 AND event_type='advance_request_issued'",[request])).rows[0].n).toBe(1);
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
