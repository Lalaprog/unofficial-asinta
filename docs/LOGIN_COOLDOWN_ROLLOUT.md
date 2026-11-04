# Shared app-login cooldown rollout

This is an additive prerequisite for the password login change. It does **not**
implement email-code recovery or change Supabase Auth settings. Do not deploy
this app version before the database prerequisite and server configuration are
confirmed: it intentionally fails closed and would otherwise block all logins.

## Current project status

On the connected project, the additive prerequisite was applied as hosted
migration `20261104161749` (`login_cooldown`); the repository filename is
`20261104000002_login_cooldown.sql`. Function body hashes match the repository,
RLS is enabled, anonymous/authenticated access is denied, service-role function
execution is granted, and Auth/DB/REST health checks passed. No real login or
bucket test was made. Vercel metadata lists the service-role variable for both
production and preview; metadata alone does not establish that its value is
valid or points to this project. The application change is not deployed yet.

## Before enabling the app version

1. Confirm the target project is the one used by production and that its
   database and Auth services are healthy. Hosted migration history differs
   from this repository; **do not blindly run `supabase db push` or an upgrade
   bundle**. Check for naming collisions, then apply only
   `20261104000002_login_cooldown.sql` through the approved migration process.
   It adds empty private tables and service-role-only functions; it does not
   alter existing users, records or Auth settings. Record the actual hosted
   migration version separately from the repository filename.
2. Confirm the production server has the correct, nonempty
   `SUPABASE_SERVICE_ROLE_KEY` for that same Supabase project. Do not print,
   copy into tickets/chat, or expose the key to the browser. Confirm forwarded
   client addresses are supplied by a trusted proxy (Vercel in production).
3. Verify table RLS, execution grants, function bodies and DB/API health without
   inserting real or synthetic login buckets into the hosted database. Confirm
   the production application's Auth route is available. Preview deployments
   may share the real project: do not use them for automated sign-in attempts.
4. Deploy/merge only after checks pass. Have a rollback to the previous app
   deployment available. The additive schema may remain installed on rollback.

## After deployment

The owner can check their actual sign-in, authenticator challenge where enrolled,
wrong-password cooldown and later successful retry from a suitable account and
network. Do not automate wrong-password tests against real accounts. Avoid five
failures on a network currently needed by others. Inspect the result without
logging credentials or session cookies. Existing signed-in sessions should not
be changed by the rollout. A browser or password manager may ignore autocomplete
preferences, and previously saved credentials are not removed.

App-only limitations are detailed in `docs/SECURITY.md` §7. Direct provider Auth
requests bypass the app guard. The old instance-local 10-requests-per-network
limiter remains, counting successes, and can affect a shared network. Email-code
recovery and configuration of the existing email provider are deferred.
