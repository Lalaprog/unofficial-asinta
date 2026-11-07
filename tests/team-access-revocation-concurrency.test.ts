// Opt-in: only an empty, local disposable asinta_test_* database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
const url=process.env.TEAM_ACCESS_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-4000-8000-000000000001',supervisor='00000000-0000-4000-8000-000000000002',supervisor2='00000000-0000-4000-8000-000000000003',project='00000000-0000-4000-8000-000000000004',supervisor3='00000000-0000-4000-8000-000000000005',supervisor4='00000000-0000-4000-8000-000000000006',supervisor5='00000000-0000-4000-8000-000000000007';
let admin:Client,first:Client,second:Client;
suite('staged access revocation concurrency',()=>{
  beforeAll(async()=>{
    const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_'))throw Error('Use an empty local disposable database.');
    admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
    if((await admin.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') LIMIT 1")).rowCount)throw Error('Database is not empty');
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;
      create schema auth;create schema app_private;create table app_private.guard(id int primary key);insert into app_private.guard values(1);
      create function app_private.lock_founder_guard() returns void language plpgsql as $$ begin update app_private.guard set id=id where id=1; end $$;
      create function app_private.lock_user_mutations() returns trigger language plpgsql as $$ begin perform app_private.lock_founder_guard();return null;end $$;
      create table public.users(id uuid primary key,email text,role text);
      create table public.workers(id uuid primary key,name text,contact_number text,position text,pay_rate numeric,pay_rate_type text,active boolean);
        create table public.projects(id uuid primary key);create table public.project_supervisors(project_id uuid,supervisor_id uuid);
      create table public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
      create table auth.mfa_factors(user_id uuid,status text);create function auth.uid() returns uuid language sql as $$ select null::uuid $$;create function auth.jwt() returns jsonb language sql as $$ select '{}'::jsonb $$;
      insert into users values ('${founder}','f@example.test','founder'),('${supervisor}','s@example.test','supervisor'),('${supervisor2}','s2@example.test','supervisor'),('${supervisor3}','s3@example.test','supervisor'),('${supervisor4}','s4@example.test','supervisor'),('${supervisor5}','s5@example.test','supervisor');
      insert into projects values ('${project}');insert into project_supervisors values ('${project}','${supervisor}'),('${project}','${supervisor2}');`);
    await admin.query(readFileSync('supabase/staged/20261107000007_staged_team_access_revocation.sql','utf8'));
    await admin.query(`create trigger lock_user_mutations before update or delete on users for each statement execute function app_private.lock_user_mutations();
      create trigger check_founder_after_update after update on users referencing old table as old_user_rows for each statement execute function app_private.check_founder_after_update()`);
  },30000);
  afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
  it('waits for an authorized worker action already holding the user lock',async()=>{
    await first.query('begin');await second.query('begin');await first.query('select app_private.lock_project_worker_access($1,$2)',[supervisor,project]);
    let done=false;const revoke=second.query('select public.revoke_supervisor_access_guarded($1,$2) ok',[founder,supervisor]).finally(()=>{done=true;});
    await new Promise(resolve=>setTimeout(resolve,200));expect(done).toBe(false);await first.query('commit');expect((await revoke).rows[0].ok).toBe(true);await second.query('commit');
    await expect(admin.query('select app_private.lock_project_worker_access($1,$2)',[supervisor,project])).rejects.toThrow(/Project access required/);
  },15000);
  it('sees a revocation committed while a later service-role action waits',async()=>{
    await first.query('begin');await second.query('begin');expect((await first.query('select public.revoke_supervisor_access_guarded($1,$2) ok',[founder,supervisor2])).rows[0].ok).toBe(true);
    let done=false;const access=second.query('select app_private.lock_project_worker_access($1,$2)',[supervisor2,project]).then(()=>null,error=>error as Error).finally(()=>{done=true;});
    await new Promise(resolve=>setTimeout(resolve,200));expect(done).toBe(false);await first.query('commit');expect((await access)?.message).toMatch(/Project access required/);await second.query('rollback');
  },15000);
  it('refuses stale repeatable-read snapshots',async()=>{
    await first.query('begin isolation level repeatable read');await expect(first.query('select app_private.lock_project_worker_access($1,$2)',[supervisor,project])).rejects.toThrow(/TEAM_ACCESS_REQUIRES_READ_COMMITTED/);await first.query('rollback');
  });
  it('serializes revocation with promotion in both orders',async()=>{
    await first.query('begin');await second.query('begin');
    expect((await first.query('select public.revoke_supervisor_access_guarded($1,$2) ok',[founder,supervisor3])).rows[0].ok).toBe(true);
    let done=false;const promotion=second.query("update public.users set role='founder' where id=$1",[supervisor3]).then(()=>null,error=>error as Error).finally(()=>{done=true;});
    await new Promise(resolve=>setTimeout(resolve,200));expect(done).toBe(false);await first.query('commit');expect((await promotion)?.message).toMatch(/blocked account/);await second.query('rollback');
    await first.query('begin');await second.query('begin');await first.query("update public.users set role='founder' where id=$1",[supervisor4]);
    done=false;const revoke=second.query('select public.revoke_supervisor_access_guarded($1,$2)',[founder,supervisor4]).then(()=>null,error=>error as Error).finally(()=>{done=true;});
    await new Promise(resolve=>setTimeout(resolve,200));expect(done).toBe(false);await first.query('commit');expect((await revoke)?.message).toMatch(/Supervisor account not found/);await second.query('rollback');
    expect((await admin.query('select count(*)::int n from team_access_revocations where user_id=$1',[supervisor4])).rows[0].n).toBe(0);
  },15000);

  it('blocks global worker registration after a concurrent revocation',async()=>{
    await first.query('begin');await second.query('begin');expect((await first.query('select public.revoke_supervisor_access_guarded($1,$2) ok',[founder,supervisor5])).rows[0].ok).toBe(true);
    let done=false;const registration=second.query("select public.create_global_worker_guarded($1,$2,'Test Worker','—','Mason',800,'daily')",[supervisor5,'00000000-0000-4000-8000-000000000009']).then(()=>null,error=>error as Error).finally(()=>{done=true;});
    await new Promise(resolve=>setTimeout(resolve,200));expect(done).toBe(false);await first.query('commit');expect((await registration)?.message).toMatch(/active team account required/);await second.query('rollback');
    expect((await admin.query('select count(*)::int n from workers')).rows[0].n).toBe(0);
  },15000);

});
