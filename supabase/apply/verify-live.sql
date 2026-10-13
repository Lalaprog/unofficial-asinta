-- ===========================================================================
-- BALE — live verification
-- ===========================================================================
--
-- Run this in the Supabase SQL editor (or psql) AFTER applying a bundle from
-- this folder. It is READ-ONLY and safe to run any number of times.
--
-- Every row should say PASS. A FAIL row names the problem and tells you which
-- migration to apply. This turns the static guards in tests/rls-migration.test.ts
-- into checks against the live database.
-- ===========================================================================

with
-- ── expected objects ──────────────────────────────────────────────────────
expected_tables(name) as (
  values ('users'), ('workers'), ('clients'), ('projects'), ('project_supervisors'),
         ('invoices'), ('expenses'), ('advances'), ('attendance'), ('payroll'),
         ('tools'), ('sms_logs'), ('email_logs'), ('email_templates'),
         ('reminder_dispatches'), ('audit_log'), ('vendor_memory'), ('advance_requests'),
         ('user_notifications')
),
missing_tables as (
  select e.name
  from expected_tables e
  where not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = e.name and c.relkind = 'r'
  )
),
public_tables as (
  select c.relname, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
),
rls_off as (
  select relname from public_tables where not relrowsecurity
),
-- Policies that still apply to unauthenticated callers. The base schema's 23
-- policies had no TO clause, which Postgres resolves to PUBLIC (anon included).
-- Supabase also reports the implicit "public" role for unscoped policies.
anon_policies as (
  select tablename, policyname, roles::text as roles
  from pg_policies
  where schemaname = 'public'
    and (roles::text like '%anon%' or roles::text like '%public%' or roles::text ilike '%{public}%')
),
using_true as (
  select tablename, policyname, cmd
  from pg_policies
  where schemaname = 'public'
    and (qual = 'true' or with_check = 'true')
),
audit_write_policies as (
  select policyname, cmd
  from pg_policies
  where schemaname = 'public' and tablename = 'audit_log'
    and cmd in ('UPDATE', 'DELETE', 'ALL')
),
helpers_unpinned as (
  select p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('current_user_role', 'is_founder', 'is_supervisor_assigned')
    and (p.proconfig is null or not exists (
      select 1 from unnest(p.proconfig) as cfg where cfg like 'search_path=%'
    ))
),
receipts_bucket as (
  select id, public from storage.buckets where id = 'receipts'
),
url_style_receipts as (
  select count(*) as n
  from public.expenses
  where receipt_url is not null and receipt_url ~* '^https?://'
),
founder_profiles as (
  select count(*) as n from public.users where role = 'founder'
),
  orphan_profiles as (
  select count(*) as n
  from public.users u
  where not exists (select 1 from auth.users a where a.id = u.id)
),
advance_notification_objects as (
  select
    to_regclass('public.user_notifications') is not null as notification_table_present,
    to_regprocedure('public.approve_advance_requests(uuid[])') is not null as batch_rpc_present,
    exists (
      select 1
      from pg_trigger
      where tgname = 'notify_advance_request_event'
        and tgrelid = to_regclass('public.advance_requests')
        and not tgisinternal
    ) as event_trigger_present
),
notification_policy_check as (
  select
    count(*) as policy_count,
    count(*) filter (
      where roles::text not like '%authenticated%'
        or cmd not in ('SELECT', 'UPDATE')
        or (cmd = 'SELECT' and coalesce(qual, '') !~* 'recipient_id\s*=\s*auth\.uid\(\)')
        or (cmd = 'UPDATE' and (
          coalesce(qual, '') !~* 'recipient_id\s*=\s*auth\.uid\(\)'
          or coalesce(with_check, '') !~* 'recipient_id\s*=\s*auth\.uid\(\)'
          or coalesce(with_check, '') !~* 'read_at\s+is\s+not\s+null'
        ))
    ) as unsafe_count
  from pg_policies
  where schemaname = 'public' and tablename = 'user_notifications'
)

