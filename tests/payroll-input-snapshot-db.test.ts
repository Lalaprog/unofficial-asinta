import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const migration=readFileSync('supabase/migrations/20261103000002_payroll_input_snapshot.sql','utf8');
const f='00000000-0000-0000-0000-000000000001',s='00000000-0000-0000-0000-000000000002',w='10000000-0000-0000-0000-000000000001',a='20000000-0000-0000-0000-000000000001',b='20000000-0000-0000-0000-000000000002';
type Snapshot={attendance:{id:string}[];workers:{id:string}[];projects:{id:string}[];users:{id:string}[];advances:{id:string}[];payroll:{id:string}[]};
describe('payroll input snapshot',()=>{
  it('reads a complete period under Founder RLS, validates scope/size/duplicates, and denies other roles',async()=>{
    const db=new PGlite();try{
      await db.exec(`
        create role anon; create role authenticated; create schema auth;
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
        create table public.users(id uuid primary key,name text,role text);
        create table public.projects(id uuid primary key,name text);
        create table public.workers(id uuid primary key,name text,position text,active boolean,pay_rate numeric,pay_rate_type text);
        create table public.attendance(id uuid primary key,worker_id uuid,project_id uuid,date date,status text,notes text,recorded_by uuid,is_founder_override boolean, unique(worker_id,project_id,date));
        create table public.advances(id uuid primary key,worker_id uuid,project_id uuid,status text,amount numeric,amount_deducted numeric);
        create table public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,status text);
        create function public.is_founder() returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.users where id=auth.uid() and role='founder') $$;
        grant usage on schema public,auth to authenticated,anon;
        grant select on public.users,public.projects,public.workers,public.attendance,public.advances,public.payroll to authenticated;
        alter table public.users enable row level security; alter table public.projects enable row level security; alter table public.workers enable row level security; alter table public.attendance enable row level security; alter table public.advances enable row level security; alter table public.payroll enable row level security;
        create policy f_users on public.users for select to authenticated using(public.is_founder()); create policy f_projects on public.projects for select to authenticated using(public.is_founder()); create policy f_workers on public.workers for select to authenticated using(public.is_founder()); create policy f_att on public.attendance for select to authenticated using(public.is_founder()); create policy f_adv on public.advances for select to authenticated using(public.is_founder()); create policy f_pay on public.payroll for select to authenticated using(public.is_founder());
        insert into public.users values ('${f}','Founder','founder'),('${s}','Site Lead','supervisor');
        insert into public.projects values ('${a}','Alpha'),('${b}','Beta');
        insert into public.workers values ('${w}','Site Lead','Foreman',true,800,'daily');
        insert into public.workers select md5(('worker'||n)::text)::uuid,'Worker '||n,'Mason',true,800,'daily' from generate_series(1,1004) n;
        insert into public.attendance select md5(n::text)::uuid,case when n=1 then '${w}'::uuid else md5(('worker'||(n-1))::text)::uuid end,'${a}','2026-10-15','present','note','${s}',false from generate_series(1,1005) n;
        insert into public.attendance values ('30000000-0000-0000-0000-000000000001','${w}','${b}','2026-10-15','half_day','other site','${s}',false);
        insert into public.advances values ('40000000-0000-0000-0000-000000000001','${w}','${a}','active',100,0),('40000000-0000-0000-0000-000000000002','${w}','${b}','active',200,0);
        insert into public.payroll values ('50000000-0000-0000-0000-000000000001','${w}','2026-10-01','2026-10-31','draft');
        ${migration}
        -- Project column privacy leaves only site fields visible directly.
        revoke select on public.projects from authenticated;
        grant select (id,name) on public.projects to authenticated;
        set role authenticated; select set_config('request.jwt.claim.sub','${f}',false);
      `);
      const get=async(project:string|null)=>(await db.query<{v:Snapshot}>("select public.payroll_input_snapshot('2026-10-01','2026-10-31',$1) as v",[project])).rows[0].v;
      const all=await get(null);expect(all.attendance).toHaveLength(1006);expect(all.workers).toHaveLength(1005);expect(all.projects).toHaveLength(2);expect(all.users.map(x=>x.id)).toEqual([s]);expect(all.advances).toHaveLength(2);expect(all.payroll).toHaveLength(1);
      const scoped=await get(a);expect(scoped.attendance).toHaveLength(1005);expect(scoped.advances).toHaveLength(1);expect(scoped.projects.map(x=>x.id)).toEqual([a]);
      await expect(get('20000000-0000-0000-0000-000000000099')).rejects.toThrow(/selected project/i);
      await expect(db.query("select public.payroll_input_snapshot('2026-10-31','2026-10-01',null)")).rejects.toThrow(/Invalid payroll period/);
      await db.exec(`reset role; update public.attendance set notes=repeat('x',2097153) where id=md5('1')::uuid; set role authenticated;`);
      await expect(get(null)).rejects.toThrow(/too large/);
      await db.exec(`reset role; update public.attendance set notes='note' where id=md5('1')::uuid; update public.projects set name=repeat('x',8388609) where id='${a}'; set role authenticated;`);
      await expect(get(a)).rejects.toThrow(/safe response size/);
      await db.exec(`reset role; update public.projects set name='Alpha' where id='${a}'; set role authenticated;`);
      await db.exec(`reset role; insert into public.payroll values ('50000000-0000-0000-0000-000000000002','${w}','2026-10-01','2026-10-31','draft'); set role authenticated;`);
      await expect(get(null)).rejects.toThrow(/Duplicate vouchers/);
      await db.exec(`reset role; delete from public.payroll where id='50000000-0000-0000-0000-000000000002'; insert into public.attendance select md5(('extra'||n)::text)::uuid, '${w}', '${a}', '2000-01-01'::date + n, 'present', '', '${s}', false from generate_series(1,10000) n where '2000-01-01'::date + n <> '2026-10-15'::date; set role authenticated;`);
      await expect(db.query("select public.payroll_input_snapshot('2000-01-01','2030-12-31',null)")).rejects.toThrow(/too large/);
      const empty=(await db.query<{v:Snapshot}>("select public.payroll_input_snapshot('1990-01-01','1990-01-02',null) as v")).rows[0].v;
      expect(empty).toEqual({attendance:[],workers:[],projects:[],users:[{id:s,name:'Site Lead',role:'supervisor'}],advances:[],payroll:[]});
      await db.exec(`select set_config('request.jwt.claim.sub','${s}',false)`);await expect(get(null)).rejects.toThrow(/Founder access/);
      await db.exec('reset role; set role anon');await expect(get(null)).rejects.toThrow(/permission denied/i);
    }finally{await db.close()}
  },30000);
});
