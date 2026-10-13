export type AppRole = 'founder' | 'supervisor';

/**
 * Routes that are Founder-only by default. `/advances` is mixed-use: Supervisors may
 * access its requests view only; `canRoleAccessPath` checks the requested tab so the
 * issued-ledger view stays Founder-only at the middleware boundary. RLS and Founder-only
 * RPCs independently protect the underlying records and mutations. `/settings` is also
 * shared; Founder-only integration cards use `isFounder` and server-side `requireFounder`.
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
  if (role === 'founder') return true;

  const requestedUrl = new URL(safePath, 'https://bale.local');
  if (requestedUrl.pathname === '/advances') {
    const requestedTab = requestedUrl.searchParams.get('tab');
    return requestedTab === null || requestedTab === 'requests';
  }

  return !isFounderOnlyPath(requestedUrl.pathname);
}
