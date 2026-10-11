-- ===========================================================================
-- BALE — demo seed remediation
-- ===========================================================================
--
-- WHY THIS FILE EXISTS
-- --------------------
-- supabase/migrations/20260913000002_bale_seed.sql was applied to the live
-- project. It created four auth accounts:
--
--     02f773a0-abec-4916-9858-e9e547782bc3   junel@asinta.ph          founder
--     b5117c39-e80b-cded-2c90-510de7ce7512   rei@asinta.ph            founder
--     a564529f-1d75-aeec-1b99-a2391b321b90   marco.santos@asinta.ph   supervisor
--     494fdb42-abc2-1f62-2745-0f60da3bc00e   carlos.reyes@asinta.ph   supervisor
--
-- all four with the password `asinta2026`, which is published in this
-- repository. Two of those addresses are the firm's real founder addresses.
-- Anyone who reads the repo can sign in to the firm's books.
--
-- This is the ONLY remediation procedure. It runs in three sections:
--
--     §1  ROTATE               — new password on every account still using
--                                the published one. Do this first; it closes
--                                the hole on its own, whether or not you ever
--                                run §3.
--     §2  FORCE RE-AUTH        — revoke every live session and refresh token,
--                                so an old token cannot outlive the rotation.
--     §3  DELETE DEMO DATA     — remove the four accounts, their profiles and
--                                the 57 fictional rows. ARMED OFF BY DEFAULT:
--                                it deletes rows, and two of the accounts use
--                                real founder addresses you may want to keep.
--
-- §1 and §2 are safe to run immediately and can be re-run. §3 needs one edit
-- first, and is atomic — it either deletes all of it or none of it.
--
-- TAKE A BACKUP / CONFIRM PITR IS ON BEFORE §3. Order and rationale:
-- docs/GO_LIVE_CHECKLIST.md. Background: docs/SECURITY.md §9 and
-- docs/MIGRATION_RUNBOOK.md.
-- ===========================================================================

create extension if not exists pgcrypto;


-- ===========================================================================
-- §1 — ROTATE
-- ===========================================================================
-- EDIT THE PASSWORD ON THE LINE MARKED <<< THEN RUN THIS SECTION.
--
-- This selects accounts by VERIFYING the stored hash against the published
-- password — `encrypted_password = crypt('asinta2026', encrypted_password)` —
-- not by email address. That way it catches every account holding that
-- password, including any that are not in the list above, and it leaves every
-- account that already has its own password untouched. (bcrypt keeps its salt
-- inside the hash, so re-hashing with the stored value as the salt reproduces
-- it exactly when, and only when, the password matches.)
-- ===========================================================================

do $rotate$
declare
  k_new_password constant text := 'asinta_architects2026';   -- <<< EDIT THIS
  k_old_password constant text := 'asinta2026';
  v_affected     int;
begin
  if k_new_password = 'CHANGE-ME-BEFORE-RUNNING' then
    raise exception
      '§1 ABORTED — nothing was changed. Edit supabase/apply/seed-cleanup.sql and set '
      'k_new_password (the line marked <<< EDIT THIS) to a new strong password, then re-run.';
  end if;

  if length(k_new_password) < 12 then
    raise exception
      '§1 ABORTED — nothing was changed. The replacement password is % character(s); use at '
      'least 12 (16+ recommended for a Founder on a financial system).', length(k_new_password);
  end if;

  if k_new_password = k_old_password then
    raise exception '§1 ABORTED — the replacement password is the published one.';
  end if;

  update auth.users
     set encrypted_password = crypt(k_new_password, gen_salt('bf')),
         updated_at = now()
   where encrypted_password = crypt(k_old_password, encrypted_password);

  get diagnostics v_affected = row_count;

  if v_affected = 0 then
    raise notice
      '§1 rotated 0 accounts — no account is using the published password any more. '
      'Either §1 already ran, or the seed was never applied. Confirm with preflight.sql.';
  else
    raise notice
      '§1 rotated % account(s). They will be asked for the new password at next sign-in '
      '— §2 makes that immediate.', v_affected;
  end if;
