/**
 * Server-side role enforcement shared by all Founder-only API routes.
 * Never rely on client-side (React) role checks alone.
 */

import { isMfaEnforcementEnabled } from '@/lib/auth/mfa';
import { requireSessionAssurance, type AssuranceClient } from '@/lib/auth/session-assurance';

export interface MinimalSupabaseAuthClient extends AssuranceClient {
  auth: {
    getUser: () => Promise<{ data: { user: { id: string; email?: string | null } | null }; error: unknown }>;
    mfa?: {
      getAuthenticatorAssuranceLevel: () => Promise<{
        data: { currentLevel: string | null; nextLevel: string | null } | null;
        error: unknown;
      }>;
    };
  };
  from: (table: string) => any;
}

export interface FounderCheckResult {
  ok: boolean;
  status: number;
  error?: string;
  userId?: string;
  userEmail?: string;
}

/**
 * Validates the current session against Supabase Auth and confirms the
 * caller's `public.users` role is 'founder'. RLS lets every authenticated
 * user read only their own profile row, so this lookup cannot be spoofed.
 */
export async function requireFounder(supabase: MinimalSupabaseAuthClient): Promise<FounderCheckResult> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }

  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError || !profile || profile.role !== 'founder') {
    return { ok: false, status: 403, error: 'This action is restricted to Founder accounts' };
  }

  // A registered factor must be completed even when the separate mandatory
  // Founder enrollment flag is off. The prerequisite RPC must already exist.
  const assurance = await requireSessionAssurance(supabase);
  if (!assurance.ok) return assurance;

  /**
   * Founder MFA enforcement (opt-in, see lib/auth/mfa.ts).
   *
   * Middleware already blocks Founder PAGES, but API routes must not depend on
   * a page redirect that a direct HTTP call never performs. When enforcement is
   * on, a session that is not at aal2 is refused here — with a clear message
   * telling the caller to verify their authenticator code.
   */
  if (isMfaEnforcementEnabled()) {
    try {
      const { data: assurance } = (await supabase.auth.mfa?.getAuthenticatorAssuranceLevel()) ?? {
        data: null,
      };
      if (assurance?.currentLevel !== 'aal2') {
        return {
          ok: false,
          status: 403,
          error:
            'This action requires a session verified with your authenticator app. Verify your 6-digit code, then try again.',
        };
      }
    } catch {
      // Unreadable MFA state must not downgrade to password-only.
      return {
        ok: false,
        status: 403,
        error:
          'The second-factor status of this session could not be verified, so the action was refused.',
      };
    }
  }

  return { ok: true, status: 200, userId: user.id, userEmail: user.email || undefined };
}
