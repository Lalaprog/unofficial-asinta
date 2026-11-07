# Automatic reminder rollout notes

The combined reminder feature is **not finished or enabled** by this change.
The existing scheduler remains SMS-only. A staged settings foundation adds a
Founder-only saved master and channel preferences, with a database constraint
that forces the master OFF until a separately reviewed rollout. The cron checks
both the server switch and saved master/SMS settings, failing closed on missing
or unreadable settings. Settings now lets a Founder save independent channel preferences, but the master switch stays unavailable and off. Email preparation loads and validates authoritative data without sending; it is not connected to the cron. Automatic email delivery is not present. Editing or previewing the reminder email template does not send a message.

## Remaining work before the Founder switch is usable

- The default-off, Founder-only settings storage and API exist as a foundation;
  activation is deliberately blocked at both API and database level. The staged
  settings UI saves channel preferences only; unlock the master control only alongside complete delivery safeguards. Preserve manual sends and invoice-level pauses; show both-channel and SMS cost warnings.
- SMS eligibility rejects unreadable amounts, unrecognized statuses and invalid pause dates instead of assuming an unpaid, unpaused invoice. After claiming a slot, it also rechecks prepared invoice, client, project, template and initial-email details, the sending window and saved settings. If details have changed or cannot be read, it skips instead of using the old message. Correcting a skipped slot may not make it retry that same day. These are best-effort checks, not locks: data or switches can still change after the last check (including during attempt logging), and a provider request already in flight cannot be recalled. They do not coordinate concurrent manual sends and do not complete the delivery pipeline.
- The reminder queue now checks the saved master switch rather than treating the server environment flag alone as proof that reminders are ON. An enabled master would still not prove that a scheduler is running; this display remains conservative. Invoice preferences, planned dates and incomplete histories are labelled accordingly. Manual sends remain separate.
- Connect the switch to **both** dispatch paths. Recheck the master and channel
  before each new send; work already in flight may finish. Treat unreadable
  settings as off, not as permission to send.
- Wire up SMTP reminder delivery with the new no-send preparation helper, provider readiness checks, attempt logs and unique per-channel dispatch records. Preparation uses authoritative invoice, client, project and saved-template data and a best-effort change fingerprint; it does not lock data or authorize sending. Manual payment-email timeouts are shown as unconfirmed and are not retried with the same key. Unknown historical failed rows may still include ambiguous outcomes. Do not call SMTP or PhilSMS in tests except through mocks.
- The hosted channel-epoch migration adds server-controlled effective-enable timestamps for future catch-up decisions. Selecting a channel while the master is off does not start its epoch. Both epochs reset when the master is turned off, and each channel resets independently when disabled. A separate staged invoice-epoch migration captures eligibility and due-date changes and conservatively seeds existing rows at migration time; it is not hosted. The scheduler reads neither yet; the master remains locked off.
- Use Manila business hours and the approved schedule: three days before,
  the due date, three days after, and weekly. The user approved a conservative catch-up policy: select the latest missed slot; skip a slot if a channel,
  invoice or due-date schedule became eligible at or after 8 a.m. that Manila
  day; respect pauses; do not send a slot already covered by a contact; wait at
  least 24 hours since another contact on the same channel; and block on unresolved attempts. Email and SMS are independent and may both send for the same slot. This
  policy is NOT connected to cron. The staged invoice timestamps and contact-history aggregate require a coordinated deployment and a complete history/recovery review; client-only SMS and historical ambiguous rows remain gaps.
- A staged, **not hosted or wired** `reminder_delivery_coordination` migration
  and RPC wrapper provide one reservation per invoice and channel shared by
  manual and automatic requests. It deliberately does not expire reservations:
  crashes or unconfirmed provider results block that channel indefinitely.
  A safe, usable human review/recovery workflow is needed before integration;
  simply releasing an old claim can duplicate an in-flight send. The staged version now retains attempts after invoice deletion and blocks deletion while a channel has an active or unconfirmed attempt. This deliberately changes invoice deletion behavior and needs product/rollout review before deployment. Callers must reserve before any provider I/O, settle only known
  outcomes, handle lost RPC responses as unconfirmed, and use durable per-attempt
  IDs. Client-only SMS without an invoice, other sending paths, cross-channel
  timing, already-open deployments, and provider-side retries do not magically
  coordinate with this foundation. A reservation alone does not prevent a later
  send of a different slot or protect invoice changes during provider I/O.
- Prevent duplicate sends across overlapping jobs, use cautious handling of
  uncertain provider outcomes, impose provider-aware limits, and show useful
  failure/readiness states. Avoid sending a backlog burst after downtime.
- Verify whether an external scheduler actually exists and its frequency.
  Environment variables and a working endpoint alone do not schedule calls.
  The existing server switch was observed OFF during development; do not turn
  it on or issue a real message without separate authorization.
- Keep hosted and local migration histories distinct; inspect each additive
  migration before rollout. Never blindly apply the whole migration queue. The
  staged coordination SQL has been tested only in disposable databases; it must
  not be applied to the hosted project until the integrated paths and recovery
  workflow are reviewed together.

- Vercel project metadata on 2026-11-06 listed no configured cron definitions. This does not rule out an external scheduler; check separately before activation.

## Additional staged work (not deployed or connected)

- A per-channel planner, a single-invoice integrated dispatcher and injected email/SMS delivery adapters implement the approved policy, log before provider I/O and recheck after logging. Tests use mocked providers and a disposable database; no route calls these adapters, and batching, scheduler and rollout authorization remain unfinished.
- Staged slot-claim and manual-review SQL add durable unique invoice/channel/date claims and an explicit, audited reconciliation decision. A reviewer must verify the provider outcome and that no sender is still running; the database cannot prove either, and incorrect review can cause duplicates. The UI/API and review of historical attempts do not exist. The staged retention design retains attempts, claims and reviews after a completed invoice deletion, but blocks deletion while an attempt is active or unconfirmed. Review the user-facing deletion behavior before deployment.
- The staged aggregate scans channel-specific recorded contacts and flags ambiguous historical attempts, but cannot see client-only messages with no invoice ID, old unsaved attempts or provider activity outside the app. Existing manual senders do not use reservations. It cannot yet be treated as complete or race-free history.
- No staged migrations in this section have been applied to the hosted database. Never run the full migration queue automatically.

- All new SQL, including the earlier unhosted coordination file, is in `supabase/staged/` rather than the migration queue. No hosted migration was applied. The integrated test uses PGlite plus mocked providers; real PostgreSQL concurrency tests cover reservation/deletion, but do not prove hosted Auth, PostgREST, provider or scheduler behavior.

## Team-access review snapshot (2026-11-07)

Read-only hosted metadata showed 23 authenticated-accessible public relations with RLS and assurance-based restrictive policies. Project worker assignments are SELECT-only to authenticated users; the users profile has an intentional own-profile bootstrap exception. Reviewed hosted financial definer functions checked `is_founder()`, and `visible_projects()` used the guarded role/scope helpers. Four receipt Storage policies used `is_founder()`. These observations are not a permanent guarantee: future grants, policies, definer bodies, exposed schemas, buckets and service-role routes require another review at deployment. Current worker-registration service calls can already be in flight when access changes; existing signed URLs and already-copied data cannot be recalled. The staged DB design and Auth-ban wrapper are not exposed or deployed, and real Auth ban/recovery is unverified.
