# Team account operations and recovery

## Rollout and scope

The last-Founder protection is **not active until** `20261102000001_founder_guard.sql` is applied and verified in the target database. No hosted environment is assumed updated. Test on a staging copy first, take a backup, and pause team account administration during rollout. Apply the migration (or the current appropriate bundle) **before** deploying the new application, run `supabase/apply/verify-live.sql`, then deploy the application and replace all old instances. If the migration/RPC is missing, the new application refuses profile edits and removals rather than falling back to unsafe writes. Keep old instances out of service: their deletion code performs cleanup outside the guarded transaction, even though the new triggers stop them removing the last Founder. Resume only after staging checks, verification and replacement are complete. For rollback, retain the migration/triggers; restoring old application code restores its non-atomic cleanup, so pause administration and plan recovery first.

The migration serializes profile updates/deletes and rejects demotion or deletion of the final Founder, including direct service-role and multi-row statements. It does not create a Founder for an empty installation, block privileged administrators from altering or disabling triggers, or repair historical inconsistencies. The service-role-only RPC rechecks the acting Founder and atomically clears attribution/assignments, deactivates the linked worker, deletes the profile and writes its audit record. An outstanding advance request submitted by the target can restrict deletion; resolve the business record appropriately rather than bypassing its foreign key. Attendance and expense rows and payroll history remain. Deleted users' attribution is cleared where specified, and database FK actions may clear audit actor IDs or remove notifications. Consider retention requirements before deleting.

Coordinate account changes one at a time even after rollout: **Auth, project assignments, worker updates and some audits are separate calls**, and simultaneous edits can overwrite Auth metadata or leave other partial changes. A network timeout can obscure a committed result. Do not blindly retry unconfirmed operations.

- After an unconfirmed creation, inspect both Supabase Auth and the BALE user profile before attempting another create. Check project assignments and the worker/payroll roster. Avoid sending credentials until the correct account and password are confirmed.
- After an unconfirmed update, inspect the BALE profile, Auth metadata/password-reset state, assignments, worker/payroll rate and audit log. Never distribute a proposed password when Auth reset was not confirmed. A lost response does not prove the password was unchanged; use a new verified reset if necessary.
- After an unconfirmed profile removal, inspect the profile, attribution, worker, assignments and deletion audit **before retrying**. If the profile remains, the guarded database transaction should not have committed; investigate the returned error and references. If the profile is gone, inspect Supabase Auth: the response may have been lost before Auth deletion was requested. If Auth removal was unconfirmed, a privileged administrator must check and clean up any remaining Auth account. Do not assume login or existing sessions have been revoked; verify provider behavior and relevant permissions.
- Deletion audit failure rolls back the guarded database deletion. Other operations can still complete without an audit if that separate write fails: reconcile the state and record incidents via the organization's approved procedure. Never put a temporary password in an audit record.
- Test disposable staging accounts, failures at each step, real Auth/session behavior and old-instance replacement. These safeguards do not make the entire workflow atomic.

## Local concurrency regression test

The ordinary `npm test` runs single-connection PGlite tests; it skips the opt-in real PostgreSQL tests. For a real multi-session check, use an **empty disposable local PostgreSQL cluster and database** named `asinta_test_*`, with permission to create roles. The fixture creates roles at the cluster level and tables/functions in that database; never point it at a live or shared cluster. For example, after creating a fresh local database:

```sh
FOUNDER_GUARD_TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:5432/asinta_test_founder_guard' \
  npx vitest run tests/founder-concurrency.test.ts
```

The suite requires a local host and an empty public schema, leaves its fixture in place, and must be run on a fresh database each time. It exercises real independent sessions; it is not a substitute for hosted Supabase/Auth verification or concurrency testing of the deployed complete workflow.
