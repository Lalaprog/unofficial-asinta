import {PGlite} from '@electric-sql/pglite';
import {describe,expect,it} from 'vitest';

// This is an observational model of the checked-in and observed legacy policy,
// NOT an assertion that the behavior is desirable or a substitute for live
// Auth/PostgREST testing. Update this test when the coordinated policy changes.
describe('legacy Supervisor attendance policy scope (known gap)',()=>{
 it('checks project access but does not itself require current worker membership',async()=>{const db=new PGlite();try{
  await db.exec(`CREATE ROLE authenticated; CREATE SCHEMA auth;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('test.uid',true),'')::uuid$$;
   CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid);
   CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean);
   CREATE TABLE public.attendance(id uuid PRIMARY KEY,project_id uuid,worker_id uuid,status text);
   CREATE FUNCTION public.is_supervisor_assigned(project_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT EXISTS(SELECT 1 FROM public.project_supervisors ps WHERE ps.project_id=$1 AND ps.supervisor_id=auth.uid())$$;
   INSERT INTO public.project_supervisors VALUES('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
   INSERT INTO public.project_worker_assignments VALUES('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003',false);
   ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
   GRANT SELECT,INSERT,UPDATE ON public.attendance TO authenticated; GRANT USAGE ON SCHEMA auth TO authenticated;
   CREATE POLICY site_read ON public.attendance FOR SELECT TO authenticated USING(public.is_supervisor_assigned(project_id));
   CREATE POLICY site_insert ON public.attendance FOR INSERT TO authenticated WITH CHECK(public.is_supervisor_assigned(project_id));
   CREATE POLICY site_update ON public.attendance FOR UPDATE TO authenticated USING(public.is_supervisor_assigned(project_id));
   SET ROLE authenticated; SET test.uid='10000000-0000-4000-8000-000000000002';`);
  // Inactive at this site: project-only RLS still accepts the write. Real UI
  // filters and additional hosted paths may impose other checks.
  await db.exec("INSERT INTO public.attendance VALUES('10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','present')");
  expect((await db.query('SELECT status FROM public.attendance')).rows).toEqual([{status:'present'}]);
  await expect(db.exec("INSERT INTO public.attendance VALUES('10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000003','present')")).rejects.toThrow(/row-level security/i);
 }finally{await db.close();}},30000);
});
