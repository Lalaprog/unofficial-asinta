import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const draft=readFileSync('supabase/drafts/attendance_assignment_guard.sql','utf8');
const founder='10000000-0000-4000-8000-000000000001',sup='10000000-0000-4000-8000-000000000002',otherSup='10000000-0000-4000-8000-000000000003',worker='10000000-0000-4000-8000-000000000004',moved='10000000-0000-4000-8000-000000000005',inactive='10000000-0000-4000-8000-000000000006',site='10000000-0000-4000-8000-000000000007',otherSite='10000000-0000-4000-8000-000000000008';
const fixture=`
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('test.assurance',true)='yes',false)$$;
 CREATE TABLE public.users(id uuid PRIMARY KEY,role text); CREATE TABLE public.projects(id uuid PRIMARY KEY);
 CREATE TABLE public.workers(id uuid PRIMARY KEY,active boolean);
 CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid,PRIMARY KEY(project_id,supervisor_id));
 CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean,PRIMARY KEY(project_id,worker_id));
 CREATE TABLE public.attendance(id uuid PRIMARY KEY,worker_id uuid NOT NULL,project_id uuid NOT NULL,date date NOT NULL,status text NOT NULL,UNIQUE(worker_id,project_id,date));
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
 CREATE FUNCTION public.is_supervisor_assigned(project_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.project_supervisors WHERE project_id=$1 AND supervisor_id=auth.uid())$$;
 INSERT INTO public.users VALUES('${founder}','founder'),('${sup}','supervisor'),('${otherSup}','supervisor');
 INSERT INTO public.projects VALUES('${site}'),('${otherSite}');
 INSERT INTO public.workers VALUES('${worker}',true),('${moved}',true),('${inactive}',false),('${sup}',true),('${otherSup}',true);
 INSERT INTO public.project_supervisors VALUES('${site}','${sup}'),('${otherSite}','${sup}'),('${site}','${otherSup}');
 INSERT INTO public.project_worker_assignments VALUES('${site}','${worker}',true),('${site}','${moved}',false),('${otherSite}','${moved}',true),('${site}','${inactive}',true);
 INSERT INTO public.attendance VALUES('20000000-0000-4000-8000-000000000001','${moved}','${site}','2024-08-01','present');
 ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY; GRANT SELECT,INSERT,UPDATE ON public.attendance TO authenticated; GRANT USAGE ON SCHEMA auth TO authenticated;
 CREATE POLICY founder_all ON public.attendance FOR ALL TO authenticated USING(public.is_founder()) WITH CHECK(public.is_founder());
 CREATE POLICY site_read ON public.attendance FOR SELECT TO authenticated USING(public.is_supervisor_assigned(project_id));
 CREATE POLICY site_insert ON public.attendance FOR INSERT TO authenticated WITH CHECK(public.is_supervisor_assigned(project_id));
 CREATE POLICY site_update ON public.attendance FOR UPDATE TO authenticated USING(public.is_supervisor_assigned(project_id));
`;
const write=(id:string,w:string,p=site,date='2024-08-04')=>`INSERT INTO public.attendance VALUES('${id}','${w}','${p}','${date}','present')`;

describe('uninstalled Supervisor attendance assignment guard',()=>{
 it('enforces active single-site workers while preserving Founder backfill, history, self-row and upserts',async()=>{const db=new PGlite();try{
  await db.exec(fixture);const before=(await db.query('SELECT * FROM public.attendance')).rows;
  await db.exec(`BEGIN;${draft} COMMIT;`);expect((await db.query('SELECT * FROM public.attendance')).rows).toEqual(before);
  await db.exec(`SET ROLE authenticated; SET test.uid='${sup}'; SET test.assurance='yes'`);
  await db.exec(write('20000000-0000-4000-8000-000000000002',worker));
  await db.exec(`INSERT INTO public.attendance VALUES('20000000-0000-4000-8000-000000000003','${worker}','${site}','2024-08-04','absent') ON CONFLICT(worker_id,project_id,date) DO UPDATE SET status=EXCLUDED.status`);
  expect((await db.query("SELECT status FROM public.attendance WHERE id='20000000-0000-4000-8000-000000000002'")).rows).toEqual([{status:'absent'}]);
  await db.exec(write('20000000-0000-4000-8000-000000000004',sup));
  await expect(db.exec(write('20000000-0000-4000-8000-000000000005',moved))).rejects.toThrow(/one active assignment/);
  await expect(db.exec(write('20000000-0000-4000-8000-000000000006',inactive))).rejects.toThrow(/Worker unavailable/);
  await expect(db.exec(write('20000000-0000-4000-8000-000000000007',otherSup))).rejects.toThrow(/one active assignment/);
  await expect(db.exec("UPDATE public.attendance SET status='absent' WHERE id='20000000-0000-4000-8000-000000000001'")).rejects.toThrow(/one active assignment/);
  expect((await db.query("SELECT status FROM public.attendance WHERE id='20000000-0000-4000-8000-000000000001'")).rows).toEqual([{status:'present'}]);
  await expect(db.exec(`UPDATE public.attendance SET worker_id='${moved}' WHERE id='20000000-0000-4000-8000-000000000002'`)).rejects.toThrow(/identity cannot be changed/);
  // One invalid item aborts the whole Roll Call batch.
  await expect(db.exec(`INSERT INTO public.attendance VALUES('20000000-0000-4000-8000-000000000008','${worker}','${site}','2024-08-05','present'),('20000000-0000-4000-8000-000000000009','${moved}','${site}','2024-08-05','present')`)).rejects.toThrow(/one active assignment/);
  expect((await db.query("SELECT id FROM public.attendance WHERE date='2024-08-05'")).rows).toEqual([]);
  await db.exec(`SET test.uid='${founder}'`);await db.exec("UPDATE public.attendance SET status='half_day' WHERE id='20000000-0000-4000-8000-000000000001'");
  await db.exec(write('20000000-0000-4000-8000-000000000010',moved,site,'2024-07-31'));
  await db.exec("SET test.assurance='no'");await expect(db.exec(write('20000000-0000-4000-8000-000000000011',worker))).rejects.toThrow(/Attendance access required/);
  await db.exec("SET test.assurance='yes'; SET test.uid='' ");await expect(db.exec(write('20000000-0000-4000-8000-000000000012',worker))).rejects.toThrow(/Attendance access required/);
 }finally{await db.close();}},30000);
 it('fails closed on simultaneous assignments, revoked project access, and direct guard execution',async()=>{const db=new PGlite();try{
  await db.exec(fixture);await db.exec(`BEGIN;${draft} COMMIT;`);
  await db.exec(`INSERT INTO public.project_worker_assignments VALUES('${otherSite}','${worker}',true)`);
  await db.exec(`SET ROLE authenticated; SET test.uid='${sup}'; SET test.assurance='yes'`);
  await expect(db.exec(write('20000000-0000-4000-8000-000000000013',worker))).rejects.toThrow(/one active assignment/);
  await expect(db.exec('SELECT public.guard_attendance_assignment()')).rejects.toThrow(/permission denied/);
  await db.exec('RESET ROLE');await db.exec(`UPDATE public.project_worker_assignments SET active=false WHERE worker_id='${worker}' AND project_id='${otherSite}'; DELETE FROM public.project_supervisors WHERE supervisor_id='${sup}' AND project_id='${site}'`);
  await db.exec(`SET ROLE authenticated; SET test.uid='${sup}'; SET test.assurance='yes'`);
  await expect(db.exec(write('20000000-0000-4000-8000-000000000014',worker))).rejects.toThrow(/Attendance access required/);
 }finally{await db.close();}},30000);
});