end $rotate$;


-- ===========================================================================
-- §2 — FORCE RE-AUTHENTICATION
-- ===========================================================================
-- Rotating a password does not end a session that was already minted: an
-- access token stays valid until it expires and a refresh token can mint a new
-- one. This deletes both, for every account, so the next request has to
-- present the new password.
--
-- Both GoTrue table layouts are handled — newer projects use `auth.sessions`,
-- older ones `auth.refresh_tokens`. A table that is not there is skipped, not
-- reported as an error. Nothing in public.* is touched.
-- ===========================================================================

do $reauth$
declare
  v_sessions int := 0;
  v_refresh  int := 0;
begin
  if to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions';
    get diagnostics v_sessions = row_count;
  else
    raise notice '§2 note: auth.sessions not found — skipped (older GoTrue layout).';
  end if;

  if to_regclass('auth.refresh_tokens') is not null then
    execute 'delete from auth.refresh_tokens';
    get diagnostics v_refresh = row_count;
  else
    raise notice '§2 note: auth.refresh_tokens not found — skipped (newer GoTrue layout).';
  end if;

  raise notice
    '§2 revoked % session row(s) and % refresh token row(s). Every browser and app session '
    'is now signed out, including yours — sign back in with the new password.',
    v_sessions, v_refresh;
end $reauth$;


-- ===========================================================================
-- §3 — DELETE THE DEMO ACCOUNTS AND DATA
-- ===========================================================================
-- DESTRUCTIVE, AND ARMED OFF BY DEFAULT. Nothing is deleted until you change
-- k_armed to true on the line marked <<< ARM THIS.
--
-- READ THIS BEFORE ARMING IT
-- --------------------------
-- · Two of the four accounts use the firm's REAL founder addresses
--   (junel@asinta.ph, rei@asinta.ph). If those are genuinely the founders'
--   logins and you want to keep them, STOP HERE: §1 already gave them a new
--   password and §2 has signed every session out. Do not run §3 — instead
--   delete just the two supervisor accounts by removing their UUIDs from
--   k_demo_users below.
-- · If you delete the founders, recreate them afterwards through the Auth
--   dashboard and link each one with a public.users row (role = 'founder').
--   That procedure is docs/MIGRATION_RUNBOOK.md §6.
-- · §3 deletes only rows whose UUIDs the seed inserted. Any real data added
--   since is left alone. It runs in one transaction: if a foreign key blocks a
--   delete — which would mean real data now points at a demo row — nothing is
--   deleted and you decide by hand.
-- · Receipts: the seed stored absolute unsplash.com URLs, not uploaded files,
--   so there are no storage objects to remove. The hardening migration clears
--   those URLs as part of its backfill.
-- ===========================================================================

