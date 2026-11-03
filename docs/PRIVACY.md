# BALE — Data Privacy Act (RA 10173) Compliance Notes

Asinta Architects processes personal data in BALE: worker names, contact
numbers, positions and wages; client contact persons, phone numbers and emails;
and — in free-text notes and receipt photos — whatever a Founder types or
photographs. This document maps the obligations of the Philippine Data Privacy
Act of 2012 (RA 10173), its IRR, and NPC issuances onto what the software does,
what only the firm can do, and what is still open.

**Status legend:** ✅ in place · 🟡 partly in place / needs a decision ·
⬜ not started (firm action, not a software change)

---

## 1. Roles and accountability

| Obligation | Status | Notes |
| --- | --- | --- |
| Designate a Data Protection Officer (DPO) | ⬜ | Required once the firm processes personal data of employees/clients. Register the DPO with the NPC. |
| Maintain a Records of Processing Activities (ROPA) | 🟡 | §2 below is the technical inventory to copy into the firm's ROPA. |
| NPC registration (if thresholds met) | ⬜ | Registration is required for entities processing sensitive personal information, or ≥250 employees, or ≥1,000 data subjects in 12 months (NPC Circular 2022-04). Asinta is likely below the employee threshold but a **determination should be recorded** either way. |
| Privacy notice given to data subjects | ⬜ | Text drafted in §4; it must actually reach workers (payslip insert, site orientation) and clients. |
| Breach notification within 72 hours | ⬜ | Runbook in §6. Requires a named person and out-of-band contact details. |

---

## 2. Processing inventory (what BALE actually holds)

| Data | Where | Lawful basis | Retention |
| --- | --- | --- | --- |
| Worker name, contact number, position, pay rate | `workers` | Contract / employment | Employment + 3 years (see §5) |
| Attendance records | `attendance` | Contract / legal (labor) | 3 years |
| Wages, bale deductions, payslips | `payroll`, `advances` | Contract / legal | BIR requires books/records for **5 years** (RR 17-2013); keep payroll 5 years |
| Worker advances (BALE) | `advances` | Contract | 5 years (financial record) |
| Client contact person, phone, email, address | `clients` | Contract | Contract + 3 years |
| Invoice and payment records | `invoices`, `email_logs`, `sms_logs` | Contract / legal | 5 years |
| Receipt photos (may contain names, TINs, card fragments) | `receipts` bucket (private) | Legitimate interest / legal | 5 years |
| Expense notes (free text) | `expenses` | Contract / legal | 5 years |
| Authentication records (email, hashed password, TOTP factors) | `auth.users` (Supabase) | Security | Life of account + 1 year |
| Audit trail of financial changes | `audit_log` | Legal / accountability | 5 years |

Free-text fields are the weakest point: a Founder can type a worker's medical
reason or a client's personal number into `expenses.notes`. Advice to the firm:
keep clinical or personal details out of notes; if they are needed, they belong
in the HR file, not the ledger.

---

## 3. Data privacy principles mapped to the software

- **Transparency.** The app states what it does with data at the point of
  collection: the login screen says credentials are verified by Supabase Auth;
  the expense screens say AI suggestions are assistive and require confirmation;
  the session dialog says why sessions close.
- **Legitimate purpose.** Each collection has a stated purpose (payroll,
  billing, project cost control). AI features exist only to reduce transcription
  work — they never make decisions and never write to the ledger.
- **Proportionality.** No national ID numbers, no birthdates, no bank accounts,
  no biometrics are collected. Receipt photos are the only place card fragments
  could appear — hence the private bucket and short-lived signed URLs.
- **Security.** RLS on every table, Founder-only financial data, MFA available,
  append-only audit trail, private receipt storage, security headers, rate limits
  (see `docs/SECURITY.md`).
- **Retention.** No automated purge exists (see §5).
- **Data subject rights.** Access/correction is possible today through the UI by
  a Founder (worker/client records are editable). Erasure is *not* a one-click
  operation: financial records are subject to BIR retention, so erasure is
  limited to data not under a legal retention duty.

### Third parties (sub-processors)

