# BALE Communications Setup Guide

**Audience:** the Asinta Architects administrator (no programming knowledge
required).

This guide explains how to finish setting up BALE's client communication
features after the software has been installed:

- **Request for Payment emails** (sent through your own email provider via SMTP)
- **SMS payment reminders** (sent through PhilSMS)
- **Optional automatic SMS reminders** (disabled by default, safe to leave off)

## What the application automates vs. what you must configure

| BALE automates | You must configure externally |
| --- | --- |
| Building, previewing, and sending Request for Payment emails | An SMTP mailbox/account with your email provider |
| Storing the exact copy of every email and SMS sent | DNS records (SPF/DKIM/DMARC) at your domain host |
| Reminder scheduling, duplicate protection, Manila business hours | A PhilSMS account, API key, and approved sender ID |
| Founder-only access control and audit history | A scheduler (Vercel Cron or similar) that calls the reminder endpoint |

> **Never paste passwords, API keys, or secrets into chat apps, emails,
> source code, Git commits, issues, or pull requests.** Secrets belong only
> in the server's environment variables.

---

## 19.1 SMTP provider instructions

BALE sends email through **SMTP**, which almost every email provider offers.
Pick the section matching your provider.

### Google Workspace / Gmail

1. Sign in to the Google account that will send billing emails
   (e.g. `billing@yourdomain.com`).
2. **Enable 2-Step Verification** (Google Account → Security). App Passwords
   are unavailable without it.
3. Create an **App Password**: Google Account → Security → 2-Step
   Verification → App passwords → create one named "BALE".
4. Use the 16-character App Password as `SMTP_PASS`. **Do not use your normal
   Google password** — it will not work and should never be stored anyway.
5. Typical configuration:

   ```env
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_SECURE=true
   SMTP_USER=billing@yourdomain.com
   SMTP_PASS=your-16-character-app-password
   ```

### Microsoft 365 / Outlook

- Host is usually `smtp.office365.com`, port `587`, `SMTP_SECURE=false`
  (STARTTLS).
- **Authenticated SMTP ("SMTP AUTH") may need to be enabled** for the mailbox:
  Microsoft 365 admin center → Users → Active users → *mailbox* → Mail →
  "Manage email apps" → tick **Authenticated SMTP**.
- Some organizations disable username/password SMTP entirely and require
  OAuth or an approved relay. If test emails fail with an authentication
  error even with the right password, ask your Microsoft 365 administrator
  whether SMTP AUTH is blocked by policy.

### Zoho Mail

- Create an **application-specific password**: Zoho Accounts → Security →
  App Passwords. Use it as `SMTP_PASS`.
- Zoho hosts are **regional** — use the host shown in your own Zoho settings,
  commonly `smtp.zoho.com`, `smtp.zoho.eu`, or `smtp.zoho.in`, with port
  `465` and `SMTP_SECURE=true`.

### Amazon SES

- **Verify your sender** (an email address or, better, your whole domain) in
  the SES console before sending anything.
- New SES accounts start in the **SES sandbox**: you can only send to
  verified addresses. Request production access from the SES console before
  emailing clients.
- Create **SES SMTP credentials** (SES console → SMTP settings → Create SMTP
  credentials). These are *different* from your normal AWS keys.
- The SMTP host is **regional**, e.g.
  `email-smtp.ap-southeast-1.amazonaws.com`. Use port `587` with
  `SMTP_SECURE=false` or `465` with `SMTP_SECURE=true`.

### cPanel / business hosting email

- Log in to cPanel → **Email Accounts** → your account → **Connect Devices**
  (or "Configure Mail Client"). That page lists exactly:
  - the outgoing (SMTP) **host** (often `mail.yourdomain.com`),
  - the **port** (usually `465` with SSL or `587` with STARTTLS),
  - the **encryption** type (sets `SMTP_SECURE`),
  - the **username** (usually the full email address),
  - and uses the mailbox **password**.

### Generic SMTP providers (SendGrid, Mailgun, Postmark, etc.)

Every provider documents four values: host, port, username, password. Map
them onto `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and set
`SMTP_SECURE=true` only when the provider says the port uses **implicit
SSL/TLS** (typically port 465). Port 587 is almost always
`SMTP_SECURE=false` (STARTTLS upgrades the connection automatically).

---

## 19.2 Environment variables

Copy this block into your environment configuration and fill in the values:

```env
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=

EMAIL_FROM_NAME=Asinta Architects
EMAIL_FROM_ADDRESS=
EMAIL_REPLY_TO=
FIRM_CONTACT_NUMBER=

