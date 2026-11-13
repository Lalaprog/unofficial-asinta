# Integrated finance rehearsal (synthetic PostgreSQL only)

This is a **test harness, not an installation bundle**. Do not point it at a shared, hosted, development, staging or production database. Rollback does not prevent DDL locks, and the opt-in test creates fixture tables and roles in its target database. Use a newly created, empty, locally isolated PostgreSQL 17 database with a name beginning `asinta_test_`; dispose of it afterwards. The fixture is synthetic and is not a clone of Supabase or the target schema. See [release reconciliation](RELEASE_RECONCILIATION.md) for deployment blockers.

Example, assuming a local isolated PostgreSQL instance is already running and its owner can create databases and the fixture roles:

```sh
createdb -h 127.0.0.1 -p 55432 -U postgres asinta_test_finance_rehearsal
FINANCE_INTEGRATION_REHEARSAL_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/asinta_test_finance_rehearsal \
  npx vitest run tests/finance-integration-rehearsal-postgres.test.ts
```

Use a **fresh database for each run**: setup persists the synthetic base fixture and marker even though candidate and scenario transactions roll back. Do not share the server with valuable databases: the fixture may create cluster-wide roles. The test validates an `asinta_test_*` database name and empty public schema but this is only a guardrail, not proof of isolation. Never embed credentials in documentation, CI logs or committed URLs.

`node scripts/build-finance-integration-rehearsal.mjs` prints the rollback-only SQL; it accepts no arguments and has no commit/deployment option. A generator unit test checks the ordered source hashes and boundary; a PostgreSQL test checks the marker, failure rollback and success rollback. For the end-to-end synthetic scenario only, the test removes the *final* rollback from an in-memory copy, runs the transaction and explicitly rolls it back after assertions. Do not modify or repurpose the script to commit.

## Sequence under test

First the existing PR #103 rehearsal assembles the time/allowance, Supervisor foundation and RPC rollout; legacy atomic payroll freezes; and hosted-equivalent read-only weekly base. Then the following uninstalled drafts run in this exact order (see generator for authoritative paths and hashes):

1. `guard_legacy_bale_payment`, `weekly_payment_date`
2. `weekly_worker_generator`, `weekly_worker_approval`, `weekly_worker_paid_allocation`, `weekly_worker_draft_details`, `weekly_worker_draft_refresh`, `weekly_worker_return_to_draft`
3. `weekly_bale_schedule`, `weekly_bale_expiration`, `weekly_bale_release_list`, `weekly_bale_status_batch`, `weekly_bale_scheduler`
4. `attendance_history_time_batch`, `supervisor_leave_notification`, `project_paid_payroll_evidence`, `paid_payroll_adjustments`, `supervisor_payroll_preview`
5. `historical_paid_date_annotation`, `historical_settled_bale_evidence`, `historical_finance_evidence_review`, `historical_external_worker_payroll`, `supervisor_payroll_ledger`, `paid_period_assertion_adjustments`
6. `confirmed_rental_expense_link`, `project_cost_reconciliation_preview`

The SQL then performs selected function, internal-function privilege and table-grant checks before rollback. Each draft has its own preflight/postflight as well. The transaction-control scanner is a simple tripwire, **not a SQL parser**; changes to source inputs, role inheritance, function definitions and order still require review.

## What it proves and does not prove

The test exercises the combined installation and a synthetic operational flow rather than independently applying each candidate. It verifies missing-marker failure, rollback after a deliberately late collision, successful rollback and selected ACL/role failures. It checks worker gross and net in centavos, paid site allocation and history; a manual estimate with one confirmed rental and an excluded Bale-related expense; original paid voucher preservation after an externally settled correction case; two-site Supervisor attendance, leave summary/review and one company-wide payroll ledger; and direct invocation of overdue request expiry twice. Its SQL and business fixtures are rolled back and selected base-table fingerprints are compared.

This does **not** install any database objects, activate feature flags, create a schedule, transfer money, send messages, verify actual accounts or prove live RLS, recovery or concurrent operation. The manual cost choices are not persisted or authoritative. The single expense exclusion is a human decision, not automatic duplicate detection. Other candidates including assignment history, owned equipment and category catalog are not part of this sequence. Selected denial checks and fingerprints are not exhaustive. The marker, name check, tests and SQL tripwires do not authorize using the script against any shared or hosted database.

Before any real installation: separately reconcile the exact hosted catalog, existing functions, grants, policies, migration history, active/old clients and data; review all interacting drafts and lock orders; test restore/recovery and isolated target-compatible cutover; then explicitly plan and authorize deployment. No `supabase db push` or stale generated installation bundle is implied.