do $cleanup$
declare
  k_demo_users constant text[] := array[
    '02f773a0-abec-4916-9858-e9e547782bc3',
    'b5117c39-e80b-cded-2c90-510de7ce7512',
    'a564529f-1d75-aeec-1b99-a2391b321b90',
    '494fdb42-abc2-1f62-2745-0f60da3bc00e'];
  k_clients    constant text[] := array[
    '4f253f4e-bfab-8f08-4e4d-c7a98995e3d8','781eaf58-2ac6-d504-bd47-a4b10cab1268',
    '78faed80-651d-d3bf-bcad-6bdb60527892','20b9452b-5231-087b-7bf1-ae41f6c79c24'];
  k_projects   constant text[] := array[
    'f337de46-faf2-4ed7-92f5-559417285970','c9e48d2c-962b-5088-0119-2177bcbee57b',
    '09d48e01-1e9f-aa8e-91e9-67ff7708cbf1','86e5045e-864d-62b9-b74b-b50b06d055f4'];
  k_workers    constant text[] := array[
    '9af0a8d4-e790-3cc9-a1eb-2799cc8ce733','02be5394-7982-5806-3601-a35947502655',
    '0ff9addd-72b4-3cdc-6c19-f47fb8611a6c','7deb1f59-518d-c0f4-ccaa-5192515d2a36',
    'b08602d2-0238-7012-f3cf-50a34e362566','e4c6cc24-c274-0c4f-7dd3-0dcd02ec3d3c',
    '4832550f-10f6-129d-0e4d-3c32ef76c6b8'];
  k_sup_assign constant text[] := array[
    '7496a174-f057-c39a-d28c-311ea4d4be0d','4e99f6cf-d18d-7dd3-2468-30f4b1972c5c',
    '58fbf9be-67e5-5bb3-eb47-59860e56bb38'];
  k_invoices   constant text[] := array[
    '04a12fe6-4231-77a6-7098-91c046fe8aed','4c414013-24e5-0db0-997e-0557392f5182',
    '9c400d0c-d69c-5eb7-e872-75e3f69566eb','4319af1c-5118-6c44-857b-5e6a996b43bf',
    'b6e738fc-7bea-23d9-21ef-7cb7cc053a1b','34a637fd-db0e-fa2f-8de4-bfe8315ce238'];
  k_expenses   constant text[] := array[
    '34a8d937-e2b0-6fc0-a55a-d580a82f8c40','3d75fe68-55fa-b52d-1b2a-e7c302ce4b9f',
    '0f6e0f9e-a7b3-dce1-10ec-9f7dc5cc59ae','bdfb4be8-d16d-9020-2e2e-909a6650348e',
    '393c2372-fa05-3247-dda2-204a68bb4ba4','fdba091b-c16c-0e42-7ccf-38096e0a48d1'];
  k_advances   constant text[] := array[
    '7afe77fb-256d-7286-d604-5e94fa762739','e245a752-b9a6-b23b-abe9-4523c67fc30f',
    'c70607cd-ade9-3f7d-1d38-88a648b1a63d'];
  k_attendance constant text[] := array[
    '0c856168-3afb-f375-6506-c6019c145375','0ca99d27-979b-64fa-aa4f-13478be7a96e',
    '0388376d-e3bd-ff67-0512-23f82e84e4a2','405bbb26-195d-cb00-4103-1f0eeea6b27f',
    '7e5155fa-ee61-6772-35ee-0fc5ea235c1e','5bcfdc6a-727d-8364-911b-b066d74ee8b7',
    'bbe67ab4-dc54-5bdb-8e57-5224c5d98707','06b07ec5-0dbc-4db3-108c-45ab2004c022',
    'd7e51360-3ee4-a4e9-4a2d-2a21b44ca2d0','d1784947-7535-1b56-1542-9584ea20cfc0'];
  k_payroll    constant text[] := array[
    '21791ef4-dd52-b1fa-98f2-a956bcbffe83','5ce4bbb4-c3bf-3af1-d268-6c6e1792fecd',
    'ec48593d-6940-78cb-609b-18169434def3','b373db2c-8200-ff5f-32d7-a59c30d5b49d',
    '5e1dc025-479f-98df-561d-3e1a84724505'];
  k_tools      constant text[] := array[
    '5c1ca1d3-839b-01f5-6a33-25d0ca3cfb50','00d2fbd6-dd4e-fed7-ada7-931f6b508f7a',
    '21c0f9fc-84d2-db29-ac36-4dc753629075','6fd88fab-ed33-eff7-477c-65c7a7c9ebbe',
    '4bf5b454-ea11-8018-647e-f73ab495c352','051877fd-1be6-6271-d647-791768b32ab1',
    '71c65bf8-9f0f-8376-a381-9108ee653836'];
  k_sms_logs   constant text[] := array[
    '4c83ef72-96fc-2b5a-df10-0309159e79c1','47bc38b0-d5e9-581f-f22a-015beb4b66b6'];
  v_total bigint := 0;
