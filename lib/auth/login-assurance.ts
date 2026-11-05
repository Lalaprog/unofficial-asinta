import { requireSessionAssurance, type AssuranceClient } from '@/lib/auth/session-assurance';

export type LoginAssurance =
  | { kind: 'ready' }
  | { kind: 'challenge'; factorId: string }
  | { kind: 'unavailable' };

interface LoginAssuranceClient extends AssuranceClient {
  auth: { mfa: { listFactors: () => Promise<{ data: { totp: Array<{ id: string; status: string }> } | null; error: unknown }> } };
}

/** Determine what the sign-in UI may do, without trusting cached user factors. */
export async function getLoginAssurance(client: LoginAssuranceClient): Promise<LoginAssurance> {
  const result = await requireSessionAssurance(client);
  if (result.ok) return { kind: 'ready' };
  if (result.status !== 403) return { kind: 'unavailable' };
  try {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error || !data || !Array.isArray(data.totp)) return { kind: 'unavailable' };
    const verified = data.totp.find(factor => factor.status === 'verified' && typeof factor.id === 'string' && factor.id.length > 0);
    return verified ? { kind: 'challenge', factorId: verified.id } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}
