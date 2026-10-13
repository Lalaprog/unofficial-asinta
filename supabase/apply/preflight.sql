-- ===========================================================================
-- BALE — pre-flight state report (READ-ONLY)
-- ===========================================================================
--
-- Paste this whole file into Supabase → SQL Editor and Run.
--
-- It changes NOTHING. It creates one temporary table in your own session to
-- hold the report and drops it at the end. No row in public, auth or storage
-- is written, updated or deleted.
--
-- WHAT YOU GET BACK — one grid, one row per item:
--
--   · what is already applied      (base schema / communications / hardening /
--                                   AI-draft support / Bale requests)
--   · the two ORDERING DEPENDENCIES, spelled out — getting either wrong makes
--     the bundle abort and roll back, which is exactly the failure that looked
--     like two unrelated bugs last time
--   · the exact NEXT STEP for your project
--   · whether the DEMO SEED was applied, and how many rows of it are live
--
-- Run this BEFORE applying anything, and again after each step.
-- Full procedure: docs/GO_LIVE_CHECKLIST.md. Long form: docs/MIGRATION_RUNBOOK.md.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Report table. Temp, session-scoped, dropped at the end.
-- Everything after this is guarded by to_regclass(...) so the file still runs
-- on a project that has nothing at all applied yet.
-- ---------------------------------------------------------------------------
drop table if exists pg_temp.bale_preflight;

create temp table bale_preflight (
  ord     int,
  item    text,
  value   text,
  meaning text
);

do $preflight$
declare
  -- ── the four auth accounts created by 20260913000002_bale_seed.sql ──────
  -- Two of these use the firm's real founder addresses (junel@, rei@).
  k_demo_users constant text[] := array[
    '02f773a0-abec-4916-9858-e9e547782bc3',  -- junel@asinta.ph         (founder)
    'b5117c39-e80b-cded-2c90-510de7ce7512',  -- rei@asinta.ph           (founder)
    'a564529f-1d75-aeec-1b99-a2391b321b90',  -- marco.santos@asinta.ph  (supervisor)
    '494fdb42-abc2-1f62-2745-0f60da3bc00e'   -- carlos.reyes@asinta.ph  (supervisor)
  ];

  -- ── the demo DATA rows, by the fixed UUIDs the seed inserted ────────────
  k_clients   constant text[] := array[
    '4f253f4e-bfab-8f08-4e4d-c7a98995e3d8', '781eaf58-2ac6-d504-bd47-a4b10cab1268',
    '78faed80-651d-d3bf-bcad-6bdb60527892', '20b9452b-5231-087b-7bf1-ae41f6c79c24'];
  k_projects  constant text[] := array[
    'f337de46-faf2-4ed7-92f5-559417285970', 'c9e48d2c-962b-5088-0119-2177bcbee57b',
    '09d48e01-1e9f-aa8e-91e9-67ff7708cbf1', '86e5045e-864d-62b9-b74b-b50b06d055f4'];
  k_workers   constant text[] := array[
    '9af0a8d4-e790-3cc9-a1eb-2799cc8ce733', '02be5394-7982-5806-3601-a35947502655',
    '0ff9addd-72b4-3cdc-6c19-f47fb8611a6c', '7deb1f59-518d-c0f4-ccaa-5192515d2a36',
    'b08602d2-0238-7012-f3cf-50a34e362566', 'e4c6cc24-c274-0c4f-7dd3-0dcd02ec3d3c',
    '4832550f-10f6-129d-0e4d-3c32ef76c6b8'];
  k_sup_assign constant text[] := array[
    '7496a174-f057-c39a-d28c-311ea4d4be0d', '4e99f6cf-d18d-7dd3-2468-30f4b1972c5c',
    '58fbf9be-67e5-5bb3-eb47-59860e56bb38'];
  k_invoices  constant text[] := array[
    '04a12fe6-4231-77a6-7098-91c046fe8aed', '4c414013-24e5-0db0-997e-0557392f5182',
    '9c400d0c-d69c-5eb7-e872-75e3f69566eb', '4319af1c-5118-6c44-857b-5e6a996b43bf',
    'b6e738fc-7bea-23d9-21ef-7cb7cc053a1b', '34a637fd-db0e-fa2f-8de4-bfe8315ce238'];
  k_expenses  constant text[] := array[
    '34a8d937-e2b0-6fc0-a55a-d580a82f8c40', '3d75fe68-55fa-b52d-1b2a-e7c302ce4b9f',
    '0f6e0f9e-a7b3-dce1-10ec-9f7dc5cc59ae', 'bdfb4be8-d16d-9020-2e2e-909a6650348e',
    '393c2372-fa05-3247-dda2-204a68bb4ba4', 'fdba091b-c16c-0e42-7ccf-38096e0a48d1'];
  k_advances  constant text[] := array[
    '7afe77fb-256d-7286-d604-5e94fa762739', 'e245a752-b9a6-b23b-abe9-4523c67fc30f',
    'c70607cd-ade9-3f7d-1d38-88a648b1a63d'];
  k_attendance constant text[] := array[
    '0c856168-3afb-f375-6506-c6019c145375', '0ca99d27-979b-64fa-aa4f-13478be7a96e',
    '0388376d-e3bd-ff67-0512-23f82e84e4a2', '405bbb26-195d-cb00-4103-1f0eeea6b27f',
    '7e5155fa-ee61-6772-35ee-0fc5ea235c1e', '5bcfdc6a-727d-8364-911b-b066d74ee8b7',
    'bbe67ab4-dc54-5bdb-8e57-5224c5d98707', '06b07ec5-0dbc-4db3-108c-45ab2004c022',
    'd7e51360-3ee4-a4e9-4a2d-2a21b44ca2d0', 'd1784947-7535-1b56-1542-9584ea20cfc0'];
  k_payroll   constant text[] := array[
    '21791ef4-dd52-b1fa-98f2-a956bcbffe83', '5ce4bbb4-c3bf-3af1-d268-6c6e1792fecd',
    'ec48593d-6940-78cb-609b-18169434def3', 'b373db2c-8200-ff5f-32d7-a59c30d5b49d',
    '5e1dc025-479f-98df-561d-3e1a84724505'];
  k_tools     constant text[] := array[
    '5c1ca1d3-839b-01f5-6a33-25d0ca3cfb50', '00d2fbd6-dd4e-fed7-ada7-931f6b508f7a',
    '21c0f9fc-84d2-db29-ac36-4dc753629075', '6fd88fab-ed33-eff7-477c-65c7a7c9ebbe',
    '4bf5b454-ea11-8018-647e-f73ab495c352', '051877fd-1be6-6271-d647-791768b32ab1',
    '71c65bf8-9f0f-8376-a381-9108ee653836'];
  k_sms_logs  constant text[] := array[
    '4c83ef72-96fc-2b5a-df10-0309159e79c1', '47bc38b0-d5e9-581f-f22a-015beb4b66b6'];

  v_base      boolean;
  v_comm      boolean;
  v_hard      boolean;
  v_ai        boolean;
  v_vendor    boolean;
  v_requests  boolean;
  v_bucket    text;
  v_demo_auth bigint := 0;
  v_demo_prof bigint := 0;
  v_demo_data bigint := 0;
  v_next      text;
  v_seed_risk text;
