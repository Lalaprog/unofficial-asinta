import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireFounder } from '@/lib/auth/serverRole';
import { enforceRateLimit } from '@/lib/api/rateLimitGuard';
import { buildReceiptDraft, buildReceiptItems } from '@/lib/ai/receiptDraft';
import { loadDraftData } from '@/lib/ai/draftData';
import { readReceiptImage, validateReceiptImagePayload } from '@/lib/ai/receiptVision';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Receipt images sent as base64 need room in the request body.
export const maxDuration = 60;

/**
 * Track B — receipt photo → draft.
 *
 * The browser posts the image as base64 (NOT a storage URL): the `receipts`
 * bucket is private, and sending a signed URL to a third-party model would
 * re-open exactly the exposure the private bucket closes.
 *
 * The response is labelled `verification: 'model-reported'`: the values are
 * quoted from the model's own reading of the photo, which a human must check
 * against the image. The photo is shown beside the draft in the UI for that
 * reason.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const founder = await requireFounder(supabase);
    if (!founder.ok) {
      return NextResponse.json({ error: founder.error }, { status: founder.status });
    }

    const limited = enforceRateLimit('aiExtract', req.headers, founder.userId);
    if (limited) return limited;

    const body = await req.json().catch(() => null);
    const payload = validateReceiptImagePayload({
      mediaType: body?.mediaType,
      base64: body?.base64,
    });
    if (!payload.ok) {
      return NextResponse.json({ error: payload.reason }, { status: 400 });
    }

    const reading = await readReceiptImage({ mediaType: payload.mediaType, base64: payload.base64 });
    if (!reading.ok) {
      // Honest failure: the manual path is unaffected, and we say so.
      return NextResponse.json(
        {
          ok: false,
          error: reading.reason,
          manualEntryAvailable: true,
          rateLimited: reading.rateLimited === true,
          ...(reading.retryAfterSeconds ? { retryAfterSeconds: reading.retryAfterSeconds } : {}),
        },
        { status: reading.rateLimited ? 429 : 502, headers: { 'Cache-Control': 'no-store', ...(reading.retryAfterSeconds ? { 'Retry-After': String(reading.retryAfterSeconds) } : {}) } }
      );
    }

    const { context, errors } = await loadDraftData(supabase);

    // The source text for verification is the model's own reading of the
    // receipt; quotes must appear inside it. That catches internally
    // inconsistent output but cannot catch a misread, which is why the draft is
    // labelled and why the founder sees the photo next to it.
    const draft = buildReceiptDraft(reading.fields, reading.text, context, reading.model);

    return NextResponse.json(
      {
        ok: true,
        draft,
        items: buildReceiptItems(reading.fields.items, reading.text),
        read: {
          model: reading.model,
          usedFallbackModel: Boolean(reading.usedFallback),
          extractedText: reading.text,
        },
        contextWarnings: errors,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read the receipt' },
      { status: 500 }
    );
  }
}
