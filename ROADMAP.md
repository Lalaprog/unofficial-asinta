# BALE — Roadmap & Open Work

Tracked in-repo because the GitHub issue list is empty, which meant the next
planned work lived nowhere. Sections are ordered by intended sequence.

Legend: **Verified** = checked in this checkout (tests, typecheck, build, smoke).
**Needs live project** = cannot be completed or confirmed without the Supabase /
production credentials. **Open** = known work, deliberately deferred.

---

## Done — security pass (Part 1)

- **Next 14.2.35 advisories (incl. critical GHSA-2xp9-vwfh-vxw4, Image
  Optimizer RCE).** Verified: `images.unoptimized: true` (optimizer disabled),
  `images.remotePatterns` narrowed from `hostname: '**'`, no `next/image` import
  anywhere, no `sharp` in the lockfile. The **upgrade to 16.x is the real fix**
  and is tracked below as its own PR.
- **Receipts bucket private + signed URLs.** Verified: migration
  `20261006000000_security_hardening.sql` flips `storage.buckets.public = false`,
  rewrites existing `expenses.receipt_url` values (public URL or signed URL →
  bare storage path, tokens stripped) and clears unresolvable absolute URLs.
  Uploads store a path; reads mint a 5-minute signed URL
  (`lib/supabase/receipts.ts`).
- **Security headers.** Verified: CSP (`default-src 'self'`, `object-src 'none'`,
  `base-uri`/`form-action 'self'`, dev-permissive `frame-ancestors` for the
  sandbox preview, `frame-ancestors 'none'` + `X-Frame-Options: DENY` + HSTS in
  production), `nosniff`, `Referrer-Policy`, `Permissions-Policy`,
  `X-DNS-Prefetch-Control`.
- **Rate limiting.** Verified: sliding-window limiter (`lib/rateLimit.ts`) with
  named per-route budgets; SMS 15/10 min, SMTP test 5/hour, email send
  20/hour, AI extraction 12/min. Keys prefer the authenticated user id and fall
  back to the proxy-appended client address. 429 responses carry `Retry-After`
  and a message stating the limit and the wait.
- **Founder MFA.** Verified: real Supabase TOTP enrolment/verification with the
  aal1→aal2 gate (`app/mfa`, `components/auth/MfaCard.tsx`); the decorative
  toggle that claimed MFA while doing nothing is gone. Enforcement is opt-in via
  `MFA_ENFORCE_FOUNDERS` (rollout order in `docs/SECURITY.md` §5).
- **SMTP `requireTLS`.** Verified: `requireTLS: true` and `minVersion: 'TLSv1.2'`
  (dev-only opt-out via `SMTP_REQUIRE_TLS=false`).
- **Audit log for financial mutations.** Verified: `public.audit_log` with
  before/after JSONB, Founder-only select/insert, **no update/delete policy at
  all**, wired into invoice / expense / advance / payroll mutations.
- **RLS regression test.** Verified: `tests/rls-migration.test.ts` asserts RLS is
  enabled on every migrated `public.*` table, no `using (true)` survives, and
  every policy is scoped `to authenticated` — this caught the real finding that
  the base schema's 23 policies had **no `TO` clause** and therefore applied to
  `anon` as well; `20261006000002_security_hardening.sql` re-scopes all of them
  and pins `search_path` on the `security definer` helpers.
- **Receipt extension allowlist.** Verified: extension is derived from the MIME
  type (never the uploaded filename), allowlist JPEG/PNG/WebP, ≤5 MB, randomised
  object key.
- **Seed password warning + rotation.** Verified: boxed "LOCAL DEVELOPMENT ONLY"
  warning in `20260913000002_bale_seed.sql`, rotation SQL + procedure in
  `docs/SECURITY.md` §9, and a test that the published demo password appears in
  no non-seed migration.
- **CSRF reasoning documented.** `docs/SECURITY.md` §11 (no token by design:
  `SameSite=Lax` cookies + JSON-only bodies + no state-changing `GET`).