| Processor | Data | Notes |
| --- | --- | --- |
| Supabase (database, auth, storage) | All of the above | Confirm the project region and the data processing agreement. |
| Groq (AI drafting) | Expense text, receipt images — sent **per request** | No key configured ⇒ nothing is sent. Receipts are sent as base64 within the request. Prefer Dataverse/enterprise settings if the firm requires no-training guarantees. |
| PhilSMS | Client recipient name and phone number | Only when a SMS is actually sent. |
| SMTP provider | Client email address and message content | Only when a mail is sent. |

Action: record the Supabase project region and confirm each processor's data
processing terms. A founder-facing summary of "who sees what" belongs in the
privacy notice.

---

## 4. Privacy notice (draft text for the firm to adopt)

> **How Asinta Architects handles your information.** We collect your name,
> contact number, position, attendance and pay details so we can pay you
> correctly, comply with labour and tax rules, and track project costs. Client
> contact details are used to send invoices and payment reminders. Records are
> stored in BALE, our billing and payroll system, hosted by Supabase, and are
> accessible only to firm founders and, for their assigned projects, supervisors.
> Some expense details are read by an AI service (Groq) to reduce typing; it
> never decides anything and never changes the ledger without a founder
> confirming it. We keep payroll, billing and expense records for five years as
> required by BIR rules and attendance records for three years. You may ask to
> see or correct your information, and ask questions about it, by contacting our
> Data Protection Officer at **[DPO name, email, phone]**. If you believe your
> data has been mishandled you may complain to the National Privacy Commission
> (complaints@privacy.gov.ph).

---

## 5. Retention (open item)

No automated deletion exists. Recommended policy for the firm to adopt and then
either (a) accept as a manual annual review, or (b) commission as a follow-up
job (a scheduled function that anonymises/removes rows past their retention
date, with its own audit entry).

Trigger the manual review each January:

```sql
-- Attendance older than 3 years (see the retention table above).
select count(*) from public.attendance where date < (current_date - interval '3 years');

-- Financial records older than 5 years — review, do NOT delete without
-- confirming the BIR retention period has actually elapsed.
select
  (select count(*) from public.invoices where issue_date < (current_date - interval '5 years')) as invoices,
  (select count(*) from public.expenses where expense_date < (current_date - interval '5 years')) as expenses,
  (select count(*) from public.payroll where period_end   < (current_date - interval '5 years')) as payroll,
  (select count(*) from public.audit_log where created_at < (current_date - interval '5 years')) as audit_rows;
```

Also delete receipt **objects**, not just rows: clearing `expenses.receipt_url`
leaves the photo in the bucket. Storage objects and database rows are separate
lifecycles.

---

## 6. Breach runbook (72-hour rule)

1. **Contain.** Rotate the Supabase service-role key and any SMTP/SMS keys;
   sign out all sessions; if a Factor is suspected compromised, remove it.
2. **Assess.** What data, how many data subjects, is it sensitive personal
   information (health, finances)? Check `audit_log` for the affected window —
   it records every financial mutation with actor and timestamp.
3. **Notify the NPC within 72 hours** of becoming aware, if the breach involves
   sensitive personal information or is likely to result in serious harm
   (NPC Circular 16-03). Include: nature of the breach, data involved, measures
   taken, and contact details of the DPO.
4. **Notify affected data subjects** when the breach involves their sensitive
   personal information or could enable identity fraud.
5. **Record** the facts, timeline and decisions — an accountability log, not a
   narrative email. Keep it with the ROPA.
6. **Fix and verify** the underlying cause, and record the fix.

Keep the DPO contact details and the NPC hotline **offline** as well as in this
repository: during an incident, the system that holds them may be the one that
is unavailable.

---

## 7. Software-side privacy controls already implemented

- No PII in logs: no phone numbers, message bodies or credentials in printed
  errors; SMTP errors are sanitised (`lib/email/mailer.ts`).
- Receipt bucket private with 5-minute signed URLs.
- Founder-only financial data via RLS; supervisors are scoped to assigned
  projects.
- Service-role key is server-only, never imported by a client component.
- Aborted AI requests degrade to manual entry; no personal data is sent unless
  the Founder explicitly uses a drafting feature and a key is configured.
- Audit trail of financial mutations, append-only.
