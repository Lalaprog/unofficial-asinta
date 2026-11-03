# Applying the BALE migrations to a live Supabase project

> **Team accounts:** the current bundles also include the Founder guard. Follow [TEAM_ACCOUNT_OPERATIONS.md](TEAM_ACCOUNT_OPERATIONS.md) for maintenance, deployment order, staging and recovery.

> **Payroll/Bale deployment:** the current bundles include a breaking financial-write migration. Follow [ATOMIC_PAYROLL_ROLLOUT.md](ATOMIC_PAYROLL_ROLLOUT.md) for staging, maintenance, reconciliation and recovery before applying them. A committed migration is not undone by the bundle transaction.

Written for project `mchkdkjntnbwrgmyobpd`. Everything here is read-only until
step 4, and step 4 is reversible via the transaction the bundle runs inside.

> **Why this document exists.** The normal path (`supabase db push`) needs the
> database password and a machine that can reach `*.supabase.co`. The agent
> sandbox this was prepared in **cannot** reach Supabase (its egress allowlist
> covers only npm and GitHub), so the migration could not be applied from here.
> Path A below needs nothing but dashboard access to your project.

---

## 0. If you are picking this up cold: verify the fixes are present

The migration SQL in `supabase/migrations` has twice been corrected after a
sandbox reset silently reverted it, and once after a version reached a live
project still broken. **Verify by file content, not by commit id** — a commit
may not exist while the corrected files do, or the other way round.

Five checks. All five must pass. Run them from the repository root.

```bash
[ -d node_modules ] || npm ci      # node_modules is never in the sandbox snapshot
```

**1. Every `create policy` in the base schema and the communications migration
names its role.**

```bash
grep -c "TO authenticated" supabase/migrations/20260913000000_bale_schema.sql    # expect 20
grep -c "TO authenticated" supabase/migrations/20260929000000_communications.sql # expect 3
```

**2. No statement in the hardening migration lost its semicolon.**

```bash
python3 - <<'EOF'
import re, pathlib
t = pathlib.Path('supabase/migrations/20261006000000_security_hardening.sql').read_text()
body = t[t.index('-- 3. Scope every existing policy'):t.index('-- 4. Function hardening')]
chunks = [c.strip() for c in body.split(';') if c.strip()]
merged = [c for c in chunks if len(re.findall(r'\b(?:create|drop)\s+policy\b', c, re.I)) > 1]
print(f"merged statements (must be 0): {len(merged)}")
print(f"create: {len(re.findall('create policy', body, re.I))}  drop: {len(re.findall('drop policy if exists', body, re.I))}")
EOF
```

Expect `merged statements (must be 0): 0`, `create: 23`, `drop: 23`.

**3. These files exist.**

```bash
ls supabase/apply/{preflight,seed-cleanup,upgrade-hardening,verify-live}.sql \
   tests/migrations-parse.test.ts docs/GO_LIVE_CHECKLIST.md
```

**4. The two MIGRATION bundles are seed-free.** (`preflight.sql` and
`seed-cleanup.sql` mention the demo password deliberately — they exist to
detect and rotate it. Only `fresh-install.sql` and `upgrade-hardening.sql` must
never contain seed content.)

```bash
grep -l asinta2026 supabase/apply/fresh-install.sql supabase/apply/upgrade-hardening.sql \
  && echo "LEAKED — regenerate with npm run build:apply-sql" \
  || echo "clean"
```

**5. The parse test and the full suite pass.**

```bash
npm run build:apply-sql
./node_modules/.bin/tsc --noEmit && npm run lint && npm test && npm run build
```

Use `./node_modules/.bin/tsc`, never `npx tsc` — the latter can resolve an
unrelated `tsc` package from the registry.

Expected: **22 test files, 278 tests, all passing** (plus a clean typecheck and lint).

### Re-applying the corrections

If any check fails, re-apply the correction. Both are mechanical.

**Missing semicolons** — in `20261006000000_security_hardening.sql` §3, every
`create policy` block ends with `using (…)` or `with check (…)` followed by a
newline and the next `drop policy` line. Add `;` to the end of each
`using (…)` / `with check (…)` line.

Without it, PostgreSQL reads the `drop` as part of the `create` and reports
**`syntax error at or near "drop"`**. The SQL editor runs a script as one
implicit transaction, so that one error rolls back the whole file. The
follow-up error **`relation "public.audit_log" does not exist`** is a *symptom*
of that rollback, not a separate bug — fix the semicolons and both go away.

