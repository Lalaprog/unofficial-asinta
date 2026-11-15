/** A development-only RPC must not be sent to an unexpected backend. The
 * public URL check is a deployment configuration guard, not authentication or
 * evidence that the RPC exists. Outside development, rollout is separate. */
export function baleSubmissionTargetBlocked(idempotent: boolean): boolean {
  if (!idempotent || process.env.NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER !== 'true') return false;
  const ref = process.env.NEXT_PUBLIC_DEVELOPMENT_BALE_SUPABASE_REF;
  if (!ref || !/^[a-z0-9]{20}$/.test(ref)) return true;
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '');
    return !(url.protocol === 'https:' && url.hostname === `${ref}.supabase.co` &&
      !url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash);
  } catch {
    return true;
  }
}
