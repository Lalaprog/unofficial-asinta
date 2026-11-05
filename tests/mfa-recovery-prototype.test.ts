import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// This is a disposable research fixture, NOT a production migration or proof
// that the real application is covered. No Supabase project is contacted.
const prototype = readFileSync('tests/fixtures/mfa-recovery-prototype.sql', 'utf8');
const founder = '00000000-0000-0000-0000-000000000001';
const supervisor = '00000000-0000-0000-0000-000000000002';
const noFactor = '00000000-0000-0000-0000-000000000003';

async function identity(db: PGlite, id: string, aal: string | null) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)", [id, JSON.stringify(aal ? { aal } : {})]);
}

describe('isolated MFA assurance research prototype', () => {
  it('protects example rows, storage, profile bootstrap and a guarded definer without exposing factor rows', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        create role authenticated; create role anon; create role service_role bypassrls;
        create schema auth; create schema storage;
        create function auth.uid() returns uuid language sql stable as $$
          select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
        $$;
        create function auth.jwt() returns jsonb language sql stable as $$
          select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
        $$;
        grant usage on schema public, auth, storage to authenticated, anon, service_role;
        create table auth.mfa_factors(id int, user_id uuid, status text, secret text);
        revoke all on auth.mfa_factors from public, authenticated, anon;
        insert into auth.mfa_factors values
          (1, '${founder}', 'verified', 'never exposed'),
          (2, '${supervisor}', 'unverified', 'never exposed');
        create table public.private_entries(id int primary key, owner_id uuid, description text);
        create table public.profiles(id uuid primary key, name text);
        create table storage.objects(id int primary key, owner_id uuid);
        insert into public.private_entries values (1,'${founder}','private'),(2,'${supervisor}','supervisor'),(3,'${noFactor}','unenrolled');
        insert into public.profiles values ('${founder}','Founder'),('${supervisor}','Supervisor'),('${noFactor}','Another');
        insert into storage.objects values (1,'${founder}'),(2,'${supervisor}');
        alter table public.private_entries enable row level security;
        alter table public.profiles enable row level security;
        alter table storage.objects enable row level security;
        grant select, insert, update, delete on public.private_entries, public.profiles, storage.objects to authenticated, service_role;
        create policy example_entries on public.private_entries to authenticated using(owner_id = auth.uid()) with check(owner_id = auth.uid());
        create policy example_profiles on public.profiles to authenticated using(true) with check(true);
        create policy example_storage on storage.objects to authenticated using(owner_id = auth.uid()) with check(owner_id = auth.uid());
        -- A privileged function ignores the table's row policies unless guarded.
        create function public.unguarded_entries() returns setof public.private_entries language sql security definer set search_path = '' as $$
          select * from public.private_entries where owner_id = auth.uid()
        $$;
        revoke all on function public.unguarded_entries() from public;
        grant execute on function public.unguarded_entries() to authenticated;
      `);
      await db.exec(prototype);
      await db.exec('set role authenticated');
      await identity(db, founder, 'aal1');
      expect((await db.query('select * from public.private_entries')).rows).toEqual([]);
      expect((await db.query('select * from storage.objects')).rows).toEqual([]);
      expect((await db.query('select id from public.profiles')).rows).toEqual([{id: founder}]);
      expect((await db.query("update public.profiles set name='changed' returning id")).rows).toEqual([]);
      expect((await db.query("update public.private_entries set description='changed' returning id")).rows).toEqual([]);
      await expect(db.query(`insert into public.private_entries values (4,'${founder}','new')`)).rejects.toThrow(/row-level security/);
      await expect(db.query('select * from public.guarded_entries()')).rejects.toThrow(/Additional verification required/);
      // Demonstrates why adding table policies alone would leave a serious gap.
      expect((await db.query('select * from public.unguarded_entries()')).rows).toHaveLength(1);
      await expect(db.query('select * from auth.mfa_factors')).rejects.toThrow(/permission denied/);

      await identity(db, founder, 'aal2');
      expect((await db.query('select * from public.private_entries')).rows).toHaveLength(1);
      expect((await db.query('select * from storage.objects')).rows).toHaveLength(1);
      expect((await db.query('select * from public.profiles')).rows).toHaveLength(3);
      expect((await db.query('select * from public.guarded_entries()')).rows).toHaveLength(1);
      expect((await db.query("update public.private_entries set description='updated' returning id")).rows).toEqual([{id:1}]);

      // An unverified/abandoned factor does not force MFA on an unenrolled user.
      await identity(db, supervisor, 'aal1');
      expect((await db.query('select * from public.private_entries')).rows).toHaveLength(1);
      expect((await db.query('select * from storage.objects')).rows).toHaveLength(1);
      expect((await db.query('select * from public.guarded_entries()')).rows).toHaveLength(1);
      // The same rule applies if a Supervisor later verifies an authenticator.
      await db.exec("reset role; update auth.mfa_factors set status='verified' where id=2; set role authenticated");
      await identity(db, supervisor, 'aal1');
      expect((await db.query('select * from public.private_entries')).rows).toEqual([]);
      await expect(db.query('select * from public.guarded_entries()')).rejects.toThrow(/Additional verification required/);
      await identity(db, supervisor, 'aal2');
      expect((await db.query('select * from public.private_entries')).rows).toHaveLength(1);
      await identity(db, noFactor, 'aal1');
      expect((await db.query('select * from public.private_entries')).rows).toHaveLength(1);
      for (const aal of [null, 'invalid']) {
        await identity(db, noFactor, aal);
        expect((await db.query('select * from public.private_entries')).rows).toEqual([]);
        expect((await db.query('select * from public.profiles')).rows).toEqual([]);
        await expect(db.query('select * from public.guarded_entries()')).rejects.toThrow(/Additional verification required/);
      }
      await identity(db, '', 'aal2');
      expect((await db.query('select * from public.private_entries')).rows).toEqual([]);
      await expect(db.query('select * from public.guarded_entries()')).rejects.toThrow(/Additional verification required/);
      await db.exec('reset role; set role anon');
      await expect(db.query('select assurance_private.session_satisfies_mfa()')).rejects.toThrow(/permission denied/);
      await expect(db.query('select * from public.guarded_entries()')).rejects.toThrow(/permission denied/);
      await db.exec('reset role; set role service_role');
      // Service-role bypass is intentional and must be secured at each API.
      expect((await db.query('select * from public.private_entries')).rows).toHaveLength(3);
    } finally {
      await db.close();
    }
  }, 30000);
});

describe('prototype against selected checked-in privileged functions', () => {
  it('denies a verified Founder at aal1 and permits synthetic project reads and payroll approval at aal2', async () => {
    const db = new PGlite();
    const uid = founder;
    const worker = '10000000-0000-0000-0000-000000000001';
    const payroll = '10000000-0000-0000-0000-000000000002';
    const project = '10000000-0000-0000-0000-000000000003';
    try {
      await db.exec(`
        create role anon; create role authenticated; create schema auth;
        grant usage on schema public, auth to authenticated;
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
        create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
        create table auth.mfa_factors(id int, user_id uuid, status text);
        insert into auth.mfa_factors values (1,'${uid}','verified');
        revoke all on auth.mfa_factors from public, authenticated;
        create table public.users(id uuid primary key,email text,role text);
        create table public.project_supervisors(project_id uuid,supervisor_id uuid);
        create table public.projects(id uuid primary key,name text,client_id uuid,location text,budget_estimate numeric,status text,start_date date,target_completion_date date,created_at timestamptz default now());
        create table public.workers(id uuid primary key);
        create table public.advances(id uuid primary key,worker_id uuid,project_id uuid,amount numeric,amount_deducted numeric,reason text,date date,status text,created_at timestamptz default now());
        create table public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,gross_pay numeric,bale_deduction numeric,other_deductions numeric,net_pay numeric,status text,days_worked numeric,hours_worked numeric,notes text,created_at timestamptz default now());
        create table public.audit_log(id uuid default gen_random_uuid(),actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb,created_at timestamptz default now());
        create table public.advance_requests(id uuid,worker_id uuid,project_id uuid,requested_amount numeric,status text,submitted_by uuid,approved_by uuid,approved_at timestamptz,rejected_by uuid,rejected_at timestamptz,issued_by uuid,issued_at timestamptz,issued_advance_id uuid,updated_at timestamptz);
        insert into public.users values ('${uid}','founder@example.test','founder'),('${supervisor}','supervisor@example.test','supervisor');
        insert into public.project_supervisors values ('${project}','${supervisor}');
        insert into auth.mfa_factors values (2,'${supervisor}','verified');
        insert into public.projects(id,name,client_id,location,budget_estimate,status,start_date,target_completion_date) values ('${project}','Synthetic',null,'Lipa',1000,'active','2026-01-01','2026-12-31');
        insert into public.workers values ('${worker}');
        insert into public.payroll(id,worker_id,period_start,period_end,gross_pay,bale_deduction,other_deductions,net_pay,status) values ('${payroll}','${worker}','2026-01-01','2026-01-07',100,0,0,100,'draft');
        grant select,insert,update,delete on public.payroll,public.advances to authenticated;
      `);
      // Use the exact draft helper definitions with selected checked-in
      // privileged functions, against disposable synthetic application tables.
      await db.exec(readFileSync('supabase/migrations/20261105000000_session_assurance_prerequisite.sql','utf8'));
      const policies = readFileSync('supabase/migrations/20261105000001_mfa_table_storage_policies.sql','utf8');
      const helperStart = policies.indexOf('CREATE OR REPLACE FUNCTION public.is_founder()');
      const helperEnd = policies.indexOf('DROP POLICY IF EXISTS mfa_session_required ON public.advance_requests;');
      expect(helperStart).toBeGreaterThan(-1);
      expect(helperEnd).toBeGreaterThan(helperStart);
      await db.exec(policies.slice(helperStart,helperEnd));
      const requests = readFileSync('supabase/migrations/20261013000000_advance_requests.sql','utf8');
      const notifications = readFileSync('supabase/migrations/20261013000001_advance_request_notifications.sql','utf8');
      for (const [source,name] of [[requests,'review_advance_request'],[requests,'issue_advance_request'],[notifications,'approve_advance_requests']] as const) {
        const match = source.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$\\$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;`, 'i'));
        expect(match, name).not.toBeNull();
        await db.exec(match![0]);
      }
      await db.exec(readFileSync('supabase/migrations/20261104000000_visible_projects.sql','utf8'));
      await db.exec(readFileSync('supabase/migrations/20261102000000_atomic_payroll_payments.sql','utf8'));
      await db.exec('set role authenticated');
      await identity(db, uid, 'aal1');
      expect((await db.query('select * from public.visible_projects()')).rows).toEqual([]);
      await expect(db.query('select public.set_payroll_status_atomic($1,$2)',[payroll,'approved'])).rejects.toThrow(/Founder access/);
      await expect(db.query('select public.record_advance_deduction_atomic($1,1)',[worker])).rejects.toThrow(/Founder access/);
      await expect(db.query("select public.set_advance_status_atomic($1,'active')",[worker])).rejects.toThrow(/Founder access/);
      await expect(db.query("select public.review_advance_request($1,'approve')",[worker])).rejects.toThrow(/Founder access/);
      await expect(db.query('select public.issue_advance_request($1)',[worker])).rejects.toThrow(/Founder access/);
      await expect(db.query('select * from public.approve_advance_requests($1::uuid[])',[[worker]])).rejects.toThrow(/Founder access/);
      await identity(db, supervisor, 'aal1');
      expect((await db.query('select * from public.visible_projects()')).rows).toEqual([]);
      await identity(db, supervisor, 'aal2');
      expect((await db.query('select id,client_id,budget_estimate from public.visible_projects()')).rows).toEqual([{id:project,client_id:null,budget_estimate:null}]);
      await db.exec('reset role');
      expect((await db.query('select status from public.payroll')).rows).toEqual([{status:'draft'}]);
      expect((await db.query('select * from public.audit_log')).rows).toHaveLength(0);
      await db.exec('set role authenticated');
      await identity(db, uid, 'aal2');
      expect((await db.query('select id,name from public.visible_projects()')).rows).toEqual([{id:project,name:'Synthetic'}]);
      await expect(db.query('select public.record_advance_deduction_atomic($1,1)',[worker])).rejects.toThrow(/Advance not found/);
      await expect(db.query("select public.set_advance_status_atomic($1,'active')",[worker])).rejects.toThrow(/Advance not found/);
      await expect(db.query("select public.review_advance_request($1,'approve')",[worker])).rejects.toThrow(/Bale request not found/);
      await expect(db.query('select public.issue_advance_request($1)',[worker])).rejects.toThrow(/Bale request not found/);
      await expect(db.query('select * from public.approve_advance_requests($1::uuid[])',[[]])).rejects.toThrow(/Select at least one/);
      const result = await db.query<{result:{outcome:string}}>('select public.set_payroll_status_atomic($1,$2) as result',[payroll,'approved']);
      expect(result.rows[0].result.outcome).toBe('updated');
      await db.exec('reset role');
      expect((await db.query('select status from public.payroll')).rows).toEqual([{status:'approved'}]);
      expect((await db.query('select * from public.audit_log')).rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  }, 30000);
});
