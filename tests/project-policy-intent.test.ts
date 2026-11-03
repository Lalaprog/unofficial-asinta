import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Isolated miniature schema exercises the exact checked-in RLS definitions.
// It is not a test of deployed policies, grants, or the complete production schema.
const migration = readFileSync('supabase/migrations/20261006000000_security_hardening.sql', 'utf8');
function policy(name: string) {
  const statement = migration.match(new RegExp(`create policy "${name}"[\\s\\S]*?;`, 'i'))?.[0];
  if (!statement) throw new Error(`Missing policy ${name}`);
  return statement;
}
function helper(name: string) {
  const statement = migration.match(new RegExp(`create or replace function public\\.${name}\\([^)]*\\)[\\s\\S]*?\\$\\$\\s+language[^;]+;`, 'i'))?.[0];
  if (!statement) throw new Error(`Missing helper ${name}`);
  return statement;
}

describe('checked-in project access policy intent', () => {
  it('limits clients to Founders and tools/attendance to assigned sites in an isolated database', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        create role authenticated;
        create schema auth;
        create function auth.uid() returns uuid language sql stable as $$
          select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
        $$;
        grant usage on schema public, auth to authenticated;
        create table public.users (id uuid primary key, role text);
        create table public.project_supervisors (project_id uuid, supervisor_id uuid);
        create table public.clients (id uuid primary key, name text);
        create table public.projects (id uuid primary key, client_id uuid, budget_estimate integer);
        create table public.attendance (id uuid primary key, project_id uuid);
        create table public.tools (id uuid primary key, project_id uuid);
        ${helper('is_founder')}
        ${helper('is_supervisor_assigned')}
        alter table public.clients enable row level security;
        alter table public.projects enable row level security;
        alter table public.attendance enable row level security;
        alter table public.tools enable row level security;
        grant select on public.clients, public.projects, public.attendance, public.tools to authenticated;
        ${policy('Founders full access to clients')}
        ${policy('Founders have full access to projects')}
        ${policy('Supervisors can view assigned projects only')}
        ${policy('Founders full access to attendance')}
        ${policy('Supervisors can read attendance for assigned projects')}
        ${policy('Founders full access to tools')}
        ${policy('Supervisors can view tools on assigned projects')}
        insert into public.users values ('00000000-0000-0000-0000-000000000001','founder'), ('00000000-0000-0000-0000-000000000002','supervisor'), ('00000000-0000-0000-0000-000000000003','supervisor');
        insert into public.clients values ('10000000-0000-0000-0000-000000000001','Private');
        insert into public.projects values ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',90000), ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',10000);
        insert into public.project_supervisors values ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');
        insert into public.attendance values ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001'), ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002');
        insert into public.tools values ('40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001'), ('40000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002');
        set role authenticated;
        select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);
      `);
      expect((await db.query('select * from public.clients')).rows).toHaveLength(0);
      expect((await db.query('select * from public.projects')).rows).toEqual([expect.objectContaining({ id: '20000000-0000-0000-0000-000000000001', client_id: '10000000-0000-0000-0000-000000000001', budget_estimate: 90000 })]);
      expect((await db.query('select * from public.attendance')).rows).toHaveLength(1);
      expect((await db.query('select * from public.tools')).rows).toHaveLength(1);
      await db.exec("select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false)");
      for (const table of ['clients', 'projects', 'attendance', 'tools']) expect((await db.query(`select * from public.${table}`)).rows).toHaveLength(0);
      await db.exec("select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false)");
      expect((await db.query('select * from public.clients')).rows).toHaveLength(1);
      expect((await db.query('select * from public.projects')).rows).toHaveLength(2);
      expect((await db.query('select * from public.attendance')).rows).toHaveLength(2);
      expect((await db.query('select * from public.tools')).rows).toHaveLength(2);
    } finally {
      await db.close();
    }
  });
});
