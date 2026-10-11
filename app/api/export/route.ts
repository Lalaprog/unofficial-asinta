import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { handleLedgerExport } from '@/lib/export/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Founder-only CSV ledger export (`GET /api/export?table=<name>`).
 *
 * Enforced server-side via `requireFounder()`, rate-limited via
 * `lib/rateLimit.ts`, and logged in `public.audit_log` (RA 10173).
 */
export async function GET(request: NextRequest) {
  const tableParam = request.nextUrl.searchParams.get('table');
  const supabase = createServerSupabaseClient();

  const outcome = await handleLedgerExport({
    tableParam,
    headers: request.headers,
    supabase,
  });

  if (typeof outcome.body === 'string') {
    return new NextResponse(outcome.body, {
      status: outcome.status,
      headers: outcome.headers,
    });
  }

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: outcome.headers,
  });
}
