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
| Sign-in & cost abuse | Shared login cooldown and `lib/rateLimit.ts` | Shared per-email-and-network cooldown on app login; other route limits are in-process — see §7. |
| Trail | `public.audit_log` (append-only) | Covers money-moving mutations (invoices, expenses, advances, payroll). No UPDATE/DELETE policy exists. |

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
  microphone denied), `X-DNS-Prefetch-Control: off`.
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
10/5 min per IP, …). Authenticated routes call
`enforceRateLimit()` **after** authentication so the key is the Founder's user
id rather than a spoofable header. Limits return 429 with `Retry-After` and a
message stating the limit and the wait.

### App sign-in cooldown

`POST /api/auth/login` reserves capacity in the database before calling Auth.
Five rejected sign-ins for the same normalized email **and network address**
trigger a five-minute cooldown. A success clears failures; an outage or malformed
request is not counted as an invalid password. After 15 minutes without a
failure, a non-locked bucket is reset. In-flight reservations serialize capacity
and expire after two minutes; a result without a confirmed reservation cannot
publish login cookies. The database keeps an HMAC of identifiers, not the email,
IP address, or password. Stale buckets are cleaned opportunistically.

The app needs the additive `20261104000002_login_cooldown.sql` migration and a
server-only `SUPABASE_SERVICE_ROLE_KEY` pointing to that same project **before**
this version is deployed. If the key, caller IP or shared store is unavailable,
login fails closed with a temporary-unavailable response. A key rotation resets
bucket identities. See `docs/LOGIN_COOLDOWN_ROLLOUT.md` before any rollout.

The older per-instance IP limiter remains a second control: it counts **valid-shape**
requests, including successes, and can block a shared network
after 10 requests in five minutes on one instance. Credential errors remain
generic, but no anti-enumeration guarantee is perfect.

**Boundaries:** this only guards the app login endpoint; direct calls to Supabase
Auth can bypass it, as can an attacker using many network addresses. A user behind
the same network as an attacker targeting their email may be temporarily blocked.
An address forwarded by a non-trusted proxy can be spoofed; this design relies on
Vercel's trusted forwarding. Supabase Auth protections and properly enforced MFA
remain important. Other `lib/rateLimit.ts` limits remain process-local and are not
reliable distributed controls. Do not turn on CAPTCHA until the frontend supports
and has been tested with the configured challenge.

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

## 10. Recovery and ad-hoc exports — **NOT YET VERIFIED**

> The project owner reports that Supabase Dashboard backups require a paid plan and are unavailable on the current plan.

> **Current blocker:** the inspected GitHub backup runs failed before creating a dump because `SUPABASE_DB_URL` was not set. The historical backup and migration workflows are now manually disabled at repository level; no scheduled export is running. No successful run was found in the inspected workflow history. This does not establish whether another backup exists. Do not assume this project has a usable restore point.

`.github/workflows/backup.yml` is a **partial application-schema export** of `public` and `app_private`, not a complete or verified project backup. The branch updates it to use a PostgreSQL 17 client compatible with the currently connected server. A reviewed alternative would require the authorized administrator to configure credentials privately, never in chat. The repository is currently public. The draft workflow refuses to run for a public repository because the unencrypted artifact contains sensitive records. The historical default-branch workflow does not have this guard; do not configure its database secret or manually dispatch it to export real data. Even on a private repository, review access, retention and encryption before any real run. This branch's workflow changes reach the default branch only after merge; no backup was run as part of this change.

The draft export includes `public` and `app_private`, but excludes Auth, Storage files and configuration, owners, grants, and project settings. It can also depend on Supabase-managed schemas. A checksum or row-count comparison alone cannot establish a successful restore. A complete recovery plan requires a securely stored, independently tested restore to an isolated equivalent environment, a review of schema dependencies and privileges, an appropriate plan for Auth, and separate copies of Storage objects/configuration. Recovery must also account for new writes after a backup; never overwrite newer records blindly. Do not apply the five remaining PR #103 migrations or sequence guard until a suitable recovery path and staged rollout have been verified. The standalone base-only read RPC has since been installed; see `PR103_SCHEMA_REHEARSAL.md`.

The application-schema export would create an unencrypted Actions artifact containing personal and financial data. Limit who can read/download it and set an appropriate retention period. GitHub Actions' project-ref substring check is a limited guard, not independent proof of target identity. Table CSV exports are useful for inspection but are not a replacement for a complete database backup.

### 10b. Why manual in-app CSV export was deliberately omitted

BALE intentionally does **not** ship a manual CSV table export button in
Settings or a data-export API route:

1. **Keeps backup (`pg_dump`) distinct from ad-hoc exports.** A download button
   inside Settings invites treating a flat CSV as a backup; `.github/workflows/backup.yml`
   (`pg_dump`) is only a partial database export until a full recovery plan is verified. When an ad-hoc spreadsheet is
    genuinely needed, Founders can export directly from the **Supabase Dashboard
   (Table Editor → Export to CSV)**.
2. **RA 10173 local-file exposure.** One-click dumps of `workers`, `clients`,
   `attendance`, `payroll`, and `advances` place unencrypted files containing
   personal data (names, phone numbers, and wages) into a local `Downloads/`
   folder outside PostgreSQL RLS and session timeouts.
3. **No dead or unnecessary egress routes.** Omitting the in-app export avoids
   mounting an extra bulk data-egress endpoint on the application server.

### 10c. Storage gap (receipt photos)

**`pg_dump` (and any CSV table export from the Supabase Dashboard) does not
include the receipt photos in the `receipts` Supabase Storage bucket.**
`public.expenses.receipt_url` stores only the bare storage path; the image bytes
live in Supabase Storage (`storage.objects` + S3-backed object storage). Copy
receipt files separately from **Supabase Dashboard → Storage → `receipts`** (or
via the Storage API) alongside your database backup schedule.

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
  those would fail or produce an empty body. `multipart/form-data` is not used by these mutating endpoints.
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
