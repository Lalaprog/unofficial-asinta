export type AppRole = 'founder' | 'supervisor';

/**
 * Routes that are reserved for Founder accounts. Shared by middleware and login redirects.
 * Note: `/settings` is accessible to both Founders (Firm Settings & Integrations) and
 * Supervisors (Supervisor Profile & Session Sync), with Founder-only integration cards
 * gated by `isFounder` and server-side `requireFounder` on all admin API routes.
 */
export const FOUNDER_ONLY_ROUTES = [
  '/dashboard',
  '/invoices',
  '/expenses',
  '/payroll',
  '/advances',
  '/clients',
  '/tools',
  '/users',
  '/sms',
  '/reminders',
] as const;

export function isFounderOnlyPath(pathname: string): boolean {
  return FOUNDER_ONLY_ROUTES.some((route) => pathname.startsWith(route));
}

/**
 * Accept only same-site paths. This rejects absolute/protocol-relative URLs,
 * backslash browser-normalisation tricks, and malformed URL input.
 */
export function getSafeRedirectPath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return null;
  }

  try {
    const base = new URL('https://bale.local');
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function canRoleAccessPath(role: AppRole, path: string): boolean {
  const safePath = getSafeRedirectPath(path);
  if (!safePath) return false;

  const pathname = new URL(safePath, 'https://bale.local').pathname;
  return role === 'founder' || !isFounderOnlyPath(pathname);
}
