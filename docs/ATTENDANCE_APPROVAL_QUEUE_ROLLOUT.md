# Attendance approval queue rollout

The Founder approval banner now queries `pending_attendance_approvals` directly,
using the signed-in user's permissions and keyset pages. It is separate from the
shared, response-limited attendance store. The function is read-only and uses
`SECURITY INVOKER`, plus an explicit Founder check; it does not change rows or
relax table RLS. Matching retains the existing self-recorded, review-note,
Supervisor-position and Supervisor-account/name heuristics. These are heuristics,
not a new explicit review workflow.

## Deployment order

1. Review the migration `supabase/migrations/20261103000000_pending_attendance_queue.sql`
   and check the deployed policies and grants. Test on an isolated database first.
   The migration creates an index and function, so plan for database load/locking
   on large attendance tables. It does not perform attendance-data updates.
2. Apply that **individual migration** through the normal authorized migration
   process **before** deploying the app. Do not rerun a whole upgrade bundle
   casually: it includes financial-write changes with their own rollout and
   reconciliation requirements. No hosted database was changed by this PR.
3. As an authorized Founder, verify the function exists and has the expected
   grants. On a test dataset, compare its count and all pages with a direct query,
   including old pending logs; verify a Supervisor and anonymous client cannot
   call it. Confirm the hosted table RLS/grants actually match expectations.
4. Deploy the application, open Attendance as Founder, and verify loading,
   refresh, pagination and error/retry. A missing migration or rejected query is
   displayed as an error rather than as an empty approval queue. Test decisions
   only on records that may safely be changed. Check Supervisor access separately.

The count is a snapshot of the last request, not a live subscription; refresh if
another user may have changed records. Concurrent review actions remain the
existing direct update behavior and are not protected against two Founders
reviewing the same record at once. The history tab, workforce lists, roll-call
and payroll still use the shared store and may omit records beyond its response
limit. The new approval queue **does not fix payroll computation or guarantee a
complete payroll run**. Treat server-side history and safe payroll data loading
as separate necessary follow-up work.

If the application must be rolled back, reverting the UI leaves the read-only
function and index unused. Removing them requires an authorized database change;
never modify production data or apply a migration solely for this check without
approval and a recovery plan.

For a read-only existence/grant check in an authorized SQL console:

```sql
select to_regprocedure('public.pending_attendance_approvals(date,uuid,integer)') as queue_function,
       has_function_privilege('authenticated', 'public.pending_attendance_approvals(date,uuid,integer)', 'EXECUTE') as authenticated_execute,
       has_function_privilege('anon', 'public.pending_attendance_approvals(date,uuid,integer)', 'EXECUTE') as anon_execute;
```

Run this only after the function exists: `has_function_privilege` errors if it
is missing. Expected grants are authenticated `true`, anon `false`; that check
alone does not validate RLS or prove the function returns correct live data.
