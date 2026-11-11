import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
const founder='00000000-0000-0000-0000-000000000001', sup='00000000-0000-0000-0000-000000000002', site='00000000-0000-0000-0000-000000000003', other='00000000-0000-0000-0000-000000000004';
let db:PGlite;
beforeEach(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE TABLE public.users(id uuid, role text); INSERT INTO public.users VALUES ('${founder}','founder'),('${sup}','supervisor');
 CREATE TABLE public.projects(id uuid primary key); INSERT INTO public.projects VALUES ('${site}'),('${other}');
 CREATE TABLE public.project_supervisors(supervisor_id uuid,project_id uuid); INSERT INTO public.project_supervisors VALUES ('${sup}','${site}');
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT coalesce(current_setting('request.assurance',true),'')='yes' AND EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder') $$;
 CREATE FUNCTION public.is_supervisor_assigned(proj_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT coalesce(current_setting('request.assurance',true),'')='yes' AND EXISTS(SELECT 1 FROM public.project_supervisors WHERE supervisor_id=auth.uid() AND project_id=proj_id) $$;
 CREATE TABLE public.attendance(id uuid primary key default gen_random_uuid(),project_id uuid,date date);
 INSERT INTO public.attendance(project_id,date) SELECT '${site}', '2026-10-01'::date FROM generate_series(1,1050);
 INSERT INTO public.attendance(project_id,date) VALUES ('${site}','2026-09-28'),('${site}','2026-11-03'),('${site}','2026-11-10'),('${other}','2026-10-01');
 ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY; ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
 CREATE POLICY visible_projects ON public.projects FOR SELECT TO authenticated USING (public.is_founder() OR public.is_supervisor_assigned(id));
 CREATE POLICY visible_attendance ON public.attendance FOR SELECT TO authenticated USING (public.is_founder() OR public.is_supervisor_assigned(project_id));
 GRANT USAGE ON SCHEMA public,auth TO authenticated,anon; GRANT SELECT ON public.projects,public.attendance TO authenticated;
 `);
 await db.exec(readFileSync('supabase/migrations/20261112000002_project_attendance_calendar.sql','utf8'));
 await db.exec(`SELECT set_config('request.jwt.claim.sub','${sup}',false),set_config('request.assurance','yes',false); SET ROLE authenticated`);
},30000);
afterEach(async()=>{await db.close()});
const read=(project=site,month='2026-10-01')=>db.query<{data:{date:string,count:number}[]}>(`SELECT public.project_attendance_calendar($1,$2) AS data`,[project,month]);
describe('project calendar SQL',()=>{
 it('aggregates all entries for an authorized site, including edge-week dates, without page truncation',async()=>{
  expect((await read()).rows[0].data).toEqual([{date:'2026-09-28',count:1},{date:'2026-10-01',count:1050},{date:'2026-11-03',count:1}]);
 });
 it('rejects unauthorized sites, missing assurance and invalid months',async()=>{
  await expect(read(other)).rejects.toThrow(/Project access required/);
  await expect(read(site,'2026-10-10')).rejects.toThrow(/Invalid/);
  await db.exec("SELECT set_config('request.assurance','no',false)"); await expect(read()).rejects.toThrow(/Project access required/);
 });
 it('allows Founder access to other projects but not anonymous execution',async()=>{
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${founder}',false)`);
  expect((await read(other)).rows[0].data).toEqual([{date:'2026-10-01',count:1}]);
  await db.exec('RESET ROLE; SET ROLE anon'); await expect(read()).rejects.toThrow(/permission denied/);
 });
});
