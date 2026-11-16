# Go-live checklist

> **STOP — historical checklist, not a current release procedure.** SQL bundles are stale, production was temporarily recovered after a mismatched deployment, and no verified recovery backup exists. The GitHub repository is public; do not configure or run the old export workflow with real data. Follow `CLIENT_CHANGE_PLAN.md` and `SECURITY.md` for current limitations.

Short, ordered, and written to be worked through in the Supabase dashboard.
Every SQL file it names lives in `supabase/apply/` unless it says otherwise.

Background and rationale: [`MIGRATION_RUNBOOK.md`](./MIGRATION_RUNBOOK.md).
Security background: [`SECURITY.md`](./SECURITY.md).

**Read this first:** the agent sandbox this repository was prepared in cannot
reach `*.supabase.co` (its egress allowlist covers only npm and GitHub — this
was probed directly, not assumed). Nothing below has been run against your
project. Every SQL file here is parse-checked and test-covered, but "the SQL is
valid" and "your project is fixed" are two different claims, and only you can
make the second one.

---

## Step 0 — URGENT, do this before anything else

The demo seed (`supabase/migrations/20260913000002_bale_seed.sql`) was applied
to the live project. It created four auth accounts — `junel@asinta.ph`,
`rei@asinta.ph`, `marco.santos@asinta.ph`, `carlos.reyes@asinta.ph` — all with
the password `asinta2026`, which is **published in this repository**. Two of
those are the firm's real founder addresses.

Anyone who reads this repo can sign in to the firm's books right now.

**Run `supabase/apply/seed-cleanup.sql`.** It has three sections:

| Section | What it does | Blocks the leak on its own? |
| --- | --- | --- |
| §1 ROTATE | Sets a new password on every account still using the published one | **Yes** |
| §2 FORCE RE-AUTH | Revokes every session and refresh token, so an old token cannot outlive the rotation | completes §1 |
| §3 DELETE | Removes the 4 accounts, their profiles and the 57 fictional rows | cleans up |

- **§1 needs one edit before it will run**: set `k_new_password` (the line
  marked `<<< EDIT THIS`). It refuses to run with the placeholder, with a
  password under 12 characters, or with the published password.
- **§1 and §2 are safe to run immediately.** Do that now. They close the
  exposure on their own.
- **§3 is destructive and armed off by default** (`k_armed := false`). It also
  cannot be undone. Two of the accounts use real founder addresses — if those
  are genuinely the founders' logins, stop after §2. Otherwise read the notes
  above §3, arm it, and run it.
- Afterwards: re-run `preflight.sql`. `DEMO SEED: exposure` must read `none`.

If §3 removed a Founder, recreate that account afterwards — Auth dashboard →
Add user (Auto Confirm), then link a `public.users` row with `role = 'founder'`
([`MIGRATION_RUNBOOK.md` §6](./MIGRATION_RUNBOOK.md)). Until then, the
`at least one Founder profile` row in `verify-live.sql` will read FAIL, which
is correct and expected.

---

## Step 1 — Pre-flight (read-only, run this first)

Paste **`preflight.sql`** into the SQL editor and Run. It changes nothing: it
creates one temporary table in your session and drops it at the end.

It reports:

- what is already applied — base schema, communications, hardening, AI-draft, Bale requests
- the **next step** for your project, in one line
- the **two ordering dependencies**, and whether each is satisfied
- whether the demo seed is live, and how many rows of it are there

Keep the output. It is what you compare against at the end.

---

## Step 2 — Communications, if the pre-flight says it is missing

If `communications applied` reads `false`, apply
**`supabase/migrations/20260929000000_communications.sql` FIRST**.

> **Why this is not optional.** The hardening migration re-scopes policies on
> `email_templates`, `email_logs` and `reminder_dispatches` — three tables that
> only this migration creates. Apply the hardening bundle first and it dies on
> `relation "public.email_templates" does not exist`. Because the bundle runs
> as **one transaction**, that aborts the whole thing and nothing is applied —
> no `audit_log`, no private bucket, no policy re-scope. That silence is what
> produced a second, misleading error last time.

