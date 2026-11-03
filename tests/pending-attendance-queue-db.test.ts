import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Miniature, local RLS fixture. It does not verify deployed Supabase policies/grants.
const migration = readFileSync('supabase/migrations/20261103000000_pending_attendance_queue.sql', 'utf8');
const founder = '00000000-0000-0000-0000-000000000001';
const supervisor = '00000000-0000-0000-0000-000000000002';
const site = '20000000-0000-0000-0000-000000000001';
type Page = { total: number; has_more: boolean; items: Array<{id: string; date: string; worker_name: string; project_name: string}> };

describe('server-side pending attendance approvals', () => {
  it('pages beyond the client cap, matches legacy supervisor signals, and enforces Founder-only access and invoker RLS', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        create role authenticated; create role anon;
        create schema auth;
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create table public.users(id uuid primary key, name text, role text);
        create table public.projects(id uuid primary key, name text);
        create table public.workers(id uuid primary key, name text, position text);
        create table public.attendance(id uuid primary key, worker_id uuid, project_id uuid, date date, status text, notes text, recorded_by uuid, is_founder_override boolean not null default false, hours_worked numeric, submitted_at timestamptz, created_at timestamptz);
        create function public.is_founder() returns boolean language sql stable security definer set search_path = '' as $$ select exists(select 1 from public.users where id = auth.uid() and role = 'founder') $$;
        alter table public.attendance enable row level security;
        alter table public.workers enable row level security;
        alter table public.projects enable row level security;
        alter table public.users enable row level security;
        create policy f_att on public.attendance for select to authenticated using(public.is_founder());
        create policy f_workers on public.workers for select to authenticated using(public.is_founder());
        create policy f_projects on public.projects for select to authenticated using(public.is_founder());
        create policy f_users on public.users for select to authenticated using(public.is_founder());
        grant usage on schema public,auth to authenticated,anon;
        grant select on public.attendance,public.workers,public.projects,public.users to authenticated;
        insert into public.users values ('${founder}', 'Founder', 'founder'), ('${supervisor}', 'Linked Name', 'supervisor');
        insert into public.projects values ('${site}', 'Alpha');
        insert into public.workers values
          ('10000000-0000-0000-0000-000000000001','Linked Name','Foreman'),
          ('10000000-0000-0000-0000-000000000002','Position Supervisor','Site Supervisor'),
          ('10000000-0000-0000-0000-000000000003','Crew','Mason');
        insert into public.attendance
          select md5(n::text)::uuid, '10000000-0000-0000-0000-000000000003', '${site}', '2026-10-20', 'present', null, '${founder}', false, 8, now(), now()
          from generate_series(1, 1005) n;
        insert into public.attendance values
          ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','${site}','2025-01-01','present',null,'${founder}',false,8,now(),now()),
          ('30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','${site}','2025-01-01','half_day',null,'${founder}',false,4,now(),now()),
          ('30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000003','${site}','2024-12-31','present','Pending Founder Review','${founder}',false,8,now(),now()),
          ('30000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000003','${site}','2024-12-30','present',null,'10000000-0000-0000-0000-000000000003',false,8,now(),now()),
          ('30000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000002','${site}','2024-12-29','present',null,'${founder}',true,8,now(),now()),
          ('30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000002','${site}','2024-12-29','absent',null,'${founder}',false,0,now(),now());
        ${migration}
        set role authenticated;
        select set_config('request.jwt.claim.sub', '${founder}', false);
      `);
      const get = async (date: string | null, id: string | null) => (await db.query<{page: Page}>('select public.pending_attendance_approvals($1, $2, 3) as page', [date, id])).rows[0].page;
      const first = await get(null, null);
      expect(first.total).toBe(4); expect(first.items).toHaveLength(3); expect(first.has_more).toBe(true);
      expect(first.items[0]).toEqual(expect.objectContaining({ worker_name: 'Position Supervisor', project_name: 'Alpha' }));
      const last = first.items[2]; const second = await get(last.date, last.id);
      expect(second.items).toHaveLength(1); expect(second.has_more).toBe(false); expect(new Set([...first.items, ...second.items].map(i => i.id)).size).toBe(4);
      await expect(db.query('select public.pending_attendance_approvals($1, $2, 3)', ['2025-01-01', null])).rejects.toThrow();
      await expect(db.query('select public.pending_attendance_approvals(null, null, 51)')).rejects.toThrow();
      // A Founder check is not a substitute for RLS: invoker rights must still
      // respect a narrower attendance policy in this isolated fixture.
      await db.exec(`reset role; drop policy f_att on public.attendance;
        create policy f_att on public.attendance for select to authenticated using (public.is_founder() and id <> '30000000-0000-0000-0000-000000000001');
        set role authenticated;`);
      expect((await get(null, null)).total).toBe(3);
      await db.exec(`select set_config('request.jwt.claim.sub', '${supervisor}', false)`);
      await expect(get(null, null)).rejects.toThrow(/Only Founders/);
      await db.exec("reset role; set role anon");
      await expect(db.query('select public.pending_attendance_approvals(null,null,3)')).rejects.toThrow(/permission denied/i);
    } finally { await db.close(); }
  });
});
