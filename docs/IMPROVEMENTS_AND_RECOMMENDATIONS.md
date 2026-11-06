# Improvement roadmap

A plain-language record of work still to consider. This is a planning document, not a promise that every recommendation has been implemented. Do not enable message sending or change real financial records merely to test an item.

## Agreed final-stretch work

- [ ] **Founder-friendly message templates:** The existing request-for-payment email editor and its one-time invoice message editor now use readable fields while preserving saved templates. Invoice email edits must be previewed again before confirmation. Still add a saved, previewable SMS template and appropriate templates for automatic reminder emails. Previews must not send messages, and missing important invoice details should be called out.
- [ ] **Optional project photos:** Let authorized users upload, replace and remove a project image. Keep the preferred blueprint as the default, with legible text, appropriate private access, storage limits and mobile layouts.
- [ ] **Automatic invoice reminders:** Provide one persistent Founder master switch for email and SMS, retaining invoice-level controls. Target three days before, on the due date, three days after, then weekly; Monday–Saturday, 8 a.m.–6 p.m. Manila. Handle dates outside the window without missing or flooding, check scheduling/provider constraints and costs, expose readiness/failures, and guard duplicate sends. OFF prevents new sends; work already in flight may finish. Keep automatic sending OFF during tests; do not send real messages without approval.
- [ ] **Final UI and empty-state audit:** Distinguish no records, filters with no results, loading and errors; offer actions appropriate to each role. Remove redundant development-oriented explanations and model configuration from everyday screens while preserving essential safety warnings and useful controls. Preserve the liked dashboard mobile view.
- [ ] **User's real-world checks:** On real devices, check saved expense draft/photo recovery and receipt scanning, and review AI suggestions against the actual receipt. The user will handle real-data testing and report issues.

## AI follow-up

- **Receipt AI cooldown:** This work adds an advisory provider-reported retry interval when available, without automatic retries. It is not a guarantee that Groq will be available afterward; real-provider behavior still needs a real-world check.
- **Text AI backup:** GPT-OSS 20B could be tested as a text-only fallback, but is not an automatic backup today. Do not present it as a receipt-image reader or assume independent quota without checking the account.

## Later recommendations — not scheduled for implementation now

- **IT troubleshooting tracker:** Consider a private, low-maintenance place for technical status, failed integrations, model identifiers and actionable diagnostics. Decide access and format before building; never expose credentials or sensitive financial data. It should not add clutter to the Founder's ordinary screens.
- **Multiple-receipt queue:** If entering several receipts becomes frequent, consider selecting multiple photos and processing one at a time with separate review. Current draft storage supports one expense draft, not a durable queue. Design safe partial failure and recovery before adding it.
- **Financial consistency:** The invoice email preview is rechecked before sending, but that check does not lock the invoice against a change during delivery. Expense writes and their audit entries are separate. Stronger transaction and retry safeguards, including more robust concurrent-tab handling and invoice payment protections, remain useful future work. Existing protections reduce risk but do not make every workflow atomic.
- **Receipt storage cleanup:** Discarded or interrupted drafts can leave unused private receipt objects. Any future cleanup must avoid deleting objects referenced by a recorded expense or an in-flight write.
- **Security and recovery checks:** Continue reviewing low-assurance sessions, storage access, recovery choices and future policies. Automated local simulations are not a substitute for hosted Auth/Storage and real-device checks.
- **Operational backups and historical reconciliation:** Verify backups include both database and private objects, and reconcile historical payroll/Bale data before relying on it. Do not reset or delete records without an explicit request.

## Already delivered

The dashboard project selector, initial email-template field insertion, expense item details and review, one saved expense draft per Founder, same-page receipt viewer, and clearer receipt-AI errors have been delivered. A saved draft is not a ledger entry; saving remains explicit. Do not reopen completed work unless a practical issue is found.

## Deliberately on hold

Reports and module reorganization remain on hold. Attendance marking is unchanged. Do not add paid infrastructure, send live messages, or create fake financial transactions to test these ideas.
