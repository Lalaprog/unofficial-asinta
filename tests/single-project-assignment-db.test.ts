import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const first = readFileSync('supabase/migrations/20261107000002_project_worker_lists.sql', 'utf8');
const change = readFileSync('supabase/migrations/20261112000000_guarded_single_project_worker.sql', 'utf8');
const f='00000000-0000-0000-0000-000000000001', sup='00000000-0000-0000-0000-000000000002';
const p1='10000000-0000-0000-0000-000000000001', p2='10000000-0000-0000-0000-000000000002';
const w='20000000-0000-0000-0000-000000000001', legacy='20000000-0000-0000-0000-000000000002';

describe('guarded one-project worker assignment', () => {
  it('preserves existing duplicates, restricts candidates, allows a safe move and permits linked supervisors multiple sites', async () => {
    const db=new PGlite();
    try {
      await db.exec(`create role anon; create role authenticated; create role service_role; create schema app_private;
        grant usage on schema public to authenticated, service_role;
        create table public.users(id uuid primary key,role text not null);
        create table public.projects(id uuid primary key);
        create table public.workers(id uuid primary key,name text not null,position text not null,contact_number text not null,pay_rate numeric not null,pay_rate_type text not null,active boolean not null);
        create table public.project_supervisors(project_id uuid,supervisor_id uuid,unique(project_id,supervisor_id));
        create function public.is_founder() returns boolean language sql as $$select false$$;
        create function public.is_supervisor_assigned(uuid) returns boolean language sql as $$select false$$;
        create function public.session_assurance_satisfied() returns boolean language sql as $$select false$$;
        insert into public.users values ('${f}','founder'),('${sup}','supervisor');
        insert into public.projects values ('${p1}'),('${p2}');
        insert into public.project_supervisors values ('${p1}','${sup}');
        insert into public.workers values ('${w}','Worker','Mason','—',600,'daily',true),('${legacy}','Existing duplicate','Mason','—',600,'daily',true),('${sup}','Supervisor','Supervisor','—',600,'daily',true);`);
      await db.exec(first);
      await db.exec(`insert into public.project_worker_assignments(project_id,worker_id,active) values ('${p1}','${legacy}',true),('${p2}','${legacy}',true);`);
      await db.exec(change);
      expect((await db.query('select * from public.project_worker_assignments where worker_id=$1 and active',[legacy])).rows).toHaveLength(2);
      await db.exec('set role service_role');
      const available=async(actor:string, project:string)=>(await db.query<{ids:{id:string}[]}>('select public.available_project_workers_guarded($1,$2) ids',[actor,project])).rows[0].ids.map(row=>row.id);
      expect(await available(sup,p1)).toEqual([w]);
      await expect(available(sup,p2)).rejects.toThrow(/access required/i);
      const assign=(project:string, worker:string, active:boolean)=>db.query('select public.set_project_worker_guarded($1,$2,$3,$4)',[f,project,worker,active]);
      await assign(p1,w,true);
      expect(await available(sup,p1)).toEqual([]);
      await expect(assign(p2,w,true)).rejects.toThrow(/already has an active project/i);
      await assign(p1,w,false);
      expect(await available(sup,p1)).toEqual([w]);
      await assign(p2,w,true);
      await assign(p1,sup,true); await assign(p2,sup,true);
      await db.exec('reset role');
      expect((await db.query('select * from public.project_worker_assignments where worker_id=$1 and active',[w])).rows).toHaveLength(1);
      expect((await db.query('select * from public.project_worker_assignments where worker_id=$1 and active',[sup])).rows).toHaveLength(2);
      expect((await db.query('select * from public.project_worker_assignments where worker_id=$1 and active',[legacy])).rows).toHaveLength(2);
      await db.exec('set role authenticated');
      await expect(db.query('select public.available_project_workers_guarded($1,$2)',[f,p1])).rejects.toThrow(/permission denied/i);
      await expect(db.query('select public.set_project_worker_guarded($1,$2,$3,true)',[f,p1,w])).rejects.toThrow(/permission denied/i);
      await expect(db.query('update public.project_worker_assignments set active=true')).rejects.toThrow(/permission denied/i);
    } finally {await db.close();}
  });
});