PHILSMS_API_KEY=
PHILSMS_SENDER_ID=PhilSMS

SUPABASE_SERVICE_ROLE_KEY=
CRON_SECRET=

AUTOMATIC_REMINDERS_ENABLED=false
```

| Variable | Purpose | Required? | Secret? | Where it comes from | Browser-safe? |
| --- | --- | --- | --- | --- | --- |
| `SMTP_HOST` | Your provider's SMTP server address | For email | No, but keep private | Provider docs (§19.1) | **No — server only** |
| `SMTP_PORT` | SMTP port (587 or 465 usually) | For email | No | Provider docs | **No — server only** |
| `SMTP_SECURE` | `true` for implicit SSL (port 465), `false` for STARTTLS (587) | For email | No | Provider docs | **No — server only** |
| `SMTP_USER` | SMTP login (usually the mailbox address) | For email | Yes | Your provider account | **No — server only** |
| `SMTP_PASS` | SMTP password / app password | For email | **Yes** | Your provider account | **No — server only** |
| `EMAIL_FROM_NAME` | Display name on outgoing email | Optional (default "Asinta Architects") | No | You choose | No (server only) |
| `EMAIL_FROM_ADDRESS` | The From address clients see | For email | No | Must match your verified mailbox/domain | No (server only) |
| `EMAIL_REPLY_TO` | Where client replies go | Recommended | No | A monitored mailbox | No (server only) |
| `FIRM_CONTACT_NUMBER` | Phone number shown in emails | Optional | No | Your firm | No (server only) |
| `PHILSMS_API_KEY` | Authorizes SMS sends | For live SMS | **Yes** | PhilSMS dashboard | **No — server only** |
| `PHILSMS_SENDER_ID` | Sender ID shown on outgoing SMS | Optional (defaults to `PhilSMS`) | No | PhilSMS dashboard — custom values must be approved there first | **No — server only** |
| `SUPABASE_SERVICE_ROLE_KEY` | Lets the scheduled cron job read/write reminder data | For automatic reminders | **Yes — bypasses all row security** | Supabase Dashboard → Project Settings → API | **No — server only, never in a browser** |
| `CRON_SECRET` | Password that protects the reminder endpoint | For automatic reminders | **Yes** | You invent it (long random string) | **No — server only** |
| `AUTOMATIC_REMINDERS_ENABLED` | Global on/off switch for automatic SMS | Yes (leave `false` until tested) | No | You set it | No (server only) |

**Important:** private values must **never** be prefixed with
`NEXT_PUBLIC_`. Anything starting with `NEXT_PUBLIC_` is shipped to every
visitor's browser. Only the Supabase URL and anon key use that prefix.

---

## 19.3 Local setup (development machine)

1. Copy the example file: `cp .env.example .env.local`
2. Add the SMTP settings from §19.1 to `.env.local`.
3. Add the Supabase settings (`NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
4. Add the server-only values (`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`,
   `PHILSMS_API_KEY` if available). Keep `AUTOMATIC_REMINDERS_ENABLED=false`.
5. Install dependencies: `npm install`
6. Apply the database migrations (see §19.5), including
   `supabase/migrations/20260929000000_communications.sql`.
7. Start development: `npm run dev` and open `http://localhost:3000`.
8. Sign in as a **Founder** account.
9. Open **Settings** and check the integration badges (Supabase, Groq,
   PhilSMS, SMTP, Automatic reminders).
10. Use **Settings → Send Test Email** to verify SMTP. Success shows
    "Accepted by mail server"; then check the inbox (and spam folder).
11. Test SMS: without `PHILSMS_API_KEY` the SMS page shows **Simulation
    mode** and nothing leaves the server — safe for testing. With a key,
    send one SMS to your own phone first.
12. Verify logs: the invoice's **Email History** and the **SMS Reminders**
    page should show the exact messages with honest statuses.

---

## 19.4 Production setup

### Vercel

1. Vercel Dashboard → your project → **Settings → Environment Variables**.
2. Add every variable from §19.2. For each one choose the environments
   (**Production**, and optionally **Preview** / **Development**). Keep
   secrets out of Preview if external collaborators can open preview
   deployments.
3. **Redeploy after any environment change** — environment variables are
   baked in at deploy time. Deployments → ⋯ → Redeploy.

### Generic Node.js hosting

- Set the same variables in the host's environment (systemd unit
  `Environment=` lines, Docker `--env-file`, hosting control panel, etc.).
