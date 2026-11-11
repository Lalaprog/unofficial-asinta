# Client change plan and deferred items

This is a working plan, not a statement that all features below have been delivered. The first batch only includes the items explicitly described by its PR and must not be treated as a payroll, attendance, permission or database rollout.

## Agreed rules for later implementation

- Workers: Sunday–Saturday period, normally paid on that Saturday. Supervisors: 1st–15th and 16th–last day of each month, normally paid on the period end. Manila dates; the schedule is not anchored to the launch date. The period helpers are not yet connected to payroll.
- Unmarked is not absent; the Founder may backfill recorded attendance. Warn when calculating an incomplete period. Historical paid records and Bale must not issue or deduct money again. Preserve the original paid record and resolve differences against the original period; never automatically carry them into another period.
- Regular hours and OT are separate; one day is eight regular hours. Requested OT is daily rate / 8 × OT hours; client should confirm applicable legal/payroll requirements before real use. Allowances submitted by a Supervisor require Founder approval; Founder can directly record them.
- Bale request and Founder approval Sunday–Tuesday; unapproved requests rejected after Tuesday. Wednesday release recorded by Founder or authorized Supervisor; full released amount for the period deducted from Saturday payroll. No new request/approval Wednesday–Saturday. An excess deduction needs Founder review, never silent negative pay.
- One general attendance record per Supervisor per day. Founder can approve even if project attendance is missing; show indicators for assigned projects. Normal leave requires two calendar days' notice in Philippine time; emergencies may be filed late, including past dates. Founder decides; approved leave is unpaid.
- Regular workers have one active project assignment; Supervisors may handle multiple sites. Restrict Supervisors' ordinary rosters to the selected authorized project; allow unassigned-worker discovery only when adding to an authorized project. Existing duplicates require review rather than silent changes. Founder manages worker categories.
- Project expenses include confirmed rentals and approved **and** paid worker payroll, without counting Bale twice. Determine worker cost attribution from the period's project work. Supervisor payroll remains a company cost, not a project cost for now.
- Founder-only expense creation and receipt uploads; multiple photos can be saved for later, with optional AI/manual processing. A photo alone is not an expense. Preserve existing records. The first batch does not change or certify current expense permissions.
- Tools need owned stock and site/depot allocations with over-allocation prevention, rental tracking and linked expenses. Calendars, detailed hours, allowance approval, leave, payroll reports, nine-up payslip printing and optional Supervisor profile photos still need their own implementation and testing.

## Deferred after the defense

- Supervisor expense photo attachment/scanning and submitting an expense for Founder approval before it counts in project totals. This is not part of the current scope.
- Revisit whether or how company-wide Supervisor wages should be allocated to projects if the client clarifies their accounting practice.
- Client-owned deployment: use a reviewed structure-only migration and verify security/configuration. Do not copy development business records or accounts. The existing fresh-install bundle must be verified and updated before use.
