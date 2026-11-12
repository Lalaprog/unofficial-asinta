import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const [founder, supervisor, other, worker, project, otherProject, linkedSupervisor] = [1,2,3,4,5,6,7].map(id);

describe('Bale request site guard', () => {
  it('protects new inserts without changing older requests; rejects spoofed fields and out-of-scope workers', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
        CREATE TABLE public.users(id uuid primary key,role text);
        CREATE TABLE public.projects(id uuid primary key);
        CREATE TABLE public.workers(id uuid primary key, active boolean);
        CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid,primary key(project_id,supervisor_id));
        CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean,primary key(project_id,worker_id));
        CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
        CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT role FROM public.users WHERE id=auth.uid()$$;
        CREATE FUNCTION public.is_supervisor_assigned(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS (SELECT 1 FROM public.project_supervisors WHERE project_id=p AND supervisor_id=auth.uid())$$;
        CREATE TABLE public.advance_requests(id uuid primary key default gen_random_uuid(),worker_id uuid,project_id uuid,requested_amount numeric,submitted_by uuid,status text default 'pending_approval',created_at timestamptz default now(),updated_at timestamptz default now());
        ALTER TABLE public.advance_requests ENABLE ROW LEVEL SECURITY;
        CREATE POLICY read_request ON public.advance_requests FOR SELECT TO authenticated USING (true);
        CREATE POLICY insert_request ON public.advance_requests FOR INSERT TO authenticated WITH CHECK (public.current_user_role()='supervisor' AND submitted_by=auth.uid() AND public.is_supervisor_assigned(project_id) AND status='pending_approval');
        GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;
        GRANT SELECT,INSERT ON public.advance_requests TO authenticated;
        INSERT INTO public.users VALUES ('${founder}','founder'),('${supervisor}','supervisor'),('${other}','supervisor'),('${linkedSupervisor}','supervisor');
        INSERT INTO public.projects VALUES ('${project}'),('${otherProject}');
        INSERT INTO public.workers VALUES ('${worker}',true),('${linkedSupervisor}',true);
        INSERT INTO public.project_supervisors VALUES ('${project}','${supervisor}');
        INSERT INTO public.project_worker_assignments VALUES ('${project}','${worker}',true),('${project}','${linkedSupervisor}',true);
        INSERT INTO public.advance_requests(id,worker_id,project_id,requested_amount,submitted_by,status,created_at) VALUES ('${id(8)}','${worker}','${project}',50,'${supervisor}','pending_approval','2020-01-01');
      `);
      await db.exec(readFileSync('supabase/migrations/20261113000004_bale_request_site_guard.sql', 'utf8'));
      await db.exec(`SET test.uid='${supervisor}'; SET test.assurance='yes'; SET ROLE authenticated;`);
      const insert = (w = worker, p = project, who = supervisor) => db.query('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES ($1,$2,100,$3) RETURNING status', [w,p,who]);
      expect((await insert()).rows[0]).toEqual({ status: 'pending_approval' });
      await expect(insert(linkedSupervisor)).rejects.toThrow(/Worker unavailable/);
      await expect(insert(worker,otherProject)).rejects.toThrow(/Project access/);
      await expect(insert(worker,project,other)).rejects.toThrow(/Supervisor access/);
      await expect(db.query(`INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by,created_at) VALUES ($1,$2,100,$3,'2020-01-01')`, [worker,project,supervisor])).rejects.toThrow(/permission denied/);
      await db.exec(`RESET ROLE; INSERT INTO public.project_worker_assignments VALUES ('${otherProject}','${worker}',true); SET ROLE authenticated;`);
      await expect(insert()).rejects.toThrow(/conflicting assignments/);
      await db.exec(`RESET ROLE; DELETE FROM public.project_worker_assignments WHERE project_id='${otherProject}'; UPDATE public.project_worker_assignments SET active=false WHERE worker_id='${worker}'; SET ROLE authenticated;`);
      await expect(insert()).rejects.toThrow(/selected site/);
      await db.exec(`RESET ROLE; UPDATE public.project_worker_assignments SET active=true WHERE worker_id='${worker}'; UPDATE public.workers SET active=false WHERE id='${worker}'; SET ROLE authenticated;`);
      await expect(insert()).rejects.toThrow(/Worker unavailable/);
      await db.exec(`SET test.assurance='no';`); await expect(insert()).rejects.toThrow(/Supervisor access/);
      await db.exec(`SET test.uid='${founder}'; SET test.assurance='yes';`); await expect(insert(worker,project,founder)).rejects.toThrow(/Supervisor access/);
      await db.exec('RESET ROLE');
      const result = await db.query<{status:string; created_at:Date}>(`SELECT status,created_at FROM public.advance_requests WHERE id='${id(8)}'`);
      expect(result.rows[0].status).toBe('pending_approval');
      expect(new Date(result.rows[0].created_at).toISOString()).toBe('2020-01-01T00:00:00.000Z');
      expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advance_requests')).rows[0].n).toBe(2);
    } finally { await db.close(); }
  }, 30000);
});