**Unscoped policies** — in `20260913000000_bale_schema.sql` and
`20260929000000_communications.sql`, insert ` TO authenticated` immediately
before every `USING` / `WITH CHECK` that follows a
`FOR ALL|SELECT|INSERT|UPDATE|DELETE` clause. A policy with no `TO` clause
defaults to PUBLIC, which includes `anon`.

**Then prove the tests are not no-ops.** Reintroduce a defect into a copy of a
migration — drop a semicolon, or strip a policy's role — and confirm the
relevant test goes red. A guard that passes on broken input is worse than no
guard, which is exactly how both defects reached a live project.

### Who catches what

| Defect | `rls-migration.test.ts` (text) | `migrations-parse.test.ts` (parser) |
| --- | --- | --- |
| missing semicolon | **no** — `split(';')` reads the merged chunk as one statement | **yes** — the grammar rejects the file |
| policy with no `TO` clause | unreliable — matches `to authenticated` on a neighbouring statement | **yes** — reads the grantee from the parse tree |

---

## 1. Pre-flight — what has already been applied?

**Use `supabase/apply/preflight.sql`** — it is read-only, returns one row per
item, and also reports the two ordering dependencies and the next step for your
specific project. The query below is the short form it grew out of; keep it
only if you want the single-row version.

Paste into **Supabase → SQL Editor** and run:

```sql
select
  to_regclass('public.expenses')  is not null as base_schema_applied,
  to_regclass('public.audit_log') is not null as hardening_applied,
  to_regclass('public.vendor_memory') is not null as ai_draft_applied,
  to_regclass('public.advance_requests') is not null as bale_requests_applied,
  to_regclass('public.user_notifications') is not null as bale_notifications_applied,
  exists (
    select 1 from pg_trigger
    where tgname = 'notify_advance_request_event'
      and tgrelid = to_regclass('public.advance_requests')
      and not tgisinternal
  ) as bale_notification_trigger_applied,
  to_regprocedure('public.approve_advance_requests(uuid[])') is not null as batch_approval_rpc_applied,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'expenses' and column_name = 'vendor'
  ) as expenses_vendor_column,
  (select public from storage.buckets where id = 'receipts') as receipts_bucket_public,
  case
    when to_regclass('public.expenses') is null
      then 'apply supabase/apply/fresh-install.sql'
    when to_regclass('public.audit_log') is null
      or to_regclass('public.vendor_memory') is null
      or to_regclass('public.advance_requests') is null
      or to_regclass('public.user_notifications') is null
      or not exists (
        select 1 from pg_trigger
        where tgname = 'notify_advance_request_event'
          and tgrelid = to_regclass('public.advance_requests')
          and not tgisinternal
      )
      or to_regprocedure('public.approve_advance_requests(uuid[])') is null
      or not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='expenses' and column_name='vendor')
      then 'apply supabase/apply/upgrade-hardening.sql'
    else 'already migrated — just run supabase/apply/verify-live.sql'
  end as next_step;
```

`preflight.sql` additionally reports **two ordering dependencies** that the
query above cannot see, and which are the difference between a bundle that
applies and one that silently rolls back:

1. **`20260929000000_communications.sql` must run BEFORE
   `upgrade-hardening.sql`.** The hardening migration re-scopes policies on
   `email_templates`, `email_logs` and `reminder_dispatches` — three tables
   only that migration creates. Miss it and the bundle dies on
   `relation "public.email_templates" does not exist`, and the transaction
   takes the whole bundle with it.
2. **The two bundles are mutually exclusive.** `fresh-install.sql` is for an
   empty project and is *not* idempotent; `upgrade-hardening.sql` *requires*
   the base schema to already be there. Never run both.

Result interpretation:

- `base_schema_applied = false` → project is empty → **fresh-install.sql**
- base applied, any hardening / AI / Bale-request / notification-RPC check false → **upgrade-hardening.sql**
- everything true → nothing to apply; go to step 5.

⚠️ **`fresh-install.sql` is not idempotent.** The base schema creates policies
with plain `CREATE POLICY`, so a second run fails on `policy already exists`.
If the project is half-migrated, stop and restore a backup rather than forcing
statements through.

---

## 2. Before you run it

- **Take a backup.** Supabase Pro: Database → Backups → confirm PITR is on and
  note the timestamp. Without PITR, `pg_dump` the database first. This is also
  the restore test `docs/SECURITY.md` §10 is still waiting for.