---

## Step 3 — Apply the hardening bundle

Apply **`upgrade-hardening.sql`**. It is wrapped in `begin; … commit;` and
includes the security/AI hardening, Founder-reviewed Bale request workflow, durable notifications, and site-scoped batch approval:

| Section | Effect |
| --- | --- |
| `20261006000000` §1 | `receipts` bucket `public → false` |
| `20261006000000` §2 | rewrites `expenses.receipt_url` (public/signed URL → storage path), clears unresolvable absolute URLs |
| `20261006000000` §3 | creates append-only `audit_log`; re-scopes all 23 existing policies `TO authenticated` |
| `20261006000000` §4 | pins `search_path` on `current_user_role`, `is_founder`, `is_supervisor_assigned` |
| `20261006000001` | `expenses.vendor`, two indexes, `vendor_memory`, `record_vendor_outcome()`, drops the dead `ai_approval_suggestion` column |
| `20261013000000` | Supervisor Bale requests, RLS + audit trail, Founder approve/reject, and atomic payment-to-issued-advance RPC |
| `20261013000001` | Recipient-only persistent request notifications, status-event triggers, and Founder-only same-site batch approval (approval does not issue payment) |

Expect `Success. No rows returned` — this is DDL, not a query.

**Do not run `fresh-install.sql`.** It is for an empty project only and is not
idempotent. The two bundles are mutually exclusive.

**Take a backup first.** Supabase Pro: Database → Backups → confirm PITR is on
and note the timestamp. Without PITR, `pg_dump` first. This is also the restore
test `SECURITY.md` §10 is still waiting for.

---

## Step 4 — Verify

Run **`verify-live.sql`** (read-only). **Every row must say `PASS`.** It checks
19 tables exist, including durable request notifications; RLS is on everywhere, no policy is reachable by `anon`,
no `USING (true)`, `audit_log` cannot be rewritten, the helpers pin
`search_path`, the receipts bucket is private, no `receipt_url` still holds an
`http(s)://` value, and there is at least one Founder profile.

A FAIL row names the problem and the migration that fixes it.

---

## Step 5 — Human checks SQL cannot make

1. **Open a receipt** on the Expenses page. It must render. If it says no
   stored photo, the backfill could not resolve that URL — re-attach the photo.
   That is the expected outcome for absolute URLs §2 deliberately clears.
2. **Upload a new receipt**, reload, reopen it — proves path storage + signed
   URL minting end to end.
3. **Record an expense**, then in the SQL editor:
   `select * from audit_log order by created_at desc limit 3;` — an `insert`
   row for `expenses` should be there with your user id.

---

## Step 6 — Dashboard & Vercel settings (not in any migration)

These live outside the code and will silently disagree with the app if skipped.

