# Supervisor project privacy: read-only assessment

Checked 2026-11-04 against project `mchkdkjntnbwrgmyobpd` and the app at PR #62. This is a targeted catalog and source review, not a full security audit or a signed-in live test. No live data or permissions were changed.

## Findings

- `clients` has row-level security enabled and its sole policy grants access to authenticated Founders through `is_founder()`. `invoices`, `expenses`, and `sms_logs` also have Founder-only policies in the inspected catalog. A table-level SELECT grant alone does not bypass row-level security.
- `projects` has row-level security enabled, with Founder access and a policy allowing a Supervisor to read assigned projects. The assignment helper checks the signed-in user's ID and project assignment.
- Authenticated users have SELECT access to all `projects` columns. The shared app store requests `projects.select('*')` for both roles. Consequently, a Supervisor can receive the `client_id` UUID and `budget_estimate` for an assigned project even though the project screen hides the client and financial sections. The UUID is an identifier, not the client's name or contact information; it can still link projects belonging to the same client.
- No public views or materialized views were found. A targeted catalog search for functions mentioning `clients` or `client_id` returned no matching public functions. This does not prove that other routes, dynamic queries, integrations, project names, addresses, notes, backups or cached data cannot disclose sensitive information.
- No signed-in Supervisor request was performed against the hosted API. Catalog inspection identifies configured access, but does not replace end-to-end verification or prove the absence of other exposure.

## Validation

The existing isolated tests `tests/project-policy-intent.test.ts` and `tests/project-supervisor-view.test.ts` passed (4 tests). They exercise the checked-in policies and mocked UI respectively, not the live API. The policy test deliberately demonstrates that an assigned Supervisor receives `client_id` and `budget_estimate` in the current design.

## Future fix: plan and precautions

A proposed fix and phased rollout are described in [PROJECT_PRIVACY_ROLLOUT.md](PROJECT_PRIVACY_ROLLOUT.md). Both the additive function and the Phase 2 column restrictions have since been applied. See the rollout document for verification and remaining signed-in checks.

Before any permission change, agree whether the client identifier and project budget must be hidden from Supervisors. A UI-only projection would reduce unnecessary data transfer but **would not** prevent an authenticated user from querying the base table directly.

A real restriction requires a coordinated app/database design. Founders and Supervisors both use the PostgreSQL `authenticated` role, so revoking a sensitive column from that role also affects Founders. The current shared store reads `select('*')`, and project creation/editing returns full rows. Other attendance and payroll read functions use project fields, and older tabs and integrations may use the base table directly. Do not revoke project SELECT access without adapting and testing those paths and planning the rollout. Any privileged Founder-only access must verify the caller server-side and avoid weakening existing project-assignment RLS.

Test using isolated synthetic data for Founder, assigned Supervisor, unassigned Supervisor and anonymous callers; exercise project list/detail, creation/editing, attendance, payroll matrix/snapshot and stale clients. Verify the live API with explicit permission and test records only after coordinating any potentially disruptive permissions change. Do not run a full upgrade bundle or blindly reconcile the existing hosted migration history.
