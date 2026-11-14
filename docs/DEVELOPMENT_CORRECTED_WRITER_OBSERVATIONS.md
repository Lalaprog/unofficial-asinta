# Development corrected-cost writer observations

These are point-in-time, read-only observations on the development project on 14 November 2026, **not permission to install** the held corrected-review artifact or a complete writer/security audit. Migration history differs from this repository; do not use `supabase db push` or the old generated bundles. The held artifact has a manual stop and the selected-writer check described in `supabase/preflight/development-corrected-writer-audit.sql` cannot freeze function definitions or detect every writer.

## Selected table privileges and triggers

Catalog queries inspected the nine public tables named in the selected-writer preflight: `expenses`, `confirmed_rental_expenses`, `weekly_worker_paid_allocations`, `weekly_worker_draft_sources`, `payroll_payment_dates`, `historical_worker_attributions`, `historical_worker_attribution_sites`, `paid_payroll_adjustment_cases` and `paid_period_assertion_cases`. All were owned by `postgres` with RLS enabled. For table-level INSERT, UPDATE, DELETE and TRUNCATE, effective privilege checks showed:

- `anon`: none on all nine.
- `authenticated`: INSERT, UPDATE and DELETE on `expenses`, but no TRUNCATE; none of those four on the other eight. RLS and assurance still determine ordinary authenticated access.
- `service_role`: all four on `expenses`, `payroll_payment_dates` and `weekly_worker_paid_allocations`; none of the four on the other six. This role can bypass RLS. It is therefore a real privileged writer path, independently of the selected RPC list.
- `postgres` as owner had all four on all nine. Privileged operators can also change schema, grants or triggers.

No explicit column-level INSERT or UPDATE ACLs appeared on those nine tables in the inspected catalog. This is not a complete inherited-role, ownership, policy, trigger, view or security-definer analysis. Eight non-internal triggers were present: two on `expenses`, one each on `confirmed_rental_expenses`, the two historical attribution tables, the two case tables and `weekly_worker_paid_allocations`; no non-internal triggers were found on the other two. Trigger presence or names do not prove their behavior or that they prevent all privileged changes.

## Dynamic SQL survey

A textual search for `EXECUTE` followed by whitespace in PL/pgSQL bodies in `public` and `app_private` identified six functions. The four with payroll/project terms were `historical_external_worker_review`, `project_cost_review`, `record_project_cost_review`, and `supervisor_period_external_conflicts`; their observed dynamic statements called a review function or selected counts, rather than directly modifying the nine tables. The two other hits were `delete_team_profile_guarded` (dynamic reference-existence SELECT) and `rls_auto_enable` (event-trigger DDL enabling RLS). This survey does not cover other schemas/languages, dynamic indirection that does not match this expression, extension code, future changes, callers, trigger effects, or arbitrary owner/service activity. It is not evidence that all writers have been found.

## Consequences for corrected review

The corrected-review ledger rechecks a snapshot but does **not** lock every source writer until commit. A source can change between recheck and commit or immediately afterward; freshness is advisory, and a saved illustration is not a complete ledger or proof of payment. The selected function guard is also a point-in-time check, not a DDL lock. Confirm actual writers and role inheritance, review indirect/trigger/privileged/DDL paths and lock ordering, and coordinate a quiet migration window before even considering installation. Rehearse the exact final artifact in a hosted transaction that rolls back, verify the target and compatible client/backend and preserve the default hold until the operator's checks are satisfied. Test authenticated flows separately; never interpret the synthetic PostgreSQL checks as hosted Auth/PostgREST verification. Cross-site reallocations into a site without an included original remain blocked.
