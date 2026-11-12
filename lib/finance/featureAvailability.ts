/**
 * Temporary UI release gate for unfinished PR #103 features and paid review.
 * Next.js inlines this NEXT_PUBLIC value at build time. It is not authorization
 * or a database safety gate. Only enable on a separately verified deployment
 * after its matching schema, permissions, workflows and recovery plan are ready.
 */
export function financeFoundationEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW === 'true';
}

/** A second independent display gate; the experimental adjustment RPCs must exist first. */
export function paidAdjustmentsPreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_PAID_ADJUSTMENTS_PREVIEW === 'true';
}