- **Prefer staging.** If you have Supabase branching or a throwaway project,
  run it there first — it is the same SQL and costs nothing.
- **Never apply `20260913000002_bale_seed.sql`.** It is not in either bundle. It
  creates real auth accounts with the published password `asinta2026`. Demo data
  is for `supabase start` on a laptop only.
- Path C (§8) applies the same bundle through GitHub Actions if you would
  rather not paste SQL.
- The bundles are **generated** from `supabase/migrations` and record each
  source file's SHA-256 in their header. Regenerate after any migration change:

```bash
npm run build:apply-sql
```

---

## 3. Path A — SQL editor (no CLI, no password)

1. Open `supabase/apply/fresh-install.sql` or `upgrade-hardening.sql`.
2. Copy the **entire** file.
3. Supabase → **SQL Editor** → New query → paste → **Run**.
4. The bundle is wrapped in `begin; … commit;`. If any statement fails, nothing
   is committed — read the error and stop. (If the editor reports *"there is
   already a transaction in progress"*, that is its own wrapper; the script
   still commits as a whole. Harmless.)
5. Expect `Success. No rows returned` — this is DDL, not a query.

The `upgrade-hardening.sql` bundle includes the security and AI hardening, the Bale request workflow, durable request notifications, batch approval, atomic payroll and Founder protection:

| Section | Effect |
| --- | --- |
| `20261006000000` §1 | `receipts` bucket `public → false` |
| `20261006000000` §2 | rewrites `expenses.receipt_url`: public/signed URL → storage path; clears URLs it cannot resolve |
| `20261006000000` §3 | creates `audit_log`; **drops and re-creates all 23 existing policies** with `TO authenticated` |
| `20261006000000` §4 | pins `search_path` on `current_user_role`, `is_founder`, `is_supervisor_assigned` |
| `20261006000001` | `expenses.vendor`, two indexes, `vendor_memory`, `record_vendor_outcome()`, drops the dead `ai_approval_suggestion` column |
| `20261013000000` | Supervisor-submitted `advance_requests` with RLS, audit logging, Founder-only approval/rejection, and atomic payment-to-issued-advance RPC |
| `20261013000001` | Recipient-only persistent request notifications, submission/status triggers, and Founder-only same-site batch approval (approval remains separate from payment) |
| `20261102000000` | Atomic payroll and advance deduction protections; follow the payroll rollout guide |
| `20261102000001` | Last-Founder guard and atomic profile cleanup RPCs; follow the team account operations guide |

§3 changes the *grantee* of every existing policy from `PUBLIC` (which includes
`anon`) to `authenticated`. Signed-in behaviour is unchanged — the `USING`
predicates already required a real user — but unauthenticated requests now get
nothing instead of being evaluated against a role predicate that was never
meant to include them.

---

## 4. Path B — Supabase CLI

Needs the database password (Project Settings → Database → Connection string)
and a network that can reach Supabase:

```bash
supabase link --project-ref mchkdkjntnbwrgmyobpd
supabase db push          # applies supabase/migrations/*.sql in filename order
```

Note that `db push` runs **all** migrations, including the seed if it is
unapplied. Delete or rename the seed file before pushing to a production
project, or apply the bundles by hand (Path A).

---

## 5. Verify — do not skip this

Run `supabase/apply/verify-live.sql` in the SQL editor. It is read-only and
returns one row per check; **every row must say PASS**:

| Check | Fails when |
| --- | --- |
| base tables present | a table is missing → wrong bundle |
| RLS enabled on every public table | a table has RLS off |
| no policy reachable by anon | a policy still resolves to anon/PUBLIC |
| no permissive `USING (true)` | a policy admits every row |
| audit_log cannot be rewritten | an UPDATE/DELETE policy exists on `audit_log` |
| RLS helpers pin `search_path` | `security definer` helper is shadowable |
| receipts bucket is private | bucket is still public |
| receipt_url holds storage paths | rows still hold `http(s)://` values |
| Founder profile protection installed | inspect guard objects, trigger state and RPC grants; test on staging |
| at least one Founder profile | nobody can sign in as Founder yet (step 6) |
| no orphaned profiles | a `public.users` row has no matching `auth.users` row |

Then do the human checks that SQL cannot make:

1. **Open a receipt** on the Expenses page. It must render. If it says no stored
   photo, the backfill could not resolve that URL — re-attach the photo. This is
   the expected outcome for the absolute URLs §2 deliberately clears.
2. **Upload a new receipt**, reload, reopen it — validates path storage + signed
   URL minting end to end.
