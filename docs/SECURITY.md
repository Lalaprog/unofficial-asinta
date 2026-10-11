# BALE — Security Notes, Decisions & Runbooks

Written for the Asinta Architects founders and whoever maintains this system
next. Every claim here is either **verified in this repository** or explicitly
marked **assumed / needs action**. Nothing in this document is aspirational
without a label.

Last updated: 2026-10-06.

---

## 1. What is enforced where

| Layer | Mechanism | Notes |
| --- | --- | --- |
| Route access | `middleware.ts` + `requireFounder()` in every Founder `/api/*` route | Server-side. A page redirect is not a control; the API check is. |
| Data access | PostgreSQL RLS on every table, `to authenticated` policies | Verified by `tests/rls-migration.test.ts` and `tests/migrations-parse.test.ts`. |
| Session lifetime | Supabase Auth `auth.sessions.inactivity_timeout` (`20m`) / `timebox` (`8h`) + `SessionWatcher` | Project-wide across **all roles** (`founder` and `supervisor`). `NEXT_PUBLIC_SESSION_*` is baked in at build time (rebuild required when changed). |
| MFA | Supabase TOTP, opt-in enforcement (`MFA_ENFORCE_FOUNDERS`) | See §5. |
| Sign-in & cost abuse | `lib/rateLimit.ts` per-route limits (including `/api/auth/login` and `/api/export`) | Single-instance; per-IP on login (no account lockout), per-Founder on authenticated routes — see §7. |
| Trail | `public.audit_log` (append-only) | Covers money-moving mutations AND Founder CSV exports (RA 10173). No UPDATE/DELETE policy exists. |

**Not** a control: anything rendered in the browser. The UI states what the
server decided; it never decides.

---

## 2. Next.js advisories and the image optimizer (finding #1)

`next@14.2.35` carries 13 published advisories (1 critical, 10 high,
2 moderate). The critical one is **GHSA-2xp9-vwfh-vxw4** (CVSS 9.5):
unauthenticated RCE through the Image Optimization API decoding a crafted AVIF
payload via libheif/sharp. Patched in 15.5.24 / 16.3.3; **there is no patched
14.x release** — the 14.x line is end-of-life for security patches.

Mitigations applied now:

- `images.unoptimized: true` in `next.config.js`. The optimizer is disabled, so
  the AVIF decode path is unreachable.
- `images.remotePatterns` restricted to Supabase Storage and localhost. It was
  `hostname: '**'`, which allowed the optimizer to fetch any host.
- `sharp` is **not** in the dependency tree, and no component uses `next/image`
  (verified: zero `next/image` imports, zero `sharp` entries in
  `package-lock.json`). Nothing in the product depends on the optimizer.
- If `sharp` is ever added, require `>=0.35.4`.

**This is a mitigation, not a fix.** The remaining work is the upgrade to 16.x
(React 19, breaking) as its own PR with a full test pass — tracked in
`ROADMAP.md`. **Do not** run `npm audit fix --force`; it will propose the major
upgrade without any of the testing.

The same 14.x line also carries middleware/proxy redirect cache-poisoning and
rewrites-SSRF advisories. The app leans on middleware for auth, so those raise
the urgency of the upgrade.

---

## 3. Receipts are private (finding #2)

- The `receipts` Storage bucket was created `public = true`. Storage *policies*
  restricted upload and list to Founders, but a public bucket bypasses auth on
  **read**: anyone with the URL could fetch a receipt photo (supplier names,
  amounts, TINs, sometimes signatures or card fragments).
