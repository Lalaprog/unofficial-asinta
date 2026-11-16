# Testing guide — development release, 16 November 2026

This is the practical checklist for the promoted development site. It is written so your findings can be fixed without follow-up questions. It is **not** a launch or turnover checklist: there is still no verified backup, and the project-cost total is not yet fully automatic.

## Ground rules

- Use only the **TEST ONLY Client / TEST Site A, B, C** records. They are fictional development data.
- **Do not send real messages or make real payments.** The app records assertions ("external payment recorded") but transfers no money. Do not hand workers cash based on a screen.
- Do not delete records to "clean up" a failed test. Note the IDs instead; cleanup is handled separately.
- Never paste passwords, temporary passwords, or API keys into chat. If you need to share a screen, hide credentials.
- If a **money amount, deduction, or approval** looks wrong: stop that workflow, do not retry the payment, and record the exact voucher/project ID, timestamp, and what you expected. A retry after an unconfirmed result is the main way test data gets duplicated.
- Each session below is 15–25 minutes. You do not have to finish everything in one sitting.

## Environment

- Site: `https://unofficial-asinta.vercel.app/` (also `www.bale.com` / `bale.com`)
- Build: `58e6d15`, promoted 16 Nov 2026. Older tabs keep old code — **hard-refresh or open a new tab** before testing.
- Accounts: your Founder account, and the existing Supervisor account linked to the "Sherwin" workforce profile. If the Supervisor cannot sign in, report that as a blocker rather than creating a new account.
- Use two devices where possible: desktop browser and your phone.

### What is already in the development database

| Item | Current state |
| --- | --- |
| Client | TEST ONLY Client |
| Sites | TEST Site A, TEST Site B, TEST Site C (all active) |
| Supervisor assignment | Sherwin → Sites A and B only |
| Workers | TEST Worker Alpha (Carpenter, ₱600/day, Site A), TEST Worker Bravo (Mason, ₱650/day, Site B), TEST Worker Charlie (Laborer, ₱500/day, unassigned), TEST Worker Delta (Carpenter, ₱700/day, Site C), Sherwin (Supervisor profile) |
| Attendance | Alpha at Site A and Bravo at Site B, **25–30 October 2026** (Sunday–Saturday week of 25–31 Oct) |
| Expenses | 4 existing expense rows |
| Payroll / Bale / Invoices | **None yet** — you will create the first ones |

Because the only attendance is in the last week of October, the **current-week** payroll preview will look empty until you submit a new Roll Call. That is expected, not a failure.

---

## Priority 1 — blockers (do these first)

### T1. Sign-in, desktop (2 min)
1. Open the site in a new tab and sign in as Founder.
2. Expected: dashboard loads with navigation; no error banner.
3. Report: any error text, redirect loop, blank page, or a dashboard that never finishes loading.

### T2. Two-factor setup (5 min) — `Firm Settings` → security
1. Open `/settings` and find the 2FA/authenticator card.
2. Enrol, then sign out and sign back in with the code.
3. Expected: the app asks for the second factor and accepts a current code; a stale code is rejected.
4. Report: whether enrolment completed, whether recovery/skip is offered, and whether you can still reach Founder screens after signing in.
5. **Keep your authenticator working.** If enrolment fails halfway, tell me before trying again.

### T3. Wrong password and lockout (3 min)
1. Sign out. Try a wrong password twice, then the correct one.
2. Expected: a clear message, no account lockout you cannot clear, and the correct password still works.
3. Do not test lockout with the only Supervisor account repeatedly.

### T4. Session persistence on refresh (3 min)
1. Sign in, open a project, press refresh (F5), and open a second tab.
2. Expected: you stay signed in in both tabs; no "unauthorized" flash that blocks the page.

---

## Priority 2 — the core Founder loop

### T5. Dashboard and navigation (5 min) — `/dashboard`
1. Confirm the summary cards, project selector, and navigation menus open.
2. Check that the buyer-facing "More" gestures and the dashboard guide `?` still work on desktop and phone.
3. Report: any link that goes to a blank page, wrong role page, or duplicated entry in navigation.

### T6. Roll Call submit (10 min) — `Daily Roll Call` → `/attendance`
1. Select **TEST Site A**, date = **today** (Philippine date).
2. Mark Alpha present, leave one worker unmarked, and mark a second worker absent if shown.
3. Save a draft, refresh the page, and confirm the draft returns.
4. Submit.
5. Expected: submission succeeds once; the record appears in `History`; unmarked stays unmarked (not "absent"); a second submit of the same site/date is blocked or clearly warns.
6. Report: whether the draft survived refresh, whether the submit created exactly one record, and whether the History tab shows the same values.

### T7. Founder correction/backfill (5 min) — History tab
1. Open the submitted record and use the Founder override/correction path.
2. Expected: a reason/acknowledgement is required; paid or locked payroll dates refuse changes.
3. Report: whether correction was possible before payroll, and whether the screen blocked it after payroll (test that in T13).

