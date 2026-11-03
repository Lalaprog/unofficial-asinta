/**
 * Every Groq model ID BALE uses, in one place.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * While implementing this pass, the two model IDs the app depended on turned
 * out to be RETIRED. Verified against https://console.groq.com/docs/deprecations
 * on 2026-10-06:
 *
 *   - `llama-3.3-70b-versatile` (the categorizer's model) — deprecated
 *     2026-08-16. Requests to a shut-down ID return errors; the categorizer was
 *     therefore degrading to the rule layer on every call and saying so, which
 *     is why nobody had noticed. Replacement: `openai/gpt-oss-120b`.
 *   - `meta-llama/llama-4-scout-17b-16e-instruct` (the planned vision model) —
 *     deprecated 2026-07-17. Vision is now served by `qwen/qwen3.8-27b`.
 *
 * Groq retires models on a schedule of months, so the IDs must be data, not
 * code: each one is overridable with an environment variable and the active
 * choice is reported by /api/integrations/status.
 *
 * Everything here is *assistive*. Losing a model degrades the suggestion
 * quality and is reported to the user; it never blocks manual entry.
 */

export const GROQ_CHAT_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

function modelFromEnv(name: string, fallback: string): string {
  return (process.env[name] || '').trim() || fallback;
}

/** Text extraction / classification (status → suggestion text). */
export function getTextModel(): string {
  return modelFromEnv('GROQ_TEXT_MODEL', 'openai/gpt-oss-120b');
}

/** Vision model for receipt photos. */
export function getVisionModel(): string {
  return modelFromEnv('GROQ_VISION_MODEL', 'qwen/qwen3.8-27b');
}

/**
 * Vision fallbacks tried in order if the primary model errors (retired ID,
 * preview withdrawal, rate limit). Kept deliberately short: silently walking a
 * long list of models would make failures slow and confusing.
 *
 * The Llama 4 Scout entry is retained only because it may still answer on
 * committed-spend (enterprise) accounts; on free/developer tiers it returns an
 * error and we move on.
 */
export const VISION_FALLBACK_MODELS = ['meta-llama/llama-4-scout-17b-16e-instruct'];

/**
 * Request limits, from the Groq docs:
 *   - Vision, image passed as a URL: 20 MB per request.
 *   - Vision, image passed as base64: smaller in practice (Groq documents the
 *     20 MB figure for URL inputs; base64 bodies are capped lower). 4 MB of
 *     image bytes is ~5.3 MB of base64 and sits safely inside the documented
 *     URL ceiling while staying well under any body-size limit.
 *   - Receipts bucket: 5 MB per object (storage.objects.file_size_limit).
 * A photo between those two numbers is still storable — it just cannot be sent
 * to the vision model, and the UI says exactly that instead of failing vaguely.
 */
export const VISION_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
