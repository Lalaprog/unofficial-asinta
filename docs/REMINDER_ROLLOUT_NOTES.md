# Automatic reminder rollout notes

The combined reminder feature is **not finished or enabled** by this change.
The existing scheduler remains SMS-only. A staged settings foundation adds a
Founder-only saved master and channel preferences, with a database constraint
that forces the master OFF until a separately reviewed rollout. The cron checks
both the server switch and saved master/SMS settings, failing closed on missing
or unreadable settings. No settings UI or automatic email delivery is present.
Editing or previewing the reminder email template does not send a message.

## Remaining work before the Founder switch is usable

- The default-off, Founder-only settings storage and API exist as a foundation;
  activation is deliberately blocked at both API and database level. Build the
  settings UI and unlock it only alongside complete delivery safeguards. Preserve
  manual sends and invoice-level pauses; show both-channel and SMS cost warnings.
- SMS eligibility rejects unreadable amounts, unrecognized statuses and invalid pause dates instead of assuming an unpaid, unpaused invoice. Correcting a skipped slot may not make it retry that same day. This is a safety layer, not completion of the delivery pipeline.
- Connect the switch to **both** dispatch paths. Recheck the master and channel
  before each new send; work already in flight may finish. Treat unreadable
  settings as off, not as permission to send.
- Wire up SMTP reminder delivery with authoritative invoice data, the saved
  reminder email, provider readiness checks, attempt logs and unique per-channel
  dispatch records. Do not call SMTP or PhilSMS in tests except through mocks.
- Use Manila business hours and the approved schedule: three days before,
  the due date, three days after, and weekly. `latestReminderSlot` is a tested
  *planning helper only*: it selects the most recent slot on a catch-up day,
  keeps the original scheduled date for idempotency, and excludes slots before
  a channel was enabled. It is not connected to the current cron. Confirm the
  handling of pauses, recent manual/scheduled sends, changed due dates, and
  channel re-enablement before using it in production.
- Prevent duplicate sends across overlapping jobs, use cautious handling of
  uncertain provider outcomes, impose provider-aware limits, and show useful
  failure/readiness states. Avoid sending a backlog burst after downtime.
- Verify whether an external scheduler actually exists and its frequency.
  Environment variables and a working endpoint alone do not schedule calls.
  The existing server switch was observed OFF during development; do not turn
  it on or issue a real message without separate authorization.
- Keep hosted and local migration histories distinct; inspect each additive
  migration before rollout. Never blindly apply the whole migration queue.

- Vercel project metadata on 2026-11-06 listed no configured cron definitions. This does not rule out an external scheduler; check separately before activation.
