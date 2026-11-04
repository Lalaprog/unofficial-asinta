# Email-code recovery: safety review and rollout prerequisites

Status: **draft, incomplete and not deployed; recovery is not implemented or enabled.** No live database, Supabase Auth settings, email templates, or SMTP changes have been made, and no real message was sent. The intended feature is Founder/Supervisor sign-in by emailed code, with an optional password change, using the existing email provider and preserving enrolled MFA.

## Why a sign-in form alone is not sufficient

Supabase describes an email OTP or magic link as an `aal1` session: it has verified the first factor, but not an enrolled authenticator. Supabase requires the application to enforce second-factor authorization in the app, APIs and database. A new recovery form could ask for the authenticator code, yet an `aal1` token can be used against Supabase directly without going through the form. Restricting only the new UI or middleware would not close that path.

Read-only inspection of the hosted project on 2026-11-05 (Asia/Singapore) found:

- Public business tables have RLS enabled, but no restrictive MFA policies. Existing access policies check role and site assignment, not the session's MFA level.
- Founder expense receipt storage policies check `is_founder()` but not assurance level.
- Several authenticated, `SECURITY DEFINER` functions—including project visibility and finance mutations—do not automatically inherit restrictive table policies. They must be reviewed individually.
- Founder MFA enforcement in `middleware.ts` and `requireFounder()` is opt-in. Existing login normally presents an enrolled authenticator challenge, but those checks alone do not enforce MFA on direct Supabase access. Supervisor MFA is not currently enforced by that middleware.
- The browser data provider can begin loading the ledger as soon as a profile is set; a protection rollout must account for loading before the MFA challenge completes.
- At the time of inspection, one Founder had a verified authenticator; the Supervisor had none. The intended safeguard must not unexpectedly require an unenrolled account to set up MFA, while an enrolled account must complete its existing factor. These counts can change.
- `authenticated` cannot directly select `auth.mfa_factors` in this project. Supabase's illustrative policy that selects that table cannot simply be copied without resolving permissions safely. Do not grant broad access to factor metadata.

The current app-level password cooldown only guards the app login endpoint; it does not protect direct Supabase Auth requests. Supabase's own Auth limits still apply. Existing default Auth email settings send sign-in links only to the limited built-in sender's allowed recipients; connecting a custom sender changes who can receive Auth emails, including through direct Auth endpoints. Assess the current link templates and account creation settings before enabling it.

## Prerequisites to implement and validate

1. Design an assurance check that permits ordinary `aal1` sessions for accounts without verified factors and requires `aal2` for accounts with one. Fail closed if the check cannot be established. Keep any factor lookup narrowly scoped to the current authenticated user; avoid exposing MFA secrets or factor records.
2. Cover actual data boundaries: public tables and column grants, receipt storage, every relevant callable `SECURITY DEFINER` function, and server API routes (especially those using service-role access). RLS does not constrain owners or service-role clients. Review the profile-read exception needed for sign-in, with least privilege.
3. Update session/bootstrap behavior so authenticated data is not loaded before an enrolled factor is verified, and so it loads correctly after verification. Check refreshes, direct navigation, expired sessions, sign-out, cached data and both roles. Do not assume hiding a page is authorization.
4. Test permissions in a disposable database using synthetic identities for enrolled and unenrolled users at `aal1` and `aal2`; cover reads, writes, security-definer calls and storage where feasible. Test application flow with mocked Auth, failures and retries. No live financial mutations are required.
5. Before any live permissions change, explain the rollout and rollback, check that current users can access their authenticator and agree on a safe time. Old clients and active sessions may need refresh or re-verification. Live data and permissions must not be changed without the owner's approval.
6. Only then implement and verify recovery: no account creation by recovery request; generic request responses; rate limits; expired/used/incorrect code handling; enrolled MFA before workspace or password change; optional password change with existing password-strength rules; do not log tokens, passwords or email credentials. Confirm the real hosted Auth version's behavior instead of assuming source-code versions match.
7. Connect Supabase Auth separately to the existing SMTP provider. Its email templates, sender, allowed URLs and limits affect Auth emails project-wide. Check the provider's current limits and cost; the Free Supabase plan supports custom SMTP, but the external provider may have its own restrictions. Save credentials only in Supabase's private settings, not in chat, Git, PRs, logs or documents. Obtain approval before changing Auth settings or sending a real test message.

