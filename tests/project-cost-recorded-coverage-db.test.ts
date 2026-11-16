import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const founder='00000000-0000-4000-8000-000000000001',supervisor='00000000-0000-4000-8000-000000000002',site='00000000-0000-4000-8000-000000000003',other='00000000-0000-4000-8000-000000000004',worker='00000000-0000-4000-8000-000000000005';
const missing='10000000-0000-4000-8000-000000000001',broken='10000000-0000-4000-8000-000000000002',complete='10000000-0000-4000-8000-000000000003',zero='10000000-0000-4000-8000-000000000004',historical='20000000-0000-4000-8000-000000000001';
async function setup(){const db=new PGlite();await db.exec(`
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
 CREATE TABLE public.users(id uuid primary key,role text);INSERT INTO public.users VALUES('${founder}','founder'),('${supervisor}','supervisor');
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
 CREATE TABLE public.projects(id uuid primary key);INSERT INTO public.projects VALUES('${site}'),('${other}');
 CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,status text,gross_pay numeric);
 CREATE TABLE public.weekly_worker_paid_allocations(payroll_id uuid,project_id uuid,gross numeric);
 CREATE TABLE public.attendance(worker_id uuid,project_id uuid,date date);
 CREATE TABLE public.historical_external_worker_payroll(request_id uuid primary key,gross numeric);
 CREATE TABLE public.historical_worker_attributions(source_id uuid);
 CREATE FUNCTION public.project_cost_corrected_review(p uuid,r integer) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('project_id',p,'found',false,'latest_revision',0)$$;
 INSERT INTO public.payroll VALUES('${missing}','${worker}','2024-11-03','2024-11-09','paid',600),('${broken}','${worker}','2024-11-10','2024-11-16','paid',500),('${complete}','${worker}','2024-11-17','2024-11-23','paid',700),('${zero}','${worker}','2024-11-24','2024-11-30','paid',0);
 INSERT INTO public.weekly_worker_paid_allocations VALUES('${broken}','${other}',400),('${complete}','${site}',500),('${complete}','${other}',200);
 INSERT INTO public.attendance VALUES('${worker}','${site}','2024-11-04');
 INSERT INTO public.historical_external_worker_payroll VALUES('${historical}',100);
 `);await db.exec(readFileSync('supabase/drafts/project_cost_recorded_coverage.sql','utf8'));return db;}
const query=(db:PGlite,p=site)=>db.query<{v:Record<string,unknown>}>('SELECT public.project_cost_recorded_coverage($1) v',[p]);
describe('project recorded payroll coverage',()=>{
 it('reports missing and mismatched evidence without assigning it or changing finance rows',async()=>{const db=await setup();try{
  const rows=()=>db.query(`SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT jsonb_agg(to_jsonb(a) ORDER BY payroll_id,project_id) FROM public.weekly_worker_paid_allocations a) allocations,(SELECT jsonb_agg(to_jsonb(h) ORDER BY request_id) FROM public.historical_external_worker_payroll h) history`);
  const before=(await rows()).rows[0];
  await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
  const a=(await query(db)).rows[0].v;expect(a).toMatchObject({project_id:site,unallocated_paid:1,attendance_matches:1,inconsistent_allocations:1,unattributed_history:1,review:{found:false,latest_revision:0}});
  expect((await query(db,other)).rows[0].v).toMatchObject({unallocated_paid:1,attendance_matches:0,inconsistent_allocations:1,unattributed_history:1});
  await db.exec('RESET ROLE');expect((await rows()).rows[0]).toEqual(before);await db.exec(`INSERT INTO public.historical_worker_attributions VALUES('${historical}'); UPDATE public.weekly_worker_paid_allocations SET gross=500 WHERE payroll_id='${broken}';`);
  await db.exec('SET ROLE authenticated');expect((await query(db)).rows[0].v).toMatchObject({unallocated_paid:1,inconsistent_allocations:0,unattributed_history:0});
  await db.exec('RESET ROLE');expect((await db.query('SELECT count(*)::int n FROM public.payroll')).rows[0]).toEqual({n:4});
 }finally{await db.close();}},30000);
 it('requires Founder assurance and rejects unknown projects and direct anonymous calls',async()=>{const db=await setup();try{
  await db.exec(`SET ROLE authenticated;SET test.uid='${supervisor}';SET test.assurance='yes'`);await expect(query(db)).rejects.toThrow(/Founder access/);
  await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(query(db)).rejects.toThrow(/Founder access/);
  await db.exec(`SET test.assurance='yes'`);await expect(query(db,'00000000-0000-4000-8000-000000000099')).rejects.toThrow(/Project unavailable/);
  await db.exec('RESET ROLE; SET ROLE anon');await expect(query(db)).rejects.toThrow(/permission denied/);
 }finally{await db.close();}},30000);
});
