# Server-backed attendance history rollout

The Attendance History tab queries date/site groups and, when opened, their
records in bounded keyset pages. Site, status, date and literal worker/craft/site/
notes search are performed by PostgreSQL rather than on the shared-store subset.
Counts are for records matching the current filters in each sheet. The results
and counts are not a transactionally frozen snapshot across requests: concurrent
inserts/updates can change later pages. Use Refresh history when data may have
changed. Search and exact grouping may still scan many rows, so benchmark on a
large dataset; bounded responses do not imply constant-time database queries.

Both read functions are `SECURITY INVOKER` and respect deployed table RLS and
SELECT grants. Supervisors can only see assigned-site attendance. Their worker
policy may hide inactive worker details: the record can appear as “Worker
(details unavailable)” and cannot match a search by a hidden name or position.
The function does not bypass RLS to restore those details. Permissions must be
validated on the actual deployment, not inferred from local fixtures. The site
filter's dropdown still comes from the shared project store, so a site beyond
that store's response limit might not be listed there; its visible records can
still appear in All sites and may be searched by site name.

## Order and safeguards

1. Review and test `supabase/migrations/20261103000001_attendance_history.sql`
   against an isolated database and the deployed policy/grant configuration.
   The migration adds an index and read-only functions; it changes no attendance
   records, but creating the index can lock writes or consume resources on large
   tables. Arrange an appropriate window and recovery plan.
2. Apply that **individual migration before deploying the UI**. If merge causes
   automatic deployment, coordinate this before merging. Without the function
   or grants, history shows an error and retry—not an empty result. Do not rerun
   the complete upgrade bundle casually; it contains financial migrations with
   their own rollout requirements. **Do not run `supabase db push` blindly:**
   hosted migration-history versions already differ from repository filenames.
3. Verify the functions and index exist, the index is valid, authenticated users
   have EXECUTE, anon does not, and they are invoker functions. Test real
   Founder and Supervisor sessions with assigned and unassigned sites; compare
   all pages and counts against an authorized source, including old records,
   same-date sites, search, leave and inactive workers. Do not change live rows
   solely for testing.
4. Deploy the app, check History loading, filtering, paging, error/retry and
   refresh. Check Founder review/override only on records intended for change.

A UI rollback leaves the read-only database objects unused; removing them is a
separate authorized database operation. No hosted database changes are made by
this PR alone.

## Not solved here

Payroll generation, daily roll call, project workforce logs and other screens
still use the shared client store and may omit records; this PR does **not**
make payroll calculations complete or safe. Existing Founder review/override
writes are not protected against two users editing the same record concurrently.
The Founder approval queue is separate and follows its own existing heuristics.