- Never commit a `.env` file with real values; `.env*.local` is already
  ignored by Git.
- Restart the Node process after changing environment values.

**Secret handling warnings:** never log secrets, never send them through
chat/email, restrict dashboard access to trusted people, and rotate any
secret you suspect leaked.

---

## 19.5 Supabase setup

- **Project URL and anon key:** Supabase Dashboard → Project Settings → API →
  "Project URL" and "anon public" key. These go into
  `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **Service-role key:** same page, "service_role" key →
  `SUPABASE_SERVICE_ROLE_KEY`. **This key bypasses Row Level Security
  entirely.** It must exist only on the server (used solely by the
  `/api/cron/reminders` route) and must never appear in browser code, logs,
  or with a `NEXT_PUBLIC_` prefix.
- **Apply migrations:** either run `supabase db push` with the Supabase CLI,
  or open the SQL Editor in the dashboard and run each file in
  `supabase/migrations/` in filename order. For this feature set the new file
  is `20260929000000_communications.sql`.
- **Verify the new tables:** Table Editor should now show `email_templates`,
  `email_logs`, and `reminder_dispatches`, and `invoices` should have
  `automatic_reminders_enabled` and `reminders_paused_until` columns.
- **Verify RLS:** each new table shows "RLS enabled" with Founder-only
  policies.
- **Confirm Supervisor access is denied:** sign in as a Supervisor account
  and confirm that `/invoices`, `/sms`, `/reminders`, and `/settings`
  redirect away, and that querying `email_logs` from the browser console
  returns zero rows.

---

## 19.6 DNS and sender verification

Email that lacks proper DNS authentication lands in spam. Configure these at
your **domain host** (where your DNS records live):

- **SPF** — a TXT record listing which servers may send mail for your
  domain.
- **DKIM** — a cryptographic signature record your email provider generates.
- **DMARC** — a TXT record telling receivers what to do with mail that fails
  SPF/DKIM.
- **Sender verification** — some providers (notably Amazon SES) require you
  to verify the From address or domain before any mail is sent.
- **Reply-to mailbox monitoring** — clients will reply to
  `EMAIL_REPLY_TO`; someone must read that mailbox.

> **Do not invent DNS values.** Copy the exact SPF/DKIM/DMARC records shown
> in your chosen email provider's admin console — every provider's values
> are different.

**Checklist:**

- [ ] The sending mailbox exists and you can log into it.
- [ ] The sender address/domain is verified with the provider.
- [ ] SPF record published.
- [ ] DKIM record published.
- [ ] DMARC record published.
- [ ] `EMAIL_FROM_ADDRESS` domain matches the verified domain.
- [ ] The reply-to inbox is monitored.
- [ ] A test message arrives in a normal inbox, not spam.

---

## 19.7 PhilSMS setup

- Put your API key in `PHILSMS_API_KEY` (server environment only — never in
  the browser or the repository).
- **Sender ID:** BALE sends with the sender ID configured in
  `PHILSMS_SENDER_ID`, defaulting to `PhilSMS` (the account's default sender
  ID) if the variable is not set. Custom sender IDs (e.g. `ASINTA`) must be
  requested and approved in the PhilSMS dashboard first — otherwise the
  gateway will reject the message.
- **Simulation mode:** while `PHILSMS_API_KEY` is empty, the SMS page shows
  *Simulation mode*; messages are logged in BALE but **never leave the
  server**. This is the safe default for testing.
- **Test SMS:** after adding the key, send one manual SMS to your own phone
  from the SMS page before contacting any client.
- **Status meanings:**
  - *Configured* — an API key is present.
  - *Sent* — PhilSMS accepted the message for delivery.
  - *Delivered* — PhilSMS reported a delivery receipt (only then).
  - *Failed* — the gateway or network rejected the message.
- **Keeping real sends disabled during testing:** simply leave
  `PHILSMS_API_KEY` empty — everything else works and logs in simulation
  mode.

---

## 19.8 Cron (scheduler) setup for automatic reminders

- **Endpoint:** `/api/cron/reminders`
- **Method:** `GET` or `POST`
- **Authorization header:** `Authorization: Bearer <CRON_SECRET>` — requests
  without the exact secret receive `401 Unauthorized`.
- **`CRON_SECRET`:** invent a long random string (e.g. from a password
  manager) and set it in the server environment.
- **Recommended schedule:** hourly (e.g. `0 * * * *`). The route itself
  enforces the Manila sending window, so extra runs are harmless.
- **Timezone behavior:** all date decisions ("due today", "3 days before")
  are made in **Asia/Manila**, regardless of where the server runs.
- **Sending-hour enforcement:** the route refuses to send outside
  **Monday–Saturday, 8:00 AM–6:00 PM Manila** and simply reports
  `outside_sending_hours`.
- **Testing safely:** call the endpoint while
  `AUTOMATIC_REMINDERS_ENABLED=false` — it authenticates, does nothing, and
  reports `automatic_reminders_globally_disabled`.
- **Dispatch-log verification:** every attempt (sent, failed, skipped with a
  reason) is recorded in the `reminder_dispatches` table.
- **Duplicate protection:** each reminder has a unique key
  (`invoice + channel + type + date`) enforced by the database, so running
  the cron will not resend an existing key, including failed or pending attempts.
  A timeout, provider server error, missing provider response, or interrupted
  request can leave the outcome **unconfirmed** even if the provider accepted
  it. Check PhilSMS and the SMS/dispatch logs before any manual retry. Automatic
  retries for the same key are intentionally disabled, including legacy failed
  rows; this can leave a reminder unsent and requires operator review. Later
  scheduled dates and manual sends use different attempts and can still send.
  Pause or disable the invoice (or the global switch) while investigating.
  For deployment, pause the cron until all old server instances have been
  replaced: older code can still retry failed keys during a rolling rollout.
  Manual sends are not idempotent and are not deduplicated against scheduled
  sends or other dates. Review the current balance and message before sending;
  eligibility is checked again server-side, but editable message text is not
  revalidated against balance changes made concurrently.

### Vercel Cron example

`vercel.json` in the repository root:

```json
{
  "crons": [{ "path": "/api/cron/reminders", "schedule": "0 * * * *" }]
}
```

With a `CRON_SECRET` environment variable set, Vercel automatically sends it
as the `Authorization: Bearer …` header.

### Generic scheduler example (placeholders only)

```bash
curl -X POST "https://YOUR-DEPLOYMENT-DOMAIN/api/cron/reminders" \
  -H "Authorization: Bearer YOUR_CRON_SECRET_PLACEHOLDER"
