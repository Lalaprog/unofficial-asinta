import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const visible = readFileSync('supabase/migrations/20261104000000_visible_projects.sql', 'utf8');
const restrict = readFileSync('supabase/migrations/20261104000001_project_column_privacy.sql', 'utf8');

describe('project column privacy migrations', () => {
  it('keeps assigned sites useful while restricting sensitive columns and preserving Founder writes', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        create role authenticated; create role anon; create schema auth;
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        grant usage on schema public, auth to authenticated, anon;
        create table public.users (id uuid primary key, role text not null);
        create table public.project_supervisors (project_id uuid, supervisor_id uuid);
        create table public.projects (id uuid primary key, name text not null, client_id uuid not null, location text not null, budget_estimate numeric not null, status text not null, start_date date not null, target_completion_date date not null, created_at timestamptz not null default now());
        create function public.is_founder() returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.users where id=auth.uid() and role='founder') $$;
        create function public.is_supervisor_assigned(project uuid) returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.project_supervisors where supervisor_id=auth.uid() and project_id=project) $$;
        alter table public.projects enable row level security;
        create policy founders on public.projects for all to authenticated using (public.is_founder());
        create policy supervisors on public.projects for select to authenticated using (public.is_supervisor_assigned(id));
        grant select,insert,update,delete on public.projects to authenticated;
        grant select on public.projects to anon;
        insert into public.users values ('00000000-0000-0000-0000-000000000001','founder'), ('00000000-0000-0000-0000-000000000002','supervisor'), ('00000000-0000-0000-0000-000000000003','supervisor');
        insert into public.projects(id,name,client_id,location,budget_estimate,status,start_date,target_completion_date) values
          ('10000000-0000-0000-0000-000000000001','Alpha','20000000-0000-0000-0000-000000000001','Lipa',90000,'active','2026-01-01','2026-12-31'),
          ('10000000-0000-0000-0000-000000000002','Beta','20000000-0000-0000-0000-000000000001','Lipa',1000,'active','2026-01-01','2026-12-31');
        insert into public.project_supervisors values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');
      `);
      // Phase 2 cannot strand old clients if its replacement function is missing.
      await expect(db.exec(restrict)).rejects.toThrow(/Install and verify visible_projects/);
      expect((await db.query<{allowed:boolean}>("select has_column_privilege('authenticated','public.projects','client_id','SELECT') as allowed")).rows[0].allowed).toBe(true);
      await db.exec(visible);
      // Phase 1 is additive; old clients still have direct access until phase 2.
      expect((await db.query<{allowed:boolean}>("select has_column_privilege('authenticated','public.projects','client_id','SELECT') as allowed")).rows[0].allowed).toBe(true);
      await db.exec(restrict);
      await db.exec("set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)");
      const supervisor = await db.query('select id,name,client_id,budget_estimate from public.visible_projects()');
      expect(supervisor.rows).toEqual([{id:'10000000-0000-0000-0000-000000000001',name:'Alpha',client_id:null,budget_estimate:null}]);
      expect((await db.query('select id,name,location from public.projects')).rows).toHaveLength(1);
      await expect(db.query('select client_id from public.projects')).rejects.toThrow(/permission denied/);
      await expect(db.query('select budget_estimate from public.projects')).rejects.toThrow(/permission denied/);
      await expect(db.query('select * from public.projects')).rejects.toThrow(/permission denied/);
      await db.exec("select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false)");
      expect((await db.query('select * from public.visible_projects()')).rows).toHaveLength(0);
      await db.exec("select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false)");
      expect((await db.query('select id,client_id,budget_estimate from public.visible_projects() order by name')).rows).toEqual([
        {id:'10000000-0000-0000-0000-000000000001',client_id:'20000000-0000-0000-0000-000000000001',budget_estimate:'90000'},
        {id:'10000000-0000-0000-0000-000000000002',client_id:'20000000-0000-0000-0000-000000000001',budget_estimate:'1000'},
      ]);
      expect((await db.query("update public.projects set budget_estimate=2 where name='Alpha' returning id,name")).rows).toHaveLength(1);
      expect((await db.query("select budget_estimate from public.visible_projects() where name='Alpha'")).rows[0]).toEqual({budget_estimate:'2'});
      expect((await db.query("insert into public.projects(id,name,client_id,location,budget_estimate,status,start_date,target_completion_date) values ('10000000-0000-0000-0000-000000000003','Gamma','20000000-0000-0000-0000-000000000001','Lipa',3,'active','2026-01-01','2026-12-31') returning id,name")).rows).toHaveLength(1);
      await db.exec("reset role; set role anon");
      await expect(db.query('select * from public.visible_projects()')).rejects.toThrow(/permission denied/);
      await expect(db.query('select id from public.projects')).rejects.toThrow(/permission denied/);
    } finally { await db.close(); }
  }, 30000);
});