| Where | Setting | Value | Why |
| --- | --- | --- | --- |
| Supabase → Authentication → Sessions | Inactivity timeout | `20` minutes | Project-wide across **all roles** (`founder` and `supervisor`) |
| Supabase → Authentication → Sessions | Time-box | `8` hours | Absolute session cap; matches `SessionWatcher` |
| Vercel → Environment Variables | `NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MINUTES=20`<br>`NEXT_PUBLIC_SESSION_ABSOLUTE_TIMEOUT_HOURS=8`<br>`NEXT_PUBLIC_SESSION_WARNING_SECONDS=120` | **Rebuild** after setting | `NEXT_PUBLIC_*` is baked in at build time — redeploying an old build artifact is not enough. Verify by leaving a tab idle and confirming the warning dialog appears at ~18 min |
| Supabase → Authentication → Rate Limits | `sign_in_sign_ups` | `30 → 10` per 5 min per IP | No account lockout (DoS vector against the firm). `/api/auth/login` also enforces 10/5m per IP via `lib/rateLimit.ts` (mitigating Supabase issue #41947) |
| Supabase → Authentication → Attack Protection | CAPTCHA on sign-in | hCaptcha or Cloudflare Turnstile | Stops distributed credential stuffing across multiple IPs |
| Recovery | Current export workflow | **Do not run with real data** | This public repository could expose unencrypted financial and personal data. Establish a secure, verified recovery plan, including Auth and Storage, before deployment ([`SECURITY.md` §10](./SECURITY.md)). |

---

## Step 7 — Accounts and MFA

1. Create each Founder through **Authentication → Users → Add user** with a
   strong password and *Auto Confirm User*, then link a `public.users` row with
   `role = 'founder'` (§6 of the runbook). Both rows are required:
   `auth.users` authenticates, `public.users` decides the role, and
   `requireFounder()` refuses an account with no matching profile row.
2. **Turn on MFA for both founders.** Deploy with `MFA_ENFORCE_FOUNDERS=false`
   → both enrol at `/mfa` → flip to `true` → confirm a Founder without a code
   is redirected ([`SECURITY.md` §5](./SECURITY.md)).

---

## What changed in this pass, and why

Two real defects, both now fixed in `supabase/migrations` and regenerated into
the bundles:

**1. 22 `create policy` statements had no trailing semicolon.**
In `20261006000000_security_hardening.sql` §3, every `create policy` block ended
with `using (…)` / `with check (…)` and then a newline followed by the next
`drop policy` line. Without the semicolon, PostgreSQL reads the `drop` as part
of the `create` and rejects it: **`syntax error at or near "drop"`**. Because
the SQL editor runs a script as one implicit transaction, that single error
rolled back the entire file — nothing in it applied.

The follow-up error, **`relation "public.audit_log" does not exist`**, was a
**symptom** of that rollback, not a second bug. Fixing the semicolons fixes
both.

**2. 23 policies had no `TO` clause.**
In `20260913000000_bale_schema.sql` (20) and
`20260929000000_communications.sql` (3), no policy named a grantee. PostgreSQL
resolves a missing `TO` to `PUBLIC`, which includes `anon`. Their `USING`
predicates already required a real user, so anon could not read anything — this
was a latent defect, not an active leak. It is fixed anyway, because the next
policy written in the same shape might not be so lucky.

**Why the existing tests did not catch either.** `tests/rls-migration.test.ts`
reads the migrations as text — regexes and `split(';')`. The
`/\bto\s+authenticated\b/` check matched, but inside a chunk that only *looked*
like one statement: the `create policy` had swallowed the next `drop policy`
into itself. A text-level check cannot see a statement boundary it got wrong.

**What catches them now.** `tests/migrations-parse.test.ts` hands every
migration and every generated bundle to `libpg-query` — the real PostgreSQL
grammar, compiled to WASM. If `psql` would reject the file, the test rejects
the file. It reads policy grantees from the parse tree rather than from a
regex, so an unscoped policy shows up as `ROLESPEC_PUBLIC` instead of matching
a neighbouring line.

Current suite: **22 test files, 278 tests, all passing** (typecheck, lint and
`next build` too). Both defects were re-introduced into a scratch copy during
development and each one turned the relevant test red, so these are not no-op
assertions.

---

## Still unverified — says so rather than guessing

- **Nothing here has run against a live project.** The sandbox cannot reach
  Supabase. The SQL is parse-checked and unit-tested; it is not
  integration-tested.
- **`preflight.sql` and `seed-cleanup.sql` have never executed.** No PostgreSQL
  is available in the sandbox, so their PL/pgSQL was compiled and their SQL
  parsed, but no statement has actually run. Table-name guards
  (`to_regclass(...) is not null`) cover the schema differences I know about;
  they cannot cover one I don't.
- **MFA enrolment, session expiry and the warning dialog** need a real
  signed-in browser session.
- **Backups/PITR**: fill in the table in [`SECURITY.md` §10](./SECURITY.md)
  after the restore test. It is currently marked not performed.
- **The `receipts` bucket backfill assumes your stored URLs match the
  `<ref>.supabase.co/storage/v1/object/...` shape.** If yours differ, §2 clears
  those values and the photos must be re-attached by hand.
