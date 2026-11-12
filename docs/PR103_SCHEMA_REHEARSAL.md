# PR #103 schema readiness — work in progress

## What is known

The merged web code has been promoted, but the seven `20261113000000`–`20261113000006` migrations have not been installed on the connected development database. New screens relying on them cannot load. Legacy payroll and Bale still use the old rules. Do not treat these features as a completed payroll release.

`supabase/preflight/pr103_readiness.sql` is a **read-only, partial catalog check**, not a deployment script. Its check against the connected database returned: `app_private` present, no missing named relations/helpers, no conflicting named new tables/functions, and no explicit column ACLs on `advance_requests`. This is a point-in-time result and does not verify column types, function bodies, role membership, active requests, live clients, trigger side effects, identity data, hosted Auth/PostgREST or concurrency. It also cannot prove the schema is equivalent to a staging environment.

The database gives `anon`, `authenticated` and `service_role` broad default privileges on future public tables, functions and sequences created by `postgres`. The seven migrations explicitly restrict the new tables and functions; however the identity sequence for `attendance_time_details` would otherwise inherit direct client privileges. The follow-up `20261114000001_protect_time_detail_sequence.sql` revokes client access to that sequence, keeps existing service privileges, and fails rather than changing inherited role privileges silently. It has **not** been applied to the hosted database: the sequence does not yet exist there. Install it in the **same transaction** as the time-detail migration if a future release is approved, not as a delayed independent patch.

## Synthetic rehearsals

- `tests/pr102-migration-sequence.test.ts` installs the earlier seven PR #102 migrations, all seven PR #103 migrations in order, and the sequence guard into a simplified PGlite fixture with broad default grants. It exercises selected worker preview, time, allowance, Supervisor leave/day conflict, Bale site guard, earlier project features and preservation of a paid voucher. It checks the catalog preflight before and after, and confirms restricted table/function/sequence ACLs and legitimate definer-based time recording.
- `tests/time-detail-sequence-permissions.test.ts` checks client denial, preservation of existing rows/service privilege and rollback on inherited privilege problems.
- `tests/bale-guard-legacy-triggers.test.ts` combines the actual repository legacy request, audit and in-app notification triggers with the new site guard in a simplified isolated schema. A synthetic request and approval produced expected audit/in-app notification records and no advance. No hosted request or message was created.
- Existing isolated PostgreSQL multi-connection tests cover several feature-specific races. They do not establish every possible cross-feature lock order or hosted compatibility. PGlite is not a clone of the connected database.

## Before any hosted change

1. Verify a usable, independently restorable backup and an operational recovery plan that preserves new records if any writes occur after deployment. Never assume reverting the application, dropping new tables, or transaction rollback after commit will preserve those records.
2. Repeat catalog/ACL, policies, triggers and function-body comparisons against the actual target; inspect potential inherited privileges and legacy clients. Rehearse the exact ordered SQL, including the sequence guard, against an isolated equivalent schema with representative **approved** data, and test real Auth/PostgREST, role/MFA and failure behavior. Avoid external sends, real payments and new hosted demo records without separate approval.
3. Plan a bounded-lock, transactional deployment, monitoring and PostgREST schema-cache refresh; ensure no conflicting deploy is running. The site guard changes new request inserts and also rejects normal privileged inserts lacking an authenticated Supervisor identity unless the trigger is intentionally bypassed by an administrator; old clients and maintenance imports must be reviewed. It does not implement the weekly Bale schedule.
4. After any deployment, compare financial/attendance/request records and catalog/grants; carefully smoke-test reads and authorized writes only within the agreed test scope. The existing in-app notification trigger and audit function execute on requests; do not silently create real requests just to test.
5. Keep the weekly payroll, actual release recording, allowance integration, Supervisor wage calculation, paid-period adjustments and legacy reconciliation labeled unfinished. No feature here makes or sends payments.

Hosted history uses different versions and earlier combined migrations. Do **not** blindly use `supabase db push` or the stale SQL bundles. No hosted writes were made by this rehearsal.
