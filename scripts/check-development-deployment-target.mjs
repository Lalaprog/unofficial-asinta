// Check the public client URL at build time without printing it or any key.
// A successful check establishes configuration only, not Auth, RLS, schema,
// database isolation, or real workflow behavior.
if (process.env.NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER === 'true') {
  const bale = process.env.NEXT_PUBLIC_DEVELOPMENT_BALE_SUPABASE_REF;
  const correction = process.env.NEXT_PUBLIC_DEVELOPMENT_CORRECTION_SUPABASE_REF;
  let matches = false;
  if (bale && /^[a-z0-9]{20}$/.test(bale) && bale === correction) {
    try {
      const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '');
      matches = url.protocol === 'https:' && url.hostname === `${bale}.supabase.co` &&
        !url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    } catch { /* Missing or malformed URL is not a match. */ }
  }
  if (!matches || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    console.error('Development finance build stopped: expected project, client URL or public client configuration is missing or mismatched.');
    process.exitCode = 1;
  } else {
    console.log('Development finance build: public client URL matches the configured project. Auth and database behavior are not verified.');
  }
}
