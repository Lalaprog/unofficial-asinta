# Payroll input snapshot rollout

## What this change does

`20261103000002_payroll_input_snapshot.sql` installs a read-only, Founder-only, security-invoker RPC. Each request reads the selected attendance period/site, active workers with attendance, all supervisor identities, outstanding advances, and exact-period existing vouchers from one PostgreSQL statement snapshot. It is subject to existing table grants and RLS; complete results depend on Founder SELECT policies actually permitting all relevant rows. It does not create or modify attendance, vouchers, advances, or payments.

The app fails closed if the RPC is unavailable, rejects invalid results and duplicate worker/period vouchers already present, and never falls back to the shared browser store to calculate a run. It checks voucher status when updating and preserves other deductions in recalculated net pay. Preview counts and project options are still based on the shared, potentially capped store. Existing calculation rules still apply, including site-scoped recalculation of the same worker-period voucher and the existing attendance/supervisor rules.

Limits: 10,000 attendance rows, 2 MiB attendance notes, 10,000 relevant active advances and 10,000 relevant exact-period vouchers; total response JSON is capped at 8 MiB. Limit errors produce no vouchers: choose a narrower period or site and review the implications of site-scoped runs first. Large inputs may still use database resources before rejection; monitor performance. No pagination occurs inside the calculation snapshot.

## Important limitations

- **This is not an atomic payroll run.** Inputs can change after the read. Concurrent runs can both insert duplicate worker-period vouchers; no uniqueness constraint is introduced. Multiple updates and audit entries remain separate requests, so failures or interruptions can leave partial work or missing audit entries. A status condition avoids an update when that status changed, but is not a general concurrency/version lock. Avoid simultaneous attendance/advance edits, approvals and payroll runs; review all resulting vouchers before approval/payment.
- A write may have succeeded even when the client reports a network error or an incomplete returned batch. Do **not** blindly retry: refresh, inspect the ledger and audit trail, and reconcile first. The ordinary ledger view itself is also subject to the shared-store cap.
- Site-scoped generation can overwrite the same worker-period draft for another site; it is not a separate voucher per site. Supervisor matching and daily-credit calculations preserve existing rules. This does not add an attendance matrix, universal attendance review, or solve roll-call completeness.
- Existing payment/status safeguards are separate. Confirm their own migration/reconciliation before relying on them. This change does not deploy them.

## Rollout and checks

1. Confirm the target project's six tables have the expected columns, RLS enabled, authenticated SELECT grants and unrestricted Founder SELECT policies; check DB/REST health. Test on a separate environment if available. The connected project may have live migration versions that differ from repository filenames: reconcile migration history before any normal `supabase db push`. Never blindly apply the whole upgrade bundle to an existing project.
2. Apply **only** the new migration after review. It adds/replaces a function and grants authenticated execution; it performs no data updates. Verify it is STABLE, SECURITY INVOKER, has an empty search path, authenticated EXECUTE and no anon/PUBLIC EXECUTE. Verify Founder and Supervisor behavior with signed-in sessions; SQL admin/role simulation is not end-to-end.
3. Deploy the app only after the RPC is available. Before deployment, the previous app keeps using the old loaded-store calculation. If an updated app reaches an old database, generation is blocked rather than falling back. Roll back application code if needed; dropping the function while updated clients are active will block generation.
4. For a real period, first coordinate a quiet window with anyone changing attendance/advances/payroll. Compare server-backed attendance with the intended dates and sites; inspect existing vouchers before generating. Check the preview explains loaded-only counts, then carefully review each draft, rates, days, deductions and site scope against source records. Do not approve/pay solely because generation succeeded. For empty/no-matching data, confirm it says no attendance; for any error, reconcile before retrying.

Automated tests use isolated PGlite/mock data, not hosted multi-session concurrency or real-data verification.

### Hosted deployment record (2026-11-03)

The read-only function was applied to the connected `unofficial_asinta` project before the app rollout. Supabase recorded version `20261103105347`, whereas the repository migration is `20261103000002`. The earlier queue/history versions also differ from their repository filenames. Do not reapply this migration or run `supabase db push` until migration history has been reconciled. Structural/grant checks and an admin-context read-only smoke test passed; a real authenticated Founder/Supervisor app session has not been tested. No payroll or attendance records were changed by this migration.
