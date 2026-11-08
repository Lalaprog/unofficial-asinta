import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql=readFileSync('supabase/migrations/20261107000006_guarded_worker_removal.sql','utf8');
const f='00000000-0000-0000-0000-000000000001', s='00000000-0000-0000-0000-000000000002';
const w=(n:number)=>`10000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
describe('guarded worker removal',()=>{
  it('deletes only unlinked active or inactive workers, protects accounts and any FK, and audits atomically',async()=>{
    const db=new PGlite();
    try {
      await db.exec(`create role anon; create role authenticated; create role service_role; create schema app_private; create schema auth;
        create table public.users(id uuid primary key, role text, email text); create table auth.users(id uuid primary key);
        create table public.workers(id uuid primary key,name text, active boolean);
        create table public.attendance(worker_id uuid references public.workers(id) on delete restrict);
        create table public.notifications(worker_id uuid references public.workers(id) on delete set null);
        create table public.future_cascade(worker_id uuid references public.workers(id) on delete cascade);
        create table public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
        create function app_private.lock_founder_guard() returns void language sql as $$ select $$;
        grant all on public.workers to authenticated; grant usage on schema public to service_role,authenticated;
        insert into public.users values ('${f}','founder','founder@example.test'),('${s}','supervisor',null),('${w(4)}','supervisor',null);
        insert into auth.users values ('${w(5)}');
        insert into public.workers values ('${w(1)}','Active',true),('${w(2)}','Inactive',false),('${w(3)}','Has attendance',true),('${w(4)}','Account',true),('${w(5)}','Auth only',true),('${w(6)}','Notice',false),('${w(7)}','Future cascade',true);
        insert into public.attendance values ('${w(3)}'); insert into public.notifications values ('${w(6)}'); insert into public.future_cascade values ('${w(7)}');`);
      await db.exec(sql);
      await expect(db.query('select public.delete_workers_guarded($1,$2::uuid[])',[s,[w(1)]])).rejects.toThrow(/Founder access/);
      await expect(db.query('select public.delete_workers_guarded($1,$2::uuid[])',[f,[w(1),w(1)]])).rejects.toThrow(/Invalid worker selection/);
      await db.exec('set role authenticated');
      await expect(db.query('delete from public.workers')).rejects.toThrow(/permission denied/i);
      await expect(db.query('select public.delete_workers_guarded($1,$2::uuid[])',[f,[w(1)]])).rejects.toThrow(/permission denied/i);
      await db.exec('reset role; set role service_role');
      const result=await db.query<{result:{results:Array<{id:string;status:string}>}}>('select public.delete_workers_guarded($1,$2::uuid[]) result',[f,[w(7),w(6),w(5),w(4),w(3),w(2),w(1),w(8)]]);
      expect(result.rows[0].result.results).toEqual([
        {id:w(1),status:'deleted'},{id:w(2),status:'deleted'},{id:w(3),status:'linked',reasons:['Attendance']},{id:w(4),status:'account'},
        {id:w(5),status:'account'},{id:w(6),status:'linked',reasons:['Other linked records']},{id:w(7),status:'linked',reasons:['Other linked records']},{id:w(8),status:'missing'},
      ]);
      await db.exec('reset role');
      expect((await db.query('select * from public.workers')).rows).toHaveLength(5);
      expect((await db.query('select * from public.audit_log')).rows).toHaveLength(2);
      expect((await db.query('select * from public.attendance')).rows).toHaveLength(1);
      expect((await db.query('select * from public.notifications')).rows).toHaveLength(1);
      expect((await db.query('select * from public.future_cascade')).rows).toHaveLength(1);
      // An audit failure must roll back the deletion, not leave an unlogged change.
      await db.exec(`insert into public.workers values ('${w(9)}','Audit rollback',true); alter table public.audit_log add constraint audit_deny_test check (record_id <> '${w(9)}'::uuid);`);
      await expect(db.query('select public.delete_workers_guarded($1,$2::uuid[])',[f,[w(9)]])).rejects.toThrow();
      expect((await db.query('select id from public.workers where id=$1',[w(9)])).rows).toHaveLength(1);
      await db.exec('begin isolation level repeatable read');
      await expect(db.query('select public.delete_workers_guarded($1,$2::uuid[])',[f,[w(9)]])).rejects.toThrow(/REQUIRES_READ_COMMITTED/);
      await db.exec('rollback');
      await db.exec('create function public.test_worker_trigger() returns trigger language plpgsql as $$ begin return old; end $$; create trigger unknown_worker_delete before delete on public.workers for each row execute function public.test_worker_trigger()');
      await expect(db.query('select public.delete_workers_guarded($1,$2::uuid[])',[f,[w(3)]])).rejects.toThrow(/SCHEMA_REVIEW_REQUIRED/);
    } finally { await db.close(); }
  },15000);
});
