# Automatic reminder rollout notes

The combined reminder feature is **not finished or enabled** by this change.
The current production scheduler remains SMS-only and uses the existing
server-level switch plus each invoice's own switch. The new email template is
for the future reminder feature; editing or previewing it does not send a message.

## Remaining work before the Founder switch is usable

- Persist a Founder-only master switch and independent email/SMS choices. Keep
  the default off; preserve manual sends and invoice-level pauses. Show when
  both channels are selected and that SMS may cost money.
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