- Migration `20261006000000_security_hardening.sql` sets `public = false` and
  rewrites existing `expenses.receipt_url` values from public/signed URLs into
  bare **storage paths** (query strings stripped before the prefix, because a
  signed URL's token must never travel with the path). Absolute URLs that cannot
  be resolved to a path are cleared rather than left as broken links that claim a
  photo exists.
- The app mints a **5-minute signed URL** on demand (`createReceiptSignedUrl`).
  Signing requires the bucket's SELECT policy, which is Founder-only, so the
  short TTL is a second layer rather than the only one.
- Consequence for **Track B**: the vision model receives the image as a
  **base64 data URI**, never a URL, so making the bucket private did not push us
  into handing a signed URL to a third party.

**Needs action:** after applying the migration, open one old receipt from the
Expenses list. If it shows "no stored receipt photo", the row's URL could not be
resolved and the photo must be re-attached.

---

## 4. Security headers and clickjacking (finding #3)

`next.config.js` sends on every response:

- `Content-Security-Policy` — `default-src 'self'`, `object-src 'none'`,
  `base-uri 'self'`, `form-action 'self'`, `img-src 'self' data: blob:` plus the
  Supabase origin, `connect-src 'self'` plus Supabase (`https`/`wss`).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` (camera denied — receipt capture uses `<input capture>`;
  microphone allowed for voice notes), `X-DNS-Prefetch-Control: off`.
- Production only: `X-Frame-Options: DENY`, `frame-ancestors 'none'`, and HSTS
  (`max-age=63072000; includeSubDomains; preload`).

**Why `script-src` still contains `'unsafe-inline':`** the App Router streams
inline bootstrap/flight scripts and BALE has no nonce pipeline. Removing it
requires threading a per-request nonce through middleware. That is real work,
tracked in `ROADMAP.md`, and not faked here.

**Why development allows framing:** the sandbox preview embeds the dev server in
an iframe on a `*.e2b.app` origin; `frame-ancestors 'none'` would black-screen
it. Development allows that wildcard; the strict production policy is what ships.
Verify after deploying by loading the app in an iframe from another origin — it
must refuse to render.

---

## 5. Founder MFA (finding #5)

- TOTP is implemented with Supabase Auth (`supabase.auth.mfa.*`). The password
  sign-in flow leaves the session at `aal1`; when the account has a verified
  factor, BALE asks for the 6-digit code **before** any workspace opens.
- Enrolment lives in **Settings → Two-Factor Authentication**, with the QR code
  and a manual key fallback. The previous control on that page was a toggle that
  changed React state and nothing else — it claimed a protection that did not
  exist and has been removed.
- Enforcement is opt-in: `MFA_ENFORCE_FOUNDERS=false` (default) makes enrolment
  and verification available without locking anyone out; `true` makes
  middleware redirect Founders to `/mfa` and makes `requireFounder()` refuse
  Founder API calls until the session is `aal2`.

**Rollout order (important):**

1. Deploy with `MFA_ENFORCE_FOUNDERS=false`.
2. Both founders enrol and verify an authenticator app in Settings.
3. Set `MFA_ENFORCE_FOUNDERS=true` and redeploy.
4. Confirm a Founder session without a code is redirected to `/mfa`.

**Recovery:** a lost device is removed from the Supabase dashboard
(Authentication → Users → *user* → Factors). Nobody can bypass the prompt from
inside BALE.

**Unverified:** this flow has not been exercised against a live Supabase project
from this sandbox. Test steps 1–4 above on staging before relying on it.

---

## 6. Email transport (finding #6)

`lib/email/mailer.ts` sets `requireTLS: true` (override
`SMTP_REQUIRE_TLS=false` for a localhost-only catcher) and `minVersion:
'TLSv1.2'`. Without `requireTLS`, STARTTLS on port 587 is opportunistic: an
attacker who strips the STARTTLS advertisement downgrades the session to
cleartext, exposing `AUTH LOGIN` credentials and every message body. Now the
send fails instead of downgrading.

---

## 7. Rate limiting and login brute-force defence (finding #4)

`lib/rateLimit.ts` implements a sliding-window limiter; `RATE_LIMITS` names the
per-route budgets (SMS 15/10 min, SMTP test 5/hour, AI extract 12/min, login
10/5 min per IP, CSV export 10/hour per Founder, …). Authenticated routes call
`enforceRateLimit()` **after** authentication so the key is the Founder's user
id rather than a spoofable header. Limits return 429 with `Retry-After` and a
message stating the limit and the wait.

### Login rate limiting and why there is no account lockout

- **Decision: no per-account lockout.** Locking an account after N failed
  password attempts is a denial-of-service vector against the firm: anyone who
  knows `junel@asinta.ph` or `rei@asinta.ph` could intentionally fail N sign-ins
  and lock the Founders out of the books. NIST SP 800-63B advises against
  account lockout for this reason. **TOTP MFA (§5) is the real control**: a
  guessed password cannot open a Founder session without the 6-digit code.
- **Server-side login (`/api/auth/login`).** `AuthProvider.login()` routes
  sign-in through `POST /api/auth/login` before calling Supabase Auth. That puts
  `RATE_LIMITS.authLogin` (**10 attempts per 5 minutes per IP**, keyed by IP
  only via `getLoginRateLimitIdentity()`) in front of GoTrue.
- **Generic errors only.** `sanitizeLoginError()` (`lib/auth/login.ts`)
  collapses `Invalid login credentials`, `Email not confirmed`, `User not
  found`, `User banned`, and missing `public.users` profile rows into the single
  generic 401 message:
  `Invalid email or password. Please check your credentials and try again.`
  Sign-in never reveals whether an email address has an account in BALE.
- **Supabase dashboard settings (still required):**
  1. **Authentication → Rate Limits:** tighten `sign_in_sign_ups` from `30` to
     `10` per 5 minutes per IP. (Note: Supabase issue #41947 in Jan 2026
     reported under-enforcement of this limit in GoTrue — treat the dashboard
     setting as best-effort, which is why `/api/auth/login` also enforces 10/5m
     per IP in the app.)
  2. **Authentication → Attack Protection (CAPTCHA):** enable hCaptcha or
     Cloudflare Turnstile on sign-in. `/api/auth/login` forwards an optional
     `captchaToken` to `supabase.auth.signInWithPassword`.

Honest limitations:

- **Single instance.** Counters live in process memory. On a horizontally scaled
  serverless platform the effective limit is `limit × instanceCount`. It reliably
  stops stuck tabs, double submits and casual single-IP abuse; a distributed
  botnet requires CAPTCHA at the Supabase edge plus a shared store (Upstash
  Redis or a Supabase table) behind the same `checkRateLimit` interface.

---

## 8. Audit trail (finding #7)

`public.audit_log` records `actor_id`, `actor_email`, `action`
(insert/update/delete), `table_name`, `record_id`, full `before_row`/`after_row`
JSONB snapshots and a timestamp. Wired into the money-moving mutations in
`lib/data/store.tsx`: invoices, expenses, advances, payroll.

- Founder-only SELECT; Founder-only INSERT with `actor_id = auth.uid()` (you
  cannot write an entry that blames someone else).
- **No UPDATE and no DELETE policy exists.** With RLS enabled, both are denied
  for every client, so the trail cannot be rewritten by whoever holds a Founder
  session.
- A failed trail write is **reported to the user** ("saved, but the audit trail
  entry could not be recorded") rather than swallowed. The ledger write is not
  blocked on the audit write — losing an entry because the trail was unavailable
  would be worse — but it is never presented as logged.
- Retention: see `docs/PRIVACY.md`. There is no UI for reading the trail yet;
  query it in the Supabase SQL editor (an audit-log viewer is a candidate
  follow-up, not part of this pass).

---

## 9. Seeds, credentials and rotation (finding #10)

`supabase/migrations/20260913000002_bale_seed.sql` creates **real auth accounts
with a published password** (`asinta2026`), plus fictional clients, invoices and
payroll. It carries a banner saying it is local-development only.

- In production, provision accounts through the Supabase Auth dashboard / Admin
  API with a password chosen by the founder.
- If the seed was ever applied to a project that matters, rotate immediately:

```sql
-- Run as the service role in the SQL editor. Repeat per affected account.
update auth.users
set encrypted_password = crypt('<new-strong-password>', gen_salt('bf')),
    updated_at = now()
where email = 'junel@asinta.ph';
```

- Then revoke existing sessions for those users (Authentication → Users →
  Sign out all sessions) so an old token cannot outlive the rotation.
- `tests/rls-migration.test.ts` asserts that no non-seed migration contains the
  demo password, so a copy cannot drift into the schema migrations.

---

## 10. Backups vs. CSV Exports (finding #11) — **RESTORE TEST REQUIRED**

The live project is on **Supabase Free**, which does **not** include PITR or
automated platform backups. Keep the two mechanisms distinct:

- **Backup** = restorable `pg_dump` SQL archive (`.github/workflows/backup.yml`).
- **Export** = readable CSV for opening in Excel (`GET /api/export?table=<name>`).
  A manual button is never a backup strategy because people forget to press it.

### 10a. Automated database backup (primary)

`.github/workflows/backup.yml` runs weekly (`cron: '0 22 * * 6'`, Sunday 06:00
Asia/Manila) and on manual `workflow_dispatch`:

- Reuses the `SUPABASE_DB_URL` repository secret and the exact project-ref guard
  from `.github/workflows/apply-migrations.yml` (refuses to run unless the URL
  contains `mchkdkjntnbwrgmyobpd`).
- Runs `pg_dump --schema=public --clean --if-exists --no-owner --no-privileges`,
  verifies the dump completed (`PostgreSQL database dump complete`), writes a
  `.sha256` checksum, and uploads both as a GitHub Actions artifact.

**Restore test runbook (an untested dump is not a backup):**

1. Trigger **Actions → Automated database backup → Run workflow**.
2. Download the `bale-pg-dump-<run_id>` artifact and verify its `.sha256`.
3. Create a throwaway Supabase project (or local Postgres instance) and restore:
   `psql "$THROWAWAY_DB_URL" -v ON_ERROR_STOP=1 -f bale-backup-*.sql`
4. Verify (a) row counts for `invoices`, `expenses`, `payroll`, and `workers`,
   and (b) that `audit_log` rows are present through the backup timestamp.
5. Record the date and result below.

### 10b. Founder CSV export (secondary convenience)

`GET /api/export?table=<name>` (`lib/export/csv.ts`, surfaced in **Settings →
Export Ledger Table to CSV**):

- **Founder-only enforced server-side** with `requireFounder()` (including MFA
  assurance when `MFA_ENFORCE_FOUNDERS=true`), never a hidden UI button.
- **Rate-limited** via `lib/rateLimit.ts` (`RATE_LIMITS.ledgerExport`: 10 per
  hour per Founder).
- **Logged in `public.audit_log`** (`table_name = 'export:<tableName>'`, with
  actor, row count, and timestamp). If the audit write fails, the route **fails
  closed** and refuses to stream the CSV.
- **Excel-safe CSV, never JSON:** UTF-8 BOM (`\uFEFF`) so Filipino characters
  (`Ñ`/`ñ`, `₱`) open cleanly in Excel, RFC 4180 quoting, and formula-injection
  neutralisation (`=`, `+`, `-`, `@`).
- **Strict allowlist:** only the 9 public ledger tables (`invoices`, `expenses`,
  `payroll`, `advances`, `attendance`, `projects`, `clients`, `workers`,
  `audit_log`) can be exported. `auth.*` tables, `public.users`, and password
  hashes/tokens can never be exported.
- **RA 10173:** exporting `workers`, `clients`, `attendance`, `payroll`, or
  `advances` downloads personal data (worker names, contact numbers, wages) —
  which is why every download is restricted to Founders and recorded in
  `audit_log`.

### 10c. Storage gap (receipt photos)

**Neither `pg_dump` nor the CSV table export includes the receipt photos in the
`receipts` Supabase Storage bucket.** `public.expenses.receipt_url` stores only
the bare storage path; the image bytes live in Supabase Storage (`storage.objects`
+ S3-backed object storage). Copy receipt files separately from **Supabase
Dashboard → Storage → `receipts`** (or via the Storage API) alongside your
database backup schedule.

| Restore test date | Performed by | Result | Artifact / retention window |
| --- | --- | --- | --- |
| *(not yet performed)* | | | |

---

## 11. CSRF (finding #12) — reasoning, not code

There is no CSRF token, and that is a deliberate, documented decision:

- Session cookies set by `@supabase/ssr` are `SameSite=Lax` (and `Secure` over
  HTTPS). A cross-site form POST does not carry the cookie, so the request is
  unauthenticated.
- Every mutating endpoint accepts **JSON bodies** and parses them with
  `req.json()`. A cross-site HTML form can only send
  `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`;
  those would fail or produce an empty body. `multipart/form-data` is accepted
  only by the voice route, which requires an authenticated session and a
  same-origin fetch.
- There is no `GET` endpoint that mutates state. (The cron route requires the
  cron secret and is excluded from cookie auth entirely.)
- The response is never used to read cross-origin data, and CSP
  `form-action 'self'` blocks form submissions to third parties.

Adding a token would add a round trip and a new way for a legitimate save to fail
while covering nothing the above does not already cover. If a future endpoint
must accept form-encoded input or a `GET`, this analysis has to be redone.

---

## 12. Data Privacy Act (RA 10173) (finding #13)

See `docs/PRIVACY.md` — privacy notice content, retention schedule, breach
runbook, DPO and NPC registration checkpoints. Operationally relevant points:

- BALE processes worker names, contact numbers and wages, plus client contact
  details and project financials.
- The app writes **no PII to logs** (no phone numbers, no message bodies); only
  safe error strings.
- 72-hour breach notification is a legal duty that cannot be automated here:
  it needs a named DPO and a decision log.

---

## 13. Verified complete in this pass

- 227 automated tests pass; `tsc --noEmit`, `next lint`, and `next build` are
  clean.
- RLS regression test asserts: RLS on every migrated `public.*` table, no
  `using (true)` anywhere, every policy scoped `to authenticated`, `audit_log`
  has no update/delete policy, bucket private + URL backfill present, category
  CHECK constraints match the single TypeScript definition, seed password absent
  from non-seed migrations.
- Receipt path/signing helpers, session clock, rate limiter, audit row builder,
  vendor memory and the draft verification gates all have unit tests.