```

---

## 19.9 Automatic reminder activation (staged, safe rollout)

Automatic reminders stay **disabled** after deployment. Activate only after
this checklist:

1. Confirm PhilSMS is configured (Settings badge shows *Configured*).
2. Send a **test SMS to your own phone** and confirm receipt.
3. Verify client phone numbers are valid PH mobile numbers
   (`09XXXXXXXXX` / `+639XXXXXXXXX`).
4. Review the SMS wording produced in the Reminder Queue previews.
5. Confirm the schedule (3 days before, due date, 3 days after, weekly
   follow-ups) is what you want.
6. Confirm the timezone: all dates are Asia/Manila.
7. Confirm sending hours: Mon–Sat, 8 AM–6 PM Manila only.
8. Confirm paid/cancelled/zero-balance invoices are excluded (they never
   appear in the queue).
9. Confirm duplicate protection by running the cron twice in one hour and
   checking that no invoice was texted twice.
10. Set `AUTOMATIC_REMINDERS_ENABLED=true` and redeploy (global switch on).
11. Enable **only one or two test invoices** ("Enable automatic reminders
    for this invoice" in the Reminder Queue).
12. Monitor the first scheduled run: check `reminder_dispatches` and the SMS
    log.
13. Expand to more invoices only after the first run is verified.

**Emergency stop:** set `AUTOMATIC_REMINDERS_ENABLED=false` and redeploy
(or remove the cron job). Sends stop immediately; nothing else is affected.

---

## 19.10 Email template setup (for Founders)

1. Open **Settings** in BALE (Founder account).
2. Scroll to **Email Templates — Request for Payment**.
3. View the supported placeholders — bold ones (project, invoice number,
   balance, due date) are important; removing them shows a warning.
4. Edit the subject and body text. Unknown placeholders are rejected on
   save.
5. Click **Preview** with safe sample data, or pick a real invoice from the
   dropdown.
6. Click **Save New Version** — the version number increases every save.
7. **Restore Default** returns the built-in wording (with a confirmation
   step) and also creates a new version.
8. Use **Send Test Email** below the editor to verify SMTP end-to-end.
9. Send a Request for Payment from an invoice, then open the invoice's
   **Email History** to confirm the exact copy that was recorded.

**Historical messages never change.** Every sent email stores its own exact
snapshot; editing the template only affects future emails.

---

## 19.11 Troubleshooting (safe — never print secrets)

| Symptom | Likely cause and safe fix |
| --- | --- |
| "SMTP authentication failed" | Wrong `SMTP_USER`/`SMTP_PASS`. Re-enter them in the environment (don't paste them anywhere else). For Gmail, use an App Password, not the account password. |
| SMTP timeout / connection failed | Wrong `SMTP_HOST` or `SMTP_PORT`, or the host blocks outbound SMTP. Double-check provider docs. |
| Sender rejected | `EMAIL_FROM_ADDRESS` doesn't match the authenticated mailbox or isn't verified with the provider. |
| Relay denied | The provider refuses to send for that From domain — verify the domain or use the mailbox's own address. |
| Invalid recipient | The client record has a malformed email. Fix it in Clients. |
| Gmail App Password fails | 2-Step Verification not enabled, or the App Password was revoked. Create a new one. |
| Microsoft: SMTP AUTH disabled | An admin must enable Authenticated SMTP for the mailbox (§19.1). |
| SES only sends to some addresses | You are in the SES sandbox — request production access. |
| Mail lands in spam | SPF/DKIM/DMARC missing (§19.6), or the From domain isn't verified. |
| Missing SPF/DKIM | Copy the exact records from your provider's console into DNS. |
| Wrong port / `SMTP_SECURE` | Rule of thumb: port 465 → `SMTP_SECURE=true`; port 587 → `SMTP_SECURE=false`. |
| Supabase RLS errors ("row-level security") | Migrations not applied, or a non-Founder is attempting a Founder action. Apply `20260929000000_communications.sql`, sign in as a Founder. |
| "service-role … not configured" from cron | Set `SUPABASE_SERVICE_ROLE_KEY` in the server environment (never in the browser). |
| Cron returns 401 | The `Authorization: Bearer …` header doesn't match `CRON_SECRET` exactly, or `CRON_SECRET` is unset (the route fails closed). |
| SMS shows "Simulation mode" | `PHILSMS_API_KEY` is empty. That is intentional and safe; add the key for live sends. |
| PhilSMS failure | Check the error stored on the SMS log (invalid number, unapproved sender ID, or account balance). |
| "duplicate_skipped" in cron results | An attempt or skip for that key already exists; it may be pending, failed, skipped or sent. Inspect the dispatch and provider before deciding what to do. |
| Cron reports `automatic_reminders_globally_disabled` | `AUTOMATIC_REMINDERS_ENABLED` is not `true`. Enable it only after §19.9. |

---

## 19.12 Emergency disable and rollback

- **Disable automatic reminders:** set `AUTOMATIC_REMINDERS_ENABLED=false`
  and redeploy. This is the single global kill switch.
- **Disable the cron:** remove the cron entry (Vercel: delete it from
  `vercel.json` and redeploy; generic: remove the crontab line).
- **Rotate `CRON_SECRET`:** set a new random value and update the scheduler.
  Old callers instantly get 401.
- **Remove/rotate SMTP credentials:** change the mailbox password / revoke
  the app password at the provider, then update or blank the `SMTP_*`
  variables. With SMTP unset, BALE safely refuses to send email.
- **Disable email sending:** blank out `SMTP_HOST` (or any required SMTP
  variable) and redeploy.
- **Remove/rotate the PhilSMS key:** revoke it in the PhilSMS dashboard and
  blank `PHILSMS_API_KEY` — BALE falls back to simulation mode.
- **Pause a single invoice:** Reminder Queue → *Pause 7 days* (or disable
  that invoice's automatic reminders).
- **History is preserved:** none of the steps above deletes `email_logs`,
  `sms_logs`, or `reminder_dispatches` — you stop new sends while keeping
  the full audit trail.

---

## 19.13 Security checklist

- [ ] No secrets committed to Git (search the repo for passwords/keys).
- [ ] `.env.local` is ignored by Git (already configured in `.gitignore`).
- [ ] SMTP password exists only in server environment variables.
- [ ] PhilSMS key is server-only.
- [ ] Supabase service-role key is server-only and not `NEXT_PUBLIC_`.
- [ ] `CRON_SECRET` is server-only and random.
- [ ] Founder-only actions are enforced by the server (they are — every API
      route re-checks the role) and by database RLS.
- [ ] RLS enabled on all communication tables.
- [ ] Demo/test accounts have rotated passwords in production.
- [ ] The reply-to mailbox is monitored.
- [ ] Automatic reminders remain disabled until §19.9 is completed.
- [ ] A controlled production test (own email + own phone) was completed
      before contacting any client.
