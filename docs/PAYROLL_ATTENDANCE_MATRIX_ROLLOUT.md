# Payroll attendance matrix rollout

This Founder-only, display-only matrix uses the same selectable start/end dates
and site as the payroll generator. Defaults are the seven calendar dates through
today in Manila. Loading does not generate or review payroll, edit attendance,
transfer money, or change payment safeguards. It reads a bounded, server-side,
RLS-respecting snapshot; it is not the same snapshot subsequently used for a
payroll run, so data can change between loading, printing and generation.

The all-sites view includes all active workers and any inactive workers with
attendance in the selected period. In a single-site view, the app has no crew
roster, so it includes only workers with at least one attendance record at that
site in the period, including inactive workers; workers with no site records
cannot be inferred. A blank day is **unmarked in the selected scope**, not
absent or proof of expected work. Multiple same-day site records remain separate,
including contradictory statuses. Matrix entries represent recorded statuses,
not payroll eligibility or Founder review. Supervisor records can be held from
payroll by existing logic. Current rates and exact-period saved gross/net voucher
amounts are shown only in the app, not calculated from the matrix. Voucher
amounts may cover multiple sites, be stale, or be duplicated; duplicates are
flagged instead of choosing one. Existing payslip printing is separate.

**Print attendance only** builds a separate document from an explicit
attendance-only projection: names, positions, dates, statuses and site names.
It does not serialize the app screen, current rates, vouchers, deductions, Bale
or notes. It uses seven-date landscape sections, repeating worker names. Browser
pop-ups must be allowed. Use this button, not the browser's general Print command
on the payroll page; the latter may include on-screen financial information.
Check the preview before sharing or printing.

Limits: up to 93 days, 10,000 attendance rows, 10,000 worker-date cells, 10,000
period vouchers, and an 8 MiB response. A limit fails closed with a message to
narrow the range or site, rather than presenting partial data. Even bounded
queries may scan many rows; benchmark with a large production dataset. The site
picker still uses the capped shared project list. Missing/changed RLS policies
can alter visible data. This view does not make the shared store or other
attendance screens complete.

1. Validate schema, Founder policies, SELECT grants and size on the target.
   Apply **only** `20261103000004_payroll_attendance_matrix.sql` before the UI.
   It creates one `SECURITY INVOKER` function and grants execute to authenticated;
   it creates no index and changes no attendance/payroll/advance rows. Do not
   blindly apply the entire upgrade bundle or run `supabase db push`—hosted
   migration versions differ and other financial migrations require separate
   review.
2. Confirm the function exists, is invoker, denies anon execute, and DB/REST are
   healthy. Validate actual signed-in Founder and Supervisor sessions without
   modifying live financial records. An unavailable function produces an error,
   not a false empty matrix.
3. Compare both scopes, inactive and unmarked workers, same-day multi-site
   entries, selected dates and saved vouchers to an authorized source. Check
   mobile scrolling and landscape print preview, especially long periods and
   names. Verify the printed document contains no rates, wages or Bale. Recheck
   the current data before any intentional payroll operation.

A UI rollback leaves the unused read-only function; dropping it is a separate
operation. Payroll generation's concurrent writes and audit behavior remain
outside this change, as do physical-device, printer and live-role validation.
