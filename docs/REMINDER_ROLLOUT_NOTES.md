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
- The channel-epoch migration adds server-controlled effective-enable timestamps for future catch-up decisions. Selecting a channel while the master is off does not start its epoch. Both epochs reset when the master is turned off, and each channel resets independently when disabled. The scheduler does not read these yet; the master remains locked off. Decide how to treat a scheduled slot on the same Manila day as activation before connecting them.
- Use Manila business hours and the approved schedule: three days before,
  the due date, three days after, and weekly. The no-send `planCatchUp` proposes
  a conservative policy: select the latest missed slot; skip a slot if a channel,
  invoice or due-date schedule became eligible at or after 8 a.m. that Manila
  day; respect pauses; do not send a slot already covered by a contact; wait at
  least 24 hours since another contact; and block on unresolved attempts. This
  policy is NOT connected to cron and needs review before use. It requires
  reliable server-controlled invoice eligibility and schedule-change timestamps,
  plus authoritative contact history; those sources do not exist yet. Historical
  failed records can include ambiguous attempts and need conservative treatment.
- A staged, **not hosted or wired** `reminder_delivery_coordination` migration
  and RPC wrapper provide one reservation per invoice and channel shared by
  manual and automatic requests. It deliberately does not expire reservations:
  crashes or unconfirmed provider results block that channel indefinitely.
  A safe, usable human review/recovery workflow is needed before integration;
  simply releasing an old claim can duplicate an in-flight send. Its attempt rows
  cascade if an invoice is deleted; review that retention/deletion choice before
  deployment. Callers must reserve before any provider I/O, settle only known
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