3. **Record an expense**, then in the SQL editor:
   `select * from audit_log order by created_at desc limit 3;` — an `insert`
   row for `expenses` should be there with your user id.

---

## 6. First Founder account (no seed)

1. Supabase → **Authentication → Users → Add user** → email + a strong password
   → *Auto Confirm User*.
2. Copy the new user's UUID.
3. SQL editor — link it to the app's role table:

```sql
insert into public.users (id, name, email, role)
values ('<paste-uuid>', 'Junel', 'junel@asinta.ph', 'founder');
```

Both rows are required: `auth.users` authenticates, `public.users` decides the
role, and `requireFounder()` refuses an account with no matching profile row.

Other staff are added the same way with `role = 'supervisor'`, plus a
`project_supervisors` row per assigned project.

---

## 7. Dashboard settings that live outside the code

These are **not** in the migration bundles and will silently disagree with the
app if skipped:

| Where | Setting | Value | Why |
| --- | --- | --- | --- |
| Authentication → Sessions | Inactivity timeout | `20` minutes | Mirrors `supabase/config.toml`; applies project-wide to **all roles** (`founder` and `supervisor`) |
| Authentication → Sessions | Time-box | `8` hours | Absolute cap; the app's warning dialog counts down to these |
| Vercel → Environment Variables | `NEXT_PUBLIC_SESSION_*` (`20`, `8`, `120`) | **Rebuild** | `NEXT_PUBLIC_*` is inlined at build time; redeploying without rebuilding keeps old values |
| Authentication → Rate Limits | `sign_in_sign_ups` | `30 → 10` per 5 min per IP | Per-IP only (no account lockout). `/api/auth/login` also enforces 10/5m per IP in the app (docs/SECURITY.md §7) |
| Authentication → Attack Protection | CAPTCHA | hCaptcha / Turnstile | Defends sign-in against distributed IPs |
| GitHub Actions | `.github/workflows/backup.yml` | Weekly `pg_dump` + restore test | Supabase Free has no PITR; receipt photos in Storage still need a separate copy (docs/SECURITY.md §10) |

`supabase/config.toml` only configures the local stack; the managed project is
configured in the dashboard. When you change one, change the other.

---

## 8. Path C — GitHub Actions (no local setup)

`.github/workflows/apply-migrations.yml` is already in the repository. It is
**manual only** (`workflow_dispatch`) — nothing migrates a database on a push.

1. Settings → Secrets and variables → Actions → New repository secret:
   `SUPABASE_DB_URL` = the **pooled** connection string from Project Settings →
   Database → Connection string → URI, with the password filled in.
2. Actions → **Apply database migrations** → Run workflow:
   - `bundle`: `upgrade-hardening` (or `fresh-install`)
   - `confirm_project_ref`: type `mchkdkjntnbwrgmyobpd`
   - `dry_run`: leave **checked** the first time
3. Read the pre-flight output, then re-run with `dry_run` unchecked.

It applies `supabase/apply/<bundle>.sql` through `psql` with `ON_ERROR_STOP`,
**not** `supabase db push`. That is deliberate: `db push` would run every file in
`supabase/migrations`, including the seed with its published password. The
workflow also refuses to start if the bundle contains the seed password or if
`SUPABASE_DB_URL` does not mention this project ref.

The secret is a database password — rotate it in the dashboard if it is ever
exposed, and note that GitHub masks it in logs but it is visible to anyone with
repository admin rights.

---

## 9. What is still unverified after this

- The application has never run against this project: the sandbox cannot reach
  `*.supabase.co`. Every claim about runtime behaviour here is from tests and
  the local build, not from a live session.
- MFA enrolment, session expiry and the warning dialog need a real signed-in
  browser session.
- Backups/PITR: fill in the table in `docs/SECURITY.md` §10 after the restore
  test.

---

## SMS history rollout

See [SMS_HISTORY_ROLLOUT.md](SMS_HISTORY_ROLLOUT.md) before applying the
individual SMS history migration. Do not blindly apply the complete upgrade
bundle or run `supabase db push` against an existing project: hosted migration
versions may differ, and other migrations require independent review.

---

## Payroll attendance matrix rollout

See [PAYROLL_ATTENDANCE_MATRIX_ROLLOUT.md](PAYROLL_ATTENDANCE_MATRIX_ROLLOUT.md).
Apply only the individual read-only matrix migration before the UI; never
blindly run the full upgrade bundle or `supabase db push` on an existing project.