begin
  -- ── what is applied ───────────────────────────────────────────────────────
  v_base   := to_regclass('public.expenses')            is not null;
  v_comm   := to_regclass('public.reminder_dispatches') is not null;
  v_hard    := to_regclass('public.audit_log')           is not null;
  v_ai      := to_regclass('public.vendor_memory')       is not null;
  v_requests := to_regclass('public.advance_requests')   is not null;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'expenses' and column_name = 'vendor'
  ) into v_vendor;

  if to_regclass('storage.buckets') is null then
    v_bucket := 'storage schema not found';
  else
    execute 'select case
                      when count(*) = 0 then ''bucket NOT FOUND''
                      when bool_or(public) then ''PUBLIC — receipts are readable without auth''
                      else ''private''
                    end
             from storage.buckets where id = ''receipts'''
    into v_bucket;
  end if;

  -- ── demo seed detection ───────────────────────────────────────────────────
  -- auth.users always exists on a Supabase project, so this one is safe to
  -- reference directly. Everything in public.* is only touched when the table
  -- is actually there, because PostgreSQL resolves relation names when it
  -- plans a statement — including a branch that never executes.
  execute 'select count(*) from auth.users where id = any($1::uuid[])'
     into v_demo_auth using k_demo_users;

  if to_regclass('public.users') is not null then
    execute 'select count(*) from public.users where id = any($1::uuid[])'
       into v_demo_prof using k_demo_users;
  end if;

  if v_base then
    execute $q$
      select
        (select count(*) from public.clients             where id = any($1::uuid[]))
      + (select count(*) from public.projects            where id = any($2::uuid[]))
      + (select count(*) from public.workers             where id = any($3::uuid[]))
      + (select count(*) from public.project_supervisors where id = any($4::uuid[]))
      + (select count(*) from public.invoices            where id = any($5::uuid[]))
      + (select count(*) from public.expenses            where id = any($6::uuid[]))
      + (select count(*) from public.advances            where id = any($7::uuid[]))
      + (select count(*) from public.attendance          where id = any($8::uuid[]))
      + (select count(*) from public.payroll             where id = any($9::uuid[]))
      + (select count(*) from public.tools               where id = any($10::uuid[]))
      + (select count(*) from public.sms_logs            where id = any($11::uuid[]))
    $q$
    into v_demo_data
    using k_clients, k_projects, k_workers, k_sup_assign, k_invoices, k_expenses,
          k_advances, k_attendance, k_payroll, k_tools, k_sms_logs;
  end if;

  -- ── next step ─────────────────────────────────────────────────────────────
  if not v_base then
    v_next := 'EMPTY PROJECT — apply supabase/apply/fresh-install.sql';
  elsif not v_comm then
    v_next := '1) apply supabase/migrations/20260929000000_communications.sql, '
           || 'THEN 2) supabase/apply/upgrade-hardening.sql';
  elsif not v_hard or not v_ai or not v_vendor or not v_requests then
    v_next := 'apply supabase/apply/upgrade-hardening.sql';
  else
    v_next := 'nothing to apply — run supabase/apply/verify-live.sql';
  end if;

  if v_demo_auth > 0 then
    v_seed_risk := 'URGENT — see supabase/apply/seed-cleanup.sql (§1 rotate, §2 force '
                || 're-auth, §3 delete). Two of these accounts use the firm''s real '
                || 'founder addresses and the password asinta2026 is published in this repo.';
  else
    v_seed_risk := 'none found';
  end if;

  -- ── emit the report ───────────────────────────────────────────────────────
  insert into pg_temp.bale_preflight (ord, item, value, meaning) values
    (1,  'base schema applied',        v_base::text,      '20260913000000 + 20260913000001 — public.expenses exists'),
    (2,  'communications applied',     v_comm::text,      '20260929000000 — public.reminder_dispatches exists'),
    (3,  'hardening applied',          v_hard::text,      '20261006000000 — public.audit_log exists'),
    (4,  'AI-draft support applied',   v_ai::text,        '20261006000001 — public.vendor_memory exists'),
    (5,  'expenses.vendor column',     v_vendor::text,    '20261006000001 — needed by vendor memory & duplicate detection'),
    (6,  'receipts bucket',            v_bucket,          'must read "private" after hardening'),
    (7,  'Bale request workflow',      v_requests::text,  '20261013000000 — public.advance_requests exists'),

    (8,  'DEMO SEED: auth accounts',   v_demo_auth::text, 'accounts created by 20260913000002 (4 = all of them)'),
    (9,  'DEMO SEED: profiles',        v_demo_prof::text, 'public.users rows for those accounts'),
    (10, 'DEMO SEED: data rows',       v_demo_data::text, 'seeded clients/projects/workers/invoices/… (57 = all of them)'),
    (11, 'DEMO SEED: exposure',        case when v_demo_auth > 0 then 'LIVE' else 'none' end, v_seed_risk),

    (12, '>>> NEXT STEP',              v_next,            'do this one thing, then re-run this file'),

    (13, '>>> ORDER 1 (blocking)',     case when v_comm then 'satisfied' else 'NOT SATISFIED' end,
         '20260929000000_communications.sql MUST run BEFORE supabase/apply/upgrade-hardening.sql. '
      || 'The hardening migration re-scopes policies on email_templates, email_logs and '
      || 'reminder_dispatches — three tables only that migration creates. If they are missing the '
      || 'bundle dies on: relation "public.email_templates" does not exist.'),

    (14, '>>> ORDER 2 (blocking)',     case when v_base then 'upgrade-hardening' else 'fresh-install' end,
         'The two bundles are MUTUALLY EXCLUSIVE — never run both. fresh-install.sql is for an EMPTY '
      || 'project and is NOT idempotent (the base schema uses plain CREATE POLICY, so a second run '
      || 'fails on "policy already exists"). upgrade-hardening.sql REQUIRES the base schema to be '
      || 'there already. Either way the bundle runs as one transaction: one failed statement rolls '
      || 'back all of it.');

  raise notice 'BALE pre-flight done. Next step: %', v_next;
  if v_demo_auth > 0 then
    raise notice 'DEMO SEED IS LIVE (% accounts, % data rows) — run supabase/apply/seed-cleanup.sql.',
      v_demo_auth, v_demo_data;
  end if;
end $preflight$;

select item, value, meaning
from pg_temp.bale_preflight
order by ord;

drop table if exists pg_temp.bale_preflight;
