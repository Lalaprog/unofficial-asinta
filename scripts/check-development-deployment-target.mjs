// The public URL check confirms configuration only, not Auth, RLS, schema,
// isolation or real workflow behavior. Never print environment values.
const env = process.env;
const production = env.VERCEL_ENV === 'production';
const expectedDevelopmentRef = 'mchkdkjntnbwrgmyobpd';
const requiredFlags = [
  'NEXT_PUBLIC_DEVELOPMENT_SITE',
  'NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER',
  'NEXT_PUBLIC_SUPERVISOR_PAYROLL_REVISION_PREVIEW',
  'NEXT_PUBLIC_SUPERVISOR_REVISION_HISTORY_PREVIEW',
  'NEXT_PUBLIC_WORKER_CATEGORY_PREVIEW',
  'NEXT_PUBLIC_WORKER_CATEGORY_WORKFORCE_PREVIEW',
  'NEXT_PUBLIC_SUPERVISOR_PORTRAIT_PREVIEW',
  'NEXT_PUBLIC_WEEKLY_BALE_IDEMPOTENT_SUBMISSION_PREVIEW',
  'NEXT_PUBLIC_PROJECT_COST_CORRECTION_PREVIEW',
  'NEXT_PUBLIC_CORRECTED_PROJECT_COST_REVIEW_PREVIEW',
];
if (production && (
  env.VERCEL_GIT_COMMIT_REF !== 'arena/e137cf5b-unofficial-asinta' ||
  !/^[a-f0-9]{40}$/.test(env.ASINTA_DEVELOPMENT_RELEASE_SHA || '') ||
  env.ASINTA_DEVELOPMENT_RELEASE_SHA !== env.VERCEL_GIT_COMMIT_SHA ||
  requiredFlags.some(key => env[key] !== 'true') ||
  env.AUTOMATIC_REMINDERS_ENABLED === 'true' ||
  env.NEXT_PUBLIC_DEVELOPMENT_BALE_SUPABASE_REF !== expectedDevelopmentRef ||
  env.NEXT_PUBLIC_DEVELOPMENT_CORRECTION_SUPABASE_REF !== expectedDevelopmentRef
)) {
  console.error('Production build stopped: the development release configuration is incomplete or does not match the approved commit and project.');
  process.exitCode = 1;
}
if (env.NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER === 'true') {
  const bale = env.NEXT_PUBLIC_DEVELOPMENT_BALE_SUPABASE_REF;
  const correction = env.NEXT_PUBLIC_DEVELOPMENT_CORRECTION_SUPABASE_REF;
  let matches = false;
  if (bale && /^[a-z0-9]{20}$/.test(bale) && bale === correction) {
    try {
      const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL || '');
      matches = url.protocol === 'https:' && url.hostname === `${bale}.supabase.co` &&
        !url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    } catch { /* Missing or malformed URL is not a match. */ }
  }
  if (!matches || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    console.error('Development finance build stopped: expected project, client URL or public client configuration is missing or mismatched.');
    process.exitCode = 1;
  } else if (!process.exitCode) {
    console.log('Development finance build: public client URL matches the configured project. Auth and database behavior are not verified.');
  }
}