- **RA 10173 compliance notes.** `docs/PRIVACY.md`: processing inventory,
  sub-processor list, draft privacy notice, retention schedule with review
  queries, 72-hour breach runbook, DPO/NPC-registration checkpoints.
- **Session policy (Part 2).** Verified: idle 20 min + absolute 8 h, both
  mirrored in `supabase/config.toml` (`[auth.sessions] inactivity_timeout`,
  `timebox`), warning dialog before either deadline with "Stay signed in"
  (activity only, never extends the absolute limit), countdown + spoken
  countdown, deliberate-logout flag to distinguish an expired session from a
  finished one.

## Done — AI tracks (Part 3)

- **Track E — one messy line → structured draft.** Verified: 35 tests. Amount
  and date must be *quoted* in the source text or they are dropped; project and
  vendor resolve only to real database ids; ambiguity is refused rather than
  guessed; the model's amount is used only when its quote verifies, otherwise
  the rules layer's reading is used *and the substitution is disclosed*.
- **Track A — vendor memory, count-based.** Verified: `vendor_memory` records
  accepted/overridden counts per normalised supplier token;
  `record_vendor_outcome()` updates counters server-side; a category is
  suggested only when the measured rate clears a stated threshold, and the
  suggestion always carries that measurement as its evidence. No embeddings.
- **Track C — duplicate & outlier detection (arithmetic).** Verified: same
  amount ±₱0.01 within 7 days **and** (same project **or** same supplier);
  different named suppliers in the same project are explicitly *not* duplicates;
  outliers are median-based with a minimum-history guard; receipts are required
  at ₱5,000; ledger-wide pair de-duplication.
- **Track B — receipt photo → draft.** Verified: Groq vision with the image sent
  as a base64 data URI (never a signed URL), 4 MB cap, current model IDs
  (`qwen/qwen3.8-27b`; Llama 4 Scout is retired on the free tier), degrade to
  manual entry with the reason shown.
- **Expense voice recording removed.** Receipt and text drafting remain; a receipt description is now a short editable, source-checked excerpt, with the complete model reading separate and uncertain fields left for review. The photo still goes to Groq for scanning.
- **Model IDs are data, not code.** Text and vision models resolve through `lib/ai/models.ts` with environment overrides and are reported by `/api/integrations/status`.

## Done — server-backed Founder attendance approval queue

- Founder review candidates are queried independently of the capped shared
  attendance store, with keyset pages, a count, explicit errors and refresh.
  The read-only invoker function retains the existing review heuristics and RLS.
- Apply the individual migration before deploying the UI; see
  `docs/ATTENDANCE_APPROVAL_QUEUE_ROLLOUT.md`. Hosted permissions and live
  operation are not verified. Approval decisions can still race between Founders.
- **Still open:** scalable workforce logs, complete payroll-period data and
  safe payroll calculation. The queue does not make those other views complete.

## Done — server-backed attendance history

- Date/site sheets and their records load independently from the database in
  bounded keyset pages. Site/status/date/search filters run on the server,
  subject to the caller's existing RLS. Counts are per filtered sheet; refresh
  to see concurrent changes. No claim of a frozen snapshot across pages.
- Apply the individual migration before deploying the client. See
  `docs/ATTENDANCE_HISTORY_ROLLOUT.md`; hosted behavior is not verified.
- **Still open:** the shared store still feeds payroll, roll call, project
  workforce logs and other screens and may omit records. This change does not
  make payroll computation complete or address concurrent review writes.

## Done — notifications usability

- **One bell-anchored panel.** Desktop and mobile now share a non-modal Radix
  popover. Mobile is a translucent, blurred top-bar extension; desktop is a
  right-aligned popover. Opening and closing animate from/to the bell, with no
  finger-following gesture (the More panel keeps its drag behavior). Reduced
  motion removes the animation. The closing preview is inert and focus returns
  to the bell on Escape/Close.
