/**
 * Track B — receipt photo → draft.
 *
 * Reads a receipt image with a Groq vision model and returns the raw text plus
 * candidate fields. It does NOT decide anything: the caller runs the result
 * through the same verification gates as a typed description
 * (lib/ai/draft.ts) and the Founder confirms every field against the photo.
 *
 * THREE DELIBERATE CONSTRAINTS
 * ----------------------------
 * 1. The image is sent as a BASE64 DATA URI, never as a URL. The `receipts`
 *    bucket is private (migration 20261006000000) precisely because receipts
 *    leak supplier names, amounts and TINs; handing Groq a signed URL would
 *    re-open that hole from the other end.
 * 2. Handwritten and faded thermal receipts are hit-or-miss. Failure is
 *    reported as failure and the manual path is unaffected.
 * 3. A vision model is a PREVIEW-grade helper, so the UI labels its output
 *    "read from the photo — check every field". It is never authoritative.
 */

import { requestGroqJson } from '@/lib/ai/groqClient';
import { VISION_FALLBACK_MODELS, getVisionModel, VISION_MAX_IMAGE_BYTES } from '@/lib/ai/models';

export interface ReceiptReadRequest {
  /** e.g. "image/jpeg" */
  mediaType: string;
  /** Raw base64 (no data-URI prefix). */
  base64: string;
  /** Optional hint text, e.g. the projects list, to help match a project. */
  projectHint?: string;
}

export interface ReceiptReadResult {
  ok: boolean;
  /** Verbatim text the model read off the receipt. */
  text: string;
  /** Parsed candidate fields (untrusted — validated by the caller). */
  fields: Record<string, unknown>;
  model: string;
  /** Present when ok is false. Safe to show to a Founder. */
  reason?: string;
  /** True when a fallback model answered instead of the primary. */
  usedFallback?: boolean;
}

const MAX_BASE64_CHARS = Math.ceil((VISION_MAX_IMAGE_BYTES * 4) / 3) + 8;

export const RECEIPT_READ_SYSTEM_PROMPT = `You read Philippine supplier receipts and delivery slips for an architecture firm's expense ledger.

Return ONLY this JSON object:
{
  "receipt_text": "<the readable text of the receipt, line by line, verbatim>",
  "description": "<one short, verbatim item or service as it appears in receipt_text, max 120 characters, or null>",
  "amount": <the total amount as a number, or null>,
  "amount_quote": "<the exact text on the receipt showing that total, or null>",
  "date": "<YYYY-MM-DD or null>",
  "date_quote": "<the exact text on the receipt showing the date, or null>",
  "vendor": "<the supplier or store name printed on the receipt, or null>",
  "vendor_quote": "<the exact text showing that name, or null>",
  "category": "<materials|labor|equipment|permits|transportation|other or null>",
  "project_name": "<a project name if one is printed or handwritten on the receipt, or null>",
  "bale": <true only if the receipt is for a cash advance to a worker>
}

Hard rules:
- The description is one exact item/service excerpt, not the entire receipt, supplier, total, tax or a guess. If uncertain, use null.
- Read what is there. NEVER guess a number that is not legible: use null.
- If the image is not a receipt, or is too blurry to read, return receipt_text "" and nulls.
- amount must be the TOTAL, not a line item. If you cannot tell which is the total, use null.
- Quotes must be copied exactly from the receipt text.
- Output JSON only. No prose, no markdown.`;

/**
 * Reads one receipt image. Tries the configured vision model first, then a
 * short fallback list, and reports which model answered.
 */
export async function readReceiptImage(
  request: ReceiptReadRequest,
  options: { apiKey?: string; timeoutMs?: number } = {}
): Promise<ReceiptReadResult> {
  if (!request.base64) {
    return { ok: false, text: '', fields: {}, model: getVisionModel(), reason: 'No image data was provided.' };
  }
  if (request.base64.length > MAX_BASE64_CHARS) {
    return {
      ok: false,
      text: '',
      fields: {},
      model: getVisionModel(),
      reason: `The photo is larger than the ${Math.round(
        VISION_MAX_IMAGE_BYTES / (1024 * 1024)
      )} MB limit for base64 image input. Compress or crop it, or type the expense in manually — the ledger does not depend on this.`,
    };
  }

  const mediaType = request.mediaType || 'image/jpeg';
  const dataUri = `data:${mediaType};base64,${request.base64}`;

  const candidates = [getVisionModel(), ...VISION_FALLBACK_MODELS.filter((m) => m !== getVisionModel())];
  let lastReason = 'No vision model was available.';

  for (const [index, model] of candidates.entries()) {
    const result = await requestGroqJson({
      model,
      system: RECEIPT_READ_SYSTEM_PROMPT,
      user: [
        { type: 'text', text: 'Read this receipt and return the JSON described.' },
        { type: 'image_url', image_url: { url: dataUri } },
      ],
      temperature: 0,
      maxTokens: 1500,
      timeoutMs: options.timeoutMs ?? 45_000,
      apiKey: options.apiKey,
    });

    if (result.ok && result.parsed && typeof result.parsed === 'object') {
      const fields = result.parsed as Record<string, unknown>;
      const text = typeof fields.receipt_text === 'string' ? fields.receipt_text : '';
      return {
        ok: true,
        text,
        fields,
        model,
        usedFallback: index > 0,
      };
    }

    lastReason = result.ok ? 'The model returned an unusable response.' : result.reason;
  }

  return {
    ok: false,
    text: '',
    fields: {},
    model: candidates[0],
    reason: `${lastReason} Type the expense manually — nothing is blocked by this.`,
  };
}

/**
 * Validates the transport-level shape of an uploaded receipt image before any
 * bytes are sent to a provider. The client also validates; both do, because a
 * client check is convenience, not a control.
 */
export function validateReceiptImagePayload(input: {
  mediaType?: unknown;
  base64?: unknown;
  byteLength?: unknown;
}): { ok: true; mediaType: string; base64: string } | { ok: false; reason: string } {
  const mediaType = typeof input.mediaType === 'string' ? input.mediaType.toLowerCase() : '';
  const base64 = typeof input.base64 === 'string' ? input.base64.replace(/^data:[^,]+,/, '') : '';

  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)) {
    return { ok: false, reason: 'Receipt photos must be JPEG, PNG or WebP.' };
  }
  if (!base64) {
    return { ok: false, reason: 'The image data was empty.' };
  }
  if (base64.length > MAX_BASE64_CHARS) {
    return {
      ok: false,
      reason: `The image is too large to send to the vision model (max ${Math.round(
        VISION_MAX_IMAGE_BYTES / (1024 * 1024)
      )} MB).`,
    };
  }

  return { ok: true, mediaType, base64 };
}
