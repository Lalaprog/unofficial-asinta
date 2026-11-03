import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20261103000001_attendance_history.sql', 'utf8');
const f = '00000000-0000-0000-0000-000000000001', s = '00000000-0000-0000-0000-000000000002';
const a = '20000000-0000-0000-0000-000000000001', b = '20000000-0000-0000-0000-000000000002';
type Sheet={date:string;project_id:string;record_count:number;leave_count:number};
type RecordItem={id:string;worker_name:string;notes:string};
type Page<T>={items:T[];has_more:boolean};

describe('server attendance history under RLS', () => {
  it('paginates complete sheets and records, searches old rows, respects role policies and validates requests', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        create role authenticated; create role anon; create schema auth;
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
        create table public.users (id uuid primary key, name text, role text);
        create table public.projects (id uuid primary key, name text);
        create table public.workers (id uuid primary key, name text, position text, active boolean);
        create table public.attendance (id uuid primary key, worker_id uuid not null, project_id uuid not null, date date not null, status text not null, hours_worked numeric not null, notes text, recorded_by uuid, is_founder_override boolean not null default false, submitted_at timestamptz, created_at timestamptz);
        create function public.is_founder() returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.users where id=auth.uid() and role='founder') $$;
        grant usage on schema public, auth to authenticated, anon;
        grant select on public.attendance, public.workers, public.projects, public.users to authenticated;
        alter table public.attendance enable row level security; alter table public.users enable row level security; alter table public.projects enable row level security; alter table public.workers enable row level security;
        create policy f_att on public.attendance for select to authenticated using(public.is_founder() or (auth.uid()='${s}' and project_id='${a}'));
        create policy f_users on public.users for select to authenticated using(public.is_founder() or id=auth.uid());
        create policy f_projects on public.projects for select to authenticated using(public.is_founder() or id='${a}');
        create policy f_workers on public.workers for select to authenticated using(public.is_founder() or active);
        insert into public.users values ('${f}','Founder','founder'),('${s}','Supervisor','supervisor');
        insert into public.projects values ('${a}','Alpha Site'),('${b}','Beta Site');
        insert into public.workers values ('10000000-0000-0000-0000-000000000001','Ancient Worker','Mason',true), ('10000000-0000-0000-0000-000000000002','Hidden Worker','Foreman',false), ('${s}','Supervisor','Site Supervisor',true);
        insert into public.attendance select md5(n::text)::uuid,'10000000-0000-0000-0000-000000000001','${a}', '2026-10-15'::date, 'present', 8, 'ordinary', '${f}',false,now(),now() from generate_series(1,1005) n;
        insert into public.attendance values
          ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','${a}','2020-01-01','leave',0,'special old note', '${f}',false,now(),now()),
          ('30000000-0000-0000-0000-000000000002','${s}','${a}','2020-01-01','half_day',4,'Pending Founder Review','${s}',false,now(),now()),
          ('30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','${b}','2026-10-15','absent',0,'other site', '${f}',false,now(),now());
        ${migration}
        set role authenticated; select set_config('request.jwt.claim.sub','${f}',false);
      `);
      const sheets = async (date: string | null = null, project: string | null = null) => (await db.query<{v:Page<Sheet>}>('select public.attendance_history_page($1,null,null,null,null,$2,$3,null,1) as v', ['sheets',date,project])).rows[0].v;
      const first=await sheets(); expect(first.items).toHaveLength(1); expect(first.has_more).toBe(true); expect(first.items[0]).toMatchObject({date:'2026-10-15',project_id:a,record_count:1005});
      const second=await sheets(first.items[0].date,first.items[0].project_id); expect(second.items[0].project_id).toBe(b);
      const third=await sheets(second.items[0].date,second.items[0].project_id); expect(third.items[0]).toMatchObject({date:'2020-01-01',project_id:a,record_count:2,leave_count:1}); expect(third.has_more).toBe(false);
      const rows=async (cursor:string|null) => (await db.query<{v:Page<RecordItem>}>('select public.attendance_history_page($1,$2,null,$3,null,null,null,$4,50) as v',['records',a,'2026-10-15',cursor])).rows[0].v;
      let page=await rows(null); const ids=new Set<string>(); while (true) { for(const x of page.items) ids.add(x.id); if(!page.has_more) break; page=await rows(page.items[page.items.length-1].id); } expect(ids.size).toBe(1005);
      const search=(await db.query<{v:Page<Sheet>}>('select public.attendance_history_page($1,null,null,null,$2,null,null,null,10) as v',['sheets','special old'])).rows[0].v; expect(search.items).toHaveLength(1); expect(search.items[0].date).toBe('2020-01-01');
      const literal=(await db.query<{v:Page<Sheet>}>('select public.attendance_history_page($1,null,null,null,$2,null,null,null,10) as v',['sheets','%'])).rows[0].v; expect(literal.items).toHaveLength(0);
      const status=(await db.query<{v:Page<Sheet>}>('select public.attendance_history_page($1,$2,$3,$4,null,null,null,null,10) as v',['sheets',a,'leave','2020-01-01'])).rows[0].v; expect(status.items[0].record_count).toBe(1);
      await db.exec(`select set_config('request.jwt.claim.sub','${s}',false)`);
      const supervisor=(await db.query<{v:Page<Sheet>}>('select public.attendance_history_page($1,null,null,null,null,null,null,null,10) as v',['sheets'])).rows[0].v; expect(supervisor.items.every(x=>x.project_id===a)).toBe(true);
      const inactive=(await db.query<{v:Page<RecordItem>}>('select public.attendance_history_page($1,$2,null,$3,null,null,null,null,20) as v',['records',a,'2020-01-01'])).rows[0].v; expect(inactive.items.find(x=>x.id.endsWith('001'))?.worker_name).toBeNull();
      await expect(db.query("select public.attendance_history_page('records',null,null,null,null,null,null,null,20)")).rejects.toThrow();
      await expect(db.query("select public.attendance_history_page('sheets',null,null,null,null,'2020-01-01',null,null,10)")).rejects.toThrow();
      await expect(db.query("select public.attendance_history_page('sheets',null,null,null,null,null,null,null,51)")).rejects.toThrow();
      await db.exec('reset role; set role anon');
      await expect(db.query("select public.attendance_history_page('sheets')")).rejects.toThrow(/permission denied/i);
    } finally { await db.close(); }
  }, 30000);
});
