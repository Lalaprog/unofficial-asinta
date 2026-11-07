# Reminder notes — manual sending only

Automatic reminders are **on hold** at the user's request. The Founder continues to review and send email or SMS manually. The existing bell and dashboard show overdue invoices; the Reminder Queue shows eligible upcoming, due and overdue invoices. These alerts do not send messages. The existing saved automatic-reminder master remains locked off.

The experimental open-session listener, automatic sender and team-access deactivation work have been removed from this PR. They were never activated or applied to the hosted database. Their earlier draft remains in Git history at commit `5885748` if the user asks to revisit it. Do not deploy or enable that work without a fresh review and approval.

## Keep the current workflow safe

- Manual request-for-payment email and SMS routes and their screens retain their existing behavior. Preview and confirmation remain important. If a provider result is unclear, check message history and the provider before trying again; acceptance is not proof of delivery.
- The existing manual sends do not use the experimental shared-contact locks. They use best-effort checks, not a guarantee against every concurrent update or duplicate.
- The original unused coordination SQL has been moved out of the normal migrations directory into `supabase/staged/`. It is **not** a deployment instruction and must not be applied without separate review. The hosted migration history differs from the repository; do not blindly run the migration queue against it.
- Team-account removal is unchanged: a protected historical link blocks deletion, but the account stays active. Do not interpret that safeguard as deactivation.

## If automatic sending is reconsidered later

First confirm the user wants it, keep it off during development, choose a suitable no-paid-infrastructure approach, and verify provider limits, duplicate and uncertain-result handling, notification behavior, old history, hosting/security and real-device behavior. A scheduler or a listener alone does not provide those safeguards. See `IMPROVEMENTS_AND_RECOMMENDATIONS.md` for options and limitations. No real messages, hosted changes or account actions without separate approval.
