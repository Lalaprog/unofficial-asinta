import { createClient } from '@supabase/supabase-js';

/**
 * Trusted service-role Supabase client for carefully authorized SERVER-SIDE
 * operations (e.g. scheduled reminders and private project photos). It bypasses
 * RLS: routes must independently verify authorization and project scope before
 * using it. Never import it from client components or expose the key publicly.
 */
export function isServiceRoleConfigured(): boolean {
  return Boolean(
    (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim() &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  );
}

export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error('Supabase service-role client is not configured on the server.');
  }

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
