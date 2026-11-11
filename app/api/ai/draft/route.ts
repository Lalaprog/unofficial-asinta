import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireFounder } from '@/lib/auth/serverRole';
import { enforceRateLimit } from '@/lib/api/rateLimitGuard';
import { extractExpenseDraft } from '@/lib/ai/draft';
import { loadDraftData } from '@/lib/ai/draftData';
import { isOffTaskExpenseInstruction } from '@/lib/ai/textExpenseAmount';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Track E — one messy line of text → a reviewable expense draft.
 *
 * Founder-only. The response is a DRAFT: the browser prefills its form and the
 * Founder presses Save. Nothing is inserted here, and an unauthenticated or
 * non-Founder caller gets nothing but a 401/403.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const founder = await requireFounder(supabase);
    if (!founder.ok) {
      return NextResponse.json({ error: founder.error }, { status: founder.status });
    }

    const limited = enforceRateLimit('aiSuggest', req.headers, founder.userId);
    if (limited) return limited;

    const body = await req.json().catch(() => null);
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!text.trim()) {
      return NextResponse.json({ error: 'Describe the expense in one line first.' }, { status: 400 });
    }
    if (text.length > 1000) {
      return NextResponse.json(
        { error: 'That description is too long (1,000 character limit).' },
        { status: 400 }
      );
    }

    if (isOffTaskExpenseInstruction(text)) {
      return NextResponse.json(
        { error: 'This field is for expense descriptions, not general questions or instructions. Describe the purchase, quantities and prices instead.' },
        { status: 400 }
      );
    }

    const { context, errors } = await loadDraftData(supabase);
    const draft = await extractExpenseDraft(text, context);

    return NextResponse.json(
      {
        draft,
        // Context problems are reported, not hidden: if vendor memory could not
        // be read, a "no history for this supplier" statement would be false.
        contextWarnings: errors,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to draft the expense' },
      { status: 500 }
    );
  }
}