begin
  execute 'select
      (select count(*) from public.clients             where id::text = any($1))
    + (select count(*) from public.projects            where id::text = any($2))
    + (select count(*) from public.workers             where id::text = any($3))
    + (select count(*) from public.project_supervisors where id::text = any($4))
    + (select count(*) from public.invoices            where id::text = any($5))
    + (select count(*) from public.expenses            where id::text = any($6))
    + (select count(*) from public.advances            where id::text = any($7))
    + (select count(*) from public.attendance          where id::text = any($8))
    + (select count(*) from public.payroll             where id::text = any($9))
    + (select count(*) from public.tools               where id::text = any($10))
    + (select count(*) from public.sms_logs            where id::text = any($11))
    + (select count(*) from public.users               where id::text = any($12))
    + (select count(*) from auth.users                 where id::text = any($12))'
  into v_total
  using k_clients,k_projects,k_workers,k_sup_assign,k_invoices,k_expenses,
        k_advances,k_attendance,k_payroll,k_tools,k_sms_logs,k_demo_users;

  raise notice '§3 found % row(s) to delete.', v_total;

  if to_regclass('public.reminder_dispatches') is not null then
    execute 'delete from public.reminder_dispatches where invoice_id::text = any($1)' using k_invoices;
  end if;
  if to_regclass('public.email_logs') is not null then
    execute 'delete from public.email_logs where invoice_id::text = any($1)' using k_invoices;
  end if;

  execute 'delete from public.sms_logs            where id::text = any($1)' using k_sms_logs;
  execute 'delete from public.payroll             where id::text = any($1)' using k_payroll;
  execute 'delete from public.attendance          where id::text = any($1)' using k_attendance;
  execute 'delete from public.advances            where id::text = any($1)' using k_advances;
  execute 'delete from public.expenses            where id::text = any($1)' using k_expenses;
  execute 'delete from public.invoices            where id::text = any($1)' using k_invoices;
  execute 'delete from public.project_supervisors where id::text = any($1)' using k_sup_assign;
  execute 'delete from public.tools               where id::text = any($1)' using k_tools;
  execute 'delete from public.projects            where id::text = any($1)' using k_projects;
  execute 'delete from public.workers             where id::text = any($1)' using k_workers;
  execute 'delete from public.clients             where id::text = any($1)' using k_clients;
  execute 'delete from public.users               where id::text = any($1)' using k_demo_users;

  if to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where user_id::text = any($1)' using k_demo_users;
  end if;
  if to_regclass('auth.refresh_tokens') is not null then
    execute 'delete from auth.refresh_tokens where user_id::text = any($1)' using k_demo_users;
  end if;
  if to_regclass('auth.mfa_factors') is not null then
    execute 'delete from auth.mfa_factors where user_id::text = any($1)' using k_demo_users;
  end if;
  if to_regclass('auth.identities') is not null then
    execute 'delete from auth.identities where user_id::text = any($1)' using k_demo_users;
  end if;
  execute 'delete from auth.users where id::text = any($1)' using k_demo_users;

  raise notice '§3 DELETED % row(s): 4 demo accounts, their profiles, and all fictional data.', v_total;
end $cleanup$;


-- ===========================================================================
-- AFTERWARDS
-- ===========================================================================
-- · Re-run supabase/apply/preflight.sql — "DEMO SEED: exposure" must read
--   "none" (or "none found" once every section has run).
-- · If §3 removed a Founder, recreate that account: Auth dashboard → Add user
--   with Auto Confirm, then link a public.users row with role = 'founder'.
--   docs/MIGRATION_RUNBOOK.md §6.
-- · Turn on MFA for both founders once they can sign in: docs/SECURITY.md §5.
-- ===========================================================================
