import { NextRequest, NextResponse } from 'next/server';
import { analyzeExpenseWithAI } from '@/lib/ai/groq';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/api/rateLimitGuard';
import { requireFounder } from '@/lib/auth/serverRole';

/**
 * Groq AI expense categorization.
 * Requires an authenticated Supabase session whose public.users role is
 * 'founder' (expense recording is a Founder-only feature).
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();

    const founder = await requireFounder(supabase);
    if (!founder.ok || !founder.userId) {
      return NextResponse.json({ error: founder.error || 'Authentication required' }, { status: founder.status });
    }

    // Groq tokens are paid per request.
    const limited = enforceRateLimit('aiSuggest', req.headers, founder.userId);
    if (limited) return limited;

    const body = await req.json();
    const { description } = body;

    if (!description) {
      return NextResponse.json({ error: 'Description is required' }, { status: 400 });
    }

    // The suggestion always comes back with its source ("llm" | "rules") and,
    // when the model was unusable, a reason. The client shows that honestly
    // instead of presenting rule output as AI output.
    const result = await analyzeExpenseWithAI(String(description));
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || 'Failed to analyze expense' },
      { status: 500 }
    );
  }
}