## Isolated assurance prototype

`tests/fixtures/mfa-recovery-prototype.sql` and `tests/mfa-recovery-prototype.test.ts` explore a possible approach in disposable PGlite databases with synthetic users. The fixture is deliberately **not a migration** and must not be executed on the hosted project. Tests exercise an enrolled account at `aal1` and `aal2`, unenrolled and unverified-factor accounts, missing/invalid assurance, private rows, example storage, a self-profile bootstrap exception, and a guarded example privileged function. A second test uses selected checked-in project and payroll function definitions with test-only guarded role helpers. It also demonstrates why an unguarded privileged function bypasses table RLS and why service-role APIs need their own checks. The tests do not cover all real tables, APIs, privileged functions, storage permissions, concurrency, Realtime, or hosted Supabase.

The installed Auth SDK has an important server-side distinction: calling `getAuthenticatorAssuranceLevel()` without a JWT reads the session's cached `user.factors`, whereas supplying a JWT makes it fetch the user from Auth. A server-side implementation must not treat client-controlled session data as proof that no factor is enrolled. Verify the JWT/user with Auth, check all error paths and use current verified factor information; test exactly the installed and hosted versions. JWT expiration, factor enrollment/removal races and already-issued sessions must be considered.

## Draft application prerequisite (not deployed)

`supabase/migrations/20261105000000_session_assurance_prerequisite.sql` adds an authenticated-only boolean RPC for the current session; it does not itself restrict database access. `lib/auth/session-assurance.ts` and the draft API changes use it to fail closed for Founder actions, Supervisor worker creation, password setup and integration status. The selected AI endpoint also uses the Founder guard.

`supabase/migrations/20261105000001_mfa_table_storage_policies.sql` is a **draft, unapplied and potentially disruptive** second migration. It adds restrictive policies to the currently inventoried business tables and `storage.objects`, preserving existing permissive policies and allowing only a caller's own profile to be read while awaiting MFA. It refuses to run if a listed table is absent or lacks RLS, if the prerequisite function is missing, or if an unexpected authenticated-accessible public relation exists. This is a one-time preflight, not automatic protection for relations created later; future schema changes need their own assurance review. The exact SQL was exercised on synthetic tables in PGlite, including profile and storage, but has not been tested against actual hosted identities or Storage API behavior. The existing receipts bucket was private on inspection; previously issued signed URLs can remain usable until expiry, and future public buckets need separate review.

**This is still partial:** middleware and session/bootstrap must be updated; every privileged RPC and service-role boundary must be handled and tested before enforcement. In particular, `visible_projects()` and privileged financial functions bypass table RLS; several rely on `is_founder()` or `is_supervisor_assigned()`, which remain unguarded. If those role helpers are changed, ensure the Founder can still read their own profile to start an MFA challenge: the existing Founder profile policy relies on `is_founder()`, so the restrictive profile exception alone does not grant access. Verify the actual hosted definitions and audit new functions and role policies again immediately before rollout. AAL2 and factor state must also be checked against actual hosted behavior.

**Do not merge or deploy the draft application before installing and verifying the additive RPC on the intended project**: guarded endpoints fail closed if it is unavailable. Installation requires a coordinated rollout and owner approval. Conversely, the additive RPC alone provides no access restrictions. Do not enable an OTP template or custom SMTP as a substitute for the missing authorization checks. Do not run `supabase db push` blindly: hosted migration versions differ from checked-in filenames.

## References

- Supabase: [Multi-Factor Authentication and enforcement](https://supabase.com/docs/guides/auth/auth-mfa)
- Supabase: [Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- Supabase: [Email passwordless authentication](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- Existing project notes: `docs/LOGIN_COOLDOWN_ROLLOUT.md`, `docs/SECURITY.md`, and `docs/COMMUNICATIONS_SETUP.md`.
