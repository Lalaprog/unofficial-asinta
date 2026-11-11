import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000003',other='00000000-0000-0000-0000-000000000004',worker='00000000-0000-0000-0000-000000000005',hidden='00000000-0000-0000-0000-000000000006';
let db:PGlite;
beforeEach(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.uid',true),'')::uuid$$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('request.assurance',true),'')='yes'$$;
 CREATE TABLE public.users(id uuid,role text,name text); INSERT INTO public.users VALUES ('${founder}','founder','Founder'),('${sup}','supervisor','Supervisor');
 CREATE TABLE public.projects(id uuid,name text); INSERT INTO public.projects VALUES ('${site}','North Site'),('${other}','South Site');
 CREATE TABLE public.project_supervisors(supervisor_id uuid,project_id uuid); INSERT INTO public.project_supervisors VALUES ('${sup}','${site}');
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
 CREATE FUNCTION public.is_supervisor_assigned(proj_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.project_supervisors WHERE supervisor_id=auth.uid() AND project_id=proj_id)$$;
 CREATE TABLE public.workers(id uuid,name text,position text,active boolean); INSERT INTO public.workers VALUES ('${worker}','Alex Mason','Mason',true),('${hidden}','Hidden Worker','Mason',false);
 CREATE TABLE public.attendance(id uuid primary key default gen_random_uuid(),worker_id uuid,project_id uuid,date date,status text,hours_worked numeric,notes text,recorded_by uuid,is_founder_override boolean,submitted_at timestamptz,created_at timestamptz);
 INSERT INTO public.attendance(worker_id,project_id,date,status,notes,is_founder_override) SELECT '${worker}','${site}','2026-10-01','present','pour',false FROM generate_series(1,1050);
 INSERT INTO public.attendance(worker_id,project_id,date,status,notes,is_founder_override) VALUES ('${worker}','${site}','2026-10-02','absent','weather',false),('${hidden}','${site}','2026-10-02','present',null,false),('${worker}','${other}','2026-10-01','present','pour',false),('${worker}','${site}','2026-09-28','present',null,false),('${worker}','${site}','2026-11-03','present',null,false);
 ALTER TABLE public.users ENABLE ROW LEVEL SECURITY; ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY; ALTER TABLE public.workers ENABLE ROW LEVEL SECURITY; ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
 CREATE POLICY users_read ON public.users FOR SELECT TO authenticated USING (id=auth.uid() OR public.is_founder());
 CREATE POLICY projects_read ON public.projects FOR SELECT TO authenticated USING(public.is_founder() OR public.is_supervisor_assigned(id));
 CREATE POLICY workers_read ON public.workers FOR SELECT TO authenticated USING(public.is_founder() OR (auth.uid() IS NOT NULL AND active));
 CREATE POLICY attendance_read ON public.attendance FOR SELECT TO authenticated USING(public.is_founder() OR public.is_supervisor_assigned(project_id));
 GRANT USAGE ON SCHEMA public,auth TO authenticated,anon; GRANT SELECT ON public.users,public.projects,public.workers,public.attendance TO authenticated;`);
 await db.exec(readFileSync('supabase/migrations/20261103000001_attendance_history.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261112000005_attendance_history_calendar.sql','utf8'));
 await db.exec(`SELECT set_config('request.uid','${sup}',false),set_config('request.assurance','yes',false); SET ROLE authenticated;`);
},30000);
afterEach(async()=>{await db.close()});
const read=(project:string|null=null,status:string|null=null,search:string|null=null,month='2026-10-01')=>db.query<{data:{date:string,count:number}[]}>('SELECT public.attendance_history_calendar($1,$2,$3,$4) AS data',[month,project,status,search]);
describe('history calendar authorization and filters',()=>{
 it('aggregates more than 1000 visible entries and edge weeks, without leaking another site',async()=>{
  expect((await read()).rows[0].data).toEqual([{date:'2026-09-28',count:1},{date:'2026-10-01',count:1050},{date:'2026-10-02',count:2},{date:'2026-11-03',count:1}]);
  expect((await read(site,'absent','weather')).rows[0].data).toEqual([{date:'2026-10-02',count:1}]);
  expect((await read(null,null,'Hidden Worker')).rows[0].data).toEqual([]);
  await expect(read(other)).rejects.toThrow(/Project access required/);
 });
 it('matches existing history sheet filtering and allows Founder access',async()=>{
  await db.exec(`SELECT set_config('request.uid','${founder}',false)`);
  const counts=(await read(null,'present','mason')).rows[0].data;
  const expected=await db.query<{date:string,count:number}>(`SELECT date::text,count(*)::int AS count FROM public.attendance_history_matching(NULL,'present',NULL,'mason') WHERE date >= '2026-09-25' AND date < '2026-11-07' GROUP BY date ORDER BY date`);
  expect(counts).toEqual(expected.rows);expect((await read(other)).rows[0].data).toEqual([{date:'2026-10-01',count:1}]);
 });
 it('rejects invalid input, low assurance and anonymous access',async()=>{
  await expect(read(null,null,null,'2026-10-02')).rejects.toThrow(/Invalid calendar month/);
  await expect(read(null,'invalid')).rejects.toThrow(/Invalid attendance status/);
  await expect(read(null,null,'x'.repeat(201))).rejects.toThrow(/too long/);
  await db.exec("SELECT set_config('request.assurance','no',false)");await expect(read()).rejects.toThrow(/Attendance access required/);
  await db.exec('RESET ROLE; SET ROLE anon');await expect(read()).rejects.toThrow(/permission denied/);
 });
});