### T8. Weekly payroll preview (10 min) — `/payroll` → **Weekly worker planning preview**
1. Choose a date in the **25–31 October 2026** week.
2. Click **Load preview**.
3. Expected: rows for Alpha (Site A) and Bravo (Site B) with 5 present days and illustrative gross around ₱3,000 and ₱3,250 using current rates. The panel states it is an estimate.
4. Check the warning list and note every "Net withheld — review" reason. Withheld net is a designed safeguard, not automatically a bug.
5. Then choose a date in the **current** week and load again.
6. Expected: limited or no rows except what you marked in T6.
7. Report: which dates, which worker, whether the numbers match your manual arithmetic (days × current rate + allowances − same-week Wednesday Bale).

### T9. Generate one weekly draft (10 min) — same preview, worker row actions
1. On an eligible row, open the weekly actions and generate a draft after reading the confirmation.
2. Expected: a draft voucher appears with a saved revision; nothing is paid.
3. Refresh the page and reopen the preview.
4. Expected: the draft is visible and consistent; regenerating does not silently overwrite without a refresh/review step.
5. Report: voucher ID, status, amounts, and any "outcome not confirmed" message. If you see an unconfirmed message, **do not click generate again** — record it and stop.

### T10. Approve the draft, then record an external payment (5 min)
1. Approve the draft. Confirm a separate confirmation is required to record payment.
2. Record a fictional external payment dated today, acknowledging no money moved.
3. Expected: status changes; the original amounts do not change silently; an approval alone does not mark it paid.
4. Report: the exact confirmation wording, and whether the payment date/amount were preserved.

### T11. Payslip printing (5 min) — `Print worker payslips`
1. Print preview for the period you used. Use "Save as PDF" rather than a printer.
2. Expected: only worker vouchers for that exact period; draft/approved stamps are visible.
3. Report: clipped text, missing amounts, pagination problems on A4.

---

## Priority 3 — money correctness

