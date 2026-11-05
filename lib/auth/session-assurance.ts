/** Server-side assurance gate for authenticated application operations.
 *
 * The database RPC evaluates the JWT verified by Supabase and current factor
 * state. Never infer enrollment from browser-controlled session metadata. This
 * protects only the caller of this helper; direct database, storage and RPC
 * access require their own independent enforcement.
 */
export interface AssuranceClient {
  rpc: (name: string) => PromiseLike<{ data: unknown; error: unknown }>;
}

export type AssuranceResult =
  | { ok: true }
  | { ok: false; status: 403 | 503; error: string };

export async function requireSessionAssurance(supabase: AssuranceClient): Promise<AssuranceResult> {
  try {
    const { data, error } = await supabase.rpc('session_assurance_satisfied');
    if (error || (data !== true && data !== false)) {
      return { ok: false, status: 503, error: 'Unable to verify your session security. Please try again.' };
    }
    if (!data) {
      return { ok: false, status: 403, error: 'Verify your authenticator before continuing.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 503, error: 'Unable to verify your session security. Please try again.' };
  }
}
