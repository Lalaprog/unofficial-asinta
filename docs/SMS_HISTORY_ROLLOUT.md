# SMS history rollout

The Founder dispatch log reads server-side keyset pages rather than the shared
store's capped SMS subset. Search is case-insensitive literal substring search
(including `%` and `_`) across recipient, phone, message and visible invoice
number. Status and inclusive date filters use Manila calendar dates. Simulations
are separate from failed attempts. The two summary counts are global, not
filtered; total includes simulations and delivered excludes them. Sent means
provider acceptance, not confirmed delivery.

Pages are not a transactionally frozen snapshot: an insertion, deletion or
status update between requests can shift which rows match. Refresh reloads the
first page and counts; it also happens after each composer send attempt. Loading
more and searching do not send SMS. Full message/provider details remain in the
expandable row. The invoice join respects invoice RLS: hidden/deleted invoices
cannot be searched by number and their number is not displayed. The invoice
composer still uses the shared capped invoice/client/project store and is not
made complete by this change.

Both functions are `SECURITY INVOKER`, explicitly require a Founder, and rely
on existing SELECT grants and RLS. They only read. Search and exact global
counts may scan many rows, so benchmark on large datasets; a bounded response
is not a bound on query work. Changing RLS/grants can alter results. The index
build uses a normal `CREATE INDEX`, which can block SMS inserts during the
build: check table size and activity, arrange a quiet window if necessary.

1. Review `20261103000003_sms_history.sql` and validate policy/grants and index
   build risk on the target. Apply **only this migration before the UI**;
   do not casually apply the entire upgrade bundle or run `supabase db push`.
   Existing hosted migration history differs from repository filenames and
   other migrations have independent rollout risks. Do not create test SMS
   rows or send real messages merely to verify this change.
2. Verify the index is valid, both functions are invoker and executable by
   authenticated but not anon, and the Founder/RLS policies are in place. Test
   with actual Founder and Supervisor sessions when available. A missing or
   unauthorized function shows an error, not a false empty history.
3. Check search (including literal special characters), status/date filters,
   expanded messages, load more, refresh, simulated vs real failures and the
   global counts. Validate on mobile and desktop with existing data. Do not
   retry an unconfirmed message until checking the provider; a refresh or
   absence of a log is not proof that a send did not occur.

A UI rollback leaves read-only database objects unused. Removing them is a
separate database operation. There is no change to dispatch or provider logic.
