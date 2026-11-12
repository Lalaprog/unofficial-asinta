# Coordinated release: current hold and path forward

This is a **development release procedure**, not evidence that payroll, Bale or equipment is client-ready. Update the observations below before acting; they describe one point in time and are not a live monitor. A complete tested recovery plan may be finished after development, but is required before real client data or handover.

## Why there is a mismatch

- The most recent promoted production deployment observed during this work was Vercel `dpl_42Pc27WkBPsauxUGnxFTYYrv7joD`, built from PR #102 commit `de736998acc8f58ea9dc28d0abdad4cf1cfb6e4e`.
- GitHub `main` was at PR #103 merge commit `db3d44436c5abbef1a1a8d5433a174b0dd4ca135`. A normal automatic deployment of current main could therefore replace the recovered site with a different version. Merging another PR can also trigger a production deployment.
- The development database has some, but not all, of PR #103's schema. Its weekly preview base exists; time-detail and Supervisor submission functions were absent on the latest read-only check. Migrations were partly installed under different hosted versions. Never infer migration state from filenames alone, rerun the original bundles, or blindly run `supabase db push`.
- UI flags in this draft are **not authorization, backend compatibility checks, or protection for old clients**. They hide unfinished screens when off; they do not make the underlying payroll generator correct.

## Temporary deployment hold in this branch

`vercel.json` configures `scripts/vercel-release-hold.sh` as Vercel's ignored build step. It permits preview/development builds and cancels production or unknown environments. Its effect is limited to deployments that actually include and execute this file. It is **not active on current main or the existing recovery deployment before this branch is merged**. A deployment from older commits, an edited/removed guard, or a forced redeploy/promotion may bypass it. The hold does not change database permissions or disable payments/messages. Vercel counts canceled builds against deployment quotas. Do not assume the existing site is protected by this branch alone.

The owner or release operator must also control Vercel's project-level deployment settings and avoid deploying current main/old commits until reviewed. This repository-level hold cannot replace that operational control. If system environment variables are not exposed, the script holds the build rather than guessing; a canceled build does not prove the application is safe.

## Staged path to a safe engineering merge and later release

1. **Inventory first.** Recheck exact production SHA, main and PR SHA, Vercel aliases/settings, feature-flag targets and the actual hosted DB catalog/permissions. Use aggregate, read-only checks; do not print credentials, insert demo records, or assume preview uses an isolated backend.
2. **Reconcile schema by exact state.** Map each required RPC/table/trigger to what is actually installed, including bodies, grants and dependencies. Prepare atomic, state-aware scripts and rehearse them in a disposable PostgreSQL 17 database. Skip or verify already-installed objects rather than replaying old migrations. Keep unfinished finance and equipment flags off. Review direct privileged and old-client paths independently of UI flags.
3. **Test the candidate, not just its build.** Verify Founder and Supervisor authentication/MFA, assigned-site access, existing dashboard/attendance/expense flows, old and new UI paths and error behavior on desktop and mobile. Do not perform real payments or send messages. A preview can use the same database; do not write new records without permission. Confirm the planned rollback target is still available and compatible with any DB changes.
4. **Separate merge from feature completion.** An engineering-only merge can be considered once the precise deployment behavior and current-compatible screens are verified, with unfinished work disabled and PR scope accurately stated. It is not approval to use payroll or equipment as a finished feature. The present PR remains draft until that release behavior is actually verified.
5. **Release deliberately.** Once candidate SHA and database are verified together, review and remove or replace the checked-in hold in an intentional release commit. Verify the actual Vercel production alias, the resulting commit, build settings and flags after promotion; keep a compatible rollback procedure. A forced deployment can skip the ignore step and must not be used as a shortcut around unresolved checks.
6. **Finish business requirements separately.** Weekly worker payroll, Bale timing/release and same-period deductions, paid-period corrections, Supervisor payroll, durable project costs, rentals and remaining workflows require implementation and end-to-end tests before client-ready claims. Preserve identity and financial history; corrections must not auto-carry forward.
7. **Before real data/handover:** test a private, access-controlled complete recovery procedure covering database, Auth identities, Storage objects and configuration, and verify a restore. The disabled public-repository workflow is not a backup; no verified live backup exists. Client transfer must exclude demo data and retain structure, roles and access.

Do not execute destructive cleanup without a separately confirmed scope. No real payment or message is authorized by this procedure.