### T12. Expense entry with a receipt photo (10 min) — `Site Expenses & AI` → `/expenses`
1. Add an expense for TEST Site A: amount, date, category, vendor, description, one invented line item.
2. Attach **one** photo (a receipt you don't mind storing in the development bucket). Save.
3. Add a second expense with two photos to test multiple photos.
4. Expected: the expense appears in the ledger with the correct amount and photo count; totals increase by exactly that amount; a failed upload does not create a half-saved expense.
5. Report: whether the photo reopened after refresh, whether the amount was ever duplicated, and whether the AI suggestion was clearly labelled as a suggestion.

### T13. AI text draft (5 min) — same page
1. Use the AI/manual draft with a short invented expense description.
2. Expected: a draft appears for review; you must accept/edit before saving; nothing is saved automatically.
3. Report: any invented amount or vendor presented as fact, and whether you could discard the draft cleanly.

### T14. Project cost overview (10 min) — `Project Sites` → TEST Site A → `Overview & Summary`
1. Read the reviewed-cost summary and the separate expense total.
2. Then open the corrected cost review screen.
3. Expected: the screen says the amount is a reviewed component and can be incomplete; it must **not** claim a complete project cost. Empty older-pay/legacy sections are expected — there are zero older-pay attributions.
4. Report: any total that looks like it silently includes paid payroll, a rental, or Bale twice; any number shown without a review state.

### T15. Bale — record and check the weekly effect (10 min) — `Worker Bale` → `/advances`
1. Record a small fictional advance (e.g. ₱200) for TEST Worker Alpha on a **Wednesday** date in the current week.
2. Check the weekly preview for that week: the Bale should appear once and be deducted only under the agreed Wednesday/same-week rule.
3. Expected: the balance updates; no payroll is created; the Bale is not added to project cost.
4. Report: whether the amount, date, and worker were exactly as entered, and whether the preview deducts it more than once.

### T16. Bale request window (optional, 5 min)
1. As Supervisor, submit a Bale request if the window currently allows it (Sun–Tue); otherwise confirm the screen explains it is closed.
2. As Founder, approve or reject it.
3. Expected: no request can be approved outside the window; pending requests after Tuesday are clearly handled.
4. Report the exact status transitions you saw.

---

## Priority 4 — accounts, roles, and isolation

### T17. Supervisor sign-in and site scope (10 min, use the phone)
1. Sign in as the Supervisor.
2. Expected: only **Site A and Site B** appear; Site C is not selectable anywhere, including Roll Call, Bale, and project lists.
3. Expected: Founder-only pages (Payroll, Site Expenses, Team Accounts, Firm Settings, Dashboard) are not reachable.
4. Report: any Site C data, any Founder screen reachable by URL, or any menu item that fails with a permission error instead of being hidden.

### T18. Supervisor Roll Call (10 min)
1. Select Site B, today, mark Bravo and submit.
2. Expected: submission succeeds; the Supervisor cannot submit for Site C; drafts stay local until Submit.
3. Report: the same checks as T6, plus whether the Supervisor can edit a Founder-approved record.

### T19. Supervisor leave request (5 min)
1. Request leave with less than two calendar days' notice, then with valid notice.
2. Expected: the short-notice request is refused or flagged for emergency/Founder decision; the valid one appears to the Founder for approval.
3. Report: exact wording, dates, and whether approved leave shows as unpaid.

### T20. Account editing (10 min) — `/users` (Founder)
1. Open the Supervisor account, change only the display name, save.
2. Expected: the payroll roster is **not** silently renamed or re-rated; the app warns if the roster wasn't updated.
3. Reopen the same editor in two tabs, change one field in each, and save both.
4. Expected: the second save refuses with a "changed while editing" message rather than overwriting.
5. Report: whether the refusal happened, and whether the workforce row stayed intact.
6. Do not change the Supervisor's role, do not remove the payroll link, and **do not send a welcome email** during testing.

### T21. Add and archive a fictional worker (5 min)
1. Add a worker to Site C, then archive/remove them.
2. Expected: the worker can be restored; attendance/payroll history is not deleted; the login (there is none for workers) is unaffected.
3. Report any hard delete, missing restore, or lost history.

---

## Priority 5 — mobile, resilience, and wording

### T22. Phone layout for money screens (10 min)
Check `/attendance`, `/payroll` (weekly preview table), `/expenses`, `/advances`, and a project's `Overview & Summary`.
Expected: tables scroll horizontally without breaking the page; amounts stay readable; primary buttons are reachable with one thumb; nothing overlaps the bottom navigation.

### T23. Slow or dropped connection (5 min)
1. On the phone, put the browser in slow/offline mode, submit a Roll Call, then restore the connection.
2. Expected: an "unconfirmed" warning, not a silent success; retrying does not create duplicates.
3. Report the exact message and whether a duplicate appeared after reconnecting.

### T24. Refresh mid-form (5 min)
Start an expense, refresh, and reopen. Expected: the draft is restored or the app clearly says it was lost; no partial expense is saved.

### T25. Wording and dead ends (ongoing)
Note any screen that is self-contradictory, says "experimental" where it looks finished, hides the next required action, or uses jargon a site supervisor would not understand. Wording is cheaper to fix than code, so include it.

---

## What not to judge yet

These are known gaps, not test failures. Report them only if the behaviour is worse than described.

- **No automatic complete project cost.** The overview combines reviewed components and may withhold amounts; it can be incomplete by design.
- **No automatic Bale expiry alerts** from an independent monitor. The in-app job exists; external alerting is deferred.
- **No real money, SMS, or email.** Nothing in the app transfers funds. Email/SMS screens should not be used with real recipients.
- **AI is a suggestion only.** Accuracy on real receipt photos is not verified; F17-style checks only cover a fictional text draft.
- **Backup and restore are not done.** Do not enter anyone's real payroll, client, or receipt data.
- **Welcome email and first-login password change.** The welcome email is opt-in, unchecked by default, and sends a real email through the firm SMTP, so **skip it**: leave the checkbox off every time. The forced "Set Your Personal Password" gate is verified in code but is not device-tested, because testing it needs a newly created account and your existing accounts keep their logins. If you ever choose to test it, create a fictional account with a mailbox you control, never a real worker's address, and expect it to leave a real Auth account behind.
- **Chapters 4 screenshots and figure legibility** are your separate paper task.

---

## How to report a finding

Send one block per finding, in this shape:

```
ID:            (T-number, or NEW)
When:          date + time (Philippine time)
Role:          Founder / Supervisor
Device:        e.g. iPhone 13 Safari, or Windows Chrome 141
Screen:        URL and visible title
Steps:         1… 2… 3…
Expected:      what the app should have done
Actual:        exact message / number shown
Record ID:     voucher / expense / attendance ID if visible
Retried?       no / yes (what happened)
Screenshot:    attached or not
Severity:      Blocker / High / Medium / Low
```

Severity guide:
- **Blocker** — wrong money, data loss, duplicate payment record, cross-site access, cannot sign in.
- **High** — a core workflow cannot be completed, or a safeguard silently fails.
- **Medium** — completes only with a workaround, or a number is confusing but not wrong.
- **Low** — wording, spacing, alignment, minor visual issue.

If you are unsure whether something is a bug, report it as Medium and say "unsure". A short list of real findings is more useful than a long list of guesses.

## Fast path if you only have 30 minutes

T1 → T2 → T6 → T8 → T12 → T14 → T17. That covers sign-in/security, attendance, the weekly estimate, an expense with a photo, the cost overview, and Supervisor site isolation — the five areas most likely to hide a serious problem.