- **Trustworthy event ages.** Stored Bale notifications show “just now”,
  seconds, minutes, hours, days, then a Philippine date. Site groups label the
  newest stored event as “Latest”. Generated reminders (missing roll call,
  draft payroll, overdue billing, attendance overrides) intentionally have no
  invented creation timestamp. Missing/invalid times are omitted; future source
  times are disclosed as clock skew rather than shown as new.
- **Still open:** notification history is still the shared client store, not a
  scalable server-side feed. Workforce/SMS server-side loading and other
  reliability items below remain separate work.

## Open — security (deliberately deferred)

- **Upgrade off Next 14.x (its own PR).** 14.x receives no more security
  patches; the header/optimizer work is a mitigation, not a fix. Target 16.3.8+
  (or 15.5.24+), expect React 19 and App Router changes, and re-run the full
  test suite plus the runtime smoke checks. **Never `npm audit fix --force`.**
- **Remove `'unsafe-inline'` from `script-src`.** Requires a per-request nonce
  threaded through middleware — real work, not faked.
- **Rate limiter is single-instance.** Counters are in-process; the honest
  limitation is documented in `docs/SECURITY.md` §7. A multi-instance deploy
  needs a shared store (Upstash Redis / a Supabase table) behind the same
  `checkRateLimit` interface.
- **Login brute force is not covered by this limiter** — the browser talks
  directly to Supabase Auth. Configure Supabase's own rate limits (and consider
  CAPTCHA) per `docs/SECURITY.md` §7.
- **Audit-log viewer** — the trail is query-only via SQL today; a Founder-facing
  view is a candidate follow-up.

## Needs live project (blocked, not abandoned)

- **Apply migrations.** Prepared, not applied: the agent sandbox's egress
  allowlist covers only npm and GitHub, so `*.supabase.co` is unreachable from
  it — verified with a direct probe, not assumed. Three ready paths, documented
  in `docs/MIGRATION_RUNBOOK.md`: paste `supabase/apply/<bundle>.sql` into the
  SQL editor (A), `supabase db push` with the DB password (B — runs the seed
  too, delete it first), or the manual-only GitHub Actions workflow (C).
  `supabase/apply/verify-live.sql` turns each static test guard into a live
  PASS/FAIL row; run it afterwards.
- **Post-migration smoke test:** bucket is private, an old receipt still opens
  (re-attach if not — the backfill clears URLs it cannot resolve), a mutation
  writes an audit row.
- **First Founder account** must be created through the Auth dashboard and
  linked with a `public.users` row (`role = 'founder'`) — the seed is not
  applied to production. `docs/MIGRATION_RUNBOOK.md` §6.
- **Backups/PITR:** verify the plan, then **perform and record a test restore**
  (table in `docs/SECURITY.md` §10 — currently marked not performed).
- **MFA rollout:** deploy with `MFA_ENFORCE_FOUNDERS=false` → both founders
  enrol → flip to `true` → confirm a Founder without a code is redirected.
- **Session fields** in the managed dashboard must match `supabase/config.toml`
  (20 min idle / 8 h absolute); `config.toml` only governs the local stack.
- **Supabase Auth rate limits** for sign-in (the app limiter never sees login
  traffic) — dashboard setting, `docs/SECURITY.md` §7.

## Backlog

- `store.tsx` and component tests (coverage is server-logic only).
- Adopt `isSupabaseConfigured()` fail-fast path in more entry points if needed.
- Automated data-retention purge (see `docs/PRIVACY.md` §5) — manual review is
  the current answer.

### Payroll input completeness follow-up

Payroll generation can request a bounded, Founder-only server snapshot instead of relying on the capped shared browser store (see `docs/PAYROLL_INPUT_SNAPSHOT_ROLLOUT.md`). This is read-only groundwork, not a complete attendance matrix or a concurrency-safe payroll run. Atomic generation, duplicate prevention, consistent review semantics, scalable payroll ledger/project selectors, and reconciliation of existing hosted financial migrations remain separate work. Avoid concurrent edits/runs and review drafts before approval.
