# Accessibility and workflow validation: current status

This is a working checklist, **not a WCAG 2.2 AA conformance claim**. Module usability changes have been implemented, but the complete authenticated interface, assistive technologies, staging integrations and real-user tasks have not yet been validated. Navigation grouping remains on hold.

## Checks performed in this pass

- Chromium headless: unauthenticated sign-in page at 1440×900, 375×812, 320×640 and 320×480 with reduced motion. Automated axe WCAG 2 A/AA, 2.1 A/AA and 2.2 AA tagged checks reported no violations on those rendered states; no document-level horizontal overflow was observed. The 320px width is a useful reflow proxy, not a substitute for actual browser zoom testing. Password visibility toggle was exercised. Real authentication, MFA and error recovery were not validated in this environment.
- The actual mobile launcher component was rendered inside a temporary isolated browser fixture (not an authenticated workspace): at 320×480 it scrolled to the last link, kept keyboard focus inside the dialog, wrapped Tab and Shift+Tab, closed with Escape and returned focus. It also opened at 375×812. A tagged axe scan of the fixture reported no violations. This does not establish that the full workspace is accessible.
- The launcher was later changed to a non-modal panel so the mobile dock stays usable; its earlier focus-trap results above describe the previous implementation. Current regression coverage checks Escape, focus return, gestures, and dock use, but is not a full authenticated accessibility audit.
- Automated regression tests check launcher dialog semantics, focus behavior and desktop resize; form errors preserve external descriptions; semantic status foreground/background token pairs meet a 4.5:1 contrast calculation. Token checks do not cover alpha, gradients, custom colors or every rendered state.
- Added a skip link, clearer keyboard focus styling, an operable scrollable launcher, improved sign-in field autocomplete/error announcement, and corrected the warning token's insufficient contrast on its standard background.
- Follow-up project pass: rendered the real project list/create and detail/edit components in an isolated Chromium fixture with synthetic in-memory data and network calls disabled. At 320×480, 375×812 and 1440×900 the list had no document-level horizontal overflow; tagged axe checks reported no violations on the list or the sampled create/edit dialogs. Exercised missing fields, date-order validation, zero budget and a simulated create. This did not test real authentication, storage, permissions, failure recovery or a complete keyboard/screen-reader audit.
- Fixed project form date, field validation, in-flight locks and deletion confirmation issues found by inspection; local component and helper tests cover synthetic success, invalid input, pending operations, zero-row responses and lost responses. Remaining low-contrast focus rings found by source inspection were strengthened. These targeted checks do not establish cross-module conformance.

## Remaining: authenticated staging and user review

Use disposable data and **a designated staging project** with explicit authorization. The connected project may contain real records; do not create, mutate or delete data there merely for testing. Apply and verify migrations per the payroll and team operations guides; coordinate SMS, email and scheduled jobs so tests cannot send real messages or pay anyone. Do not assume production rollout from merged code.

For each role and each module below, run at least one ordinary task, one invalid input path, one failed/slow response and a recovery path. Record date, role, viewport, browser/OS, steps, expected vs actual, severity, owner and evidence (redact personal/financial data). Confirm success against saved data and audit/logs rather than the toast alone. Avoid duplicate sends or payments when an outcome is uncertain.

| Module | Representative tasks still to validate with signed-in users |
| --- | --- |
| Dashboard | Desktop alignment, liked mobile layout, project filter including attendance-linked payroll, daily/7-day indicator and reduced-motion behavior. |
| Projects | Create/edit, project filter, cost and detail navigation; supervisor assigned-site permissions. |
| Invoices | Create/edit, payment status, reminders, failed send and duplicate prevention. |
| Expenses | Record/edit, receipt attachment, AI suggestions versus saved values, validation and save failure. |
| Attendance | Supervisor site selection, roll call, history and corrections, offline/failed refresh behavior. |
| Payroll | Draft/review/approve/pay with authorized staging data; concurrent and failed payment, balances, audit and reconciliation. No real payment. |
| Bale requests and advances | Supervisor submission, Founder review/issue, same-site batch approval, rejection and uncertain payment recovery. |
| Tools/inventory | Create/edit, quantities, conditions, assignments and failure recovery. |
| Clients | Required contact validation, create/edit, linked records and deletion protections. |
| Reminders and SMS | Pending/failed/simulation/sent labels, invoice eligibility, scheduling and provider-ambiguous outcomes; no real dispatch without permission. |
| Team Accounts | Founder and Supervisor access, role updates, transactional profile removal and Auth partial failures on disposable accounts; migration applied first. |
| Settings | Integration status and test controls, MFA/password flows, supervisor profile and no unintended billable sends. |

Across the modules, test desktop, tablet and phone widths; 200% and 400% browser zoom/reflow; keyboard-only operation and visible, unobscured focus; screen-reader landmarks, errors, live updates and dialogs; text and non-text contrast in actual states; touch targets; and reduced motion. Test dialogs at short landscape heights. Validate useful task completion with at least one Founder and one Supervisor where possible, without treating automated results as user feedback.

## Known limitations for follow-up

- The existing `InspectGuard` intercepts context-menu and some browser shortcuts outside form fields. This can interfere with browser/assistive workflows and should be reviewed with the product owner; it is not a reliable security boundary. This pass did not remove it.
- Only the sign-in page and isolated launcher/project fixtures were run in a browser here. There was no authenticated cross-module audit, real-user study, full keyboard/zoom/contrast audit, hosted migration verification or live provider test.
- Separate payroll/Bale reconciliation and rollout, SMS operations rollout, and team-account migration/Auth verification remain as described in their operations guides.
