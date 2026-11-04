import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const migration=readFileSync('supabase/migrations/20261103000004_payroll_attendance_matrix.sql','utf8');
const f='00000000-0000-0000-0000-000000000001',s='00000000-0000-0000-0000-000000000002',w='10000000-0000-0000-0000-000000000001',inactive='10000000-0000-0000-0000-000000000002',noLogs='10000000-0000-0000-0000-000000000003',a='20000000-0000-0000-0000-000000000001',b='20000000-0000-0000-0000-000000000002';
type Snapshot={attendance:{id:string;project_id:string;status:string}[];workers:{id:string}[];projects:{id:string}[];vouchers:{id:string}[]};
describe('Founder attendance matrix snapshot',()=>{
  it('returns complete bounded attendance, includes unmarked active workers, preserves site entries, validates limits and respects RLS',async()=>{
    const db=new PGlite();try{
      await db.exec(`
        create role authenticated; create role anon; create schema auth;
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
        create table public.users(id uuid primary key,role text);
        create function public.is_founder() returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.users where id=auth.uid() and role='founder') $$;
        create table public.projects(id uuid primary key,name text);
        create table public.workers(id uuid primary key,name text,position text,active boolean,pay_rate numeric,pay_rate_type text);
        create table public.attendance(id uuid primary key,worker_id uuid,project_id uuid,date date,status text,notes text);
        create table public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,gross_pay numeric,net_pay numeric,status text,bale_deduction numeric);
        grant usage on schema public,auth to authenticated,anon;
        grant select on public.projects,public.workers,public.attendance,public.payroll to authenticated;
        alter table public.projects enable row level security; alter table public.workers enable row level security; alter table public.attendance enable row level security; alter table public.payroll enable row level security;
        create policy p on public.projects for select to authenticated using(public.is_founder());
        create policy w on public.workers for select to authenticated using(public.is_founder());
        create policy a on public.attendance for select to authenticated using(public.is_founder());
        create policy v on public.payroll for select to authenticated using(public.is_founder());
        insert into public.users values('${f}','founder'),('${s}','supervisor');
        insert into public.projects values('${a}','Alpha'),('${b}','Beta');
        insert into public.workers values('${w}','Multi site','Mason',true,800,'daily'),('${inactive}','Inactive','Mason',false,700,'daily'),('${noLogs}','No logs','Helper',true,600,'daily');
        insert into public.workers select md5(('worker'||n)::text)::uuid,'Worker '||n,'Mason',true,800,'daily' from generate_series(1,1001) n;
        insert into public.attendance select md5(n::text)::uuid,md5(('worker'||n)::text)::uuid,'${a}','2026-11-01','present','not returned' from generate_series(1,1001) n;
        insert into public.attendance values
          ('30000000-0000-0000-0000-000000000001','${w}','${a}','2026-11-01','present','private note'),
          ('30000000-0000-0000-0000-000000000002','${w}','${b}','2026-11-01','absent','private note'),
          ('30000000-0000-0000-0000-000000000003','${inactive}','${a}','2026-11-02','leave','private note');
        insert into public.payroll values ('40000000-0000-0000-0000-000000000001','${w}','2026-11-01','2026-11-02',1600,1200,'draft',400), ('40000000-0000-0000-0000-000000000002','${w}','2026-11-01','2026-11-02',1600,1200,'draft',400);
        ${migration}
        -- Project column privacy leaves only site fields visible directly.
        revoke select on public.projects from authenticated;
        grant select (id,name) on public.projects to authenticated;
        set role authenticated;select set_config('request.jwt.claim.sub','${f}',false);
      `);
      const get=async(site:string|null)=>(await db.query<{v:Snapshot}>("select public.payroll_attendance_matrix('2026-11-01','2026-11-02',$1) as v",[site])).rows[0].v;
      const all=await get(null);expect(all.attendance).toHaveLength(1004);expect(all.workers).toHaveLength(1004);expect(all.workers.map(x=>x.id)).toContain(noLogs);expect(all.workers.map(x=>x.id)).toContain(inactive);expect(all.vouchers).toHaveLength(2);
      expect(JSON.stringify(all)).not.toContain('private note');expect(JSON.stringify(all)).not.toContain('bale_deduction');
      const scoped=await get(a);expect(scoped.attendance).toHaveLength(1003);expect(scoped.workers).toHaveLength(1003);expect(scoped.workers.map(x=>x.id)).not.toContain(noLogs);expect(scoped.attendance.every(x=>x.project_id===a)).toBe(true);
      const other=await get(b);expect(other.attendance).toHaveLength(1);expect(other.workers).toHaveLength(1);expect(other.vouchers).toHaveLength(2);
      await expect(get('20000000-0000-0000-0000-000000000099')).rejects.toThrow(/site is unavailable/i);
      await expect(db.query("select public.payroll_attendance_matrix('2026-11-03','2026-11-01')")).rejects.toThrow(/invalid/i);
      await expect(db.query("select public.payroll_attendance_matrix('2026-01-01','2026-04-05')")).rejects.toThrow(/93 days/i);
      await expect(db.query("select public.payroll_attendance_matrix('2026-11-01','2026-11-15')")).rejects.toThrow(/too large/i);
      await db.exec(`select set_config('request.jwt.claim.sub','${s}',false)`);await expect(get(null)).rejects.toThrow(/Founder/i);
      await db.exec('reset role; set role anon');await expect(get(null)).rejects.toThrow(/permission denied/i);
    }finally{await db.close();}
  },30000);
});