-- ── results: one row per check ────────────────────────────────────────────
select 'base tables present' as check_name,
       '19 tables' as expected,
       case when (select count(*) from missing_tables) = 0
            then 'all 19 present'
            else 'MISSING: ' || (select string_agg(name, ', ') from missing_tables) end as actual,
       case when (select count(*) from missing_tables) = 0 then 'PASS' else 'FAIL' end as status

union all
select 'Bale notification trigger and batch RPC installed',
       'user_notifications + notification trigger + approve_advance_requests(uuid[])',
       case when (select notification_table_present and batch_rpc_present and event_trigger_present
                  from advance_notification_objects)
            then 'notification table, event trigger, and RPC present'
            else 'MISSING — apply supabase/apply/upgrade-hardening.sql' end,
       case when (select notification_table_present and batch_rpc_present and event_trigger_present
                  from advance_notification_objects) then 'PASS' else 'FAIL' end

union all
select 'Bale notification policies are recipient-only',
       '2 authenticated policies: recipient SELECT and recipient read_at UPDATE',
       case when (select policy_count = 2 and unsafe_count = 0 from notification_policy_check)
            then 'exactly the two recipient-scoped policies are present'
            else 'unsafe or missing policy — inspect public.user_notifications RLS' end,
       case when (select policy_count = 2 and unsafe_count = 0 from notification_policy_check)
            then 'PASS' else 'FAIL' end

union all
select 'RLS enabled on every public table',
       'no table without RLS',
       coalesce((select string_agg(relname, ', ') from rls_off), 'all tables have RLS'),
       case when (select count(*) from rls_off) = 0 then 'PASS' else 'FAIL' end

union all
select 'no policy reachable by anon',
       'every policy is TO authenticated',
       coalesce((select string_agg(distinct tablename || '.' || policyname, ', ') from anon_policies),
                'none reachable by anon'),
       case when (select count(*) from anon_policies) = 0 then 'PASS' else 'FAIL' end

union all
select 'no permissive USING (true) policy',
       'no qual/with_check of true',
       coalesce((select string_agg(distinct tablename || '.' || policyname, ', ') from using_true), 'none'),
       case when (select count(*) from using_true) = 0 then 'PASS' else 'FAIL' end

union all
select 'audit_log cannot be rewritten',
       'no UPDATE/DELETE/ALL policy',
       coalesce((select string_agg(policyname || ' (' || cmd || ')', ', ') from audit_write_policies),
                'no write policy — append-only'),
       case when (select count(*) from audit_write_policies) = 0 then 'PASS' else 'FAIL' end

union all
select 'RLS helpers pin search_path',
       '3 functions pinned',
       case when (select count(*) from helpers_unpinned) = 0
            then 'all 3 pinned'
            else 'UNPINNED: ' || (select string_agg(proname, ', ') from helpers_unpinned) end,
       case when (select count(*) from helpers_unpinned) = 0 then 'PASS' else 'FAIL' end

union all
select 'receipts bucket is private',
       'public = false',
       coalesce((select 'public = ' || public::text from receipts_bucket), 'bucket NOT FOUND'),
       case when (select count(*) from receipts_bucket) = 1
                 and (select not public from receipts_bucket) then 'PASS' else 'FAIL' end

union all
select 'receipt_url holds storage paths',
       'no http(s):// values left',
       case when (select n from url_style_receipts) = 0
            then 'all rows are bare paths'
            else (select n::text from url_style_receipts) || ' row(s) still hold a URL — the backfill was skipped or the project has not applied 20261006000000' end,
       case when (select n from url_style_receipts) = 0 then 'PASS' else 'FAIL' end

union all
select 'at least one Founder profile',
       '>= 1 row with role = founder',
       (select n::text from founder_profiles) || ' founder row(s)',
       case when (select n from founder_profiles) >= 1 then 'PASS' else 'FAIL' end

union all
select 'no orphaned profiles',
       'every public.users row has an auth.users row',
       (select n::text from orphan_profiles) || ' orphan(s)',
       case when (select n from orphan_profiles) = 0 then 'PASS' else 'FAIL' end

order by status desc, check_name;
